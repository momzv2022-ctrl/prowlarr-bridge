/**
 * The bridge, run rather than read.
 *
 * Nothing here touches the network. Prowlarr is a table: a captured
 * `ReleaseResource[]` and a stub `http` client that hands it back and records
 * what was asked for. That makes the two things most worth pinning testable
 * without a Prowlarr anywhere near it — the URL that goes out, and the JSON
 * that comes back.
 *
 * `golden/search.json` is the second of those, frozen. It is what a client
 * receives, byte for byte, and the point of freezing it is that the shape is
 * shared with a sibling project: a change here that a person did not
 * deliberately make is a change that would show up as duplicate rows in an app
 * holding results from both.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { __testing } from "../src/worker.js";

const {
  CATEGORY_TO_NEWZNAB,
  applyFilters,
  categoryFromNewznab,
  handle,
  healthz,
  magnetFor,
  merge,
  parseName,
  probe,
  readQuery,
  readSettings,
  render,
  rowBudget,
  search,
  seal,
  searchUrl,
  toRow,
  toTorrent,
  unseal,
} = __testing;

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASES = JSON.parse(readFileSync(join(HERE, "fixtures", "prowlarr-search.json"), "utf8"));
const GOLDEN_PATH = join(HERE, "golden", "search.json");

const KEY = "abcd-efgh-jkmn-pqrs-tuvw-xyz2";
const PROWLARR = "https://prowlarr.example.test";

const ENV = {
  BRIDGE_API_KEY: KEY,
  PROWLARR_URL: PROWLARR,
  PROWLARR_APIKEY: "prowlarr-secret-key",
};

const settingsFrom = (extra = {}) => readSettings({ ...ENV, ...extra });

/**
 * Prowlarr, as a table.
 *
 * *reply* is `{status, body}` or a thrown value. Every request is recorded, so a
 * test can assert on the URL and on the headers that carried the key.
 */
function stubHttp(reply = { status: 200, body: JSON.stringify(RELEASES) }, file = null) {
  const asked = [];
  return {
    asked,
    async text(url, options) {
      asked.push({ url, options });
      const answer = typeof reply === "function" ? reply(url, asked.length) : reply;
      if (!answer || answer.throws) throw new TypeError("fetch failed");
      return [answer.status, answer.body];
    },
    /** The `.torrent` half. Answers 404 unless a test supplies a file. */
    async bytes(url, options) {
      asked.push({ url, options, bytes: true });
      const answer = typeof file === "function" ? file(url) : file;
      if (!answer) return [404, new Uint8Array()];
      if (answer.throws) throw new TypeError("fetch failed");
      return [answer.status, answer.body];
    },
  };
}

/** Minimal bencoder, so a test .torrent's infohash is a fact not a fixture. */
function bencode(value) {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string") value = Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  }
  const keys = Object.keys(value).sort();
  return Buffer.concat([
    Buffer.from("d"), ...keys.flatMap((k) => [bencode(k), bencode(value[k])]), Buffer.from("e"),
  ]);
}

const PASSKEY_ANNOUNCE = "https://private.test/announce/pk-0123456789abcdef";

/**
 * A `.torrent` of the shape this path exists for: `private: 1`, so DHT and PEX
 * are off, and a passkey in the announce URL that no magnet could carry.
 */
function torrentFile({
  name = "Something Only Available As A Torrent File 1080p",
  length = 2147483648,
  isPrivate = 1,
} = {}) {
  const info = { name, "piece length": 262144, pieces: Buffer.alloc(20), length, private: isPrivate };
  const bytes = bencode({ announce: PASSKEY_ANNOUNCE, "announce-list": [[PASSKEY_ANNOUNCE]], info });
  return { bytes: new Uint8Array(bytes), infohash: createHash("sha1").update(bencode(info)).digest("hex") };
}

const headersOf = (entries = {}) => new Headers(entries);

/** Drive a whole request the way either runtime does. */
async function request(path, { key = KEY, env = ENV, http = stubHttp(), method = "GET" } = {}) {
  const headers = headersOf(key ? { "X-API-Key": key } : {});
  const answer = await handle(method, `https://bridge.test${path}`, headers, http, readSettings(env));
  const [status, body] = render(answer);
  return { status, body: body === null ? null : body, json: () => JSON.parse(body), http };
}

// ───────────────────────────────────────────────────────────────────────────
// what goes out
// ───────────────────────────────────────────────────────────────────────────

test("the search URL carries the query, the type, and nothing that would break paging", () => {
  const query = { ...readQuery(new URLSearchParams("q=big+buck+bunny")), terms: "big buck bunny" };
  const url = searchUrl(query, settingsFrom());

  assert.equal(
    url,
    `${PROWLARR}/api/v1/search?query=big+buck+bunny&type=search&limit=75`,
  );
  // The one that would be a silent bug: Prowlarr applies offset per indexer, so
  // sending one and then merging does not produce page two of anything.
  assert.ok(!url.includes("offset"), "offset must never be forwarded");
});

