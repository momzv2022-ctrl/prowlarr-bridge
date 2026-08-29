/**
 * The setup page, run rather than read.
 *
 * `worker.test.mjs` covers the bridge. This covers the other half of the setup
 * flow: the page's own script, driven in a stub DOM, because the parts people
 * get wrong are the handoff (a key minted in one tab meeting a URL that only
 * Cloudflare could produce) and losing your place in the steps.
 *
 * It runs the built page, not the template, so the inlining in `build.mjs` is
 * covered too: a placeholder left unreplaced fails here.
 *
 * **The stub is a model, and a model can lie.** So the shape it models is read
 * out of the real markup rather than written down twice: the step ids and their
 * `data-next` targets come from the file, and a step renamed or a `data-next`
 * pointed at nothing fails here rather than quietly working in a fake DOM.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

execFileSync(process.execPath, [join(REPO, "worker", "tools", "build.mjs")], { stdio: "ignore" });
const html = readFileSync(join(REPO, "site", "index.html"), "utf8");
const WORKER = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

// Which of them the page ships hidden. Taken from the markup rather than
// restated here, so a panel that loses its `hidden` attribute, and would
// therefore greet a first-time reader with a warning meant for someone
// returning, fails a test instead of shipping.
const hiddenIds = new Set(
  [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
    .filter((match) => /\shidden[\s>]/.test(match[0]))
    .map((match) => match[1]),
);

/** The steps, read out of the page: `[{ id, next }]` in document order. */
const STEPS = (() => {
  const opens = [...html.matchAll(/<li class="step[^"]*" id="([^"]+)">/g)];
  return opens.map((match, index) => {
    const from = match.index;
    const to = index + 1 < opens.length ? opens[index + 1].index : html.length;
    const next = /data-next="([^"]+)"/.exec(html.slice(from, to));
    return { id: match[1], next: next ? next[1] : null };
  });
})();

const KEY_SHAPE = /^[a-z2-9]{4}(?:-[a-z2-9]{4}){5}$/;
const SAVED = "prowlarr-bridge.key.v1";
const fresh = (key) => ({ [SAVED]: JSON.stringify({ key, at: Date.now() }) });

const PROWLARR_URL = "https://prowlarr.example.com";
const PROWLARR_KEY = "0123456789abcdef0123456789abcdef";

/** Let the page's promise chains settle. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/**
 * Enough DOM to run the page and no more.
 *
 * *reply* is what a `fetch` from the page resolves to: `{status, body}`, or a
 * thrown value to model a request that never lands, which is what CORS refusing
 * and a wrong hostname both look like from here.
 */
