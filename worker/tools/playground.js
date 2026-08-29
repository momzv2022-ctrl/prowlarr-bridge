/**
 * Put a program into a Cloudflare Workers playground URL.
 *
 * The playground keeps whatever it is showing in the URL **fragment** — the
 * `#…` part, which a browser never sends to a server. So a link generated here
 * carries the program *and* the API key baked into it without either reaching
 * Cloudflare on page load. That is what lets the setup page hand somebody a
 * single link instead of a copy button and a paste into a code editor, which is
 * the one step that is genuinely bad on a phone.
 *
 * ## The format
 *
 * Undocumented, and read off a real playground link rather than guessed:
 *
 *     #<lz-string compressToEncodedURIComponent of>
 *         "multipart/form-data; boundary=----WebKitFormBoundary<16 random>"
 *         ":"
 *         <that multipart body>
 *
 * The body is the same shape as Cloudflare's Workers upload API: one part per
 * module, then a `metadata` part naming `main_module`. `worker/tests/parity/`
 * has the captured link this was derived from, and the test suite regenerates it
 * byte for byte from its own parts — which is the only reason to trust any of
 * this, since the format can change whenever Cloudflare likes.
 *
 * **The setup page inlines this file**, so it is written to run unchanged in a
 * browser and in Node: no imports, no Node globals, nothing but `crypto` for the
 * boundary.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
const BITS_PER_CHAR = 6;

/**
 * Pieroxy's LZ-String 1.5.0 `compressToEncodedURIComponent` (MIT),
 * reimplemented rather than vendored because this repository carries no
 * third-party code. LZW with a variable code width, packed six bits to a
 * character into a URL-safe alphabet.
 *
 * `worker/tools/playground-link.mjs --self-test` pins it to the reference
 * library's own output.
 */
export function compressToEncodedURIComponent(input) {
  if (input === null || input === undefined) return "";

  const dictionary = new Map();
  const pending = new Set();
  const output = [];

  let w = "";
  let enlargeIn = 2; // compensates for the first entry, which should not count
  let dictSize = 3;
  let numBits = 2;
  let value = 0;
  let position = 0;

  const writeBit = (bit) => {
    value = (value << 1) | bit;
    if (position === BITS_PER_CHAR - 1) {
      position = 0;
      output.push(ALPHABET[value]);
      value = 0;
    } else {
      position += 1;
    }
  };

  /** *count* bits of *number*, least significant first — LZ-String's order. */
  const writeReversed = (number, count) => {
    let remaining = number;
    for (let index = 0; index < count; index += 1) {
      writeBit(remaining & 1);
      remaining >>= 1;
    }
  };

  const writeRepeated = (bit, count) => {
    for (let index = 0; index < count; index += 1) writeBit(bit);
  };

  const emit = (word) => {
    if (pending.has(word)) {
      const code = word.charCodeAt(0);
      if (code < 256) {
        writeRepeated(0, numBits); // an 8-bit literal follows
        writeReversed(code, 8);
      } else {
        writeBit(1); // a 16-bit literal follows
        writeRepeated(0, numBits - 1);
        writeReversed(code, 16);
      }
      enlargeIn -= 1;
      if (enlargeIn === 0) {
        enlargeIn = 2 ** numBits;
        numBits += 1;
      }
      pending.delete(word);
    } else {
      writeReversed(dictionary.get(word), numBits);
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const c = input.charAt(index);
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize);
      dictSize += 1;
      pending.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
      continue;
    }
    emit(w);
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits += 1;
    }
    dictionary.set(wc, dictSize);
    dictSize += 1;
    w = c;
  }

  if (w !== "") {
    emit(w);
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits += 1;
    }
  }

  writeReversed(2, numBits); // end of stream

  for (;;) {
    value <<= 1;
    if (position === BITS_PER_CHAR - 1) {
      output.push(ALPHABET[value]);
      break;
    }
    position += 1;
  }

  return output.join("");
}

/**
 * A boundary in the shape the playground itself uses. The name is WebKit's, and
 * copying it is deliberate: the fewer things that differ from a link the
 * playground made itself, the fewer things there are to be picky about.
 */
export function randomBoundary() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (let index = 0; index < bytes.length; index += 1) suffix += alphabet[bytes[index] % 62];
  return "----WebKitFormBoundary" + suffix;
}

/**
 * The uncompressed payload: a content-type value, a colon, and a multipart body.
 *
 * *modules* is `[{name, content, type}]` in the order they should appear;
 * `metadata` is appended last, as the playground does it.
 */
