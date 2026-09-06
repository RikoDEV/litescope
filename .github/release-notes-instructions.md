# Release notes style guide

liteScope is a self-hosted MeshCore mesh network monitoring dashboard, made of
two independent Go processes (`cmd/ingestor`, `cmd/server`) sharing one SQLite
file, plus a React SPA frontend. Group and describe changes with that
architecture in mind.

## Structure

Group entries under these headings, in this order, omitting any heading with
no entries for this release:

- **Ingestor / decoder** — MQTT ingest, MeshCore packet decoding, observer
  handling (`backend/internal/decoder`, `cmd/ingestor`)
- **Server / API** — REST/WebSocket endpoints, the in-memory store, analytics
  (`backend/internal/store`, `cmd/server`)
- **Frontend** — React SPA, maps, packet feed, decoder UI
- **Docker / deployment** — Dockerfiles, compose files, Caddy/nginx, env config
- **Fixes** — bug fixes not covered above
- **Other** — everything else (CI, dependencies, docs)

## Tone

- One line per change, imperative mood ("Add", "Fix", "Improve"), no filler.
- Describe user-visible or operator-visible impact, not implementation detail
  (e.g. "Fix duplicate packets appearing after reconnect", not "add mutex
  around AddTxBatch").
- Reference the PR number at the end of each line: `(#123)`.
- Skip purely internal refactors, formatting, and test-only changes unless
  they fix a user-facing bug.
- Flag anything you're not confident about instead of guessing.
