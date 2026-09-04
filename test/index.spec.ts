// API-contract suite. Every expectation here is anchored to a response captured
// from the live Go service before the migration — see migration/golden.txt,
// migration/golden-create.txt and migration/NOTES.md.

import { env, SELF } from "cloudflare:test";
import schema from "../schema.sql?raw";
import { cacheKeyFor, randomSlug } from "../src/index";
import { beforeAll, describe, expect, it } from "vitest";

const BASE = "https://short.latam-tools.com.br";
const SEEDED = "https://example.com/a?x=1&y=2";

async function get(path: string, init?: RequestInit) {
  return SELF.fetch(BASE + path, { redirect: "manual", ...init });
}
async function post(bodyText: string) {
  return get("/api/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
}

beforeAll(async () => {
  // Apply the real schema rather than restating it, so a DDL change cannot leave
  // the suite validating a shape production no longer has. exec() splits on
  // newlines, which schema.sql satisfies by keeping one statement per line.
  await env.DB.exec(schema.trim());
  const rows: [string, string][] = [
    ["seeded", SEEDED],
    ["quoted", `https://example.com/?q="a"&r='b'`],
    ["unicode", "https://café.fr/caminho"],
    ["taken", "https://example.com/taken"],
  ];
  for (const [slug, url] of rows) {
    await env.DB.prepare("INSERT OR IGNORE INTO links (slug, url) VALUES (?1, ?2)").bind(slug, url).run();
  }
});

describe("static routes", () => {
  it("GET /healthz is 200 ok", async () => {
    const r = await get("/healthz");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.text()).toBe("ok\n");
  });

  it("GET / serves the banner, 94 bytes as in production", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await r.text();
    expect(body).toBe(
      'short — sessionless URL shortener. POST /api/links {"url": "https://..."} to create a link.\n',
    );
    expect(new TextEncoder().encode(body).byteLength).toBe(94);
  });

  it("HEAD /healthz has no body", async () => {
    const r = await get("/healthz", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
});

describe("method routing", () => {
  // The Go mux resolves the method mismatch from the path alone, before dispatch.
  it.each([
    ["/healthz", "POST", "GET, HEAD"],
    ["/", "POST", "GET, HEAD"],
    ["/seeded", "DELETE", "GET, HEAD"],
    ["/unknown-slug", "DELETE", "GET, HEAD"],
    ["/api/links", "GET", "POST"],
    ["/api/links", "PUT", "POST"],
  ])("%s %s is 405 with Allow: %s", async (path, method, allow) => {
    const r = await get(path, { method });
    expect(r.status).toBe(405);
    expect(r.headers.get("Allow")).toBe(allow);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.text()).toBe("Method Not Allowed\n");
  });

  it.each(["/api/foo", "/a/b", "/healthz/", "/seeded/"])("%s is 404, not 405", async (path) => {
    const r = await get(path);
    expect(r.status).toBe(404);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await r.text()).toBe("404 page not found\n");
  });

  it("redirects an unclean path to its cleaned form, preserving the query", async () => {
    const r = await get("//seeded?a=1");
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("/seeded?a=1");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("CORS", () => {
  it.each(["/api/links", "/anything-at-all", "/"])("OPTIONS %s is 204", async (path) => {
    const r = await get(path, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(r.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(r.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(await r.text()).toBe("");
  });

  it("sets the origin header on every status class", async () => {
    const responses = await Promise.all([
      get("/healthz"), // 200
      get("/seeded"), // 301
      get("/nope"), // 404
      get("/healthz", { method: "POST" }), // 405
      post("{"), // 400
      post('{"url":"https://x.dev","slug":"taken"}'), // 409
    ]);
    for (const r of responses) {
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });
});

describe("redirect", () => {
  it("301s with the stored destination and Go's HTML body", async () => {
    const r = await get("/seeded");
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe(SEEDED);
    expect(r.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // Fprintln adds a second newline; & is escaped by net/http's htmlReplacer.
    expect(await r.text()).toBe(
      '<a href="https://example.com/a?x=1&amp;y=2">Moved Permanently</a>.\n\n',
    );
  });

  it("uses Go's &#34; / &#39; escapes, not &quot; / &apos;", async () => {
    const body = await (await get("/quoted")).text();
    expect(body).toContain("&#34;");
    expect(body).toContain("&#39;");
    expect(body).not.toContain("&quot;");
  });

  it("percent-escapes non-ASCII in Location with lowercase hex", async () => {
    const loc = (await get("/unicode")).headers.get("Location")!;
    expect(loc).toBe("https://caf%c3%a9.fr/caminho");
    expect(loc).not.toMatch(/%C3/);
  });

  it("ignores the query string", async () => {
    const r = await get("/seeded?utm_source=newsletter");
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe(SEEDED);
  });

  it("decodes percent-encoding in the slug", async () => {
    const r = await get("/%73eeded"); // %73 == 's'
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe(SEEDED);
  });

  it("HEAD gets the headers but no body", async () => {
    const r = await get("/seeded", { method: "HEAD" });
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe(SEEDED);
    expect(await r.text()).toBe("");
  });

  it("sends no Cache-Control when the TTL is 0", async () => {
    expect((await get("/seeded")).headers.get("Cache-Control")).toBeNull();
  });

  it("404s an unknown slug", async () => {
    const r = await get("/definitely-not-a-slug");
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("404 page not found\n");
  });
});

describe("create — success", () => {
  it("mints a 6-char base62 slug and returns Go's JSON shape", async () => {
    const r = await post('{"url":"https://example.com/x"}');
    expect(r.status).toBe(201);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    const text = await r.text();
    expect(text).toMatch(
      /^\{"slug":"[0-9A-Za-z]{6}","short_url":"https:\/\/short\.latam-tools\.com\.br\/[0-9A-Za-z]{6}"\}\n$/,
    );
    const { slug } = JSON.parse(text);
    const row = await env.DB.prepare("SELECT url FROM links WHERE slug = ?1").bind(slug).first<string>("url");
    expect(row).toBe("https://example.com/x");
  });

  it("accepts a custom slug and echoes it", async () => {
    const r = await post('{"url":"https://example.com/docs","slug":"docs"}');
    expect(r.status).toBe(201);
    expect(JSON.parse(await r.text())).toEqual({
      slug: "docs",
      short_url: "https://short.latam-tools.com.br/docs",
    });
  });

  it("accepts a 64-char slug and rejects 65", async () => {
    expect((await post(`{"url":"https://x.dev","slug":"${"a".repeat(64)}"}`)).status).toBe(201);
    expect((await post(`{"url":"https://x.dev","slug":"${"b".repeat(65)}"}`)).status).toBe(400);
  });

  it("matches JSON keys case-insensitively, as encoding/json does", async () => {
    // Confirmed against production: {"URL": ...} creates a link.
    const r = await post('{"URL":"https://example.com/caps","Slug":"caps"}');
    expect(r.status).toBe(201);
    expect(JSON.parse(await r.text()).slug).toBe("caps");
  });

  it("accepts a body of exactly 4096 bytes", async () => {
    const prefix = '{"url":"https://example.com/?q=';
    const suffix = '"}';
    const pad = "a".repeat(4096 - prefix.length - suffix.length);
    const r = await post(prefix + pad + suffix);
    expect(r.status).toBe(201);
  });
});

describe("create — errors", () => {
  it.each(['{', '', '[]', '123', '"str"', '{"url":123}', '{"url":"https://x.dev","slug":5}'])(
    "%s is 400 invalid JSON body",
    async (body) => {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(await r.text()).toBe('{"error":"invalid JSON body"}\n');
    },
  );

  it("rejects a body over 4096 bytes", async () => {
    const r = await post(`{"url":"https://example.com/?q=${"a".repeat(4100)}"}`);
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"error":"invalid JSON body"}\n');
  });

  // null and {} reach the URL check in Go, because both unmarshal to the zero value.
  it.each([
    "null",
    "{}",
    '{"url":null}',
    '{"url":"ftp://x.com"}',
    '{"url":"/relative"}',
    '{"url":"example.com"}',
    '{"url":"http://"}',
    '{"url":"https:example.com"}',
    '{"url":"https:///x"}',
  ])("%s is 400 url must be absolute", async (body) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"error":"url must be an absolute http(s) URL"}\n');
  });

  it.each(["api", "healthz", "has space", "a/b", "ok\\n", "a".repeat(65)])(
    "slug %j is 400",
    async (slug) => {
      const r = await post(JSON.stringify({ url: "https://x.dev", slug }));
      expect(r.status).toBe(400);
      expect(await r.text()).toBe(
        '{"error":"slug must match [A-Za-z0-9_-]{1,64} and not be reserved"}\n',
      );
    },
  );

  it("409s a slug already in use", async () => {
    const r = await post('{"url":"https://example.com/other","slug":"taken"}');
    expect(r.status).toBe(409);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    expect(await r.text()).toBe('{"error":"slug already in use"}\n');
  });

  it("leaves the original destination intact after a 409", async () => {
    await post('{"url":"https://evil.example/hijack","slug":"taken"}');
    const row = await env.DB.prepare("SELECT url FROM links WHERE slug = 'taken'").first<string>("url");
    expect(row).toBe("https://example.com/taken");
  });
});

describe("concurrency", () => {
  // Proves the ON CONFLICT ... RETURNING statement is atomic: exactly one winner.
  it("gives exactly one 201 for 20 simultaneous creates of the same slug", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(`{"url":"https://example.com/race/${i}","slug":"race"}`).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 201)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(19);
  });
});

describe("slug generator", () => {
  it("is uniform over base62 — the assertion Go's biased generator would fail", () => {
    const counts = new Map<string, number>();
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const slug = randomSlug();
      expect(slug).toHaveLength(6);
      for (const ch of slug) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }

    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    expect(counts.size).toBe(62);
    for (const ch of alphabet) expect(counts.has(ch)).toBe(true);

    // Go's `b % 62` makes '0'-'7' ~1.6% more likely than the other 54 characters.
    // Over 120k sampled characters that gap is far outside sampling noise, so this
    // assertion is what distinguishes rejection sampling from the old generator.
    const biased = [..."01234567"].reduce((a, c) => a + (counts.get(c) ?? 0), 0) / 8;
    const rest = [...alphabet.slice(8)].reduce((a, c) => a + (counts.get(c) ?? 0), 0) / 54;
    expect(Math.abs(biased - rest) / rest).toBeLessThan(0.01);
  });

  it("mints slugs that are unique in practice", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => randomSlug()));
    expect(seen.size).toBe(5000);
  });
});

