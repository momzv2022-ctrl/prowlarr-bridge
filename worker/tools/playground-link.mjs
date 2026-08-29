/**
 * Generate — and check — a Cloudflare Workers playground link.
 *
 *     node worker/tools/playground-link.mjs --self-test
 *     node worker/tools/playground-link.mjs worker/src/worker.js
 *
 * The format itself lives in `worker/tools/playground.js`, which the setup page
 * inlines. This is the command line over it, plus the self-test that pins the
 * compressor to `lz-string` 1.5.0's own output.
 *
 * See `docs/deploy-link.md` for how the format was established and what is still
 * worth re-checking.
 */

import { readFileSync } from "node:fs";

import { compressToEncodedURIComponent, deployLink, playgroundLink, playgroundPayload, suggestedName } from "./playground.js";

export { compressToEncodedURIComponent, deployLink, playgroundLink, playgroundPayload, suggestedName };

/**
 * Captured from `lz-string` 1.5.0's own `compressToEncodedURIComponent`. If this
 * implementation stops agreeing with them it has drifted from the format,
 * whatever the playground happens to accept that week.
 */
export const VECTORS = [
  ["", "Q"],
  ["a", "IZA"],
  ["hello", "BYUwNmD2Q"],
  ["Hello, World!", "BIUwNmD2A0AEDqkBOYAmBCIA"],
  ["aaaaaaaaaaaaaaaaaaaa", "IY1-kA"],
  ["export default { fetch() {} }", "KYDwDg9gTgLgBAE2AMwIYFcA28DednAwDGAFgBQCUcOAvnDUA"],
  ["日本語のテスト", "qemhpzR5UYdgyGMMidDIEwxA"],
  ['{"a":1,"b":[2,3]}', "N4IghiBcCMA0ICMoG0BMsDMBdAvkA"],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];

  if (target === "--self-test") {
    let failures = 0;
    for (const [input, expected] of VECTORS) {
      const actual = compressToEncodedURIComponent(input);
      if (actual !== expected) {
        failures += 1;
        console.error(`FAIL ${JSON.stringify(input)}\n  expected ${expected}\n  actual   ${actual}`);
      }
    }
    if (failures) process.exit(1);
    console.log(`ok — ${VECTORS.length} vectors match lz-string 1.5.0`);
  } else if (target) {
    const source = readFileSync(target, "utf8");
    // `--deploy` skips the editor and opens Cloudflare's deploy screen instead.
    const wantsDeploy = process.argv.includes("--deploy");
    const url = wantsDeploy ? deployLink(source) : playgroundLink(source);
    console.log(`source:    ${source.length.toLocaleString()} characters`);
    console.log(`URL:       ${url.length.toLocaleString()} characters`);
    console.log(`opens:     ${wantsDeploy ? "the deploy screen (no preview)" : "the playground editor"}`);
    console.log("");
    console.log(url);
  } else {
    console.error("usage: playground-link.mjs [--self-test | <file> [--deploy]]");
    process.exit(2);
  }
}
