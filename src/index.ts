// short — sessionless URL shortener, on Cloudflare Workers + D1.
//
// This is a behavior-for-behavior port of the original Go service (main.go, v0.2.0).
// Response bodies and headers reproduce net/http's output byte-for-byte, verified
// against a transcript captured from production before the migration (see
// migration/NOTES.md). Where this file deliberately diverges from Go, the comment
// says so.

// Env is generated from wrangler.jsonc by `npx wrangler types` into
// worker-configuration.d.ts, so the bindings here cannot drift from the config.

// Top-level paths the router owns. RESERVED is derived from them, so adding a route
// cannot leave a slug able to shadow it.
const ROUTE_PATHS = ["/", "/healthz", "/api/links"] as const;
const RESERVED = new Set(ROUTE_PATHS.map((p) => p.split("/")[1]).filter(Boolean));

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SLUG_LEN = 6;
const MAX_BODY = 4 << 10;
const MAX_SLUG_ATTEMPTS = 5;
const DEFAULT_BASE_URL = "https://short.latam-tools.com.br";
const BANNER =
  'short — sessionless URL shortener. POST /api/links {"url": "https://..."} to create a link.\n';

// A single atomic statement: ON CONFLICT DO NOTHING suppresses the constraint error
// entirely, and RETURNING emits a row only for rows actually inserted. So a null
// result means "slug taken" as *data*, with no error-message parsing — D1's error
// shape has changed across releases and is not safe to match on.
const INSERT_SQL =
  "INSERT INTO links (slug, url) VALUES (?1, ?2) ON CONFLICT(slug) DO NOTHING RETURNING slug";
const SELECT_SQL = "SELECT url FROM links WHERE slug = ?1";

const ENCODER = new TextEncoder();

// ---------------------------------------------------------------- response helpers

// The API is public and sessionless, so any origin may call it.
function corsHeaders(init?: Record<string, string>): Headers {
  const h = new Headers(init);
  h.set("Access-Control-Allow-Origin", "*");
  return h;
}

function textOK(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

// mirrors http.Error(): text/plain, nosniff, trailing newline
function goError(status: number, msg: string, extra?: Record<string, string>): Response {
  const h = corsHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  return new Response(msg + "\n", { status, headers: h });
}

const notFound = () => goError(404, "404 page not found");
const methodNotAllowed = (allow: string) => goError(405, "Method Not Allowed", { Allow: allow });

// mirrors json.NewEncoder(w).Encode(...), which appends a trailing newline. Object
// key order is insertion order, matching Go's struct field order.
function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload) + "\n", {
    status,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

const jsonError = (status: number, msg: string) => jsonResponse(status, { error: msg });

// net/http hexEscapeNonASCII: bytes >= 0x80 become "%" + lowercase 2-digit hex.
// Destinations run to ~2 KB and are pure ASCII in practice, so test before encoding
// rather than allocating a byte copy of every URL to discover there is nothing to do.
function hexEscapeNonASCII(s: string): string {
  if (!/[^\x00-\x7F]/.test(s)) return s;
  let out = "";
  for (const b of ENCODER.encode(s)) {
    out += b >= 0x80 ? "%" + b.toString(16) : String.fromCharCode(b);
  }
  return out;
}

// net/http htmlReplacer — note &#34; / &#39;, not &quot; / &apos;. Escaping & first
// is why the sequential form never re-escapes its own output; a single pass over the
// character class does the same thing in one scan instead of five.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&#34;",
  "'": "&#39;",
};
const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// mirrors http.Redirect(w, r, dest, 301): the HTML body is written for GET only, and
// Fprintln adds a second newline on top of the one already in the string.
function goRedirect(dest: string, withBody: boolean): Response {
  const h = corsHeaders({
    Location: hexEscapeNonASCII(dest),
    "Content-Type": "text/html; charset=utf-8",
  });
  const body = withBody ? `<a href="${htmlEscape(dest)}">Moved Permanently</a>.\n\n` : null;
  return new Response(body, { status: 301, headers: h });
}