/**
 * The arithmetic that decides how much work Prowlarr is asked to do.
 *
 * Pinned to exact numbers on purpose. The first version of this doubled the
 * window and jumped to the ceiling on any local filter, which is what made a
 * real deployment time out, and the failure mode of a number like this is to
 * creep back up unnoticed.
 */
test("the per-indexer row budget is the smallest one that can hold the page", () => {
  const settings = settingsFrom();
  const at = (search, extra = settings) => {
    const query = readQuery(new URLSearchParams(search));
    query.terms = query.q;
    return rowBudget(query, extra);
  };

  // A page, plus slack for what the merge collapses, with a floor.
  assert.equal(at("q=x&limit=5"), 50, "the floor");
  assert.equal(at("q=x&limit=50"), 75, "50 asked for, 25 of slack");
  assert.equal(at("q=x&limit=50&offset=100"), 100, "deep paging, capped by BRIDGE_MAX_ROWS");

  // A filter this file applies itself asks for twice the window, not for the
  // whole corpus. A seeder floor is not a reason to fetch everything.
  assert.equal(at("q=x&limit=5&min_seeders=10"), 60);
  assert.equal(at("q=x&limit=5&year=2008"), 60);
  assert.equal(at("q=x&limit=5&res=1080p"), 60);
  // A category Prowlarr can filter on does not widen it; one it cannot does.
  assert.equal(at("q=x&limit=5&cat=video"), 50);
  assert.equal(at("q=x&limit=5&cat=archive"), 60);
  assert.equal(at("q=x&limit=5&cat=image"), 60);

  // And it is bounded by the setting, whatever the client asks for.
  assert.equal(at("q=x&limit=200&offset=190", settingsFrom({ BRIDGE_MAX_ROWS: "120" })), 120);
  assert.equal(at("q=x&limit=200"), 100, "the default ceiling");
});

test("a search with no terms is a browse, and browsing is cheap", () => {
  const at = (search, extra = settingsFrom()) => {
    const query = readQuery(new URLSearchParams(search));
    query.terms = query.q;
    return rowBudget(query, extra);
  };

  // Prowlarr answers an empty query by asking every indexer for its latest,
  // which is the most expensive thing it can be told to do. A client that
  // opens on an empty search box hits this before the reader types anything,
  // so it gets a small budget regardless of what the client asked for.
  assert.equal(at("q="), 25);
  assert.equal(at("q=&limit=200"), 25);
  assert.equal(at("q=&limit=200&min_seeders=10"), 25, "a filter does not widen a browse either");
  assert.equal(at("q=", settingsFrom({ BRIDGE_BROWSE_ROWS: "60" })), 60);
});

test("browsing can be switched off, and then costs Prowlarr nothing at all", async () => {
  const off = { ...ENV, BRIDGE_BROWSE_ROWS: "0" };
  const answer = await request("/api/v1/search?q=", { env: off });

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.http.asked, [], "not one request upstream");
  const body = answer.json();
  assert.equal(body.count, 0);
  assert.deepEqual(body.torrents, []);
  assert.deepEqual(body.engines, []);

  // And with browsing on, the same search does reach Prowlarr.
  const on = await request("/api/v1/search?q=");
  assert.equal(on.http.asked.filter((call) => !call.bytes).length, 1, "one search, whatever else");
  assert.ok(on.http.asked[0].url.includes("limit=25"));
});

test("a category becomes Newznab ids, and the two with none are asked unfiltered", () => {
  const forCat = (cat) => searchUrl({ ...readQuery(new URLSearchParams(`q=x&cat=${cat}`)), terms: "x" }, settingsFrom());

  assert.ok(forCat("video").includes("&categories=2000&categories=5000"));
  assert.ok(forCat("audio").includes("&categories=3000"));
  assert.ok(forCat("software").includes("&categories=1000&categories=4000"));
  assert.ok(forCat("document").includes("&categories=7000"));
  // Newznab has no image and no archive category. Asking for XXX ImageSet or
  // for PC/ISO would be narrower and stranger than the reader meant, so the
  // search goes out wide and is narrowed by name afterwards.
  assert.ok(!forCat("image").includes("categories="));
  assert.ok(!forCat("archive").includes("categories="));
  assert.deepEqual(CATEGORY_TO_NEWZNAB.image, []);
  assert.deepEqual(CATEGORY_TO_NEWZNAB.archive, []);
});

test("named indexers are passed through, one parameter each", () => {
  const query = { ...readQuery(new URLSearchParams("q=x")), terms: "x" };
  const url = searchUrl(query, settingsFrom({ PROWLARR_INDEXER_IDS: "3, 7 ,not-a-number, -2" }));
  assert.ok(url.endsWith("&indexerIds=3&indexerIds=7&indexerIds=-2"), url);
});

