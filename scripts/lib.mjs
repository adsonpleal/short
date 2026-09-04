// Shared helpers for the one-shot migration scripts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Reads --name value and --name=value. The bare indexOf form these scripts used
// silently mis-parsed the = spelling.
export function arg(name, fallback) {
  const prefix = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === prefix) return process.argv[i + 1];
    if (a.startsWith(prefix + "=")) return a.slice(prefix.length + 1);
  }
  return fallback;
}

export const hasFlag = (name) => process.argv.includes(`--${name}`);

// One reader for the export format, so the scripts cannot disagree about what a
// malformed export means — before this, one exited 1 on a duplicate slug while the
// other silently kept the last copy and reported a clean pass over a shorter set.
export function readNdjson(path) {
  const rows = [];
  const seen = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { slug, url } = JSON.parse(line);
    if (seen.has(slug)) {
      console.error(`FATAL: duplicate slug in ${path}: ${slug}`);
      process.exit(1);
    }
    seen.add(slug);
    rows.push({ slug, url });
  }
  return rows;
}

// fileURLToPath rather than hand-stripping the drive letter off .pathname, which
// leaves percent-encoding intact and so breaks on a checkout path containing a space.
export const wranglerBin = () =>
  fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