// ---------------------------------------------------------------- path handling

// Go's path.Clean via net/http's cleanPath: collapse duplicate slashes, resolve "."
// and "..", preserve a trailing slash. The first line keeps the overwhelmingly common
// already-clean path allocation-free. What follows transcribes the Go original, so
// its leading-slash handling stays even though new URL() always supplies one.
function cleanPath(p: string): string {
  if (p.startsWith("/") && !p.includes("//") && !p.includes("/.")) return p;
  if (p === "") return "/";
  if (!p.startsWith("/")) p = "/" + p;
  const trailing = p.length > 1 && p.endsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  let np = "/" + out.join("/");
  if (trailing && np !== "/") np += "/";
  return np;
}

// ---------------------------------------------------------------- slug + url

// Base62 from crypto/rand. Diverges from Go deliberately: Go's `b % 62` over a
// 0..255 byte skews the first 8 alphabet characters ~1.6% high, because 256 is not
// a multiple of 62. Rejecting bytes >= 248 (4*62) makes it exactly uniform. Slugs
// are opaque, so nothing depends on reproducing the old bias.
export function randomSlug(): string {
  const out: string[] = [];
  const buf = new Uint8Array(SLUG_LEN * 2);
  let i = buf.length;
  while (out.length < SLUG_LEN) {
    if (i >= buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    const b = buf[i++];
    if (b < 248) out.push(ALPHABET[b % 62]);
  }
  return out.join("");
}

// Go requires a literal "scheme://host". url.Parse("https:example.com") yields an
// opaque URL with Host == "", which the Go handler rejects — but WHATWG's special-
// scheme rules would happily collapse it to https://example.com/ and turn a 400 into
// a 201. The guard closes that gap before new URL() ever runs. The two checks after
// the parse are unreachable behind that guard today, and kept deliberately: this
// function is all that stands between an open API and an arbitrary-scheme redirect,
// so it should not depend on one regex being right.
function normalizeURL(input: string): string | null {
  if (!/^https?:\/\/[^/\\?#]/i.test(input)) return null;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.hostname === "") return null;
  return u.href;
}

// encoding/json matches an exact key first, then falls back to a case-insensitive
// match. Confirmed against production: {"URL": "..."} creates a link.
function pick(obj: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return undefined;
}

// ---------------------------------------------------------------- handlers

// Keyed on origin and slug, never the request URL: the Go service ignores the query
// string on redirect, and shared links arrive drenched in utm_* parameters that would
// otherwise shatter one link's cache entry across unlimited variants.
export function cacheKeyFor(url: URL, slug: string): Request {
  return new Request(`${url.origin}/${encodeURIComponent(slug)}`, { method: "GET" });
}

async function redirect(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  method: string,
): Promise<Response> {
  const ttl = Number(env.REDIRECT_CACHE_TTL) || 0;
  const withBody = method === "GET";
  // HEAD is left out of the cache because its response has no body to store.
  const cacheable = ttl > 0 && withBody;

  if (cacheable) {
    const hit = await caches.default.match(cacheKeyFor(url, slug));
    if (hit) return hit;
  }

  let dest: string | null;
  try {
    dest = await env.DB.prepare(SELECT_SQL).bind(slug).first<string>("url");
  } catch (e) {
    // The Go version discards the read error and falls through to 404. Log it here
    // (a silent 404 on a storage failure is a bad debugging experience) but keep the
    // same response.
    console.error("redirect lookup:", e);
    return notFound();
  }

  // Never cache a 404: a slug can go missing -> present via the create path, and
  // cache.delete only purges the colo that runs it.
  if (dest == null || dest === "") return notFound();

  const resp = goRedirect(dest, withBody);
  if (ttl > 0) resp.headers.set("Cache-Control", `public, max-age=${ttl}`);
  if (cacheable) ctx.waitUntil(caches.default.put(cacheKeyFor(url, slug), resp.clone()));
  return resp;
}

async function createLink(request: Request, env: Env): Promise<Response> {
  // http.MaxBytesReader(w, r.Body, 4<<10): oversize surfaces as a decode failure in
  // Go, which maps to "invalid JSON body". The declared-length check is what stops a
  // huge body being buffered at all; the byte-length check is the authority, since a
  // chunked request arrives without a length.
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY) return jsonError(400, "invalid JSON body");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return jsonError(400, "invalid JSON body");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return jsonError(400, "invalid JSON body");
  }

  // Go: `null` unmarshals into the zero-value struct and falls through to the URL
  // check; arrays, numbers and strings are type errors.
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    return jsonError(400, "invalid JSON body");
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  // Absent and JSON null both collapse to "", matching Go's zero value; anything
  // present but not a string is an UnmarshalTypeError.
  const rawURL = pick(body, "url") ?? "";
  const rawSlug = pick(body, "slug") ?? "";
  if (typeof rawURL !== "string" || typeof rawSlug !== "string") {
    return jsonError(400, "invalid JSON body");
  }

  const dest = normalizeURL(rawURL);
  if (dest === null) return jsonError(400, "url must be an absolute http(s) URL");

  if (rawSlug !== "" && (!SLUG_RE.test(rawSlug) || RESERVED.has(rawSlug))) {
    return jsonError(400, "slug must match [A-Za-z0-9_-]{1,64} and not be reserved");
  }

  const stmt = env.DB.prepare(INSERT_SQL);
  try {
    if (rawSlug !== "") {
      const row = await stmt.bind(rawSlug, dest).first<{ slug: string }>();
      return row === null ? jsonError(409, "slug already in use") : created(env, rawSlug);
    }
    // Go retries forever inside the write transaction; a bounded loop cannot wedge a
    // request, and 5 consecutive collisions is not a reachable event at 62^6.
    for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
      const candidate = randomSlug();
      // Dead while every reserved name has a length other than SLUG_LEN, but the two
      // are independent: a future route could be exactly six characters long.
      if (RESERVED.has(candidate)) continue;
      const row = await stmt.bind(candidate, dest).first<{ slug: string }>();
      if (row !== null) return created(env, candidate);
    }
    console.error("create link: exhausted random slug attempts");
    return jsonError(500, "internal error");
  } catch (e) {
    console.error("create link:", e);
    return jsonError(500, "internal error");
  }
}

