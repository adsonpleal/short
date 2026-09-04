// Compares the migrated Worker against the original Go origin, slug by slug.
//
//   node scripts/parity.mjs --ndjson migration/links.ndjson \
//     --worker https://short.latam-tools.com.br \
//     --origin http://127.0.0.1:8081 \
//     [--sample 0] [--concurrency 8]
//
// Reach the Go origin through an SSH tunnel, which works regardless of DNS state and
// keeps hitting the real process even after its reverse-proxy entry is removed:
//
//   ssh -i <key> -N -L 8081:127.0.0.1:8081 <user>@<origin-host>
//
// The host and key for the (now decommissioned) origin are in the git-ignored
// deploy skill, deliberately not here.
//
// Only status and Location are compared. Full header sets never match: Cloudflare
// adds cf-ray, nel, report-to and friends. Exits non-zero on any mismatch.

import { arg, readNdjson } from "./lib.mjs";

const ndjsonPath = arg("ndjson");
const worker = (arg("worker") ?? "").replace(/\/+$/, "");
const origin = (arg("origin") ?? "").replace(/\/+$/, "");
const sample = Number(arg("sample", "0"));
const concurrency = Number(arg("concurrency", "8"));

if (!ndjsonPath || !worker) {
  console.error("usage: node scripts/parity.mjs --ndjson <path> --worker <url> [--origin <url>] [--sample N]");
  process.exit(2);
}

let rows = readNdjson(ndjsonPath);

if (sample > 0 && sample < rows.length) {
  // Deterministic-enough spread rather than a random draw, so a rerun covers the
  // same slugs and a failure is reproducible.
  const step = rows.length / sample;
  rows = Array.from({ length: sample }, (_, i) => rows[Math.floor(i * step)]);
}

// net/http hexEscapeNonASCII: the Location header carries percent-escaped bytes for
// anything >= 0x80, so the expected value is not the raw stored URL.
//
// Deliberately a second implementation rather than an import from src/index.ts: this
// is the oracle the Worker is checked against, and importing the code under test
// would make a mistake in it self-confirming.
function hexEscapeNonASCII(s) {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.every((b) => b < 0x80)) return s;
  let out = "";
  for (const b of bytes) out += b >= 0x80 ? "%" + b.toString(16) : String.fromCharCode(b);
  return out;
}

async function probe(base, slug) {
  try {
    const r = await fetch(`${base}/${encodeURIComponent(slug)}`, { redirect: "manual" });
    // Drain so the socket is released promptly.
    await r.arrayBuffer();
    return { status: r.status, location: r.headers.get("location") };
  } catch (e) {
    return { status: 0, location: null, error: String(e) };
  }
}

const failures = [];
let done = 0;
let cursor = 0;

async function runProbes() {
  for (;;) {
    const i = cursor++;
    if (i >= rows.length) return;
    const { slug, url } = rows[i];
    const want = hexEscapeNonASCII(url);

    // Independent requests to two different hosts; no reason to serialize them.
    const [w, o] = await Promise.all([
      probe(worker, slug),
      origin ? probe(origin, slug) : Promise.resolve(null),
    ]);

    const problems = [];
    if (w.status !== 301) problems.push(`worker status ${w.status}${w.error ? ` (${w.error})` : ""}`);
    if (w.location !== want) problems.push(`worker Location\n      want: ${want}\n      got : ${w.location}`);

    if (o) {
      if (o.status !== w.status) problems.push(`status differs: origin ${o.status} vs worker ${w.status}`);
      if (o.location !== w.location) {
        problems.push(`Location differs\n      origin: ${o.location}\n      worker: ${w.location}`);
      }
    }

    if (problems.length) failures.push({ slug, problems });
    if (++done % 100 === 0) process.stderr.write(`  ${done}/${rows.length}\n`);
  }
}

console.log(`Comparing ${rows.length} links`);
console.log(`  worker: ${worker}`);
console.log(`  origin: ${origin || "(skipped — no --origin)"}\n`);

await Promise.all(Array.from({ length: concurrency }, runProbes));

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} of ${rows.length} links differ\n`);
  for (const f of failures.slice(0, 50)) {
    console.error(`  ${f.slug}`);
    for (const p of f.problems) console.error(`    ${p}`);
  }
  if (failures.length > 50) console.error(`  ... and ${failures.length - 50} more`);
  process.exit(1);
}

console.log(`\nOK: all ${rows.length} links resolve identically.`);