describe("cache key", () => {
  // The Cache API is a no-op under this pool, so the hit/put path cannot be
  // exercised here. The key is the part with a real design decision in it, and it is
  // a pure function — so pin the property that decision was made for.
  it("collapses tracking-parameter variants of one link onto a single entry", () => {
    const a = cacheKeyFor(new URL("https://s.example/abc?utm_source=newsletter"), "abc");
    const b = cacheKeyFor(new URL("https://s.example/abc?utm_source=twitter"), "abc");
    const bare = cacheKeyFor(new URL("https://s.example/abc"), "abc");
    expect(a.url).toBe(b.url);
    expect(a.url).toBe(bare.url);
    expect(a.url).toBe("https://s.example/abc");
  });

  it("keeps distinct slugs on distinct entries, and re-encodes the decoded slug", () => {
    const x = cacheKeyFor(new URL("https://s.example/x"), "x");
    const y = cacheKeyFor(new URL("https://s.example/y"), "y");
    expect(x.url).not.toBe(y.url);
    // /%73eeded and /seeded decode to one slug and so must share one entry.
    expect(cacheKeyFor(new URL("https://s.example/%73eeded"), "seeded").url).toBe(
      cacheKeyFor(new URL("https://s.example/seeded"), "seeded").url,
    );
  });
});