function created(env: Env, slug: string): Response {
  const base = (env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return jsonResponse(201, { slug, short_url: `${base}/${slug}` });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const method = request.method;

    // withCORS wraps the whole mux, so OPTIONS short-circuits before any routing —
    // OPTIONS /literally-anything is a 204.
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders({
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        }),
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ServeMux redirects an unclean path to its cleaned form before dispatching,
    // for every method, with a relative Location and the query preserved.
    const cleaned = cleanPath(path);
    if (cleaned !== path) return goRedirect(cleaned + url.search, method === "GET");

    const isRead = method === "GET" || method === "HEAD";

    if (path === "/") {
      return isRead ? textOK(BANNER) : methodNotAllowed("GET, HEAD");
    }
    if (path === "/healthz") {
      return isRead ? textOK("ok\n") : methodNotAllowed("GET, HEAD");
    }
    if (path === "/api/links") {
      return method === "POST" ? createLink(request, env) : methodNotAllowed("POST");
    }

    const seg = path.slice(1);
    // GET /{slug} matches exactly one segment: /a/b and /api/foo are 404, not 405.
    // seg is never "" here, since path === "/" already returned above.
    if (seg.includes("/")) return notFound();
    // The method check precedes the storage lookup, matching the mux: DELETE on an
    // unknown slug is 405, not 404.
    if (!isRead) return methodNotAllowed("GET, HEAD");

    let slug: string;
    try {
      slug = decodeURIComponent(seg);
    } catch {
      return notFound();
    }
    return redirect(url, env, ctx, slug, method);
  },
} satisfies ExportedHandler<Env>;
