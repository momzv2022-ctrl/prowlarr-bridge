/**
 * Prowlarr bridge — one file, no dependencies, two runtimes.
 *
 * Prowlarr already searches your indexers and merges the answers. It speaks its
 * own API, which no streaming client speaks. This translates one to the other:
 * a client asks it for a search, it asks Prowlarr, and it hands back the same
 * JSON shape the Unified Torrent Search Interface produces, so anything that
 * already talks to one talks to this.
 *
 * **What it is for.** Prowlarr's key opens Prowlarr's whole admin interface.
 * This holds that key server-side and never sends it anywhere but Prowlarr, so
 * the thing on your phone gets a read-only search URL and a key of its own that
 * you can change without touching Prowlarr. Nothing else here matters as much
 * as that sentence.
 *
 *   Run it next to Prowlarr:   node worker.js
 *   Run it at Cloudflare:      wrangler deploy worker.js
 *
 * The same file does both. Which one you want depends on where Prowlarr is: a
 * Cloudflare Worker cannot reach a private address, so deploying to Cloudflare
 * means Prowlarr itself needs a public hostname. Running it next to Prowlarr
 * does not, and is the smaller thing to expose. README.md has the two recipes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. settings   — every environment variable, read once
 *   2. helpers    — text, numbers, infohashes, magnets
 *   3. names      — the six fields a release name carries, and its category
 *   4. rows       — merge, filter, sort, and the wire shape
 *   5. prowlarr   — the request out, and the rows back
 *   6. routes     — auth, /api/v1/search, /healthz
 *   7. entry      — Cloudflare, Node, and the test seam
 *
 * Sections 2 to 4 are lifted from that project's Worker unchanged, deliberately:
 * they are what makes a row here and a row there byte-identical, so a client can
 * hold results from both without seeing two of everything.
 */

const VERSION = "0.2.1";

// ── the three values, and where they come from ──────────────────────────────
//
// Each is empty in the published file and each is filled in one of two ways:
// an environment variable, which always wins, or these lines, which the setup
// page rewrites in your browser before it hands you a deploy link.
//
// **The published artifact must ship with all three empty**, and the build
// refuses otherwise. A key committed here by accident would be one key shared
// by everybody who ever used the page.

// What a client sends here, as `X-API-Key`. `BRIDGE_API_KEY` wins over it, and
// is how you change this key later without pasting the file again.
const BRIDGE_KEY = "";

// Prowlarr's base URL. `PROWLARR_URL` wins over it.
const PROWLARR = "";

// Prowlarr's own key, which never leaves the server. `PROWLARR_APIKEY` wins.
const PROWLARR_KEY = "";

// How long this bridge should assume it is still being set up, as a millisecond
// timestamp. The setup page writes it at the same moment it writes the three
// values above; the committed file ships with 0, which means never.
//
// Inside the window, a browser opening `/` is almost certainly the person who
// deployed it a minute ago with one instruction left, so the page takes them
// back to finish rather than asking them to press a button that does the same.
// Outside it, opening your own bridge months later gets a page that stays put.
//
// No storage and no cookie: the deadline is a constant in the file, so it
// answers the same for every visitor and expires on its own.
const SETUP_UNTIL = 0;

// Where the setup page lives. A deployed bridge knows its own URL and the setup
// page does not, and cannot: Cloudflare invents the account part of the name.
// That is the whole gap this closes. The page served at `/` links back here
// with `#url=<this host>` on the end, and a fragment is the part of a URL a
// browser never sends to a server, so it reaches that page and nowhere else.
const SETUP_PAGE = "https://momzv2022-ctrl.github.io/prowlarr-bridge/";

// The one origin this bridge answers cross-origin requests from without being
// configured to, so the setup page can run a real search against your bridge
// the moment you deploy it and show you the answer, rather than asking you to
// take "it works" on faith.
//
// Narrow on purpose: an origin is a scheme and a host and nothing else, and a
// `github.io` origin belongs to one account. A caller from it still needs your
// key. BRIDGE_CORS_ORIGINS adds more; nothing removes this one short of
// editing the line.
const SETUP_ORIGIN = new URL(SETUP_PAGE).origin;

// The client's key. Anything shorter is guessable against a URL that answers all
// day, and a bridge is often published on a hostname that exists the moment it
// is made, so this refuses rather than warns.
const MIN_KEY_LENGTH = 16;

// A .torrent is a file from a stranger, fetched to read four fields out of it.
// Real ones are kilobytes; this is the point past which it is not worth knowing.
const TORRENT_MAX_BYTES = 5 * 1024 * 1024;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** The `cat` enum, minus the empty string that means "no filter". */
const CATEGORIES = ["video", "audio", "software", "archive", "document", "image"];

/** The `res` enum. */
const RESOLUTIONS = ["2160p", "1080p", "720p", "480p"];

const SORTS = ["", "seeders", "size", "recent"];

const META_FIELDS = ["year", "resolution", "codec", "source", "season", "episode"];

/**
 * Trackers written into every synthesised magnet.
 *
 * A magnet built from an infohash alone has nowhere to look. These are the same
 * five the sibling project uses, so the two produce identical magnet strings for
 * the same release and a client deduplicates them for free.
 */
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://open.demonii.com:1337/announce",
];

const USER_AGENT = `prowlarr-bridge/${VERSION} (+https://github.com/momzv2022-ctrl/prowlarr-bridge)`;

const WHERE =
  "Set it in the Cloudflare dashboard under Settings, Variables and Secrets, or in the " +
  "environment of the process, and redeploy.";

// ═══════════════════════════════════════════════════════════════════════════
// 1. SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