test("Prowlarr's key travels in a header and never in the query string", async () => {
  const answer = await request("/api/v1/search?q=big+buck+bunny");
  assert.equal(answer.status, 200);

  const [asked] = answer.http.asked;
  assert.equal(asked.options.headers["X-Api-Key"], "prowlarr-secret-key");
  assert.ok(!asked.url.includes("apikey"), "a key in a URL ends up in logs and referrers");
});

test("a Prowlarr URL with a path on the end is trimmed back to the origin", () => {
  for (const given of [PROWLARR, `${PROWLARR}/`, `${PROWLARR}/api`, `${PROWLARR}/api/v1`, `${PROWLARR}/api/v1/search`]) {
    assert.equal(readSettings({ ...ENV, PROWLARR_URL: given }).prowlarrUrl, PROWLARR, given);
  }
  for (const bad of ["", "prowlarr.example.test", "ftp://x.test"]) {
    assert.equal(readSettings({ ...ENV, PROWLARR_URL: bad }).prowlarrUrl, "", bad);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// what comes back
// ───────────────────────────────────────────────────────────────────────────

test("a release becomes a row, or says why it cannot", () => {
  const byTitle = (title) => RELEASES.find((release) => release.title.startsWith(title));

  // Tier 1: the indexer's own magnet is kept as it stands, trackers and all.
  const one = toRow(byTitle("Big Buck Bunny 2008 1080p BluRay x264-GRP"));
  assert.equal(one.infohash, "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");
  assert.ok(one.magnet.includes("tracker.example"), "the indexer's trackers survive");

  // Tier 2: an infohash alone, upper case, becomes a magnet like the sibling's.
  const two = toRow(byTitle("Sintel"));
  assert.equal(two.magnet, null, "synthesised later, by toTorrent");
  assert.equal(two.infohash, "08ada5a7a6183aae1e09d831df6748d566095a10");

  // A base32 infohash inside a magnet is normalised to hex.
  const base32 = toRow(byTitle("Ubuntu"));
  assert.match(base32.infohash, /^[0-9a-f]{40}$/);

  // Tier 3: no magnet and no infohash, which is what a private tracker looks
  // like from here. The row is kept unresolved, carrying the address its
  // `.torrent` can be read from; dropping it is what made a Prowlarr of private
  // indexers answer every search with nothing.
  const three = toRow(byTitle("Something Only Available"));
  assert.equal(three.infohash, null, "not known yet");
  assert.equal(three.magnet, null);
  assert.equal(three.downloadUrl, "https://prowlarr.example.test/5/download?apikey=SECRET&link=vwx");

  // Nothing to go on at all is still no row.
  assert.equal(toRow({ ...byTitle("Something Only Available"), downloadUrl: null }), null);
  // Usenet has no swarm and no magnet, and is not this file's business.
  assert.equal(toRow(byTitle("Big Buck Bunny 2008 2160p")), null);

  // Prowlarr sends 0 for "the indexer did not say", so a nought is an absence.
  const zeroes = toRow(byTitle("Some.Show"));
  assert.equal(zeroes.sizeBytes, null);
  assert.equal(zeroes.files, null);
  assert.equal(zeroes.seeders, null, "null seeders stay null, not 0");
  assert.equal(zeroes.descriptionUrl, null);
});

test("Prowlarr's own category is used, and an unreadable one falls through to the name", () => {
  assert.equal(categoryFromNewznab([{ id: 2000 }]), "video");
  assert.equal(categoryFromNewznab([{ id: 5040 }]), "video");
  assert.equal(categoryFromNewznab([{ id: 3010 }]), "audio");
  assert.equal(categoryFromNewznab([{ id: 4020 }]), "software", "PC/ISO is software, not archive");
  assert.equal(categoryFromNewznab([{ id: 1000 }]), "software", "a console game is software here");
  assert.equal(categoryFromNewznab([{ id: 7020 }]), "document");
  // Newznab's Other says nothing, and asserting a category from it would be
  // worse than leaving the name to speak.
  assert.equal(categoryFromNewznab([{ id: 8010 }]), null);
  assert.equal(categoryFromNewznab([]), null);
  assert.equal(categoryFromNewznab(undefined), null);
  // 100000-and-up are the indexer's own ids, not Newznab's.
  assert.equal(categoryFromNewznab([{ id: 127035 }, { id: 2000 }]), "video");
});

test("the same release from two indexers is one row, with the best of each field", async () => {
  const answer = await request("/api/v1/search?q=big+buck+bunny");
  const rows = answer.json().torrents;
  const bunny = rows.filter((row) => row.infohash === "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c");

  assert.equal(bunny.length, 1, "one row, not two");
  assert.equal(bunny[0].seeders, 512, "the higher swarm count wins");
  assert.equal(bunny[0].leechers, 30);
  assert.ok(bunny[0].name.endsWith("[PROPER]"), "the longer name is the more descriptive one");
  assert.deepEqual(bunny[0].sources, ["Tracker One", "Tracker Two"]);
  assert.equal(bunny[0].first_seen, "2018-12-31T23:58:20Z", "the earliest sighting");
  assert.ok(bunny[0].magnet.includes("tracker.example"), "the magnet that had trackers wins");
});

test("a row that cannot be resolved is dropped, counted, and named in the answer", async () => {
  // The stub serves no `.torrent`, so the private row cannot be resolved and is
  // still not shown — but it is now reported as `unresolved` rather than as
  // never having been a candidate.
  const answer = await request("/api/v1/search?q=x");
  const body = answer.json();

  assert.equal(body.dropped_without_magnet, undefined, "it had a download URL, so it was a candidate");
  assert.equal(body.unresolved, 1);
  assert.ok(!body.torrents.some((row) => row.name.startsWith("Something Only Available")));
  // The usenet row is not counted: it was never a candidate.
  assert.ok(!body.torrents.some((row) => row.name.includes("NZB")));

  // Nothing to identify it at all is still counted the old way.
  const blind = RELEASES.map((r) =>
    String(r.title).startsWith("Something Only") ? { ...r, downloadUrl: null } : r);
  const other = await request("/api/v1/search?q=x", {
    http: stubHttp({ status: 200, body: JSON.stringify(blind) }),
  });
  assert.equal(other.json().dropped_without_magnet, 1);
});

test("the envelope is the shape a client expects", async () => {
  const answer = await request("/api/v1/search?q=big+buck+bunny&limit=2");
  const body = answer.json();

  assert.deepEqual(Object.keys(body).sort(), [
    "count", "engines", "limit", "offset", "query", "took_ms", "torrents",
  ]);
  assert.equal(body.query, "big buck bunny");
  assert.equal(body.limit, 2);
  assert.equal(body.offset, 0);
  assert.equal(body.torrents.length, 2);
  assert.equal(body.count, 7, "count is the whole result set, not the page");
  assert.deepEqual(body.engines, ["Tracker Four", "Tracker One", "Tracker Three", "Tracker Two"]);
});

test("no row ever carries a Prowlarr URL or a Prowlarr key", async () => {
  const answer = await request("/api/v1/search?q=x");
  const text = JSON.stringify(answer.json());

  assert.ok(!text.includes("prowlarr.example.test"), "the hostname this bridge exists to hide");
  assert.ok(!text.includes("SECRET"), "Prowlarr's downloadUrl carries its key in the query string");
  // `torrent_url` exists now, but only ever on this bridge's own origin, and the
  // token naming the file is sealed rather than signed — which is what makes the
  // two assertions above a test of the seal.
  for (const row of answer.json().torrents) {
    if (row.torrent_url === undefined) continue;
    assert.ok(row.torrent_url.startsWith("https://bridge.test/api/v1/torrentfile/"), row.torrent_url);
  }
});

test("paging is stable, and offset walks the merged set", async () => {
  const all = (await request("/api/v1/search?q=x&limit=200")).json().torrents;
  const first = (await request("/api/v1/search?q=x&limit=3")).json().torrents;
  const second = (await request("/api/v1/search?q=x&limit=3&offset=3")).json().torrents;

  assert.deepEqual(first.map((row) => row.infohash), all.slice(0, 3).map((row) => row.infohash));
  assert.deepEqual(second.map((row) => row.infohash), all.slice(3, 6).map((row) => row.infohash));
});

// ───────────────────────────────────────────────────────────────────────────
// private trackers
// ───────────────────────────────────────────────────────────────────────────

/** A stub that also serves the one `.torrent` the private release points at. */
function withFile(file = torrentFile()) {
  return stubHttp({ status: 200, body: JSON.stringify(RELEASES) }, (url) =>
    url.includes("/5/download") ? { status: 200, body: file.bytes } : null);
}

const PRIVATE_ROW = "Something Only Available";
const findPrivate = (body) => body.torrents.find((t) => t.name.startsWith(PRIVATE_ROW));

test("a private tracker's release becomes a usable row", async () => {
  // The bug this exists for. The release carries no magnet and no infoHash,
  // because the file is behind the passkey — so before the `.torrent` was read
  // every row from a private indexer was dropped, and a Prowlarr of nothing but
  // private indexers answered every search with nothing at all.
  const file = torrentFile();
  const answer = await request("/api/v1/search?q=x&limit=50", { http: withFile(file) });
  const body = answer.json();
  const row = findPrivate(body);

  assert.ok(row, "the private release is a result now");
  assert.equal(row.infohash, file.infohash, "read out of the file, not guessed");
  assert.equal(body.unresolved, undefined, "nothing left unresolved");

  // The file was asked for at Prowlarr's URL, with the bridge's Prowlarr key.
  const fetched = answer.http.asked.find((call) => call.bytes);
  assert.ok(fetched.url.startsWith("https://prowlarr.example.test/5/download"));
  assert.equal(fetched.options.headers["X-Api-Key"], "prowlarr-secret-key");
});

test("a private release's magnet announces where the swarm actually is", async () => {
  // `private: 1` turns off DHT and PEX. A magnet carrying the five public
  // trackers would name a swarm it can never reach, so the file's own announce
  // list — passkey and all — is what goes in.
  const answer = await request("/api/v1/search?q=x&limit=50", { http: withFile() });
  const row = findPrivate(answer.json());

  assert.ok(row.magnet.includes(encodeURIComponent(PASSKEY_ANNOUNCE)), row.magnet);
  assert.ok(!row.magnet.includes("opentrackr"), "not the public suffix, which cannot help here");
});

test("the file behind torrent_url can actually be fetched", async () => {
  const file = torrentFile();
  const found = await request("/api/v1/search?q=x&limit=50", { http: withFile(file) });
  const row = findPrivate(found.json());

  const path = row.torrent_url.slice("https://bridge.test".length);
  const answer = await request(path, { http: withFile(file) });

  assert.equal(answer.status, 200);
  assert.equal(Buffer.compare(Buffer.from(answer.body), Buffer.from(file.bytes)), 0, "byte for byte");
});

test("the torrentfile route refuses everything it should", async () => {
  const file = torrentFile();
  const found = await request("/api/v1/search?q=x&limit=50", { http: withFile(file) });
  const path = findPrivate(found.json()).torrent_url.slice("https://bridge.test".length);
  const [route, token] = path.split("?t=");

  // The client's own key is still required: this hands out a file that took
  // Prowlarr's key to fetch.
  const anonymous = await request(path, { key: null, http: withFile(file) });
  assert.equal(anonymous.status, 401);

  // A token that is not ours does not open, and neither does a mangled one. The
  // answer is the same either way: which of the two it was is not the caller's
  // business, and saying would be an oracle.
  for (const bad of ["", "nonsense", token.slice(0, -4), token.slice(4)]) {
    const answer = await request(`${route}?t=${bad}`, { http: withFile(file) });
    assert.equal(answer.status, 403, `token ${JSON.stringify(bad.slice(0, 8))} must not open`);
    assert.equal(answer.json().error, "bad_token");
  }

  // A token minted by another bridge is exactly as unreadable, because the seal
  // is keyed on that bridge's own key.
  const stranger = { ...ENV, BRIDGE_API_KEY: "a-completely-different-bridge-key" };
  const elsewhere = await request(path, {
    env: stranger, key: stranger.BRIDGE_API_KEY, http: withFile(file),
  });
  assert.equal(elsewhere.status, 403);

  // The infohash in the path is not decoration. If Prowlarr answers with a
  // different file than the one that was indexed, it is refused rather than
  // handed on to a client that would seed something it never chose.
  const swapped = torrentFile({ name: "Something Else Entirely 1080p" });
  assert.notEqual(swapped.infohash, file.infohash);
  const mismatched = await request(path, { http: withFile(swapped) });
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.json().error, "infohash_mismatch");

  // A path that is not an infohash never reaches Prowlarr at all.
  const nonsense = await request(`/api/v1/torrentfile/not-a-hash?t=${token}`, { http: withFile(file) });
  assert.equal(nonsense.status, 400);
});

test("a link expires, and cannot be aimed anywhere but Prowlarr", async () => {
  const settings = readSettings(ENV);

  const stale = await seal(settings, { u: `${PROWLARR}/5/download`, e: Date.now() - 1000 });
  assert.equal(await unseal(settings, stale), null, "expired");
  const fresh = await seal(settings, { u: `${PROWLARR}/5/download`, e: Date.now() + 60_000 });
  assert.ok(await unseal(settings, fresh), "not expired");

  // A sealed URL that is no longer Prowlarr's origin is refused even though the
  // seal itself opens — otherwise a token minted before PROWLARR_URL moved
  // would turn this route into an open proxy for whatever it named.
  const wrong = await seal(settings, { u: "https://elsewhere.test/x", e: Date.now() + 60_000 });
  const answer = await request(`/api/v1/torrentfile/${"a".repeat(40)}?t=${wrong}`);
  assert.equal(answer.status, 403);
});

test("BRIDGE_MAX_RESOLVE=0 restores the old behaviour exactly", async () => {
  const off = { ...ENV, BRIDGE_MAX_RESOLVE: "0" };
  const none = await request("/api/v1/search?q=x&limit=50", { env: off, http: withFile() });

  assert.ok(!findPrivate(none.json()), "back to being dropped");
  assert.ok(!JSON.stringify(none.json()).includes("torrent_url"));
  const closed = await request(`/api/v1/torrentfile/${"a".repeat(40)}?t=x`, { env: off });
  assert.equal(closed.status, 404, "the route is not there either");
});

test("resolving is bounded, and never runs past the page", async () => {
  // One extra request to Prowlarr per row is the cost, so only rows a client
  // can reach are paid for.
  const shallow = withFile();
  await request("/api/v1/search?q=x&limit=1", { http: shallow });
  assert.equal(shallow.asked.filter((call) => call.bytes).length, 0, "not on page one");

  const deep = withFile();
  await request("/api/v1/search?q=x&limit=50", { http: deep });
  assert.equal(deep.asked.filter((call) => call.bytes).length, 1);
});

test("a .torrent that will not parse leaves the row unresolved rather than wrong", async () => {
  const junk = stubHttp({ status: 200, body: JSON.stringify(RELEASES) }, () => ({
    status: 200, body: new TextEncoder().encode("<html>login page</html>"),
  }));
  const answer = await request("/api/v1/search?q=x&limit=50", { http: junk });
  const body = answer.json();

  assert.ok(!findPrivate(body), "a page that is not a torrent is not a torrent");
  assert.equal(body.unresolved, 1, "reported, not silently gone");
});

test("the filters Prowlarr has no parameter for are applied here", async () => {
  const namesFor = async (search) => (await request(`/api/v1/search?${search}`)).json().torrents.map((row) => row.name);

  const seeded = await namesFor("q=x&min_seeders=500");
  assert.deepEqual(seeded, [
    "Ubuntu 24.04.1 LTS Desktop amd64 iso",
    "Some Game Deluxe Edition v1.2.3 [FitGirl Repack]",
    "Big Buck Bunny 2008 1080p BluRay x264-GRP [PROPER]",
  ]);

  const year = await namesFor("q=x&year=2008");
  assert.ok(year.every((name) => name.includes("2008")));

  const res = await namesFor("q=x&res=1080p");
  assert.ok(res.every((name) => name.includes("1080p")), res);

  // A category with no Newznab id is narrowed by name, not by Prowlarr.
  const audio = await namesFor("q=x&cat=audio");
  assert.ok(audio.some((name) => name.includes("FLAC")), audio);
});

test("sorting orders the merged set, not each indexer's slice of it", async () => {
  const seedersFirst = (await request("/api/v1/search?q=x")).json().torrents;
  assert.deepEqual(
    seedersFirst.map((row) => row.seeders ?? 0),
    [...seedersFirst.map((row) => row.seeders ?? 0)].sort((a, b) => b - a),
  );

  const bySize = (await request("/api/v1/search?q=x&sort=size")).json().torrents;
  assert.equal(bySize[0].name, "Some Game Deluxe Edition v1.2.3 [FitGirl Repack]");

  const byRecent = (await request("/api/v1/search?q=x&sort=recent")).json().torrents;
  assert.equal(byRecent[0].name, "Some Game Deluxe Edition v1.2.3 [FitGirl Repack]");
});

test("the frozen answer has not moved", async () => {
  const answer = await request("/api/v1/search?q=big+buck+bunny&limit=50");
  const body = answer.json();

  // Two fields are clock readings. Pinning them is what makes the rest of the
  // document comparable at all.
  assert.equal(typeof body.took_ms, "number");
  body.took_ms = 0;
  for (const row of body.torrents) {
    assert.match(row.scraped_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    row.scraped_at = "PINNED";
    // A third reading of the same kind: the token in `torrent_url` is sealed
    // under a fresh random IV every time, so it cannot be equal between two
    // runs and is not part of the contract. The route it names is, and that is
    // what stays in the document.
    if (row.torrent_url !== undefined) {
      const [route, token] = row.torrent_url.split("?t=");
      assert.equal(route, `https://bridge.test/api/v1/torrentfile/${row.infohash}`);
      assert.ok(token && token.length > 24, "a sealed token, not an empty one");
      row.torrent_url = `${route}?t=PINNED`;
    }
  }

  const rendered = JSON.stringify(body, null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, rendered);
    return;
  }
  assert.equal(rendered, readFileSync(GOLDEN_PATH, "utf8"));
});

// ───────────────────────────────────────────────────────────────────────────
// the key, and the other key
// ───────────────────────────────────────────────────────────────────────────

test("a missing key is 401, a wrong one is 403, and neither reaches Prowlarr", async () => {
  const missing = await request("/api/v1/search?q=x", { key: "" });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.http.asked, []);

  const wrong = await request("/api/v1/search?q=x", { key: "not-the-key-but-long-enough" });
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong.http.asked, []);
});