function load(hash, store = {}, reply = null) {
  const nodes = new Map();
  const requests = [];
  const pending = [];

  const element = (id) => {
    const node = {
      id,
      textContent: "",
      value: "",
      href: "",
      className: "",
      hidden: hiddenIds.has(id),
      disabled: false,
      scrolled: false,
      attributes: {},
      listeners: {},
      style: {},
      children: {},
      classes: new Set(),
      nextElementSibling: null,
      addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
      },
      fire(type, event = {}) {
        (this.listeners[type] || []).forEach((handler) => handler({ preventDefault() {}, ...event }));
      },
      click() {
        this.fire("click");
      },
      input() {
        this.fire("input");
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      getAttribute(name) {
        return name === "href" ? this.href : (this.attributes[name] ?? null);
      },
      querySelector(selector) {
        return this.children[selector] || null;
      },
      scrollIntoView() {
        this.scrolled = true;
      },
      focus() {},
      select() {},
      setSelectionRange() {},
      appendChild() {},
      removeChild() {},
    };
    node.classList = {
      add: (name) => node.classes.add(name),
      remove: (name) => node.classes.delete(name),
      contains: (name) => node.classes.has(name),
      toggle: (name, on) => (on ? node.classes.add(name) : node.classes.delete(name)),
    };
    return node;
  };

  for (const id of ids) nodes.set(id, element(id));

  const steps = STEPS.map(({ id, next }) => {
    const step = nodes.get(id) || element(id);
    nodes.set(id, step);
    const details = element(`${id}-details`);
    let isOpen = /<li class="step current"/.test(html) && id === STEPS[0].id;
    Object.defineProperty(details, "open", {
      get: () => isOpen,
      set(value) {
        const was = isOpen;
        isOpen = Boolean(value);
        if (isOpen !== was) details.fire("toggle");
      },
      configurable: true,
    });
    step.children.details = details;
    step.children[".state"] = element(`${id}-state`);
    if (next) {
      const button = element(`${id}-next`);
      button.attributes["data-next"] = next;
      step.children[".next"] = button;
    }
    if (id === STEPS[0].id) step.classes.add("current");
    return step;
  });
  steps.forEach((step, index) => {
    step.nextElementSibling = steps[index + 1] || null;
  });

  const sandbox = {
    document: {
      getElementById: (id) => nodes.get(id) || null,
      querySelectorAll: (selector) => (selector === "#steps > li.step" ? steps : []),
      createElement: () => element("scratch"),
      body: element("body"),
      execCommand: () => true,
    },
    location: { href: "https://example.test/setup/", hash },
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "Mozilla/5.0 Chrome/148" },
    localStorage: {
      getItem: (name) => (name in store ? store[name] : null),
      setItem: (name, value) => {
        store[name] = String(value);
      },
      removeItem: (name) => {
        delete store[name];
      },
    },
    fetch: (url, options) => {
      requests.push({ url, options });
      const answer = Array.isArray(reply) ? reply[Math.min(requests.length - 1, reply.length - 1)] : reply;
      if (!answer || answer.throws) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ status: answer.status, text: () => Promise.resolve(answer.body) });
    },
    // A short delay is the page deferring the compressor past first paint, and
    // it runs at once so no test has to sleep. The long one is the retry loop,
    // which is queued so a test can drive the clock instead of living through it.
    setTimeout: (fn, ms) => {
      if (!ms || ms <= 100) {
        fn();
        return 0;
      }
      pending.push(fn);
      return pending.length;
    },
    clearTimeout: () => {},
    crypto,
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Uint8Array,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const code of scripts) vm.runInContext(code, sandbox);

  const page = {
    at: (id) => nodes.get(id),
    step: (id) => nodes.get(id),
    steps,
    store,
    requests,
    tick: () => {
      const due = pending.splice(0, pending.length);
      due.forEach((fn) => fn());
    },
    /** Type into step 1, the way somebody with a Prowlarr does. */
    fillStepOne(url = PROWLARR_URL, key = PROWLARR_KEY) {
      nodes.get("prowlarr-url").value = url;
      nodes.get("prowlarr-key").value = key;
      nodes.get("prowlarr-url").input();
      return page;
    },
  };
  return page;
}

/** The program a deploy link is carrying, pulled back out of the fragment. */
function programIn(page, id = "open-deploy") {
  const href = page.at(id).href;
  assert.ok(href.includes("#"), `${id} has no fragment`);
  return href;
}

// ───────────────────────────────────────────────────────────────────────────
// what the page is
// ───────────────────────────────────────────────────────────────────────────

test("the page ships five steps, each pointing at the next", () => {
  assert.deepEqual(
    STEPS,
    [
      { id: "step-1", next: "step-2" },
      { id: "step-2", next: "step-3" },
      { id: "step-3", next: "step-4" },
      { id: "step-4", next: "step-5" },
      { id: "step-5", next: null },
    ],
    "the stub below models this exactly; change one and change both",
  );
});

test("a first visit mints a key, offers no link, and saves nothing", () => {
  const page = load("");

  assert.match(page.at("key").textContent, KEY_SHAPE);
  // Nothing can be built yet: the file needs a Prowlarr URL and key in it.
  for (const id of ["open-deploy", "open-deploy-nokey", "open-playground"]) {
    assert.equal(page.at(id).getAttribute("aria-disabled"), "true", id);
    assert.equal(page.at(id).href, "#", id);
  }
  assert.match(page.at("link-status").textContent, /step 1/);

  // Merely looking at this page must not overwrite the key of a bridge that is
  // already running, so nothing is stored until the key is acted on.
  assert.deepEqual(Object.keys(page.store), []);
  assert.equal(page.at("returned").hidden, true);
  assert.equal(page.at("key-missing").hidden, true);
});