function envText(env, name, fallback = "") {
  const value = env && env[name];
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function envInt(env, name, fallback, low, high) {
  const text = envText(env, name, String(fallback));
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Math.max(low, Math.min(Number(text), high));
}

function envFlag(env, name, fallback) {
  const raw = envText(env, name, fallback ? "1" : "0").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envList(env, name, fallback = []) {
  const raw = envText(env, name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Paths someone might paste along with their Prowlarr origin. Longest first. */
const PROWLARR_SUFFIXES = ["/api/v1/search", "/api/v1", "/api"];

/** An origin with any trailing path and slash taken off, or "" if unusable. */
function envOrigin(env, name) {
  let raw = envText(env, name).replace(/\/+$/, "");
  const lower = raw.toLowerCase();
  if (!lower.startsWith("https://") && !lower.startsWith("http://")) return "";
  for (const suffix of PROWLARR_SUFFIXES) {
    if (raw.toLowerCase().endsWith(suffix)) {
      raw = raw.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  return raw;
}

/**
 * Every setting this file has, read once per request.
 *
 * Two keys, and keeping them apart is the whole point of the bridge:
 * `BRIDGE_API_KEY` is what a client sends here, `PROWLARR_APIKEY` is what this
 * sends to Prowlarr. The second never leaves the server.
 */
function readSettings(env) {
  return {
    apiKey: envText(env, "BRIDGE_API_KEY") || String(BRIDGE_KEY || "").trim(),
    allowAnonymous: envFlag(env, "BRIDGE_ALLOW_ANONYMOUS", false),
    // See SETUP_ORIGIN: the setup page can test this bridge, nothing else can.
    corsOrigins: [SETUP_ORIGIN, ...envList(env, "BRIDGE_CORS_ORIGINS")],

    prowlarrUrl: envOrigin(env, "PROWLARR_URL") || envOrigin({ PROWLARR }, "PROWLARR"),
    prowlarrApikey: envText(env, "PROWLARR_APIKEY") || String(PROWLARR_KEY || "").trim(),
    // Empty means every enabled indexer. Prowlarr also understands -2 for
    // "all torrent indexers", which is worth knowing but not worth defaulting
    // to: a usenet row is dropped here anyway, by protocol.
    indexerIds: envList(env, "PROWLARR_INDEXER_IDS").filter((id) => /^-?\d+$/.test(id)),

    // A Prowlarr search is a fan-out across every indexer, and the slowest one
    // sets the pace. Prowlarr has its own per-indexer timeouts underneath this;
    // this is the ceiling on the whole answer.
    timeoutS: envInt(env, "BRIDGE_TIMEOUT_S", 45, 5, 120),

    // The ceiling on the per-indexer row count sent to Prowlarr. See
    // rowBudget() for why this is not the client's `limit`.
    maxRows: envInt(env, "BRIDGE_MAX_ROWS", 100, 10, 500),

    // Rows per indexer for a search with no terms in it, which Prowlarr
    // answers by browsing every indexer. Small, because browse returns the
    // latest few and nobody pages deep into it. Zero switches browsing off:
    // an empty search then answers immediately without asking Prowlarr
    // anything, which is the right setting if your client opens on one.
    browseRows: envInt(env, "BRIDGE_BROWSE_ROWS", 25, 0, 200),

    // How many rows of a page may be resolved by fetching their `.torrent` from
    // Prowlarr. This is what makes a private tracker work at all: its releases
    // carry no `magnetUrl` and no `infoHash`, because the file is behind the
    // passkey, so the only way to learn the infohash TSP requires on every row
    // is to read the file. One extra request per row, only for rows the client
    // can actually see, and 0 restores the old behaviour of dropping them.
    maxResolve: envInt(env, "BRIDGE_MAX_RESOLVE", 12, 0, 100),

    // How long a `torrent_url` stays valid. The URL carries a sealed token
    // naming the file to fetch, and the seal expires so a link copied out of a
    // response cannot be replayed indefinitely. Long enough to open a search,
    // read it and press download; short enough not to be a standing grant.
    torrentfileTtlS: envInt(env, "BRIDGE_TORRENTFILE_TTL_S", 3600, 60, 86400),
  };
}

/** Why the key is unusable, or "" when it is fine. */
function keyProblem(settings) {
  if (settings.allowAnonymous) return "";
  if (!settings.apiKey) return "missing";
  return settings.apiKey.length < MIN_KEY_LENGTH ? "short" : "";
}

function isConfigured(settings) {
  return !keyProblem(settings);
}

/** Why Prowlarr cannot be reached at all, or "" when it looks set up. */
function upstreamProblem(settings) {
  if (!settings.prowlarrUrl) return "missing_url";
  if (!settings.prowlarrApikey) return "missing_apikey";
  return "";
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. HELPERS
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything from here to the end of section 4 is a copy of the corresponding
// code in the Unified Torrent Search Interface Worker, unchanged. That is on
// purpose and worth the duplication: it is what makes a row produced here and a
// row produced there the same bytes, down to the percent-encoding in the magnet.

function quote(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function quotePlus(text) {
  return quote(text).replace(/%20/g, "+");
}

/** `{a: "1", b: "x y"}` into `a=1&b=x+y`, in insertion order. */
function urlencode(params) {
  return Object.entries(params)
    .map(([key, value]) => quotePlus(key) + "=" + quotePlus(value))
    .join("&");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

function htmlUnescape(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    return whole;
  });
}

/** A release name as a client should see it. */
function cleanName(value) {
  return htmlUnescape(String(value ?? "")).trim();
}

/**
 * A whole number, or null.
 *
 * Anything that is not a plain non-negative integer is "no value", not zero: a
 * missing seeder count and a count of nought are different facts, and the wire
 * format omits the first rather than lying with the second.
 */
function intOrNone(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

/**
 * The same, but zero also means "no value".
 *
 * Prowlarr sends `size: 0` and `files: 0` for indexers that did not say, rather
 * than omitting the field, so here a nought really is an absence. Seeders and
 * leechers are `int?` and genuinely nullable, so they keep intOrNone and a real
 * zero-seeder row still reports zero.
 */
function positiveOrNone(value) {
  const number = intOrNone(value);
  return number ? number : null;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Prowlarr's `publishDate` as `2019-01-01T00:00:00Z`, or null.
 *
 * It serialises a .NET DateTime, which is already ISO 8601 but carries
 * fractional seconds and sometimes an offset rather than `Z`. Round-tripping it
 * through Date normalises both, so the field matches what the sibling project
 * emits for the same release.
 */
function isoStamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < 0 || ms > 253402300799000) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- infohashes and magnets --------------------------------------------------

const HEX40 = /^[0-9a-fA-F]{40}$/;
const BASE32_32 = /^[A-Za-z2-7]{32}$/;
const BTIH = /urn:btih:([0-9A-Za-z]{32,40})/i;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * A lowercase 40-character hex infohash, or null.
 *
 * Accepts hex and base32, the two encodings BEP-9 magnets use in the wild.
 */
function normalizeInfohash(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (HEX40.test(value)) return value.toLowerCase();
  if (!BASE32_32.test(value)) return null;

  let bits = 0;
  let accumulator = 0;
  let hex = "";
  for (const character of value.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((accumulator >> bits) & 0xff).toString(16).padStart(2, "0");
      accumulator &= (1 << bits) - 1;
    }
  }
  return hex.length === 40 ? hex : null;
}

function infohashFromMagnet(magnet) {
  if (!magnet) return null;
  const match = BTIH.exec(magnet);
  return match ? normalizeInfohash(match[1]) : null;
}

/** The tracker tail never changes, so it is encoded once rather than per row. */
const TRACKER_SUFFIX = DEFAULT_TRACKERS.map((tracker) => "&tr=" + quote(tracker)).join("");

function magnetFor(infohash, name, trackers = null) {
  // A private torrent announces to one tracker and one only — `private: 1` turns
  // off DHT and PEX, so the public suffix below is not merely useless there, it
  // is the whole reason a magnet built from it would never find a peer. When the
  // `.torrent` has been read, its own announce list is what goes in.
  const suffix = trackers && trackers.length
    ? trackers.map((tracker) => "&tr=" + quote(tracker)).join("")
    : TRACKER_SUFFIX;
  if (name) return `magnet:?xt=urn:btih:${infohash}&dn=${quote(name)}${suffix}`;
  return `magnet:?xt=urn:btih:${infohash}${suffix}`;
}

// --- bencode ---------------------------------------------------------------
//
// Just enough to read a `.torrent`, for the case that needs it: a private
// tracker, whose releases reach Prowlarr with neither a magnet nor an infohash
// because the file itself is behind the passkey. Reading the file is the only
// way to learn what TSP requires on every row. Off when BRIDGE_MAX_RESOLVE is 0.
//
// This is the sibling Worker's decoder, unchanged except for the two fields a
// private torrent needs and a public one does not: the announce list and the
// `private` flag.

function bdecode(data, index, depth = 0) {
  if (depth > 32) throw new Error("nesting too deep");
  if (index >= data.length) throw new Error("truncated");
  const marker = data[index];

  if (marker === 0x69) {
    // "i" — an integer, terminated by "e"
    const end = data.indexOf(0x65, index);
    if (end === -1) throw new Error("unterminated integer");
    return [Number(latin1(data, index + 1, end)), end + 1];
  }
  if (marker === 0x6c) {
    // "l" — a list
    const items = [];
    index += 1;
    while (data[index] !== 0x65) {
      const [value, next] = bdecode(data, index, depth + 1);
      items.push(value);
      index = next;
    }
    return [items, index + 1];
  }
  if (marker === 0x64) {
    // "d" — a dictionary, keys are byte strings
    const mapping = new Map();
    index += 1;
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index, depth + 1);
      const [value, afterValue] = bdecode(data, afterKey, depth + 1);
      if (key instanceof Uint8Array) mapping.set(latin1(key, 0, key.length), value);
      index = afterValue;
    }
    return [mapping, index + 1];
  }
  if (marker >= 0x30 && marker <= 0x39) {
    // a byte string, "<length>:<bytes>"
    const colon = data.indexOf(0x3a, index);
    if (colon === -1) throw new Error("unterminated string");
    const length = Number(latin1(data, index, colon));
    const start = colon + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 0 || end > data.length) {
      throw new Error("bad string length");
    }
    return [data.subarray(start, end), end];
  }
  throw new Error(`unexpected byte ${marker} at ${index}`);
}

function latin1(bytes, start, end) {
  let out = "";
  for (let index = start; index < end; index += 1) out += String.fromCharCode(bytes[index]);
  return out;
}

function utf8(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Every announce URL in the file, `announce-list` first, deduplicated. */
function trackersFrom(root) {
  const found = [];
  const add = (value) => {
    if (!(value instanceof Uint8Array)) return;
    const url = utf8(value).trim();
    // http, https and udp only. A `.torrent` is a file from a stranger, and the
    // announce list is the part of it that ends up somewhere else entirely.
    if (/^(?:https?|udp):\/\/[^\s]+$/i.test(url) && !found.includes(url)) found.push(url);
  };
  const tiers = root.get("announce-list");
  if (Array.isArray(tiers)) for (const tier of tiers) if (Array.isArray(tier)) tier.forEach(add);
  add(root.get("announce"));
  return found.slice(0, 12);
}

/**
 * Read a `.torrent`: v1 infohash, display name, total size, file count, the
 * announce list, and whether it is a private torrent.
 *
 * The infohash is `sha1(bencode(info dict))`, taken over the *original* bytes of
 * the info dict rather than a re-encoding, so a file that round-trips
 * imperfectly still hashes correctly.
 */
async function parseTorrent(data) {
  if (!data.length || data[0] !== 0x64) return null;

  let index = 1;
  let infoSpan = null;
  const root = new Map();
  try {
    while (data[index] !== 0x65) {
      const [key, afterKey] = bdecode(data, index);
      const start = afterKey;
      const [value, afterValue] = bdecode(data, afterKey);
      if (key instanceof Uint8Array) {
        const name = latin1(key, 0, key.length);
        root.set(name, value);
        if (name === "info") infoSpan = [start, afterValue];
      }
      index = afterValue;
    }
  } catch {
    return null;
  }

  const info = root.get("info");
  if (!infoSpan || !(info instanceof Map)) return null;

  const digest = await crypto.subtle.digest("SHA-1", data.subarray(infoSpan[0], infoSpan[1]));
  const infohash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  let size = null;
  let files = null;
  const length = info.get("length");
  if (typeof length === "number") {
    size = length;
    files = 1;
  } else {
    const entries = info.get("files");
    if (Array.isArray(entries)) {
      const sizes = entries
        .filter((entry) => entry instanceof Map && typeof entry.get("length") === "number")
        .map((entry) => entry.get("length"));
      if (sizes.length) {
        size = sizes.reduce((total, one) => total + one, 0);
        files = entries.length;
      }
    }
  }

  const name = info.get("name");
  return {
    infohash,
    name: name instanceof Uint8Array ? utf8(name) : null,
    sizeBytes: size,
    files,
    trackers: trackersFrom(root),
    private: info.get("private") === 1,
  };
}

// --- sealed tokens -----------------------------------------------------------
//
// A `torrent_url` has to name the file it will fetch, and this bridge exists in
// part to keep Prowlarr's address off the phone — so the name is sealed rather
// than signed. AES-GCM, keyed by SHA-256 of the bridge's own key: the client
// gets an opaque string it cannot read, and the seal is authenticated, so a
// token that decrypts at all is one this bridge minted. Nothing is stored; a
// Worker has nowhere to store it and no need to.

const SEAL_CACHE = new Map();

async function sealKey(settings) {
  const secret = settings.apiKey || settings.prowlarrApikey;
  if (!secret) return null;
  let key = SEAL_CACHE.get(secret);
  if (!key) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    // One entry: the key does not change inside an isolate, and an unbounded
    // map keyed by a secret is a leak waiting for a reason.
    SEAL_CACHE.clear();
    SEAL_CACHE.set(secret, key);
  }
  return key;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function unbase64url(text) {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Seal *payload* into a URL-safe token, or null when there is no key to seal with. */
async function seal(settings, payload) {
  const key = await sealKey(settings);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** The payload back, or null if the token is not one of ours or has expired. */
async function unseal(settings, token) {
  const key = await sealKey(settings);
  if (!key || !token || token.length > 4096) return null;
  let payload;
  try {
    const raw = unbase64url(token);
    if (raw.length <= 12) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) }, key, raw.subarray(12),
    );
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    // Forged, truncated, or minted under a key that has since been rotated.
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.e !== "number") return null;
  return payload.e < Date.now() ? null : payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. NAMES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A word character, as a regular expression sees it *in Python*: letters,
 * numbers and underscore from every script, not just ASCII.
 *
 * JavaScript's own `\b` stops at ASCII, so `\bx264\b` would match inside a
 * Japanese title where Python's would not. Every pattern below is written with
 * `\b` and compiled through `pattern()`, which expands it into a boundary that
 * behaves the same way — so this file, the sibling Worker and its Python server
 * all classify a given name identically.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

function pattern(source, flags = "") {
  return new RegExp(source.split("\\b").join(BOUNDARY), flags + "u");
}

/** Separator characters the query rules call out, plus scene bracketing. */
const SEPARATORS = /[._\-+()[\]{},]+/gu;

const RESOLUTION_PATTERNS = [
  ["2160p", pattern("\\b(2160p|4k|uhd|3840\\s?x\\s?2160)\\b", "i")],
  ["1080p", pattern("\\b(1080[pi]|fhd|1920\\s?x\\s?1080)\\b", "i")],
  ["720p", pattern("\\b(720p|hd\\s?ready|1280\\s?x\\s?720)\\b", "i")],
  ["480p", pattern("\\b(480[pi]|sd|640\\s?x\\s?480|854\\s?x\\s?480)\\b", "i")],
];

const CODEC_PATTERNS = [
  ["x265", pattern("\\b(x265|h\\s?265|hevc)\\b", "i")],
  ["x264", pattern("\\b(x264|h\\s?264|avc)\\b", "i")],
  ["av1", pattern("\\bav1\\b", "i")],
  ["vp9", pattern("\\bvp9\\b", "i")],
  ["xvid", pattern("\\bxvid\\b", "i")],
  ["divx", pattern("\\bdivx\\b", "i")],
  ["mpeg2", pattern("\\b(mpeg\\s?2|mpeg2video)\\b", "i")],
];

// Longest/most specific first: "bdremux" must win over "bdrip", "web-dl" over
// "web".
const SOURCE_PATTERNS = [
  ["remux", pattern("\\b(remux|bd\\s?remux|bdmux)\\b", "i")],
  ["bluray", pattern("\\b(blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|brrip|bd\\s?25|bd\\s?50)\\b", "i")],
  ["web-dl", pattern("\\b(web\\s?dl|webdl)\\b", "i")],
  ["webrip", pattern("\\b(web\\s?rip|webrip|web)\\b", "i")],
  ["hdtv", pattern("\\b(hd\\s?tv|hdtv|pdtv|dsr)\\b", "i")],
  ["dvd", pattern("\\b(dvd\\s?rip|dvdrip|dvd\\s?r|dvd5|dvd9|dvd)\\b", "i")],
  ["hdrip", pattern("\\b(hd\\s?rip|hdrip)\\b", "i")],
  ["screener", pattern("\\b(dvd\\s?scr|screener|scr)\\b", "i")],
  ["telesync", pattern("\\b(telesync|hd\\s?ts|ts)\\b", "i")],
  ["cam", pattern("\\b(cam\\s?rip|camrip|hd\\s?cam|cam)\\b", "i")],
];

const YEAR = pattern("\\b(19[0-9]{2}|20[0-9]{2})\\b", "g");

const SEASON_EPISODE = pattern("\\bs\\s?(\\d{1,2})\\s?e\\s?(\\d{1,3})(?:\\s?-\\s?e?\\d{1,3})?\\b", "i");
const SEASON_X_EPISODE = pattern("\\b(\\d{1,2})x(\\d{2,3})\\b");
const SEASON_ONLY = pattern("\\b(?:season|series)\\s?(\\d{1,2})\\b|\\bs\\s?(\\d{1,2})\\b(?!\\s?e\\d)", "i");
const EPISODE_ONLY = pattern("\\b(?:episode|ep)\\s?(\\d{1,3})\\b", "i");

/**
 * A year is only a *release* year if it precedes one of these markers; that is
 * what separates `2012.2009.1080p` (a film called "2012", released 2009) from a
 * title that merely contains a number.
 */
const QUALITY_MARKER = pattern(
  "\\b(2160p|1080[pi]|720p|480[pi]|4k|uhd|x26[45]|h\\s?26[45]|hevc|avc|xvid|divx|av1" +
    "|blu\\s?ray|bluray|bd\\s?rip|bdrip|br\\s?rip|web\\s?dl|webdl|web\\s?rip|webrip|hd\\s?tv|hdtv" +
    "|dvd\\s?rip|dvdrip|remux|complete|multi|proper|repack|extended|unrated|imax)\\b",
  "i",
);

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Turn scene punctuation into spaces so the word boundaries behave. */
function normalizeSeparators(name) {
  return name.replace(SEPARATORS, " ");
}

/**
 * The canonical token whose pattern matches earliest in *text*.
 *
 * Scanning by position rather than by rule order keeps `WEB-DL` from losing to a
 * stray `TS` later in the name, while the ordering within equal positions still
 * favours the more specific rule.
 */
function firstMatch(text, patterns) {
  let bestAt = -1;
  let bestToken = "";
  for (const [token, regexp] of patterns) {
    const match = regexp.exec(text);
    if (match && (bestAt === -1 || match.index < bestAt)) {
      bestAt = match.index;
      bestToken = token;
    }
  }
  return bestToken;
}

function pickYear(text) {
  const horizon = new Date().getUTCFullYear() + 1;
  const plausible = [];
  YEAR.lastIndex = 0;
  let match;
  while ((match = YEAR.exec(text))) {
    const value = Number(match[1]);
    if (value >= 1900 && value <= horizon) {
      plausible.push({ value: match[1], start: match.index, end: match.index + match[1].length });
    }
  }
  if (!plausible.length) return "";
  if (plausible.length === 1) return plausible[0].value;

  const marker = QUALITY_MARKER.exec(text);
  if (marker) {
    const before = plausible.filter((candidate) => candidate.end <= marker.index);
    if (before.length) return before[before.length - 1].value;
  }
  return plausible[plausible.length - 1].value;
}

function pickSeasonEpisode(text) {
  const paired = SEASON_EPISODE.exec(text) || SEASON_X_EPISODE.exec(text);
  if (paired) return [pad2(Number(paired[1])), pad2(Number(paired[2]))];

  let season = "";
  const seasonMatch = SEASON_ONLY.exec(text);
  if (seasonMatch) {
    const raw = seasonMatch[1] || seasonMatch[2];
    if (raw) season = pad2(Number(raw));
  }

  let episode = "";
  const episodeMatch = EPISODE_ONLY.exec(text);
  if (episodeMatch) episode = pad2(Number(episodeMatch[1]));

  return [season, episode];
}

/** The six metadata fields a release name can carry. Absent ones omitted. */
function parseName(name) {
  if (!name) return {};
  const text = normalizeSeparators(name);
  const [season, episode] = pickSeasonEpisode(text);
  const found = {
    year: pickYear(text),
    resolution: firstMatch(text, RESOLUTION_PATTERNS),
    codec: firstMatch(text, CODEC_PATTERNS),
    source: firstMatch(text, SOURCE_PATTERNS),
    season,
    episode,
  };
  const meta = {};
  for (const field of META_FIELDS) if (found[field]) meta[field] = found[field];
  return meta;
}

/**
 * The query rules: `.`, `_` and `-` are separators.
 *
 * Word order is irrelevant, so this only collapses separators and whitespace;
 * Prowlarr and the indexers under it decide how to match the terms.
 */
function normalizeQuery(query) {
  return normalizeSeparators(query).split(/\s+/u).filter(Boolean).join(" ");
}

// --- categories --------------------------------------------------------------

const EXTENSION = /\.([a-z0-9]{2,5})$/iu;

const EXTENSION_CATEGORY = {
  mkv: "video", mp4: "video", avi: "video", mov: "video", m4v: "video",
  wmv: "video", mpg: "video", mpeg: "video", flv: "video", webm: "video",
  mp3: "audio", flac: "audio", wav: "audio", aac: "audio", ogg: "audio",
  m4a: "audio", opus: "audio", alac: "audio", wma: "audio", ape: "audio",
  pdf: "document", epub: "document", mobi: "document", azw3: "document",
  djvu: "document", cbr: "document", cbz: "document", chm: "document",
  jpg: "image", jpeg: "image", png: "image", gif: "image", bmp: "image",
  tiff: "image", webp: "image", psd: "image", svg: "image",
  exe: "software", msi: "software", dmg: "software", apk: "software",
  deb: "software", rpm: "software", pkg: "software", appimage: "software",
  rar: "archive", zip: "archive", "7z": "archive", tar: "archive",
  gz: "archive", bz2: "archive", xz: "archive", tgz: "archive",
};

/**
 * Ordered rules: the first family with a hit wins. Video markers come first
 * because scene video names are the most distinctive, and because a game or an
 * application essentially never carries a resolution or an SxxEyy tag.
 */
const CLASSIFY_RULES = [
  [
    "video",
    pattern(
      "\\b(" +
        "2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dolby[. _-]?vision" +
        "|x26[45]|h[. _-]?26[45]|hevc|avc|xvid|divx|av1" +
        "|blu[. _-]?ray|bd(?:rip|remux|mux)|br[. _-]?rip|web[. _-]?(?:dl|rip)" +
        "|hd(?:tv|rip|cam)|dvd(?:rip|scr|r)?|remux|telesync|cam[. _-]?rip" +
        "|s\\d{1,2}[. _-]?e\\d{1,3}|\\d{1,2}x\\d{2}|season[. _-]?\\d{1,2}" +
        "|complete[. _-]series|episode[. _-]?\\d{1,3}" +
        "|dts(?:[. _-]?hd)?|ddp?\\d[. _-]?\\d|aac\\d[. _-]?\\d|truehd|atmos" +
        ")\\b",
      "i",
    ),
  ],
  [
    "audio",
    pattern(
      "\\b(" +
        "flac|mp3|aac|alac|ogg|opus|wav|ape|dsd" +
        "|\\d{2,3}\\s?kbps|v0|v2|cbr|vbr" +
        "|discography|anthology|album|ep|single|soundtrack|ost|bootleg" +
        "|audiobook|audio[. _-]?book|vinyl|cd[. _-]?(?:rip|q|da)|web[. _-]?flac" +
        ")\\b",
      "i",
    ),
  ],
  [
    "software",
    pattern(
      "\\b(" +
        "x64|x86|win(?:32|64|dows)?|macos|osx|linux|ubuntu|debian|fedora|arch" +
        "|v\\d+(?:\\.\\d+)+|build[. _-]?\\d+|portable|multilingual|activated" +
        "|crack(?:ed|fix)?|keygen|patch|repack|pre[. _-]?activated|iso" +
        "|fitgirl|dodi|codex|plaza|skidrow|reloaded|empress|razor1911|tenoke" +
        "|gog|steam|denuvo|update[. _-]?only|dlc" +
        ")\\b",
      "i",
    ),
  ],
  [
    "document",
    pattern(
      "\\b(" +
        "ebook|e[. _-]?book|epub|pdf|mobi|azw3|retail|magazine|comics?|manga" +
        "|\\d(?:st|nd|rd|th)[. _-]?edition|textbook|novel|paperback" +
        ")\\b",
      "i",
    ),
  ],
  [
    "image",
    pattern(
      "\\b(wallpapers?|imageset|image[. _-]?pack|photos?|pics|pictures|artwork" +
        "|hi[. _-]?res[. _-]?scans)\\b",
      "i",
    ),
  ],
  ["archive", pattern("\\b(rar|zip|7z|tar|tgz|gz|bz2|xz)\\b", "i")],
];

/**
 * Best-effort category for a release name, or null if unreadable.
 *
 * Null means "no idea", which is not the same as "no". Every rule here keys off
 * a technical marker — a resolution, a codec, a format — and a great many real
 * releases carry none. Callers filtering by category must keep those, because
 * dropping them makes a filter delete correct answers rather than narrow them.
 */
function classifyName(name) {
  if (!name) return null;
  const extension = EXTENSION.exec(name.trim());
  if (extension) {
    const category = EXTENSION_CATEGORY[extension[1].toLowerCase()];
    if (category) return category;
  }
  for (const [category, regexp] of CLASSIFY_RULES) {
    if (regexp.test(name)) return category;
  }
  return null;
}

/**
 * Newznab's top-level category ids, which is what Prowlarr reports, mapped onto
 * the six this file speaks.
 *
 * Newznab has eight top-level ids and no notion of an image or an archive, so
 * two of the six have no id to ask for and no id to recognise. `Other` (8000)
 * and the unnumbered `0` mean nothing in particular and stay null, which sends
 * the row to classifyName instead of asserting something false about it.
 */
const NEWZNAB_TO_CATEGORY = {
  1000: "software", // Console — games are software here
  2000: "video",    // Movies
  3000: "audio",    // Audio
  4000: "software", // PC, which is also where PCISO (4020) lives
  5000: "video",    // TV
  6000: "video",    // XXX
  7000: "document", // Books
};

/**
 * The ids to ask Prowlarr for, given a category. Empty means "do not filter".
 *
 * `image` and `archive` are deliberately empty. The only image category Newznab
 * has is XXX ImageSet and the only archive-ish one is PCISO, so asking for
 * either would be narrower and stranger than the reader meant. Those two
 * searches go out unfiltered and are narrowed here by classifyName instead,
 * which is best-effort and says so in the README.
 */
const CATEGORY_TO_NEWZNAB = {
  video: [2000, 5000],
  audio: [3000],
  software: [1000, 4000],
  document: [7000],
  image: [],
  archive: [],
};

/** The category Prowlarr's `categories` array implies, or null. */
function categoryFromNewznab(categories) {
  if (!Array.isArray(categories)) return null;
  for (const entry of categories) {
    const id = intOrNone(entry && typeof entry === "object" ? entry.id : entry);
    if (id === null || id < 1000 || id >= 10000) continue;
    const found = NEWZNAB_TO_CATEGORY[Math.floor(id / 1000) * 1000];
    if (found) return found;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. ROWS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The key a row deduplicates on: its infohash, or failing that its name and
 * size. The `h:`/`n:` prefix is also the sort's final tie-break, which is what
 * makes paging stable across requests.
 */
function dedupeKey(row) {
  if (row.infohash) return `h:${row.infohash}`;
  const slug = [...row.name.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
  return `n:${slug}:${row.sizeBytes === null ? "?" : row.sizeBytes}`;
}

function maxOrNull(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * Collapse duplicates, keeping the best of each field.
 *
 * Two indexers carrying the same release is the normal case for Prowlarr, and
 * without this the client sees the same film four times. The longest name wins
 * because it is the most descriptive release string, swarm counts are `max`-ed
 * because a stale indexer under-reports, and every contributing indexer is
 * recorded in `sources`.
 */
function merge(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = dedupeKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }
    if (row.name.length > existing.name.length) existing.name = row.name;
    existing.seeders = maxOrNull(existing.seeders, row.seeders);
    existing.leechers = maxOrNull(existing.leechers, row.leechers);
    if (existing.sizeBytes === null) existing.sizeBytes = row.sizeBytes;
    if (existing.files === null) existing.files = row.files;
    existing.category = existing.category || row.category;
    existing.descriptionUrl = existing.descriptionUrl || row.descriptionUrl;
    existing.infohash = existing.infohash || row.infohash;
    existing.sources = existing.sources.concat(row.sources);
    if (row.firstSeen && (existing.firstSeen === null || row.firstSeen < existing.firstSeen)) {
      existing.firstSeen = row.firstSeen;
    }
  }
  return [...merged.values()];
}

/** The parsed name for *row*, computed at most once. */
function parsedMeta(row) {
  if (row.meta === null) row.meta = parseName(row.name);
  return row.meta;
}

/**
 * Every spelling the name parser normalises to a given `res` token. Keep in step
 * with RESOLUTION_PATTERNS; the tests prove they agree.
 */
const RESOLUTION_SPELLINGS = {
  "2160p": ["2160p", "4k", "uhd", "3840"],
  "1080p": ["1080p", "1080i", "fhd", "1920"],
  "720p": ["720p", "hdready", "hd ready", "1280"],
  "480p": ["480p", "480i", "sd", "640x480", "854x480"],
};

/**
 * The query filters Prowlarr's generic search cannot apply, cheapest test first.
 *
 * Prowlarr's `/api/v1/search` takes a query, categories and a set of indexers,
 * and nothing else: no year, no resolution, no seeder floor. So those three are
 * applied here, over the merged set, which is also the only place they could be
 * applied correctly — a seeder floor per indexer would throw away the row a
 * second indexer was about to report better numbers for.
 */
function applyFilters(rows, { category = "", year = "", resolution = "", minSeeders = 0 } = {}) {
  const resTokens = resolution ? RESOLUTION_SPELLINGS[resolution] || [resolution] : [];
  const kept = [];
  for (const row of rows) {
    if (minSeeders && (row.seeders || 0) < minSeeders) continue;
    if (category) {
      // Only a category we can read and that disagrees is grounds to drop. An
      // unreadable name means "no idea", and treating that as "not video" makes
      // the video filter hide rows the unfiltered search had just shown.
      const found = row.category || classifyName(row.name);
      if (found && found !== category) continue;
    }
    if (year && (!row.name.includes(year) || parsedMeta(row).year !== year)) continue;
    if (resTokens.length) {
      const lowered = row.name.toLowerCase();
      if (!resTokens.some((token) => lowered.includes(token))) continue;
      if (parsedMeta(row).resolution !== resolution) continue;
    }
    kept.push(row);
  }
  return kept;
}

/** Order by *sort*, descending, with a total tie-break for stable paging. */
function sortRows(rows, sort) {
  const decorated = rows.map((row) => {
    const key = dedupeKey(row);
    if (sort === "size") return { row, primary: [row.sizeBytes || 0, row.seeders || 0], key };
    if (sort === "recent") return { row, primary: [row.firstSeen || "", row.seeders || 0], key };
    return { row, primary: [row.seeders || 0, row.sizeBytes || 0], key };
  });

  decorated.sort((left, right) => {
    for (let index = 0; index < left.primary.length; index += 1) {
      const a = left.primary[index];
      const b = right.primary[index];
      if (a !== b) return a < b ? 1 : -1; // descending
    }
    if (left.key !== right.key) return left.key < right.key ? 1 : -1;
    return 0;
  });

  return decorated.map((entry) => entry.row);
}

/**
 * The wire row, or null when it has no magnet to offer.
 *
 * Absent fields are omitted rather than sent as null: a client reads an absent
 * numeric as zero, and this is the shape the sibling project emits.
 *
 * **`torrent_url` points back here**, never at Prowlarr. TSP says a client sends
 * its key only to the index's own origin, so a Prowlarr URL would arrive
 * unusable *and* would tell the phone the hostname this bridge exists to keep to
 * itself. Instead the URL names this bridge and carries a sealed token that only
 * this bridge can read; `/api/v1/torrentfile/` opens it and fetches the file.
 *
 * That field is what makes a private tracker usable rather than merely visible.
 * `private: 1` disables DHT and PEX, so the magnet — which TSP requires on every
 * row and which is therefore still emitted — cannot reach the swarm on its own.
 * The `.torrent`, with its passkey in the announce URL, can.
 */
async function toTorrent(row, scrapedAt, settings = null, origin = "") {
  if (!row.infohash) return null;

  const torrent = {
    magnet: row.magnet || magnetFor(row.infohash, row.name, row.trackers),
    infohash: row.infohash,
    name: row.name,
  };
  if (settings && origin && row.downloadUrl && settings.maxResolve) {
    const token = await seal(settings, {
      u: row.downloadUrl,
      e: Date.now() + settings.torrentfileTtlS * 1000,
    });
    if (token) torrent.torrent_url = `${origin}/api/v1/torrentfile/${row.infohash}?t=${token}`;
  }
  if (row.sizeBytes !== null) torrent.size_bytes = row.sizeBytes;
  if (row.files !== null) torrent.files = row.files;
  const category = row.category || classifyName(row.name);
  if (category) torrent.category = category;
  if (row.seeders !== null) torrent.seeders = row.seeders;
  if (row.leechers !== null) torrent.leechers = row.leechers;
  Object.assign(torrent, parsedMeta(row));
  if (row.firstSeen) torrent.first_seen = row.firstSeen;
  torrent.scraped_at = scrapedAt;
  if (row.descriptionUrl) torrent.description_url = row.descriptionUrl;
  if (row.sources.length) torrent.sources = [...new Set(row.sources)].sort();
  return torrent;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PROWLARR
// ═══════════════════════════════════════════════════════════════════════════

/** Something went wrong upstream. *status* is what the client should be told. */
class BridgeError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Slack over the client's page, for rows the merge collapses or a filter eats. */
const MARGIN = 25;

/**
 * How many rows to ask each indexer for.
 *
 * **Prowlarr's `limit` is per indexer, not per answer.** It goes into the
 * Newznab request sent to every indexer, so a limit of 200 across twelve
 * indexers is two thousand four hundred rows fetched, parsed and merged to
 * show fifty. And `offset` is per indexer too, which is why this file never
 * sends one: skipping fifty rows at every indexer and then merging does not
 * produce page two of anything. Paging happens here, over the merged set.
 *
 * So the number sent upstream is the smallest one that can still contain the
 * page the client asked for. Its first version doubled the window and jumped
 * straight to the ceiling whenever any local filter was set, which meant a
 * plain search asked for a hundred rows per indexer and a search with a seeder
 * floor asked for two hundred. That is what made the first real deployment
 * slow enough to time out.
 */
function rowBudget(query, settings) {
  // No terms is a browse: Prowlarr asks every indexer for its latest, which is
  // the most expensive thing it can be told to do, and the answer is a
  // shopfront rather than a result set. It gets its own small budget.
  if (!query.terms) return settings.browseRows;

  // Everything the client could page to, plus slack.
  const window = query.offset + query.limit + MARGIN;

  // A filter this file applies itself can throw candidates away, so it asks
  // for more. Prowlarr can filter by category, but not for `image` or
  // `archive`, which have no Newznab id to ask for. Twice the window, not the
  // whole corpus: a seeder floor is not a reason to fetch everything.
  const filteringHere =
    query.year ||
    query.res ||
    query.minSeeders ||
    (query.cat && !CATEGORY_TO_NEWZNAB[query.cat].length);

  return Math.max(DEFAULT_LIMIT, Math.min(settings.maxRows, filteringHere ? window * 2 : window));
}

/** The Prowlarr URL for a search. Repeated parameters, so not urlencode(). */
function searchUrl(query, settings) {
  const parts = [
    `query=${quotePlus(query.terms)}`,
    // Always the generic search. Prowlarr's other types (tvsearch, movie) want
    // ids this file has no way to know.
    "type=search",
    `limit=${rowBudget(query, settings)}`,
  ];
  for (const id of query.cat ? CATEGORY_TO_NEWZNAB[query.cat] : []) parts.push(`categories=${id}`);
  for (const id of settings.indexerIds) parts.push(`indexerIds=${quotePlus(id)}`);
  return `${settings.prowlarrUrl}/api/v1/search?${parts.join("&")}`;
}

/**
 * One release, as a row, or null when it cannot become one.
 *
 * A row needs a magnet, and Prowlarr's `magnetUrl` and `infoHash` are both
 * nullable — an indexer that only ever hands out `.torrent` files populates
 * neither. Two tiers, in order:
 *
 *   1. `magnetUrl` — used as it stands, and the infohash read back out of it,
 *      so whatever trackers the indexer chose survive.
 *   2. `infoHash` — a magnet is synthesised around it with the default
 *      trackers, exactly as the sibling project does.
 *   3. `downloadUrl` — neither of the above, which is what a **private tracker**
 *      looks like from here: the `.torrent` is behind the passkey, so the feed
 *      publishes no magnet and Prowlarr has no infohash to report. The row is
 *      kept unresolved and `resolveWindow()` reads the file if the client pages
 *      to it. Before this existed such a row was dropped, which meant a Prowlarr
 *      of private indexers answered every search with nothing.
 *
 * A row with none of the three cannot become anything and is dropped.
 */
function toRow(release) {
  if (!release || typeof release !== "object") return null;
  // Usenet has no swarm and no magnet. A Prowlarr with usenet indexers
  // configured returns those rows too, and they are not this file's business.
  if (String(release.protocol || "torrent").toLowerCase() !== "torrent") return null;

  const name = cleanName(release.title);
  if (!name) return null;

  const magnetUrl = String(release.magnetUrl || "").trim();
  const infohash = infohashFromMagnet(magnetUrl) || normalizeInfohash(release.infoHash);
  // Prowlarr's own address for the file. Kept whether or not the infohash is
  // already known: it is what a private row is resolved through, and what the
  // `torrent_url` proxy fetches for any row a client asks for the file of.
  const downloadUrl = String(release.downloadUrl || "").trim();
  if (!infohash && !/^https?:\/\//iu.test(downloadUrl)) return null;

  const indexer = cleanName(release.indexer) || "prowlarr";

  return {
    name,
    infohash,
    downloadUrl: /^https?:\/\//iu.test(downloadUrl) ? downloadUrl : null,
    trackers: null,
    magnet: magnetUrl && magnetUrl.toLowerCase().startsWith("magnet:") ? magnetUrl : null,
    sizeBytes: positiveOrNone(release.size),
    files: positiveOrNone(release.files),
    seeders: intOrNone(release.seeders),
    leechers: intOrNone(release.leechers),
    category: categoryFromNewznab(release.categories),
    firstSeen: isoStamp(release.publishDate),
    // The indexer's own page for the release, which is a tracker URL and not a
    // Prowlarr one. `infoUrl` is the details page; `commentUrl` is where older
    // indexers put it.
    descriptionUrl: String(release.infoUrl || release.commentUrl || "") || null,
    sources: [indexer],
    meta: null,
  };
}

/** Ask Prowlarr, and turn its answer into rows. Throws BridgeError. */
async function askProwlarr(http, query, settings) {
  const problem = upstreamProblem(settings);
  if (problem === "missing_url") {
    throw new BridgeError(503, "not_configured", `PROWLARR_URL is not set. ${WHERE}`);
  }
  if (problem === "missing_apikey") {
    throw new BridgeError(503, "not_configured", `PROWLARR_APIKEY is not set. ${WHERE}`);
  }

  let status = 0;
  let body = "";
  try {
    [status, body] = await http.text(searchUrl(query, settings), {
      timeout: settings.timeoutS,
      // Prowlarr takes its key as a header or as `apikey=` in the query string.
      // The header, always: a query string ends up in access logs and in the
      // referrer of anything the answer links onward.
      headers: { "X-Api-Key": settings.prowlarrApikey },
    });
  } catch (thrown) {
    throw new BridgeError(
      502,
      "prowlarr_unreachable",
      `Could not reach Prowlarr at ${settings.prowlarrUrl}: ${thrown && thrown.name === "TimeoutError" ? `no answer in ${settings.timeoutS}s` : String(thrown && thrown.message ? thrown.message : thrown)}.`,
    );
  }

  // 401 is deliberately not passed through. To a client, a 401 from the index
  // means "your key is wrong", and the reader would go and change the one key
  // that was never the problem. This is a configuration fault on the server.
  if (status === 401 || status === 403) {
    throw new BridgeError(
      502,
      "prowlarr_rejected_key",
      "Prowlarr refused this bridge's key. PROWLARR_APIKEY is not the key in " +
        "Prowlarr's Settings, General. The client's own key is not the problem.",
    );
  }
  if (status !== 200) {
    throw new BridgeError(502, "prowlarr_error", `Prowlarr answered HTTP ${status}.`);
  }

  let payload = null;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new BridgeError(
      502,
      "prowlarr_error",
      "Prowlarr's answer was not JSON. Check that PROWLARR_URL is Prowlarr itself " +
        "and not a login page or a reverse proxy error.",
    );
  }
  if (!Array.isArray(payload)) {
    throw new BridgeError(502, "prowlarr_error", "Prowlarr's answer was not a list of releases.");
  }

  const rows = [];
  let dropped = 0;
  for (const release of payload) {
    const row = toRow(release);
    if (row) rows.push(row);
    else if (release && String(release.protocol || "torrent").toLowerCase() === "torrent") dropped += 1;
  }
  return [rows, dropped];
}

/** Fetch one release's `.torrent` from Prowlarr and read what it says. */
async function fetchTorrent(downloadUrl, http, settings) {
  let status = 0;
  let data = null;
  try {
    [status, data] = await http.bytes(downloadUrl, {
      timeout: Math.min(settings.timeoutS, 20),
      headers: { "X-Api-Key": settings.prowlarrApikey },
    });
  } catch {
    return null;
  }
  if (status !== 200 || !data || !data.length || data.length > TORRENT_MAX_BYTES) return null;
  return parseTorrent(data);
}

/**
 * Read the `.torrent` for the rows a client is about to see.
 *
 * Only that page, and only up to `maxResolve` of it: this is one request to
 * Prowlarr per row, and Prowlarr in turn goes to the tracker, so resolving a
 * hundred-row candidate set to serve twenty would be paying for eighty files
 * nobody asked for. Rows that still have no infohash afterwards are dropped by
 * `toTorrent`, exactly as they were before any of this existed.
 */
async function resolveWindow(rows, http, settings) {
  if (!settings.maxResolve) return 0;
  const pending = rows.filter((row) => !row.infohash && row.downloadUrl).slice(0, settings.maxResolve);
  if (!pending.length) return 0;

  let resolved = 0;
  await Promise.all(
    pending.map(async (row) => {
      const meta = await fetchTorrent(row.downloadUrl, http, settings);
      if (!meta) return;
      row.infohash = meta.infohash;
      // The announce list is the point for a private torrent: `private: 1`
      // turns off DHT and PEX, so a magnet carrying the public trackers would
      // name a swarm it can never reach.
      if (meta.trackers.length) row.trackers = meta.trackers;
      if (row.sizeBytes === null) row.sizeBytes = meta.sizeBytes;
      if (row.files === null) row.files = meta.files;
      resolved += 1;
    }),
  );
  return resolved;
}

/**
 * A search, start to finish.
 *
 * Prowlarr has already done the fan-out, so what is left is the part it does
 * not do: collapse the same release reported by several indexers, apply the
 * filters its generic search has no parameters for, order the result, and cut
 * out the page that was asked for.
 */
async function search(query, http, settings, origin = "") {
  const started = Date.now();
  query.terms = normalizeQuery(query.q);

  // A browse nobody wants is a browse worth not doing. With BRIDGE_BROWSE_ROWS
  // at zero this answers an empty search without asking Prowlarr anything,
  // which matters because a client that opens on an empty search box would
  // otherwise fire the most expensive request in the system before the reader
  // has typed a character.
  if (!query.terms && !settings.browseRows) {
    return reply(200, {
      query: query.q,
      count: 0,
      limit: query.limit,
      offset: query.offset,
      took_ms: Date.now() - started,
      torrents: [],
      engines: [],
    });
  }

  const [rows, dropped] = await askProwlarr(http, query, settings);

  const shape = (collected) =>
    sortRows(
      applyFilters(merge(collected), {
        category: query.cat,
        year: query.year,
        resolution: query.res,
        minSeeders: query.minSeeders,
      }),
      query.sort,
    );

  let ordered = shape(rows);

  // Read the `.torrent` for everything up to the end of the page — the prefix,
  // not just the page, because a row that will not resolve has to be taken out
  // before the page is cut or it leaves a hole where a row should be. This is
  // the only way a private tracker's rows ever acquire an infohash.
  //
  // Then merge again: an infohash learned here can collapse a row against
  // another indexer's copy of the same release that had its infohash all along.
  const resolved = await resolveWindow(
    ordered.slice(0, query.offset + query.limit), http, settings,
  );
  if (resolved) ordered = shape(ordered);

  // A row still without an infohash cannot become a TSP row, so it is not one:
  // it is excluded before `count` is taken and before the page is cut, which is
  // what keeps `offset=0` then `offset=3` a coherent sequence.
  //
  // Counted over the prefix only, not the whole result set: a row further down
  // than the client has paged to was never attempted, and reporting it as
  // unresolved would be reporting a failure that never happened. Over the
  // prefix the number means something exact — this many rows you asked for are
  // missing, because their file could not be read or because
  // BRIDGE_MAX_RESOLVE stopped short of them.
  const unresolved = ordered
    .slice(0, query.offset + query.limit)
    .filter((row) => !row.infohash).length;
  const final = ordered.filter((row) => row.infohash);

  const scrapedAt = nowIso();
  const page = [];
  for (const row of final.slice(query.offset, query.offset + query.limit)) {
    const torrent = await toTorrent(row, scrapedAt, settings, origin);
    if (torrent !== null) page.push(torrent);
  }

  const body = {
    query: query.q,
    count: final.length,
    limit: query.limit,
    offset: query.offset,
    took_ms: Date.now() - started,
    torrents: page,
    // Which indexers actually produced something. Prowlarr names each release's
    // indexer, so this costs nothing and is the closest honest answer to "where
    // did this come from".
    engines: [...new Set(final.flatMap((row) => row.sources))].sort(),
  };

  // Not part of the contract, and clients ignore fields they do not know. It is
  // here because a row with nothing to identify it is silently gone otherwise,
  // and "Prowlarr found nine, you were shown six" is a fact the reader can act
  // on. It now counts only releases with no magnet, no infohash *and* no
  // download URL — a private tracker's rows are resolved rather than counted
  // here, and one that fails to resolve is reported as `unresolved` instead.
  if (dropped) body.dropped_without_magnet = dropped;
  // Rows Prowlarr found, that carry a download URL, and whose `.torrent` could
  // not be read — a private indexer Prowlarr cannot currently reach, or more
  // rows above the page than BRIDGE_MAX_RESOLVE allows fetching.
  if (unresolved) body.unresolved = unresolved;

  return reply(200, body);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. ROUTES
// ═══════════════════════════════════════════════════════════════════════════

function keyComplaint(settings) {
  if (keyProblem(settings) === "short") {
    return [
      "api_key_too_short",
      `BRIDGE_API_KEY is ${settings.apiKey.length} characters and needs at least ${MIN_KEY_LENGTH}. ` +
        `This key is the only thing between the internet and your Prowlarr, so a short one is a ` +
        `guessable one. Four random words is plenty. ${WHERE}`,
    ];
  }
  return [
    "not_configured",
    `This bridge has no API key, so it refuses every request rather than serving without one. ` +
      `${WHERE} Or set BRIDGE_ALLOW_ANONYMOUS=1 to serve with no key at all, which on a public ` +
      `URL hands your Prowlarr to anyone who finds it.`,
  ];
}

/**
 * Compare two keys without letting the time taken say how much of one matched.
 *
 * The length is allowed to leak — it always does, over HTTP — but the content is
 * not, which is what stops a caller guessing the key one character at a time.
 */
function timingSafeEqual(presented, expected) {
  let difference = presented.length ^ expected.length;
  const length = Math.max(presented.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Null when the caller may proceed, otherwise the refusal to send.
 *
 * Both spellings are accepted because clients differ: `X-API-Key` is what the
 * contract documents, `Authorization: Bearer` is what a generic HTTP client
 * reaches for. The key never travels in the query string.
 */
function authorize(settings, headers) {
  if (!isConfigured(settings)) return error(503, ...keyComplaint(settings));
  if (settings.allowAnonymous) return null;

  let presented = headers.get("x-api-key") || "";
  if (!presented) {
    const authorization = headers.get("authorization") || "";
    if (authorization.slice(0, 7).toLowerCase() === "bearer ") {
      presented = authorization.slice(7).trim();
    }
  }
  if (!presented) return error(401, "missing_api_key", "Send the key in the X-API-Key header.");
  if (!timingSafeEqual(presented, settings.apiKey)) {
    return error(403, "invalid_api_key", "The X-API-Key header did not match.");
  }
  return null;
}

// --- replies -----------------------------------------------------------------

function reply(status, body, headers = null, text = null) {
  return { status, body, headers, text, bytes: null };
}

function error(status, name, detail = null, headers = null) {
  const body = { error: name };
  if (detail) body.detail = detail;
  return reply(status, body, headers);
}

/** Named origins only. A wildcard would let any page spend this bridge. */
function corsHeaders(settings, origin) {
  if (!origin || !settings.corsOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-API-Key, Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// --- query -------------------------------------------------------------------

/** Validate a query string, or say exactly what was wrong with it. */
function readQuery(params) {
  const one = (name) => (params.get(name) || "").trim();

  const cat = one("cat");
  if (cat && !CATEGORIES.includes(cat)) {
    return error(400, "invalid_cat", `cat must be one of ${CATEGORIES.join(", ")}`);
  }
  const sort = one("sort");
  if (sort && !SORTS.includes(sort)) {
    return error(400, "invalid_sort", "sort must be one of seeders, size, recent");
  }
  const res = one("res");
  if (res && !RESOLUTIONS.includes(res)) {
    return error(400, "invalid_res", `res must be one of ${RESOLUTIONS.join(", ")}`);
  }
  const year = one("year");
  if (year && !/^\d{4}$/.test(year)) {
    return error(400, "invalid_year", "year must be four digits");
  }

  const number = (name, fallbackValue) => {
    const raw = one(name);
    if (!raw) return fallbackValue;
    return /^[+-]?\d+$/.test(raw) ? Number(raw) : fallbackValue;
  };

  // Clamped rather than rejected: a 422 is not in the client's retry contract.
  return {
    q: one("q"),
    cat,
    year,
    res,
    minSeeders: Math.max(0, number("min_seeders", 0)),
    sort,
    limit: Math.max(1, Math.min(number("limit", DEFAULT_LIMIT), MAX_LIMIT)),
    offset: Math.max(0, number("offset", 0)),
    terms: "",
  };
}

// --- health ------------------------------------------------------------------

/**
 * What this bridge knows about itself, without asking anything.
 *
 * No key and no outbound request, so it is safe to leave open and cannot be
 * turned into an amplifier by somebody who does not have the key. It reports
 * configuration only: whether both keys are set and whether Prowlarr's URL
 * looks usable, which is what almost every first-run problem turns out to be.
 *
 * `?probe=1` is the live answer and needs the key. See probe().
 */
function healthz(settings) {
  const upstream = upstreamProblem(settings);
  return {
    status: isConfigured(settings) && !upstream ? "ok" : "not_configured",
    api_key: isConfigured(settings) ? "ok" : keyProblem(settings),
    prowlarr_url: settings.prowlarrUrl ? "ok" : "missing",
    prowlarr_apikey: settings.prowlarrApikey ? "ok" : "missing",
    version: VERSION,
    runtime: RUNTIME,
    // The one thing worth saying out loud, because it is the reason to run this
    // at all rather than pointing the client straight at Prowlarr.
    note: "Prowlarr's key stays on this server and is never sent to a client.",
  };
}

/**
 * Ask Prowlarr whether it is well, and which of its indexers are not.
 *
 * This is the endpoint that answers "I get no results and I do not know why".
 * Prowlarr's own search cannot answer it: when every indexer fails it logs the
 * failures and returns an empty list, so from here a total outage and a genuine
 * nil return are the same reply. `/api/v1/indexerstatus` is where the failures
 * actually are.
 */
async function probe(http, settings) {
  const problem = upstreamProblem(settings);
  if (problem) return { ...healthz(settings), reachable: false, detail: `PROWLARR_${problem === "missing_url" ? "URL" : "APIKEY"} is not set.` };

  const key = { "X-Api-Key": settings.prowlarrApikey };
  const get = async (path, headers = null) => {
    try {
      const [status, body] = await http.text(`${settings.prowlarrUrl}${path}`, {
        timeout: Math.min(settings.timeoutS, 20),
        headers,
      });
      if (status !== 200) return [status, null];
      try {
        return [status, JSON.parse(body)];
      } catch {
        return [status, null];
      }
    } catch {
      return [0, null];
    }
  };

  // `/ping` needs no key, so a failure here is the network and a failure at the
  // next line is the key. Telling those two apart is most of the value.
  const [pingStatus] = await get("/ping");
  const reachable = pingStatus === 200;

  const report = { ...healthz(settings), reachable, authenticated: false };
  if (!reachable) {
    report.status = "unreachable";
    report.detail =
      pingStatus === 0
        ? `Nothing answered at ${settings.prowlarrUrl}. A Cloudflare Worker cannot reach a machine on a home network; see README.md.`
        : `${settings.prowlarrUrl}/ping answered HTTP ${pingStatus}.`;
    return report;
  }

  const [indexerStatus, indexers] = await get("/api/v1/indexer", key);
  if (indexerStatus === 401 || indexerStatus === 403) {
    report.status = "degraded";
    report.detail = "Prowlarr is up and refused this bridge's key. Check PROWLARR_APIKEY.";
    return report;
  }
  report.authenticated = true;

  const [, blocked] = await get("/api/v1/indexerStatus", key);
  const blockedIds = new Set(
    (Array.isArray(blocked) ? blocked : []).map((entry) => entry && entry.indexerId).filter((id) => id != null),
  );

  const torrents = (Array.isArray(indexers) ? indexers : []).filter(
    (indexer) => String(indexer.protocol || "").toLowerCase() !== "usenet",
  );
  const enabled = torrents.filter((indexer) => indexer.enable !== false);

  report.indexers = enabled.length;
  report.indexers_blocked = enabled.filter((indexer) => blockedIds.has(indexer.id)).length;
  report.blocked = enabled
    .filter((indexer) => blockedIds.has(indexer.id))
    .map((indexer) => cleanName(indexer.name) || String(indexer.id))
    .sort();
  if (!enabled.length) {
    report.status = "degraded";
    report.detail = "Prowlarr has no enabled torrent indexers, so every search will be empty.";
  } else if (report.indexers_blocked === enabled.length) {
    report.status = "degraded";
    report.detail = "Every torrent indexer is currently blocked by Prowlarr, so every search will be empty.";
  }
  return report;
}

/**
 * The auto-return, inlined into the page only while setup is still in progress.
 *
 * A short pause rather than an instant jump, so "Your bridge is live" is read
 * before the page moves: the reassurance is half the point of showing it.
 * `replace` rather than `assign`, so the back button does not land on a page
 * that would immediately bounce again.
 *
 * Anyone who would rather stay presses Stay. With JavaScript off none of this
 * runs and the button is still there.
 */
const RETURN_SCRIPT = `
var going = setTimeout(function () {
  location.replace(document.getElementById("finish").href);
}, 2500);
document.getElementById("lede").innerHTML =
  "<strong>All set. Taking you back to finish.<\\/strong> " +
  "Your URL is on its way to the page that has your key, so you get both together.";
var stay = document.getElementById("stay");
stay.hidden = false;
stay.addEventListener("click", function () {
  clearTimeout(going);
  stay.hidden = true;
  document.getElementById("lede").innerHTML =
    "<strong>Staying here.<\\/strong> Press Finish setup whenever you are ready.";
});
`;

/** Escape for HTML text and double-quoted attributes. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/**
 * The one page this bridge serves, and the reason it serves any.
 *
 * A deployed bridge knows its own URL; the setup page that minted the key does
 * not, and cannot, because Cloudflare invents the account part of the name and
 * lengthens what you typed. So the last step of setup used to be "read the URL
 * off Cloudflare's screen and type it back into the other tab", which is the
 * step people got wrong. This page removes it: it *is* the URL, and it carries
 * a link back with the URL in the fragment.
 *
 * **It never shows a key.** This page needs none to read, so anybody who ever
 * ended up with the URL would end up with the key too, permanently: a
 * screenshot, a shared link, a synced history. The URL is not the secret. The
 * keys are, and they stay where they already are.
 */
function landingPage(host, returning) {
  const url = escapeHtml(host);
  const back = escapeHtml(SETUP_PAGE + "#url=" + encodeURIComponent(host));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>Your bridge is live</title>
<style>
:root { --bg:#fff; --ink:#111; --muted:#666; --line:#e5e5e5; --code:#f6f6f6;
  /* Cloudflare's orange at 38% lightness, so white on it clears WCAG AA. The
     same orange marks the thing to press on the setup page, and this page has
     exactly one thing to press. */
  --accent:#ba5a08; }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
body { margin:0; padding:2rem 1.15rem 5rem; background:var(--bg); color:var(--ink);
  font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  overflow-wrap:break-word; -webkit-font-smoothing:antialiased; }
main { max-width:34rem; margin:0 auto; }
h1 { font-size:1.6rem; line-height:1.2; letter-spacing:-.022em; margin:0 0 .5rem; font-weight:700; }
h2 { font-size:1rem; margin:2rem 0 .3rem; font-weight:650; letter-spacing:-.008em; }
p { margin:.7rem 0; }
a { color:var(--ink); text-underline-offset:2px; }
.lede { color:var(--muted); margin-bottom:1.4rem; }
.note { color:var(--muted); font-size:.935rem; }
.card { border:1px solid var(--line); border-radius:10px; padding:1rem; margin:1.1rem 0; }
label { display:block; font-size:.82rem; font-weight:650; letter-spacing:.01em;
  text-transform:uppercase; color:var(--muted); margin-bottom:.3rem; }
.value { font:500 .98rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--code); border:1px solid var(--line); border-radius:8px; padding:.7rem .75rem;
  user-select:all; -webkit-user-select:all; margin-bottom:.9rem; }
a.btn, button { display:flex; align-items:center; justify-content:center; width:100%;
  min-height:3.15rem; padding:.8rem 1rem; font:inherit; font-weight:600; letter-spacing:-.005em;
  text-align:center; text-decoration:none; border:1px solid var(--accent); border-radius:8px;
  background:var(--accent); color:#fff; cursor:pointer; font-size:1.05rem; }
button.ghost { background:var(--bg); color:var(--ink); border-color:var(--line); margin-top:.5rem; }
a.btn:active, button:active { transform:translateY(1px); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em;
  background:var(--code); padding:.1em .32em; border-radius:4px; }
.status { min-height:1.35rem; margin-top:.5rem; font-size:.9rem; font-weight:600; text-align:center; }
footer { margin-top:2.8rem; padding-top:1.2rem; border-top:1px solid var(--line);
  color:var(--muted); font-size:.89rem; }
</style>
</head>
<body>
<main>

<h1>Your bridge is live</h1>
<p class="lede" id="lede">
  <strong>One tap left. Press Finish setup below.</strong> That is the only
  thing this page is for: it hands your URL back to the page that made your key,
  so you get both together, ready to copy.
</p>

<div class="card">
  <label>Your URL</label>
  <div class="value" id="url">${url}</div>
  <a class="btn" id="finish" href="${back}">Finish setup &nearr;</a>
  <button class="ghost" id="stay" type="button" hidden>Stay on this page</button>
  <button class="ghost" id="copy" type="button">Copy the URL</button>
  <div class="status" id="status" role="status" aria-live="polite"></div>
  <p class="note" style="margin-bottom:0">
    Finish setup opens the page you started on, with this URL already in it, so
    it can show you the URL and the key together and test them. The URL travels
    after the <code>#</code>, which your browser never sends to a server.
  </p>
</div>

<h2>Is it working?</h2>
<p class="note">
  <a href="/healthz">/healthz</a> says whether this bridge is configured. It
  needs no key. Add <code>?probe=1</code>, with your key, and it asks Prowlarr
  as well: whether it answers, whether it accepts the key, and which of your
  indexers Prowlarr has currently blocked.
</p>

<h2>If that page no longer has your key</h2>
<p class="note">
  It is not lost. Open this Worker in the Cloudflare dashboard, press
  <strong>Edit code</strong>, and read the line near the top that starts
  <code>const BRIDGE_KEY</code>. You can also replace it from Settings,
  Variables and Secrets, as <code>BRIDGE_API_KEY</code>, which wins over the
  line in the file.
</p>

<footer>
  Prowlarr bridge ${VERSION} &middot;
  <a href="https://github.com/momzv2022-ctrl/prowlarr-bridge" rel="noopener">source and documentation</a>
  <p style="margin:.5rem 0 0">
    This URL is yours alone. There is no public instance of this and no list of
    other people's. MIT licence, no warranty, no liability.
  </p>
</footer>

</main>
<script>
${returning ? RETURN_SCRIPT : ""}
document.getElementById("copy").addEventListener("click", function () {
  var status = document.getElementById("status");
  var text = location.protocol + "//" + location.host;
  function done() { status.textContent = "URL copied."; setTimeout(function () { status.textContent = ""; }, 4000); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { status.textContent = "Could not copy. Select it by hand."; });
    return;
  }
  status.textContent = "Could not copy. Select it by hand.";
});
</script>
</body>
</html>
`;
}

const BANNER = `Prowlarr bridge ${VERSION}

  GET /api/v1/search?q=...   send the key as the X-API-Key header
  GET /healthz               configuration, no key needed
  GET /healthz?probe=1       asks Prowlarr; needs the key

https://github.com/momzv2022-ctrl/prowlarr-bridge
`;

/** Route one request. Everything above this is reachable from tests alone. */
async function handle(method, url, headers, http, settings) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const cors = corsHeaders(settings, headers.get("origin") || "");

  if (method === "OPTIONS") return reply(204, null, cors);
  if (method !== "GET" && method !== "HEAD") {
    return error(405, "method_not_allowed", "This API is read-only.", { ...cors, Allow: "GET, OPTIONS" });
  }

  if (path === "/healthz") {
    if (!["1", "true", "yes"].includes((parsed.searchParams.get("probe") || "").trim())) {
      return reply(200, healthz(settings), cors);
    }
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    return reply(200, await probe(http, settings), cors);
  }

  // A bridge to somebody's private Prowlarr is the one thing that should never
  // turn up in a search engine.
  if (path === "/robots.txt") return reply(200, null, cors, "User-agent: *\nDisallow: /\n");

  if (path === "/") {
    // A browser gets the page that closes the setup loop; anything else, a
    // client or a monitor or curl, gets the plain text it has always got.
    if (!(headers.get("accept") || "").includes("text/html")) {
      return reply(200, null, { ...cors, "X-Robots-Tag": "noindex" }, BANNER);
    }
    return reply(
      200, null,
      { ...cors, "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
      landingPage(parsed.host, SETUP_UNTIL > Date.now()),
    );
  }

  if (path === "/api/v1/search") {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    const query = readQuery(parsed.searchParams);
    if (query.status) return reply(query.status, query.body, cors);
    try {
      const answer = await search(query, http, settings, parsed.origin);
      return reply(answer.status, answer.body, { ...cors, ...(answer.headers || {}) });
    } catch (thrown) {
      if (thrown instanceof BridgeError) {
        return error(thrown.status, thrown.code, thrown.detail, cors);
      }
      throw thrown;
    }
  }

  if (path.startsWith("/api/v1/torrentfile/")) {
    const refusal = authorize(settings, headers);
    if (refusal) return reply(refusal.status, refusal.body, { ...cors, ...(refusal.headers || {}) });
    return torrentfile(path.slice("/api/v1/torrentfile/".length), parsed.searchParams, http, settings, cors);
  }

  return error(404, "not_found", "No route here. Try /api/v1/search.", cors);
}

/**
 * `GET /api/v1/torrentfile/<infohash>?t=<token>` — the file itself.
 *
 * TSP names this route, and calls `torrent_url` "decisive for thin swarms". For
 * a private tracker it is decisive for every swarm: the file carries the passkey
 * that a magnet cannot.
 *
 * The token is sealed, not signed, so the client never learns Prowlarr's
 * address. Three things are checked before anything is fetched, and the last is
 * the one that matters: the sealed URL must still be Prowlarr's own origin, so
 * that a token minted when `PROWLARR_URL` pointed somewhere else cannot turn
 * this route into an open proxy for whatever it named.
 */
async function torrentfile(wanted, params, http, settings, cors) {
  const infohash = normalizeInfohash(wanted);
  if (!infohash) return error(400, "invalid_infohash", "Expected 40 hex characters.", cors);

  const problem = upstreamProblem(settings);
  if (problem) return error(503, "not_configured", `Prowlarr is not configured. ${WHERE}`, cors);
  if (!settings.maxResolve) {
    return error(404, "not_found", "Serving .torrent files is off: BRIDGE_MAX_RESOLVE is 0.", cors);
  }

  const payload = await unseal(settings, (params.get("t") || "").trim());
  // One answer for forged, expired and malformed alike. Which of the three it
  // was is not the client's business, and saying would be an oracle.
  if (!payload) {
    return error(403, "bad_token", "This link is not valid, or has expired. Search again.", cors);
  }

  let target;
  try {
    target = new URL(payload.u);
  } catch {
    return error(403, "bad_token", "This link is not valid, or has expired. Search again.", cors);
  }
  if (target.origin !== new URL(settings.prowlarrUrl).origin) {
    return error(403, "bad_token", "This link was minted for a different Prowlarr.", cors);
  }

  let status = 0;
  let data = null;
  try {
    [status, data] = await http.bytes(target.href, {
      timeout: Math.min(settings.timeoutS, 20),
      headers: { "X-Api-Key": settings.prowlarrApikey },
    });
  } catch (thrown) {
    return error(502, "prowlarr_unreachable", `Could not reach Prowlarr: ${thrown && thrown.message}.`, cors);
  }
  if (status === 401 || status === 403) {
    return error(502, "prowlarr_rejected_key", "Prowlarr refused this bridge's key.", cors);
  }
  if (status !== 200 || !data || !data.length) {
    return error(502, "prowlarr_error", `Prowlarr answered HTTP ${status} for that file.`, cors);
  }
  if (data.length > TORRENT_MAX_BYTES) {
    return error(502, "prowlarr_error", "That .torrent is implausibly large.", cors);
  }

  // The file must be the one that was asked for. Without this the infohash in
  // the path would be decoration, and a client that trusted it would be seeding
  // something it never chose.
  const meta = await parseTorrent(data);
  if (!meta) return error(502, "prowlarr_error", "Prowlarr's answer was not a .torrent.", cors);
  if (meta.infohash !== infohash) {
    return error(409, "infohash_mismatch", "That file is no longer the release it was.", cors);
  }

  return {
    status: 200,
    body: null,
    text: null,
    bytes: data,
    headers: {
      ...cors,
      "Content-Type": "application/x-bittorrent",
      "Content-Disposition": `attachment; filename="${infohash}.torrent"`,
      // Sealed and expiring, so it is cacheable by the client that asked and by
      // nothing in between.
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. ENTRY
// ═══════════════════════════════════════════════════════════════════════════

/** Which of the two runtimes this is, for /healthz and for the entry below. */
const RUNTIME =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers"
    ? "cloudflare-worker"
    : typeof process !== "undefined" && process.versions && process.versions.node
      ? "node"
      : "unknown";

/**
 * A reply as (status, body, headers), ready for either runtime.
 *
 * The body is null, not `""`, when there is nothing to send: 204 and 304 are
 * "null body" statuses and the `Response` constructor rejects a string body.
 */
function render(answer) {
  const headers = { ...(answer.headers || {}) };
  // A .torrent is bytes and must not go near a string: `Content-Type` is set by
  // the route, and re-encoding through UTF-8 would corrupt the info dict — and
  // with it the infohash the client is about to trust.
  if (answer.bytes !== null && answer.bytes !== undefined) {
    return [answer.status, answer.bytes, headers];
  }
  if (answer.text !== null && answer.text !== undefined) {
    if (!("Content-Type" in headers)) headers["Content-Type"] = "text/plain; charset=utf-8";
    return [answer.status, answer.text, headers];
  }
  if (answer.body === null || answer.body === undefined) return [answer.status, null, headers];
  if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return [answer.status, JSON.stringify(answer.body), headers];
}

/** `fetch()` reduced to the one shape this file needs. */
function httpClient(userAgent = USER_AGENT) {
  return {
    /** Raw bytes, for a `.torrent`. Accept says so; Prowlarr does not care. */
    async bytes(url, { timeout, headers }) {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          Accept: "application/x-bittorrent, application/octet-stream",
          ...(headers || {}),
        },
        signal: AbortSignal.timeout(Math.round(timeout * 1000)),
      });
      if (response.status !== 200) return [response.status, new Uint8Array()];
      return [response.status, new Uint8Array(await response.arrayBuffer())];
    },

    async text(url, { timeout, headers }) {
      const response = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": userAgent, Accept: "application/json", ...(headers || {}) },
        signal: AbortSignal.timeout(Math.round(timeout * 1000)),
      });
      if (response.status !== 200) return [response.status, ""];
      return [response.status, await response.text()];
    },
  };
}

/** The Cloudflare entry. Ignored entirely when this runs under Node. */
export default {
  async fetch(request, env) {
    const settings = readSettings(env || {});
    const answer = await handle(request.method, request.url, request.headers, httpClient(), settings);
    const [status, body, headers] = render(answer);
    return new Response(body, { status, headers });
  },
};

// --- node --------------------------------------------------------------------
//
// `node worker.js` serves the same handler on a port. This is the deployment to
// prefer when Prowlarr is on a private address, which is where Prowlarr usually
// is: put this next to it, let it talk to Prowlarr over the loopback, and expose
// this rather than Prowlarr.

/** True only when this file is the program, not when a test imported it. */
function startedDirectly() {
  if (RUNTIME !== "node") return false;
  if (!Array.isArray(process.argv) || !process.argv[1]) return false;
  const entry = process.argv[1].replace(/\\/g, "/");
  return import.meta.url.endsWith(entry) || import.meta.url.endsWith(entry.replace(/^[A-Za-z]:/, ""));
}

async function serve() {
  // The specifier is built rather than written, so that a bundler aimed at
  // Cloudflare cannot try to resolve `node:http` while packing a file that will
  // never reach this line there. Every deployment path this project documents
  // either runs the file as it is or pastes it into an editor, so nothing is
  // lost by being unanalysable here.
  const { createServer } = await import("node:" + "http");

  const settings = readSettings(process.env);
  const port = Number(process.env.BRIDGE_PORT || 8788);
  const host = process.env.BRIDGE_HOST || "127.0.0.1";
  const http = httpClient();

  const server = createServer(async (incoming, outgoing) => {
    const origin = `http://${incoming.headers.host || `${host}:${port}`}`;
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method,
      headers: incoming.headers,
    });
    try {
      const answer = await handle(request.method, request.url, request.headers, http, settings);
      const [status, body, headers] = render(answer);
      outgoing.writeHead(status, headers);
      outgoing.end(body === null ? undefined : body);
    } catch (thrown) {
      outgoing.writeHead(500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: "internal", detail: String(thrown && thrown.message) }));
    }
  });

  server.listen(port, host, () => {
    const problem = keyProblem(settings) || upstreamProblem(settings);
    process.stdout.write(`\n  prowlarr-bridge ${VERSION}\n`);
    process.stdout.write(`  URL       http://${host}:${port}\n`);
    process.stdout.write(`  Prowlarr  ${settings.prowlarrUrl || "(PROWLARR_URL is not set)"}\n`);
    if (problem) {
      process.stdout.write(`\n  Not ready: ${problem}. Open /healthz for what is missing.\n`);
    } else {
      process.stdout.write(`\n  Ready. Open /healthz?probe=1 with your key to check Prowlarr.\n`);
    }
    process.stdout.write("\n");
  });
}

if (startedDirectly()) await serve();

/**
 * The seam the test suite reaches through, and the only thing in this file that
 * is not part of serving a request.
 *
 * Both runtimes ignore it. It is here so the tests can drive the pipeline
 * directly, with Prowlarr replaced by a fixture, rather than only through
 * `fetch()`.
 */
export const __testing = {
  BridgeError,
  CATEGORY_TO_NEWZNAB,
  MIN_KEY_LENGTH,
  VERSION,
  applyFilters,
  askProwlarr,
  categoryFromNewznab,
  classifyName,
  dedupeKey,
  handle,
  healthz,
  landingPage,
  magnetFor,
  merge,
  normalizeInfohash,
  normalizeQuery,
  parseTorrent,
  resolveWindow,
  seal,
  torrentfile,
  unseal,
  parseName,
  probe,
  readQuery,
  readSettings,
  render,
  rowBudget,
  search,
  searchUrl,
  sortRows,
  toRow,
  toTorrent,
};
