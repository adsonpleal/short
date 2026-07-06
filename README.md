# short

A tiny, sessionless URL shortener. One Go binary, one [bbolt](https://github.com/etcd-io/bbolt) database file, zero sessions — redirects are served straight from a memory-mapped key-value store.

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

Random slugs are 6 characters of base62 from `crypto/rand`.

## Configuration

Everything is environment variables — no flags, no config files.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | Listen port |
| `DATA_FILE` | `short.db` | Path to the bbolt database file |
| `BASE_URL` | `https://short.latam-tools.com.br` | Prefix used to build `short_url` in API responses |

## Build & run

```sh
go build -o short .
PORT=8081 ./short
```

Or cross-compile a static Linux binary:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o short .
```

## Deployment

Runs as a plain systemd service behind a reverse proxy that terminates TLS (Caddy, in our case). No Docker required — the binary is fully static and the only state is the single `DATA_FILE`. Memory stays flat regardless of how many links are stored, since bbolt is memory-mapped and served through the OS page cache.

## License

[MIT](LICENSE)
