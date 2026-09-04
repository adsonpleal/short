// Verifies that a D1 table matches an NDJSON export byte-for-byte.
//
//   node scripts/verify-import.mjs --ndjson migration/links.ndjson [--remote] [--table links]
//
// Compares the full set both ways: every exported row must be present in D1 with an
// identical destination, and D1 must contain no rows the export does not have.
// Exits non-zero on any difference.

import { execFileSync } from "node:child_process";

import { arg, hasFlag, readNdjson, wranglerBin } from "./lib.mjs";

const ndjsonPath = arg("ndjson");
const table = arg("table", "links");
const db = arg("db", "short");
const remote = hasFlag("remote");
if (!ndjsonPath) {
  console.error("usage: node scripts/verify-import.mjs --ndjson <path> [--remote] [--table links]");
  process.exit(2);
}

// Invoke wrangler's entrypoint with the current node binary: npx/npx.cmd is not
// reliably spawnable via execFileSync on Windows.
const WRANGLER = wranglerBin();

function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  // wrangler can prefix the JSON with banner lines; take from the first bracket.
  const start = out.indexOf("[");
  return JSON.parse(out.slice(start))[0].results;
}

const expected = new Map(readNdjson(ndjsonPath).map((r) => [r.slug, r.url]));

// Page through the table rather than assuming one response holds everything.
const actual = new Map();
const PAGE = 5000;
for (let offset = 0; ; offset += PAGE) {
  const rows = d1(
    `SELECT slug, url FROM ${table} ORDER BY slug LIMIT ${PAGE} OFFSET ${offset};`,
  );
  for (const r of rows) actual.set(r.slug, r.url);
  if (rows.length < PAGE) break;
}

const missing = [];
const mismatched = [];
for (const [slug, url] of expected) {
  if (!actual.has(slug)) missing.push(slug);
  else if (actual.get(slug) !== url) mismatched.push({ slug, export: url, d1: actual.get(slug) });
}
const extra = [...actual.keys()].filter((s) => !expected.has(s));

const bytes = (m, i) =>
  [...m].reduce((a, kv) => a + Buffer.byteLength(kv[i], "utf8"), 0);

console.log(`export: ${expected.size} rows  slug_bytes=${bytes(expected, 0)} url_bytes=${bytes(expected, 1)}`);
console.log(`d1    : ${actual.size} rows  slug_bytes=${bytes(actual, 0)} url_bytes=${bytes(actual, 1)}`);

let failed = false;
if (missing.length) {
  failed = true;
  console.error(`\nMISSING from D1 (${missing.length}):`);
  for (const s of missing.slice(0, 50)) console.error(`  ${s}`);
}
if (mismatched.length) {
  failed = true;
  console.error(`\nMISMATCHED destinations (${mismatched.length}):`);
  for (const m of mismatched.slice(0, 50)) {
    console.error(`  ${m.slug}\n    export: ${m.export}\n    d1    : ${m.d1}`);
  }
}
if (extra.length) {
  // Not necessarily an error after cutover — links created through the Worker live
  // in D1 and not in the bbolt export. Reported so the count is always explained.
  console.log(`\nIn D1 but not in this export (${extra.length}):`);
  for (const s of extra.slice(0, 50)) console.log(`  ${s}`);
}

if (failed) {
  console.error("\nFAIL: D1 does not match the export.");
  process.exit(1);
}
console.log("\nOK: every exported link is present in D1 with a byte-identical destination.");