test("a key too short to be safe refuses to serve at all", async () => {
  const short = await request("/api/v1/search?q=x", { key: "abc", env: { ...ENV, BRIDGE_API_KEY: "abc" } });
  assert.equal(short.status, 503);
  assert.equal(short.json().error, "api_key_too_short");

  const none = await request("/api/v1/search?q=x", { key: "", env: { ...ENV, BRIDGE_API_KEY: "" } });
  assert.equal(none.status, 503);
  assert.equal(none.json().error, "not_configured");
});

test("Prowlarr refusing this bridge's key is not reported as the client's fault", async () => {
  const answer = await request("/api/v1/search?q=x", { http: stubHttp({ status: 401, body: "" }) });

  // A 401 passed through would send the reader to change the one key that was
  // never the problem.
  assert.equal(answer.status, 502);
  assert.equal(answer.json().error, "prowlarr_rejected_key");
  assert.match(answer.json().detail, /PROWLARR_APIKEY/);
});

test("an unreachable or nonsense Prowlarr says which, and says it is a server fault", async () => {
  const down = await request("/api/v1/search?q=x", { http: stubHttp({ throws: true }) });
  assert.equal(down.status, 502);
  assert.equal(down.json().error, "prowlarr_unreachable");

  const html = await request("/api/v1/search?q=x", { http: stubHttp({ status: 200, body: "<html>login</html>" }) });
  assert.equal(html.status, 502);
  assert.match(html.json().detail, /not JSON/);

  const wrong = await request("/api/v1/search?q=x", { http: stubHttp({ status: 500, body: "" }) });
  assert.equal(wrong.status, 502);
  assert.equal(wrong.json().error, "prowlarr_error");
});

