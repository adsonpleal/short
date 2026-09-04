# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-04

Migrated from a Go binary on EC2 to Cloudflare Workers + D1. All 1018 existing links
were carried over byte-for-byte and verified individually against the old service
before cutover; the public API is unchanged.

### Changed

- Runtime is now a TypeScript Worker (`src/index.ts`) instead of a Go binary behind Caddy.
- Storage is now D1 (`links` table, `slug TEXT PRIMARY KEY`) instead of a bbolt file.
  Slug uniqueness comes from the primary key via
  `INSERT ... ON CONFLICT(slug) DO NOTHING RETURNING slug`, so a `409` is decided from
  returned data rather than by matching a database error message.
- `PORT` and `DATA_FILE` are gone. `BASE_URL` remains, joined by `REDIRECT_CACHE_TTL`.
- Random slugs now use rejection sampling. The old `b % 62` over a 0-255 byte made the
  first 8 alphabet characters ~1.6% more likely, since 256 is not a multiple of 62.

### Added

- Edge caching on the redirect path, keyed on the slug only so tracking parameters do
  not shatter the cache. 404s are never cached.
- An API-contract test suite anchored to a transcript captured from the live Go
  service, asserting exact bodies and headers.
- `cmd/export`, which reads an archived bbolt file and emits NDJSON + SQL, plus
  `scripts/verify-import.mjs` and `scripts/parity.mjs` for verifying a migration.
- Backups, via `wrangler d1 export`. The previous deployment had none.

### Behavior differences

The response transcript is otherwise byte-identical to v0.2.0, including status codes,
error strings, CORS headers, `404`/`405` routing, path cleaning, and the HTML body
`net/http` writes with a redirect. The exceptions:

- Redirects now carry `Cache-Control`, where the Go service sent none. A bare `301` is
  cached heuristically-forever by browsers; bounding it makes a future delete feasible.
- `Content-Length` is omitted on responses; the Workers runtime handles framing.
- Newly created links are normalized by WHATWG `URL` rather than Go's `net/url`, so
  `https://example.com` is stored as `https://example.com/`, hosts are lowercased,
  default ports are dropped and IDNs are punycoded. Imported links are untouched.
- `{"url":"https://x.com"} trailing garbage` was a `201` under Go's streaming decoder
  and is now a `400`.

## [0.2.0] - 2026-07-06

### Added

- CORS support (`Access-Control-Allow-Origin: *` + `OPTIONS` preflight handling) so browser apps can call `POST /api/links` cross-origin.

## [0.1.0] - 2026-07-06

### Added

- Sessionless URL shortener service in a single Go binary.
- `GET /{slug}`: 301 redirect to the stored destination URL.
- `POST /api/links`: create links with random 6-char base62 slugs or an optional custom slug.
- `GET /healthz`: health check endpoint.
- bbolt-backed storage: single database file, memory-mapped reads, flat memory usage.
- Configuration via `PORT`, `DATA_FILE`, and `BASE_URL` environment variables.