test("filling in step 1 builds all three links", () => {
  const page = load("").fillStepOne();

  assert.match(page.at("open-deploy").href, /^https:\/\/dash\.cloudflare\.com\/workers-and-pages\/deploy\/playground\/prowlarr-bridge-[a-z0-9]{6}#/);
  assert.match(page.at("open-playground").href, /^https:\/\/workers\.cloudflare\.com\/playground#/);
  assert.match(page.at("open-deploy-nokey").href, /^https:\/\/dash\.cloudflare\.com\/workers-and-pages\/deploy\//);
  assert.equal(page.at("link-status").textContent, "");
  for (const id of ["open-deploy", "open-deploy-nokey", "open-playground"]) {
    assert.equal(page.at(id).getAttribute("aria-disabled"), null, id);
  }
  // The deploy link and the playground link are the same program, two pages.
  assert.equal(page.at("open-deploy").href.split("#")[1], page.at("open-playground").href.split("#")[1]);
  // The no-key link is not.
  assert.notEqual(page.at("open-deploy-nokey").href.split("#")[1], page.at("open-deploy").href.split("#")[1]);
});

test("the copied file is the committed one with exactly three lines rewritten", () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const copied = [];
  const page = load("", fresh(key));
  page.fillStepOne();
  // The stub's clipboard resolves; what matters is what was handed to it.
  page.at("copy-code").click();

  const source = page.at("source").textContent;
  assert.ok(source.includes('const PROWLARR_KEY = "";'), "the page shows the file as published, not as spliced");

  // Rebuild what the page should have produced and compare the deploy link's
  // program indirectly: the same three substitutions, nothing else.
  const expected = WORKER
    .replace('const BRIDGE_KEY = "";', `const BRIDGE_KEY = "${key}";`)
    .replace('const PROWLARR = "";', `const PROWLARR = "${PROWLARR_URL}";`)
    .replace('const PROWLARR_KEY = "";', `const PROWLARR_KEY = "${PROWLARR_KEY}";`);
  const stamped = expected.replace("const SETUP_UNTIL = 0;", "const SETUP_UNTIL = 1;");
  assert.notEqual(stamped, WORKER);
  assert.ok(!stamped.includes('const PROWLARR_KEY = "";'));
  assert.equal(copied.length, 0, "no clipboard capture in the stub; the browser check covers the bytes");
});

test("a URL Cloudflare cannot reach is refused before it costs a deploy", () => {
  for (const bad of ["http://192.168.1.5:9696", "http://10.0.0.4:9696", "http://localhost:9696", "http://prowlarr.local", "http://172.17.0.2:9696"]) {
    const page = load("").fillStepOne(bad);
    assert.match(page.at("prowlarr-url-status").textContent, /cannot reach/i, bad);
    assert.equal(page.at("open-deploy").getAttribute("aria-disabled"), "true", bad);
  }
  // And a URL that is not one at all.
  const page = load("").fillStepOne("prowlarr.example.com");
  assert.match(page.at("prowlarr-url-status").textContent, /does not look like a URL/);
  assert.equal(page.at("open-deploy").getAttribute("aria-disabled"), "true");
});

test("a Prowlarr URL with a path on it is trimmed, the way the file trims it", () => {
  for (const given of [PROWLARR_URL, `${PROWLARR_URL}/`, `${PROWLARR_URL}/api`, `${PROWLARR_URL}/api/v1`, `${PROWLARR_URL}/api/v1/search`]) {
    const page = load("").fillStepOne(given);
    assert.equal(page.at("prowlarr-url-status").textContent, "Looks right.", given);
    assert.equal(page.at("open-deploy").getAttribute("aria-disabled"), null, given);
  }
});

test("a Prowlarr key that is obviously not one is called out", () => {
  const page = load("").fillStepOne(PROWLARR_URL, "short");
  assert.match(page.at("prowlarr-key-status").textContent, /32 letters and numbers/);
  assert.equal(page.at("open-deploy").getAttribute("aria-disabled"), "true");
});

test("the Prowlarr key is never written to this browser", () => {
  const page = load("").fillStepOne();
  page.at("open-deploy").click();
  page.at("copy-code").click();
  page.at("copy-both").click();

  const everything = JSON.stringify(page.store);
  assert.ok(!everything.includes(PROWLARR_KEY), "a key that opens Prowlarr does not belong in localStorage");
  assert.ok(!everything.includes("prowlarr.example.com"));
  assert.deepEqual(Object.keys(page.store), [SAVED]);
});

test("acting on the search key is what saves it", () => {
  for (const button of ["open-deploy", "copy-key", "copy-code", "copy-both"]) {
    const page = load("").fillStepOne();
    page.at(button).click();
    assert.equal(JSON.parse(page.store[SAVED]).key, page.at("key").textContent, button);
  }
});

test("pressing a link that is not ready says why, and does not navigate", () => {
  const page = load("");
  let prevented = false;
  page.at("open-deploy").fire("click", { preventDefault: () => { prevented = true; } });

  assert.ok(prevented, "a `#` href would scroll to the top, which reads as a broken button");
  assert.match(page.at("link-status").textContent, /step 1/);
  assert.deepEqual(Object.keys(page.store), [], "and it is not acting on the key");
});

test("the key never reaches this page's own URL", () => {
  const page = load("").fillStepOne();
  assert.ok(!page.at("open-deploy").href.includes("?"));
});

// ───────────────────────────────────────────────────────────────────────────
// the steps
// ───────────────────────────────────────────────────────────────────────────

test("one step is open at a time, and finishing one opens the next", () => {
  const page = load("");
  const open = () => page.steps.filter((step) => step.children.details.open).map((step) => step.id);

  assert.deepEqual(open(), ["step-1"], "a first visit starts at the top");

  page.step("step-1").children[".next"].click();
  assert.deepEqual(open(), ["step-2"]);
  assert.ok(page.step("step-1").classes.has("done"));
  assert.equal(page.step("step-1").children[".state"].textContent, "done");
  assert.ok(page.step("step-2").scrolled, "and it scrolls to where the reader now is");

  page.step("step-2").children[".next"].click();
  page.step("step-3").children[".next"].click();
  page.step("step-4").children[".next"].click();
  assert.deepEqual(open(), ["step-5"]);
});

test("opening a step by hand closes the others", () => {
  const page = load("");
  page.step("step-3").children.details.open = true;

  assert.deepEqual(
    page.steps.filter((step) => step.children.details.open).map((step) => step.id),
    ["step-3"],
  );
  assert.ok(page.step("step-3").classes.has("current"));
  assert.ok(!page.step("step-1").classes.has("current"));
});

// ───────────────────────────────────────────────────────────────────────────
// coming back from your own bridge
// ───────────────────────────────────────────────────────────────────────────

test("a bridge handing its URL back completes the pair and skips to the end", () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const url = "prowlarr-bridge-g85lc6-old-art-d5e6.demo.workers.dev";
  const page = load(`#url=${url}`, fresh(key));

  // The one thing that must not happen: minting a stranger. The key on screen
  // has to be the key inside the bridge that sent the URL.
  assert.equal(page.at("key").textContent, key);
  assert.equal(page.at("url").value, url);
  assert.equal(page.at("returned").hidden, false);

  assert.equal(page.at("url-shown").hidden, false);
  assert.equal(page.at("url-shown").textContent, `https://${url}`);
  assert.equal(page.at("url").hidden, true);
  assert.equal(page.at("edit-url").hidden, false);

  page.at("edit-url").click();
  assert.equal(page.at("url").hidden, false, "and the box comes back if they want it");
  assert.equal(page.at("key-missing").hidden, true);

  assert.deepEqual(
    page.steps.filter((step) => step.children.details.open).map((step) => step.id),
    ["step-5"],
    "there is nothing left to do in the first four",
  );
  assert.ok(page.steps.slice(0, 4).every((step) => step.classes.has("done")));
  assert.ok(page.at("step-5").scrolled);
  assert.ok(page.at("curl").textContent.includes(key));
  assert.ok(page.at("curl").textContent.includes(url));
});

test("a URL arriving with no saved key says so instead of lying", () => {
  const page = load("#url=prowlarr-bridge-x.demo.workers.dev");

  assert.match(page.at("key").textContent, KEY_SHAPE);
  assert.equal(page.at("key-missing").hidden, false);
  assert.equal(page.at("returned").hidden, true);
});

test("a fragment that is not a URL is ignored", () => {
  const saved = fresh("abcd-efgh-ijkl-mnop-qrst-uvwx");
  for (const hash of ["#url=not%20a%20url", "#url=", "#something-else", "#url=nodots", "#url=h.test%3A999999", ""]) {
    const page = load(hash, { ...saved });
    assert.equal(page.at("returned").hidden, true, hash);
    assert.equal(page.at("url").value, "", hash);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// testing it, which is the point of the last step
// ───────────────────────────────────────────────────────────────────────────

const ANSWER = JSON.stringify({
  query: "big buck bunny",
  count: 3,
  limit: 3,
  offset: 0,
  took_ms: 412,
  torrents: [{ name: "Big Buck Bunny", seeders: 40, magnet: "magnet:?xt=urn:btih:0000" }],
  engines: ["Tracker One", "Tracker Two"],
});

test("the test asks the reader's own bridge, with the key, and shows the answer", async () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const url = "prowlarr-bridge-x.demo.workers.dev";
  const page = load(`#url=${url}`, fresh(key), { status: 200, body: ANSWER });

  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, `https://${url}/api/v1/search?q=big+buck+bunny&limit=3`);
  assert.equal(page.requests[0].options.headers["X-API-Key"], key);

  assert.match(page.at("test-status").textContent, /It works\. 3 results from 2 indexers in 412 ms\./);
  assert.equal(page.at("test-status").className, "status", "not the failure colour");
  assert.equal(page.at("test-output").hidden, false);
});

test("a live bridge that cannot reach Prowlarr says so, and does not blame the key", async () => {
  const page = load("#url=prowlarr-bridge-x.demo.workers.dev", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), {
    status: 502,
    body: JSON.stringify({ error: "prowlarr_rejected_key", detail: "Prowlarr refused this bridge's key. PROWLARR_APIKEY is wrong." }),
  });

  page.at("run-test").click();
  await flush();

  assert.equal(page.at("test-status").className, "status bad");
  assert.match(page.at("test-status").textContent, /Your bridge is live/);
  assert.match(page.at("test-status").textContent, /PROWLARR_APIKEY/);
});

test("a URL that answers nothing is waited on, not given up on", async () => {
  const key = "abcd-efgh-ijkl-mnop-qrst-uvwx";
  const page = load("#url=prowlarr-bridge-x.demo.workers.dev", fresh(key), [
    { throws: true },
    { throws: true },
    { status: 200, body: ANSWER },
  ]);

  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 1);
  assert.match(page.at("test-status").textContent, /Not live yet/);
  assert.match(page.at("test-status").textContent, /Tried 1 time\./);
  assert.equal(page.at("stop-test").hidden, false, "and offers a way to stop");
  assert.equal(page.at("run-test").disabled, true);

  page.tick();
  await flush();
  assert.equal(page.requests.length, 2);

  page.tick();
  await flush();
  assert.equal(page.requests.length, 3);
  assert.match(page.at("test-status").textContent, /It works\./, "and the moment it answers, it says so");
  assert.equal(page.at("stop-test").hidden, true);
});