test("an unset Prowlarr is a 503 that names the variable", async () => {
  for (const [missing, env] of [
    ["PROWLARR_URL", { ...ENV, PROWLARR_URL: "" }],
    ["PROWLARR_APIKEY", { ...ENV, PROWLARR_APIKEY: "" }],
  ]) {
    const answer = await request("/api/v1/search?q=x", { env });
    assert.equal(answer.status, 503, missing);
    assert.match(answer.json().detail, new RegExp(missing));
  }
});

// ───────────────────────────────────────────────────────────────────────────
// the other routes
// ───────────────────────────────────────────────────────────────────────────

test("/healthz needs no key and asks Prowlarr nothing", async () => {
  const answer = await request("/healthz", { key: "" });
  assert.equal(answer.status, 200);
  assert.equal(answer.json().status, "ok");
  // It is open, so it must not be usable to make this bridge generate traffic.
  assert.deepEqual(answer.http.asked, []);
});

test("/healthz names what is missing before anything is deployed", () => {
  assert.equal(healthz(readSettings({})).status, "not_configured");
  assert.equal(healthz(readSettings({})).api_key, "missing");
  assert.equal(healthz(readSettings({ BRIDGE_API_KEY: "abc" })).api_key, "short");
  assert.equal(healthz(settingsFrom({ PROWLARR_URL: "" })).prowlarr_url, "missing");
  assert.equal(healthz(settingsFrom()).status, "ok");
});

