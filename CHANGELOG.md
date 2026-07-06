# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-06

### Added

- Sessionless URL shortener service in a single Go binary.
- `GET /{slug}`: 301 redirect to the stored destination URL.
- `POST /api/links`: create links with random 6-char base62 slugs or an optional custom slug.
- `GET /healthz`: health check endpoint.
- bbolt-backed storage: single database file, memory-mapped reads, flat memory usage.
- Configuration via `PORT`, `DATA_FILE`, and `BASE_URL` environment variables.
