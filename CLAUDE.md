# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

liteScope is a self-hosted dashboard for monitoring [MeshCore](https://meshcore.io/) mesh networks. It ingests MQTT telemetry from one or more MeshCore brokers, stores it in SQLite, and serves a real-time React UI (live packet feed, node/observer/channel analytics, maps, packet decoder).

## Architecture (the big picture)

Two **independent Go processes share one SQLite file** — they do not talk directly:

```
MQTT broker(s) ──▶ ingestor (cmd/ingestor) ──writes──▶ SQLite ◀──reads (1s poll)── server (cmd/server) ──REST + WS──▶ React SPA
```

- **`cmd/ingestor`** subscribes to MQTT, decodes each MeshCore packet (`internal/decoder`), and writes a transmission + per-observer observation row. It is the **only writer**. Topic shape is `meshcore/<region>/<observerID>/...`; a `raw` hex field carries the packet, a `.../status` topic carries observer metadata.
- **`cmd/server`** loads the whole DB into an in-memory `internal/store.Store` at startup, then **polls SQLite every second** (`LoadSince`) for rows with `id` greater than its high-water marks (`lastTxID`/`lastObsID`), merges them, and pushes new/updated packets to browsers over WebSocket. It serves all REST under `/api/*` and the socket at `/ws`. It never writes packet data.
- **`frontend`** is a React 19 + Vite + MUI v9 SPA served as static files (Caddy/nginx in Docker, or Cloudflare Pages). `services/api.ts` wraps REST; `services/stream.ts` is a singleton WebSocket client with auto-reconnect.

Because there are two processes, **`internal/db` and `internal/store` are duplicated dependencies** of both binaries, and `db.Open` runs the schema migration on every start (guarded — see below).

### The in-memory Store is the heart of the read path

`internal/store/store.go` holds everything in RAM behind a single `sync.RWMutex` and maintains several indexes that must stay consistent on every mutation (`Load`, `AddTxBatch`, `Prune`):

- `packets` (append-order ≈ first-seen), `byHash`, `byTxID`, `byObsID`
- `byObserver` (per-observer obs), `byNode` (per-pubkey adverts), `byRelayHop` (hex hash-prefix → packets that relayed through it) + `relayHopLengths`

Concurrency invariants — **respect these when adding fields or indexes**:
- Everything a read path needs per row is computed **once under the write lock** in `txFromRow`/`obsFromRow`/`AddTxBatch`, so read-lock holders treat it as immutable: `DecodedPayload`, `Tx.FirstSeenMs`/`Obs.TimestampMs` (parsed times — never `time.Parse` a row timestamp in a scan), `Obs.Path` plus `Obs.hopKeys` (aligned lowercase interned hex hop keys, `""` for non-hex hops — never `ToLower`/`isHexHop` per hop in a scan), and the cached `Tx.BestObservation()` (`Tx.best`, an atomically swapped immutable value refreshed whenever observations are appended). Never `json.Unmarshal` a path or decoded blob in a read path.
- `Obs` is deliberately compact (the whole history is in RAM; pointers = GC work): RSSI/SNR/Score are values with `Has*` flags, repeated strings are interned (`Store.internStr`), and per-observation `raw_hex`/`path_json` are **not** held in memory — `LoadAll`/`LoadSince` skip `raw_hex`, the packet-detail endpoint fetches it via `db.ObservationRawHex`, and `Obs.PathJSON()` re-encodes `Path`.
- Time-windowed scans start at `s.txsSince(sinceMs)` (binary search on `firstSeenPrefixMax`, the running max of `FirstSeenMs`) — exact even though `packets` is only approximately first-seen ordered. Keep `appendPacket`/`rebuildFirstSeenPrefixMax` in sync when changing `packets`.
- Some per-request lookups are maintained incrementally instead of scanned: `obsIATACount` (IATAs) and `nodeRegionCount` (NodeRegions/NodeRegionsAll) are updated in `Load`/`AddTxBatch` and decremented in `Prune`. `indexByNode`/`indexSrcHash` run exactly once per transmission (when it's added), not per observation.
- Analytics are memoized by `cachedAnalytics`/`cachedAnalyticsForFilter`, keyed on an `atomic.Uint64` `version` bumped on every mutation, **plus** a freshness TTL (`analyticsCacheTTL`, default 30s, config `analyticsCacheTTLSeconds`). Past the TTL the stale value is served immediately while **one** background refresh runs (stale-while-revalidate); only a cold miss blocks. Computations hold a `computeSem` slot (≈ GOMAXPROCS/2) — a cached lookup made *inside* another computation must use `cachedByVersionNested` or it can deadlock. `compute()` runs outside the cache lock. `nodeVersion` (node-geometry caches: geo distances, coverage repeater index) bumps only on node add/remove or name/role/position changes, not `LastSeen` churn.
- Nodes are never mutated in place after publication: updates and location repair swap in a new `*Node` (repair is computed under the read lock, applied under the write lock). The API's encoded-response cache (`api/respcache.go`, keyed on `Store.CacheGeneration()`) relies on this.
- Relayed-packet / retransmit / self-hash logic matches a node by **hex hash-prefix** (a routing hop is a short prefix of a pubkey), so a hop can collide with several nodes — this is inherent, not a bug.

### Polling invariant (data-integrity critical)

`AddTxBatch` must **not** advance `lastObsID` past an observation whose transmission isn't loaded yet (the two `LoadSince` queries can race a concurrent insert between them). It `break`s on the first such gap so the next poll re-reads and links it. Don't "optimize" this into skipping/continuing — that silently orphans observations.

### Other cross-cutting pieces

- **Wardrive coverage** (`internal/wardrive`, `store/coverage.go`) — MeshMapper "Custom API" pings. The ingestor hosts the HTTP endpoint on `wardrive.listen` (keeping it the only writer); the server forwards `POST /api/wardrive` to it via a reverse proxy and polls `wardrive_samples` by id like packets. Coverage samples have their **own lock and version** (`Store.cov`), so never nest `cov.mu` inside `s.mu`. Plausibility (known repeater within range, device speed) is applied at read time in `computeCoverage`, not at ingest, so it re-evaluates as the node registry changes.
- **`internal/decoder`** — pure MeshCore binary decode + AES-128 channel decryption. `ComputeContentHash` is the dedup key for a transmission (`observations.raw_hex` differs per hop, so the same packet has many observation rows but one transmission).
- **`internal/geo`** — embedded Natural-Earth polygons + ray-casting `CountryAt(lat,lon)`, memoized on a grid. Used for "strict" geographic (country) filtering, distinct from observer-region (IATA) filtering.
- **`observation_count`** means *unique observers*, not raw row count. Both the DB increment logic and `BestObservation` enforce this.
- **Analytics filter** (`store.AnalyticsFilter`, built by `analyticsFilter()` in handlers) is shared by every `/api/analytics/*` endpoint: `hours` window, `regions` (observer IATA), `countries` (ISO-A2 geo), `lock` (exclusive region match).
- **Retention** (`config.retentionDays`, default 0 = unlimited): server prunes the in-memory store (`Store.Prune`), ingestor prunes the DB (`db.PruneOlderThan`), both hourly. Nodes/observers and their lifetime counters are kept.

## Commands

### Backend (`cd backend`, Go 1.26, **CGO disabled** — `modernc.org/sqlite` is pure Go)

```bash
go build ./...                 # build both binaries
go vet ./...                   # CI gate
go test ./...                  # unit tests (store + geo)
go test ./internal/store/ -run TestPrune -v   # single test
go test ./internal/store/ -run '^$' -bench . -benchmem -benchtime=3x   # analytics benchmarks (synthetic 200k tx / 1M obs)

# Run locally (point both at the same config; they share the DB)
go run ./cmd/ingestor -config ../config.json &
go run ./cmd/server   -config ../config.json

# Race detector needs a C compiler; the store has a race test for the lock model:
CGO_ENABLED=1 go test -race ./internal/store/
```

**Modernization:** the backend is kept clean against the Go `modernize` analyzer. After backend changes, run and fix:
```bash
go run golang.org/x/tools/go/analysis/passes/modernize/cmd/modernize@latest -fix ./...
# note: -fix gofmt-reformats every file it touches; revert whitespace-only changes to keep the manual alignment
```
CI builds with `CGO_ENABLED=0 go build -ldflags="-s -w"`.

### Frontend (`cd frontend`, Node 22+, pnpm/npm)

```bash
pnpm install
pnpm run dev        # Vite dev server :5173, proxies /api and /ws to :3000
pnpm run build      # tsc typecheck + vite build → dist/  (tsc must pass)
```

### Full stack

```bash
docker compose up -d                          # build-from-source stack (port 80)
docker compose -f docker-compose.full.yml up -d   # prebuilt images
```

## Conventions

- **Go formatting is intentionally not gofmt-clean** — the codebase uses manual column alignment and one-line `if`/struct bodies. Match the surrounding style; do **not** run `gofmt -w` across files.
- Frontend reads runtime config via `getEnv()` (`src/env.ts`): `window.__ENV__` (injected by `docker-entrypoint.sh` from env at container start) with fallback to Vite's `import.meta.env`. `VITE_API_URL` empty ⇒ same-origin relative URLs; the WS URL is derived (`http→ws`). Don't read `import.meta.env` directly in app code.
- Config (`config.json`, see `config.example.json` / README) is loaded by `internal/config`; the `Public` channel key and SHA-256-derived `hashChannels` keys are defaulted in `config.Load`.
- New analytics endpoints should go through `cachedAnalytics` (cached, no-arg form) only when the filter is inactive (`f.Active()`), and accept the shared `analyticsFilter(r)` otherwise — follow the existing `XxxStats`/`computeXxxStats` split. Scan with `s.txsSince(f.sinceMs)`, and serve the handler through `s.writeCachedJSON` when its output derives only from cached store values.