test("/healthz?probe=1 needs the key, and tells the network apart from the key", async () => {
  const anonymous = await request("/healthz?probe=1", { key: "" });
  assert.equal(anonymous.status, 401);

  const nothing = await probe(stubHttp({ throws: true }), settingsFrom());
  assert.equal(nothing.status, "unreachable");
  assert.equal(nothing.reachable, false);
  assert.match(nothing.detail, /home network/);

  // Up, but the key is wrong: /ping is anonymous, so it answers and the next
  // call does not. That is exactly the pair that separates the two faults.
  const refused = await probe(
    stubHttp((url) => (url.endsWith("/ping") ? { status: 200, body: '{"status":"OK"}' } : { status: 401, body: "" })),
    settingsFrom(),
  );
  assert.equal(refused.reachable, true);
  assert.equal(refused.authenticated, false);
  assert.equal(refused.status, "degraded");
  assert.match(refused.detail, /PROWLARR_APIKEY/);
});

test("/healthz?probe=1 reports which indexers Prowlarr has blocked", async () => {
  const answers = {
    "/ping": { status: 200, body: '{"status":"OK"}' },
    "/api/v1/indexer": {
      status: 200,
      body: JSON.stringify([
        { id: 1, name: "Tracker One", protocol: "torrent", enable: true },
        { id: 2, name: "Tracker Two", protocol: "torrent", enable: true },
        { id: 3, name: "Off Tracker", protocol: "torrent", enable: false },
        { id: 9, name: "An NZB Site", protocol: "usenet", enable: true },
      ]),
    },
    "/api/v1/indexerStatus": { status: 200, body: JSON.stringify([{ indexerId: 2, disabledTill: "2026-01-01T00:00:00Z" }]) },
  };
  const http = stubHttp((url) => answers[url.slice(PROWLARR.length)] || { status: 404, body: "" });

  const report = await probe(http, settingsFrom());
  assert.equal(report.status, "ok");
  assert.equal(report.authenticated, true);
  assert.equal(report.indexers, 2, "enabled torrent indexers only");
  assert.deepEqual(report.blocked, ["Tracker Two"]);

  // Everything blocked is the case Prowlarr's own search cannot report: it
  // catches the failures, logs them, and hands back an empty list.
  const allBlocked = stubHttp((url) =>
    url.endsWith("/api/v1/indexerStatus")
      ? { status: 200, body: JSON.stringify([{ indexerId: 1 }, { indexerId: 2 }]) }
      : answers[url.slice(PROWLARR.length)] || { status: 404, body: "" },
  );
  const bad = await probe(allBlocked, settingsFrom());
  assert.equal(bad.status, "degraded");
  assert.match(bad.detail, /every search will be empty/);
});

