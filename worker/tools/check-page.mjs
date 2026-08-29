/**
 * Open the built setup page in a real browser, at phone sizes, and check the
 * things that are easy to claim and easy to break.
 *
 *     node worker/tools/build.mjs
 *     node worker/tools/check-page.mjs
 *
 * "Mobile-first" is not a design opinion here, it is a list of assertions:
 *
 *   1. the page never scrolls sideways, at 320 CSS pixels wide;
 *   2. wide things, the file and the curl line, scroll inside their own box;
 *   3. every button and disclosure is at least 32 pixels tall;
 *   4. the key is legible without pinch-zoom, and so is anything you type into;
 *   5. the steps advance one at a time and only one is ever open;
 *   6. the deploy link is inert until step 1 is filled in, and says why;
 *   7. a URL Cloudflare cannot reach is refused before it can waste a deploy;
 *   8. the copy button yields the file with *this* browser's three settings
 *      spliced in, byte for byte.
 *
 * And one that is not about layout at all: **the page must make no network
 * request.** It is a page that asks for a key opening somebody's whole
 * Prowlarr; anything it fetched would be something to explain.
 *
 * It needs a Chromium. `playwright-core` and a browser path, in this order:
 * `$PLAYWRIGHT_CHROMIUM`, then the usual `$PLAYWRIGHT_BROWSERS_PATH` layout,
 * then whatever `playwright` bundles. With neither, it says so and exits 0 — a
 * developer without a browser installed should not be blocked, but CI runs it
 * with one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { playgroundLink } from "./playground.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PAGE = pathToFileURL(join(REPO, "site", "index.html")).href;
const WORKER = readFileSync(join(REPO, "worker", "src", "worker.js"), "utf8");

/** Fixed, so the browser's link and this process's link are comparable at all. */
const FIXED_BOUNDARY = "----WebKitFormBoundaryPageCheck00";

const PROWLARR_URL = "https://prowlarr.example.com";
const PROWLARR_KEY = "0123456789abcdef0123456789abcdef";

const KEY_SHAPE = /^[a-z2-9]{4}(-[a-z2-9]{4}){5}$/;