export function playgroundPayload(modules, metadata, boundary) {
  for (const module of modules) {
    if (module.content.includes(boundary)) throw new Error("boundary appears in the content");
  }

  const part = (name, filename, type, content) =>
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n` +
    `${content}\r\n`;

  const body =
    modules.map((m) => part(m.name, m.name, m.type, m.content)).join("") +
    part("metadata", "blob", "application/json", JSON.stringify(metadata)) +
    `--${boundary}--\r\n`;

  return `multipart/form-data; boundary=${boundary}:${body}`;
}

/**
 * The compatibility settings a live playground link was observed to carry.
 *
 * Read off the playground's own Deploy button on **2026-08-18**: it sends the
 * day's date and `nodejs_compat`. Both are copied here for the same reason the
 * boundary is shaped like WebKit's — the fewer things that differ from a link
 * the playground made itself, the fewer things there are for the deploy screen
 * to be picky about.
 *
 * The date is **pinned rather than computed from the clock**, which is the one
 * place this deliberately does not match. A compatibility date exists to hold
 * runtime behaviour still; a date taken from `Date.now()` in the reader's
 * browser would make two people deploying the same file get two different
 * runtimes, and a device with a wrong clock get one Cloudflare rejects. So it
 * moves when someone re-checks the live link and moves it — see
 * `docs/deploy-link.md`.
 */
export const COMPATIBILITY_DATE = "2026-08-18";
export const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * A playground URL for one ES-module Worker.
 *
 * The module is called `index.js` and the compatibility settings are the ones
 * above, both because they are what a playground link was observed to contain.
 * Every avoidable difference from the observed shape is one avoidable way to be
 * wrong — see `docs/deploy-link.md`.
 */
export function playgroundLink(source, options = {}) {
  return "https://workers.cloudflare.com/playground#" + encodedWorker(source, options);
}

/** The fragment both links share: one ES-module Worker, compressed. */
function encodedWorker(source, options) {
  const boundary = options.boundary || randomBoundary();
  const payload = playgroundPayload(
    [{ name: "index.js", content: source, type: "application/javascript+module" }],
    {
      compatibility_date: options.compatibilityDate || COMPATIBILITY_DATE,
      compatibility_flags: options.compatibilityFlags || [...COMPATIBILITY_FLAGS],
      main_module: "index.js",
    },
    boundary,
  );
  return compressToEncodedURIComponent(payload);
}

/**
 * What to put in the Name field, since the link has to put something.
 *
 * Not a security measure, and the page no longer pretends it is one: names are
 * scoped to an account, so a constant would not collide between people anyway,
 * and Cloudflare appends words of its own regardless — `utsi-g85lc6` came back
 * as `utsi-g85lc6-old-art-d5e6`. The prefix is here so the Worker is
 * recognisable in a list; the six characters are free and do no harm.
 */
export function suggestedName() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (let index = 0; index < bytes.length; index += 1) suffix += alphabet[bytes[index] % 36];
  return "prowlarr-bridge-" + suffix;
}

/**
 * A link that goes straight to Cloudflare's deploy screen, skipping the editor.
 *
 * Same fragment as `playgroundLink`, different page. The playground is a code
 * editor that happens to have a Deploy button; this is the thing that button
 * goes to, so a link pointing here removes a step and a whole surface that can
 * fail — and it *has* failed, blank-paging for reasons that turned out to live
 * in one browser profile rather than in the payload.
 *
 * The trailing path segment is the Worker's name, which Cloudflare pre-fills and
 * the person deploying can still change.
 *
 * What this loses is the preview: the playground runs the program before you
 * commit to it, and this does not. That is a real trade and it is why both
 * functions exist.
 */
export function deployLink(source, options = {}) {
  return bothLinks(source, options).deploy;
}

/**
 * Both links, and the name, from **one** pass of the compressor.
 *
 * The setup page offers the deploy screen and the playground, and compressing
 * 120 KB twice to say the same thing twice is a second of a phone appearing to
 * have frozen. The fragment is identical either way — that is the whole point of
 * the deploy link — so it is built once and pointed at two pages.
 */
export function bothLinks(source, options = {}) {
  const name = options.name || suggestedName();
  const fragment = encodedWorker(source, options);
  return {
    name,
    deploy:
      "https://dash.cloudflare.com/workers-and-pages/deploy/playground/" +
      encodeURIComponent(name) +
      "#" +
      fragment,
    playground: "https://workers.cloudflare.com/playground#" + fragment,
  };
}