test("the odd routes behave", async () => {
  assert.equal((await request("/robots.txt", { key: "" })).body, "User-agent: *\nDisallow: /\n");
  assert.match((await request("/", { key: "" })).body, /^Prowlarr bridge /);
  assert.equal((await request("/nope")).status, 404);
  assert.equal((await request("/api/v1/search?q=x", { method: "POST" })).status, 405);
  assert.equal((await request("/api/v1/search?q=x", { method: "OPTIONS" })).status, 204);
  // Deliberately absent: a client that cannot read stats offers every category
  // chip, which is the right answer for an index that has no catalogue to count.
  assert.equal((await request("/api/v1/stats")).status, 404);
});

test("a query the contract does not allow is refused before Prowlarr is asked", async () => {
  for (const [search, code] of [
    ["q=x&cat=nonsense", "invalid_cat"],
    ["q=x&sort=nonsense", "invalid_sort"],
    ["q=x&res=999p", "invalid_res"],
    ["q=x&year=20", "invalid_year"],
  ]) {
    const answer = await request(`/api/v1/search?${search}`);
    assert.equal(answer.status, 400, search);
    assert.equal(answer.json().error, code);
    assert.deepEqual(answer.http.asked, [], "nothing goes upstream");
  }
  // Numbers are clamped rather than refused: a 422 is not in the retry contract.
  const clamped = readQuery(new URLSearchParams("q=x&limit=9999&offset=-5&min_seeders=-1"));
  assert.equal(clamped.limit, 200);
  assert.equal(clamped.offset, 0);
  assert.equal(clamped.minSeeders, 0);
});