const VIEWPORTS = [
  { name: "smallest phone still in use", width: 320, height: 568, scheme: "light" },
  { name: "typical Android phone", width: 360, height: 800, scheme: "dark" },
  { name: "recent iPhone", width: 393, height: 852, scheme: "light" },
  { name: "tablet, portrait", width: 768, height: 1024, scheme: "dark" },
  { name: "desktop", width: 1440, height: 900, scheme: "light" },
];

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium")) continue;
      for (const binary of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const candidate = join(root, entry, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

let chromium = null;
let bringsItsOwnBrowser = false;
try {
  ({ chromium } = await import("playwright"));
  bringsItsOwnBrowser = true;
} catch {
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.log("skipped: no playwright installed (npm i -D playwright-core)");
    process.exit(0);
  }
}

const executablePath = findChromium();
if (!executablePath && !bringsItsOwnBrowser) {
  console.log("skipped: no chromium found (set PLAYWRIGHT_CHROMIUM to one)");
  process.exit(0);
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(`  ✗ ${message}`);
};

for (const viewport of VIEWPORTS) {
  const phone = viewport.width < 800;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: viewport.scheme,
    permissions: ["clipboard-read", "clipboard-write"],
    hasTouch: phone,
    isMobile: phone,
    deviceScaleFactor: phone ? 3 : 1,
  });
  const page = await context.newPage();

  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const offsite = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("file://")) offsite.push(request.url());
  });

  await page.goto(PAGE);
  await page.waitForFunction(() =>
    /^[a-z2-9]{4}(-[a-z2-9]{4}){5}$/.test(document.getElementById("key").textContent),
  );

  console.log(`\n${viewport.name} — ${viewport.width}×${viewport.height}, ${viewport.scheme}`);
  if (problems.length) fail(`script errors: ${problems.join(" | ")}`);

  // Nothing has been filled in, so there is nothing to deploy and the button
  // must say so rather than looking ready and going nowhere.
  const before = await page.evaluate(() => ({
    disabled: document.getElementById("open-deploy").getAttribute("aria-disabled"),
    href: document.getElementById("open-deploy").getAttribute("href"),
    status: document.getElementById("link-status").textContent,
  }));
  if (before.disabled !== "true" || before.href !== "#") {
    fail(`the deploy button is live before step 1 is filled in: ${JSON.stringify(before)}`);
  }
  if (!before.status.trim()) fail("the deploy button is inert and says nothing about why");

  const layout = await page.evaluate(() => {
    /** Overflow is only a bug when nothing between here and the body scrolls. */
    const contained = (element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      escaping: [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !contained(el))
        .map((el) => `${el.tagName}${el.id ? "#" + el.id : ""}`),
      scrollers: [...document.querySelectorAll("pre")].filter(
        (el) => getComputedStyle(el).overflowX !== "visible",
      ).length,
      small: [...document.querySelectorAll("button, summary")]
        .map((el) => ({ text: (el.textContent || "").trim().slice(0, 30), height: el.getBoundingClientRect().height }))
        .filter((el) => el.height > 0 && el.height < 32),
      key: (() => {
        const el = document.getElementById("key");
        return { text: el.textContent, fontSize: parseFloat(getComputedStyle(el).fontSize) };
      })(),
      // Below 16px iOS zooms the page the moment a box takes focus, which moves
      // the layout under someone in the middle of pasting into it.
      tinyInputs: [...document.querySelectorAll("input")]
        .map((el) => ({ id: el.id, fontSize: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((el) => el.fontSize < 16),
    };
  });

  if (layout.documentWidth > layout.viewportWidth) {
    fail(`the page scrolls sideways: ${layout.documentWidth}px of content in ${layout.viewportWidth}px`);
  }
  if (layout.escaping.length) fail(`outside the viewport and not in a scroller: ${layout.escaping.join(", ")}`);
  if (!layout.scrollers) fail("no <pre> has its own horizontal scroller");
  if (layout.small.length) fail(`tap targets under 32px: ${JSON.stringify(layout.small)}`);
  if (layout.key.fontSize < 16) fail(`the key is ${layout.key.fontSize}px, which needs pinch-zoom`);
  if (layout.tinyInputs.length) {
    fail(`inputs under 16px, so iOS zooms on focus: ${JSON.stringify(layout.tinyInputs)}`);
  }
  if (!KEY_SHAPE.test(layout.key.text)) fail(`the key looks wrong: ${layout.key.text}`);
  console.log(
    `  ✓ no sideways scroll · ${layout.scrollers} scrolling code blocks · ` +
      `key ${layout.key.fontSize.toFixed(0)}px · every target ≥ 32px`,
  );

  // A URL on a home network is the one mistake this page can catch before it
  // costs somebody a deploy and a confusing error two screens later.
  await page.fill("#prowlarr-url", "http://192.168.1.5:9696");
  await page.fill("#prowlarr-key", PROWLARR_KEY);
  await page.waitForTimeout(150);
  const refused = await page.evaluate(() => ({
    status: document.getElementById("prowlarr-url-status").textContent,
    disabled: document.getElementById("open-deploy").getAttribute("aria-disabled"),
  }));
  if (refused.disabled !== "true" || !/cannot reach/i.test(refused.status)) {
    fail(`a private URL was accepted: ${JSON.stringify(refused)}`);
  }
  console.log("  ✓ a URL Cloudflare cannot reach is refused, with a reason");

  await page.fill("#prowlarr-url", PROWLARR_URL);
  await page.waitForFunction(
    () => document.getElementById("open-deploy").getAttribute("aria-disabled") === null,
    { timeout: 20000 },
  );

  // The steps are an accordion, and walking it is both how the checks below
  // reach step 5 and a test of the accordion itself.
  const openSteps = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#steps > li.step")]
        .filter((step) => step.querySelector("details").open)
        .map((step) => step.id),
    );

  const atFirst = await openSteps();
  if (JSON.stringify(atFirst) !== '["step-1"]') {
    fail(`a first visit opens ${JSON.stringify(atFirst)} rather than step 1 alone`);
  }
  for (const [from, to] of [["step-1", "step-2"], ["step-2", "step-3"], ["step-3", "step-4"], ["step-4", "step-5"]]) {
    await page.click(`#${from} .next`);
    await page.waitForFunction((id) => document.querySelector(`#${id} details`).open, to);
  }
  const atEnd = await openSteps();
  if (JSON.stringify(atEnd) !== '["step-5"]') fail(`after walking the steps, ${JSON.stringify(atEnd)} are open`);
  console.log("  ✓ the steps advance one at a time, and only one is ever open");

  // Everything outside a step is an ordinary disclosure. Step 5 is open, so the
  // ones inside it are reachable too.
  await page.evaluate(() => {
    for (const details of document.querySelectorAll("details")) {
      if (!details.parentElement.closest("#steps > li.step")) details.open = true;
    }
  });
  await page.click("#copy-code");
  await page.waitForFunction(() => document.getElementById("code-status").textContent !== "");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The page writes four things into the file. Three are known here; the fourth
  // is a clock reading, so it is taken from what was copied and then checked.
  const stamped = /^const SETUP_UNTIL = (\d+);$/m.exec(copied);
  if (!stamped) fail("the copied file has no SETUP_UNTIL line");
  else if (Number(stamped[1]) <= Date.now()) fail(`the setup window is already over: ${stamped[1]}`);
  const expected = WORKER
    .replace('const BRIDGE_KEY = "";', `const BRIDGE_KEY = ${JSON.stringify(layout.key.text)};`)
    .replace('const PROWLARR = "";', `const PROWLARR = ${JSON.stringify(PROWLARR_URL)};`)
    .replace('const PROWLARR_KEY = "";', `const PROWLARR_KEY = ${JSON.stringify(PROWLARR_KEY)};`)
    .replace("const SETUP_UNTIL = 0;", `const SETUP_UNTIL = ${stamped ? stamped[1] : 0};`);
  if (copied !== expected) {
    fail(`the copy button did not yield the program with the settings in it (${copied.length} vs ${expected.length})`);
  } else {
    console.log(`  ✓ copied ${copied.length.toLocaleString()} characters, all three settings spliced in exactly`);
  }

  await page.click("#copy-key");
  await page.waitForFunction(() => document.getElementById("key-status").textContent !== "");
  const copiedKey = await page.evaluate(() => navigator.clipboard.readText());
  if (copiedKey !== layout.key.text) fail("the key button copied something else");

  // The playground link: the page inlines `worker/tools/playground.js`, so the
  // copy running in the browser has to produce the same bytes as the module
  // this process imported.
  const href = await page.getAttribute("#open-playground", "href");
  if (!href.startsWith("https://workers.cloudflare.com/playground#")) {
    fail(`the playground link points at ${href.slice(0, 60)}`);
  }
  const inBrowser = await page.evaluate(
    ([program, boundary]) => playgroundLink(program, { boundary }),
    [expected, FIXED_BOUNDARY],
  );
  if (inBrowser !== playgroundLink(expected, { boundary: FIXED_BOUNDARY })) {
    fail("the page's inlined copy of playground.js disagrees with the module");
  }
  // The two differ because the real link has a random boundary and a random key
  // in it, and lz-string's output size depends on what it is compressing. The
  // exact byte count is pinned by the equality check above; this only catches
  // the page building something *wildly* different.
  if (Math.abs(href.length - inBrowser.length) > 500) {
    fail(`the real link is ${href.length} but a fixed-boundary one is ${inBrowser.length}`);
  }
  console.log(`  ✓ playground link ${href.length.toLocaleString()} characters, matches the module`);

  // The deploy link is the button people actually press. Its fragment must be
  // *identical* to the playground link's: same program, two destinations.
  const deployHref = await page.getAttribute("#open-deploy", "href");
  const deployBase = "https://dash.cloudflare.com/workers-and-pages/deploy/playground/";
  if (!deployHref.startsWith(deployBase)) fail(`the deploy link points at ${deployHref.slice(0, 70)}`);
  const [deployPath, deployFragment] = deployHref.slice(deployBase.length).split("#");
  if (deployFragment !== href.split("#")[1]) {
    fail("the deploy link and the playground link carry different programs");
  }
  if (!/^prowlarr-bridge-[a-z0-9]{6}$/.test(deployPath)) {
    fail(`the deploy link's worker name is ${JSON.stringify(deployPath)}`);
  }
  // Small enough for every browser, Safari included, which is the one thing
  // this file gets for free by being a tenth the size of its sibling.
  if (deployHref.length > 78000) {
    fail(`the deploy link is ${deployHref.length} characters, which Safari will refuse`);
  }
  console.log(`  ✓ deploy link → ${deployPath}, ${deployHref.length.toLocaleString()} characters, fits every browser`);

  // The second route: the same program with the Prowlarr key left out, for
  // somebody who would rather add it in the dashboard.
  const noKey = await page.getAttribute("#open-deploy-nokey", "href");
  const withoutKey = await page.evaluate(
    ([link]) => {
      const fragment = link.split("#")[1];
      return fragment;
    },
    [noKey],
  );
  if (!noKey.startsWith(deployBase) || withoutKey === deployFragment) {
    fail("the no-key deploy link carries the same program as the full one");
  }
  console.log("  ✓ the no-key route deploys a different program");

  // The URL box: the one thing this page cannot work out for itself.
  const commandFor = async (typed) => {
    await page.fill("#url", typed);
    return page.textContent("#curl");
  };
  const host = "prowlarr-bridge-ab12.example.workers.dev";
  for (const typed of [host, `https://${host}`, `https://${host}/healthz`, `  ${host}/  `]) {
    const command = await commandFor(typed);
    if (!command.includes(`https://${host}/api/v1/search`) || !command.includes(layout.key.text)) {
      fail(`the URL box made ${JSON.stringify(command.slice(0, 90))} of ${JSON.stringify(typed)}`);
    }
  }
  const rubbish = await commandFor("not a url");
  if (!rubbish.includes("your-url.workers.dev")) {
    fail("the URL box put something that is not a URL into the command");
  }
  await page.fill("#url", "");
  console.log("  ✓ the URL box fills the command in, and refuses what is not a URL");

  // The way down to the verify section has to exist and has to land on
  // something. A link to an id that is not there scrolls nowhere and looks like
  // nothing happened.
  const verify = await page.evaluate(() => {
    const link = document.querySelector("a.verify-first");
    const target = link && document.querySelector(link.getAttribute("href"));
    return {
      landed: Boolean(target),
      belowSteps:
        Boolean(target) &&
        document.getElementById("steps").compareDocumentPosition(target) === Node.DOCUMENT_POSITION_FOLLOWING,
    };
  });
  if (!verify.landed) fail("the verify link lands on nothing");
  if (!verify.belowSteps) fail("the verify section is not below the steps");
  console.log("  ✓ steps first, verify at the foot, and the link reaches it");

  // The claim the whole page rests on. Anything fetched here would be a request
  // made by a page that has just been handed somebody's Prowlarr key.
  if (offsite.length) fail(`the page fetched something: ${offsite.join(", ")}`);
  else console.log("  ✓ not one network request, with every button pressed");

  await context.close();
}

// Two browsers, two keys. A page that handed everyone the same key would be a
// page that handed everyone the same password.
const first = await keyFrom(browser);
const second = await keyFrom(browser);
if (first === second) fail("two visits produced the same key");
else console.log(`\n✓ two visits produce different keys (${first.slice(0, 9)}…, ${second.slice(0, 9)}…)`);

async function keyFrom(instance) {
  const context = await instance.newContext();
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.waitForFunction(() =>
    /^[a-z2-9]{4}(-[a-z2-9]{4}){5}$/.test(document.getElementById("key").textContent),
  );
  const key = await page.textContent("#key");
  await context.close();
  return key;
}

await browser.close();
console.log(failures ? `\n${failures} failed` : "\nthe setup page is fine on every size checked");
process.exit(failures ? 1 : 0);