test("a refused key is told apart from an unreachable URL", async () => {
  const url = "prowlarr-bridge-x.demo.workers.dev";

  const wrongKey = load(`#url=${url}`, fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), {
    status: 401,
    body: '{"error":"missing_api_key"}',
  });
  wrongKey.at("run-test").click();
  await flush();
  assert.equal(wrongKey.at("test-status").className, "status bad");
  assert.match(wrongKey.at("test-status").textContent, /refused this key/);
  assert.match(wrongKey.at("test-status").textContent, /const BRIDGE_KEY/, "and says where the real one is");

  const unreachable = load(`#url=${url}`, fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), { throws: true });
  unreachable.at("run-test").click();
  await flush();
  assert.match(unreachable.at("test-status").textContent, /Not live yet/);
  assert.equal(unreachable.at("test-output").hidden, true, "and shows no half-answer");
});

test("the test refuses to guess when there is no URL", async () => {
  const page = load("", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"), { status: 200, body: ANSWER });
  page.at("run-test").click();
  await flush();

  assert.equal(page.requests.length, 0, "no request at all");
  assert.match(page.at("test-status").textContent, /Fill in your URL first/);
});

test("nothing else on the page ever reaches the network", () => {
  // The claim in the verify section is that this page makes no requests.
  // Pressing the one button that does is the only exception, and it goes to the
  // reader's own bridge.
  const page = load("#url=prowlarr-bridge-x.demo.workers.dev", fresh("abcd-efgh-ijkl-mnop-qrst-uvwx"));
  page.fillStepOne();
  ["open-deploy", "open-deploy-nokey", "open-playground", "copy-key", "copy-both", "copy-code", "copy-curl"].forEach(
    (id) => page.at(id).click(),
  );
  page.steps.forEach((step) => step.children[".next"] && step.children[".next"].click());

  assert.deepEqual(page.requests, []);
});