test("CORS is granted to named origins and to nobody else", async () => {
  const ask = async (origin, env) => {
    const answer = await handle(
      "GET", "https://bridge.test/healthz", headersOf({ Origin: origin }), stubHttp(), readSettings(env),
    );
    return answer.headers["Access-Control-Allow-Origin"];
  };
  assert.equal(await ask("https://app.test", ENV), undefined);
  assert.equal(await ask("https://app.test", { ...ENV, BRIDGE_CORS_ORIGINS: "https://app.test" }), "https://app.test");
  assert.equal(await ask("https://evil.test", { ...ENV, BRIDGE_CORS_ORIGINS: "https://app.test" }), undefined);
});

// ───────────────────────────────────────────────────────────────────────────
// the shared shape
// ───────────────────────────────────────────────────────────────────────────

test("a synthesised magnet is the one the sibling project would have made", () => {
  const infohash = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c";
  assert.equal(
    magnetFor(infohash, "Big Buck Bunny"),
    `magnet:?xt=urn:btih:${infohash}&dn=Big%20Buck%20Bunny` +
      "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce" +
      "&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce" +
      "&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce" +
      "&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce" +
      "&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce",
  );
});

test("the name parser reads the six fields the contract carries", () => {
  assert.deepEqual(parseName("Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP"), {
    year: "2008", resolution: "1080p", codec: "x264", source: "bluray",
  });
  assert.deepEqual(parseName("Some.Show.S02E05.720p.HDTV.x264"), {
    resolution: "720p", codec: "x264", source: "hdtv", season: "02", episode: "05",
  });
  // A film called 2012, released in 2009: the year before the quality marker.
  assert.equal(parseName("2012.2009.1080p.BluRay").year, "2009");
  assert.deepEqual(parseName("Sintel"), {});
});

test("a name that says nothing is kept by a category filter, not dropped", () => {
  const row = (name, category = null) => ({
    name, category, infohash: "a".repeat(40), sizeBytes: 1, files: null,
    seeders: 1, leechers: null, firstSeen: null, descriptionUrl: null, sources: [], meta: null,
  });
  const rows = [row("Big Buck Bunny"), row("Some.Show.S01E01.1080p.WEB-DL"), row("A Sampler FLAC")];

  const video = applyFilters(rows, { category: "video" }).map((r) => r.name);
  assert.ok(video.includes("Big Buck Bunny"), "unreadable means no idea, not no");
  assert.ok(video.includes("Some.Show.S01E01.1080p.WEB-DL"));
  assert.ok(!video.includes("A Sampler FLAC"), "a category we can read and that disagrees is dropped");
});

test("merge keeps the earliest sighting and every contributing indexer", async () => {
  const base = {
    infohash: "b".repeat(40), sizeBytes: null, files: null, leechers: null,
    category: null, descriptionUrl: null, magnet: null, meta: null,
  };
  const [only] = merge([
    { ...base, name: "Short", seeders: 5, firstSeen: "2024-01-02T00:00:00Z", sources: ["A"] },
    { ...base, name: "A Longer Name", seeders: 9, firstSeen: "2023-01-02T00:00:00Z", sources: ["B"] },
  ]);
  assert.equal(only.name, "A Longer Name");
  assert.equal(only.seeders, 9);
  assert.equal(only.firstSeen, "2023-01-02T00:00:00Z");
  assert.deepEqual((await toTorrent(only, "PINNED")).sources, ["A", "B"]);
});
