# short

A tiny, sessionless URL shortener running on Cloudflare Workers, with links stored in
[D1](https://developers.cloudflare.com/d1/). Redirects are served from the edge, with
a short-lived cache in front of the database lookup.

## How it works

- `GET /{slug}` — `301` redirect to the stored destination, `404` if the slug is unknown.
- `POST /api/links` — create a link:

  ```sh
  curl -X POST https://short.latam-tools.com.br/api/links \
    -d '{"url": "https://example.com/some/very/long/path"}'
  # → {"slug":"x7Kf2a","short_url":"https://short.latam-tools.com.br/x7Kf2a"}
  ```

  Pass a custom slug if you want one (`[A-Za-z0-9_-]{1,64}`, `409` if taken):

  ```sh
  curl -X POST https://short.latam-tools.com.br/api/links \
    -d '{"url": "https://example.com", "slug": "docs"}'
  ```

- `GET /healthz` — health check, returns `200 ok`.

The API is public and sessionless: no auth, no rate limit, `Access-Control-Allow-Origin: *`.

Random slugs are 6 characters of base62 from `crypto.getRandomValues`, drawn with
rejection sampling so the distribution is exactly uniform. Slug uniqueness comes from
the table's primary key — a create is a single
`INSERT ... ON CONFLICT(slug) DO NOTHING RETURNING slug`, so a taken slug returns no
row and becomes a `409` without any error-string matching.

Links are immutable: there is no update or delete endpoint.

## Configuration

Set in `wrangler.jsonc` under `vars`.

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `https://short.latam-tools.com.br` | Prefix used to build `short_url` in API responses |
| `REDIRECT_CACHE_TTL` | `300` | Seconds to cache a redirect at the edge; `0` disables caching entirely |

The D1 binding is `DB`. Schema is one table:

```sql
CREATE TABLE links (slug TEXT PRIMARY KEY NOT NULL, url TEXT NOT NULL);
```

`NOT NULL` is not redundant — SQLite rowid tables otherwise allow NULL in a TEXT
primary key. The collation is the default `BINARY`, never `NOCASE`: `Docs` and `docs`
are distinct slugs.

## Develop, test, deploy

```sh
npm install
npm test              # API-contract suite against a local D1
npm run dev           # wrangler dev on :8787
npm run deploy
```

`npx wrangler types` regenerates `worker-configuration.d.ts` after a config change.

The test suite is a port of the original Go service's observable behavior, anchored to
a response transcript captured from the live service before the migration. It asserts
exact bodies and headers, including the HTML body `net/http` writes with a redirect
and Go's `&#34;`/`&#39;` escapes.

## Backups

```sh
npx wrangler d1 export short --remote --output backup-$(date +%F).sql
```

Worth doing periodically — the pre-migration deployment had no backups at all.

## The Go module

`cmd/export` is the only Go code left. It reads a bbolt database written by the
original service and emits NDJSON plus idempotent SQL, so the archived `short.db`
snapshots stay readable. It is not part of running the service.

```sh
go run ./cmd/export -db short.db -ndjson links.ndjson -sql links.sql
```

The stderr summary (`links=… slug_bytes=… url_bytes=…`) is a byte-level checksum to
compare against the imported table.

## History

Originally a single Go binary with a memory-mapped bbolt file, running as a systemd
service behind Caddy on EC2. Migrated to Workers + D1 in v0.3.0; see `CHANGELOG.md`.

## License

[MIT](LICENSE)
