# liteScope

A lightweight, self-hosted dashboard for monitoring [MeshCore](https://meshcore.co.uk/) networks. liteScope ingests MQTT telemetry from one or more MeshCore brokers, stores it in SQLite, and serves a real-time React UI with live packet feeds, node analytics, channel decryption, and observer stats.

**by [riko.dev](https://riko.dev)**

---

## Features

- **Live packet feed** — filter by type, route, channel, or minimum observer count; live pause/resume
- **Node explorer** — per-node RF analytics (RSSI / SNR distributions), last-heard filters, role tabs
- **Channel decryption** — add AES-128 keys (or derive them via SHA-256 from a passphrase); view decrypted message history
- **Observer dashboard** — per-observer packet timelines, SNR charts, packet-type breakdown
- **Network analytics** — overview cards, activity heatmap, RF stats, top nodes/observers, packet-type distribution
- **Map** — live Leaflet map of recent observations
- **Decoder** — paste raw hex packets for one-off decoding
- **Light / dark theme** — Material 3 Expressive design, persisted per-browser
- **i18n** — English, Polish, German (auto-detected from browser, persisted)

---

## Architecture

```
┌──────────────┐    MQTT     ┌───────────┐   HTTP/WS   ┌──────────┐
│  Meshtastic  │ ──────────► │ ingestor  │ ──────────► │  server  │
│  network(s)  │             │  (Go)     │             │  (Go)    │
└──────────────┘             └───────────┘             └──────────┘
                                   │                        │
                              SQLite (shared)          REST + WebSocket
                                                            │
                                                    ┌───────────────┐
                                                    │  React (Vite) │
                                                    │  MUI v9 / i18n│
                                                    └───────────────┘
```

- **ingestor** — subscribes to MQTT topics, decodes MeshCore packets, writes to SQLite
- **server** — serves the REST API (`/api/*`) and WebSocket (`/ws`) for live updates
- **frontend** — React 19 SPA, served as static files (Caddy in Docker, or Cloudflare Pages)
- **Mosquitto** — local MQTT broker (optional; any external broker works too)
- **Caddy** — TLS termination + reverse proxy in the Docker Compose stack

---

## Quick Start (Docker Compose)

### Prerequisites

- Docker 24+ with Compose v2
- A MeshCore node publishing to an MQTT broker (local or remote)

### 1. Clone & configure

```bash
git clone https://github.com/riko-dev/litescope.git
cd litescope
cp .env.example .env
cp config.example.json config.json
```

Edit `.env` and `config.json` — see [Configuration](#configuration) and [MQTT Authentication](#mqtt-authentication) below.

### 2. Build the frontend

```bash
cd frontend
pnpm install        # or: npm install
pnpm run build      # outputs to frontend/dist/
cd ..
```

### 3. Start the stack

```bash
docker compose up -d
```

The dashboard is available at `http://localhost` (port 80).
For HTTPS, edit `Caddyfile` with your domain — Caddy handles certs automatically.

### 4. Stop

```bash
docker compose down          # keep data volumes
docker compose down -v       # also wipe data
```

---

## Configuration

All runtime settings live in `config.json` (mounted read-only into the backend container).

```jsonc
{
  // TCP port the HTTP server listens on (internal; exposed via Caddy)
  "port": 3000,

  // SQLite database path inside the container
  "dbPath": "/app/data/litescope.db",

  // One or more MQTT sources
  "mqttSources": [
    {
      "name": "local",                      // display name
      "broker": "mqtt://mosquitto:1883",    // broker URL
      "topics": ["meshcore/#"],             // topics to subscribe to
      "region": ""                          // optional region tag shown in UI
    }
  ],

  // AES-128 channel keys for decryption (channel name → hex key)
  "channelKeys": {
    "Public": "8b3387e9c5cdea6ac9e5edbaa115cd72"
  },

  // Channel names that use # (hashtag) addressing
  "hashChannels": []
}
```

---

## MQTT Authentication

liteScope ships with Mosquitto auth **enabled by default** (`allow_anonymous false`). Credentials are provisioned at container startup via a thin entrypoint script.

### Setup

1. Set credentials in `.env` (copied from `.env.example`):

```env
MQTT_USERNAME=litescope
MQTT_PASSWORD=change_me_please
```

2. Set the same credentials in `config.json` so the backend can authenticate:

```jsonc
"mqttSources": [
  {
    "name": "local",
    "broker": "mqtt://mosquitto:1883",
    "username": "litescope",
    "password": "change_me_please",
    ...
  }
]
```

3. MeshCore observer nodes connecting to the broker also need these credentials configured in their MQTT settings.

On `docker compose up`, the `mqtt-entrypoint.sh` script runs `mosquitto_passwd -c -b` to generate `/mosquitto/config/passwd` from the env vars, then starts the broker. The password file is regenerated from env vars on every container restart, so changing credentials is as simple as updating `.env` and restarting the Mosquitto container.

### Connecting an external broker

If you point `mqttSources[].broker` at an external broker instead of the bundled Mosquitto, just set the corresponding `username`/`password` in `config.json` and remove or leave the `MQTT_USERNAME`/`MQTT_PASSWORD` env vars empty (the bundled Mosquitto is unused in that case).

---

### Multiple MQTT brokers

```jsonc
"mqttSources": [
  { "name": "home",   "broker": "mqtt://192.168.1.10:1883", "topics": ["meshcore/#"] },
  { "name": "remote", "broker": "mqtts://mesh.example.com:8883", "topics": ["meshcore/#"], "region": "EU" }
]
```

---

## Development

### Backend

```bash
cd backend
go run ./cmd/ingestor -config ../config.json &
go run ./cmd/server   -config ../config.json
```

Requires Go 1.22+. No CGO — `modernc.org/sqlite` is a pure-Go SQLite port.

### Frontend

```bash
cd frontend
pnpm install
pnpm run dev        # Vite dev server on http://localhost:5173
                    # proxies /api and /ws to http://localhost:3000
```

Requires Node 20+ and pnpm (or npm/yarn).

### Frontend environment variables

Copy the example and adjust as needed:

```bash
cp frontend/.env.example frontend/.env.local
```

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | *(empty)* | Backend base URL (e.g. `https://litescope.example.com`). WebSocket URL is derived automatically (`http→ws`, `https→wss`). Leave empty for same-origin / Vite proxy. |

When empty the frontend uses relative URLs, which works with the Vite proxy in dev and Caddy/nginx in production.

---

## Deployment

### Self-hosted (Docker Compose + domain)

1. Point your DNS `A` record at the server IP.
2. Edit `Caddyfile`:
   ```
   your.domain.com {
       @api path /api/* /ws
       reverse_proxy @api backend:3000

       root * /srv/frontend
       file_server
   }
   ```
3. Mount the built frontend into Caddy:
   ```yaml
   # docker-compose.yml — caddy volumes
   volumes:
     - ./frontend/dist:/srv/frontend:ro
     - ./Caddyfile:/etc/caddy/Caddyfile:ro
     - caddy-data:/data
   ```
4. `docker compose up -d` — Caddy will auto-provision a Let's Encrypt cert.

### Cloudflare Pages (frontend only)

The React SPA can be deployed to Cloudflare Pages while the backend runs anywhere (VPS, home server, etc.).

See [Cloudflare Pages deployment](#cloudflare-pages-deployment) below.

---

## Cloudflare Pages Deployment

The `wrangler.toml` at the repo root configures the frontend for Cloudflare Pages.

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed (`npm i -g wrangler`)
- A Cloudflare account with Pages enabled
- Backend accessible over HTTPS (needed for the browser to call the API)

### Setup

```bash
# Authenticate
wrangler login

# Build the frontend
cd frontend && pnpm run build && cd ..

# Deploy (first deploy creates the Pages project)
wrangler pages deploy frontend/dist --project-name litescope
```

### Environment variables (Cloudflare dashboard)

Set these in **Cloudflare Dashboard → Pages → litescope → Settings → Environment variables**:

| Variable | Example value | Description |
|---|---|---|
| `VITE_API_URL` | `https://litescope.example.com` | Your backend's public HTTPS URL. The WebSocket URL (`wss://...`) is derived automatically. |

Then rebuild and redeploy after setting them (Vite bakes them in at build time).

### Custom domain

In Cloudflare Dashboard → Pages → litescope → Custom domains, add your domain. Cloudflare handles DNS and TLS automatically.

---

## API Reference

All endpoints are prefixed with `/api`. The WebSocket is at `/ws`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/packets` | List packets (query: `limit`, `offset`, `type`, `route`, `channel`, `minObs`) |
| `GET` | `/api/packets/:hash` | Get packet detail with observations |
| `GET` | `/api/nodes` | List nodes |
| `GET` | `/api/nodes/:pubkey` | Node detail |
| `GET` | `/api/nodes/:pubkey/packets` | Packets seen by node |
| `GET` | `/api/nodes/:pubkey/rf` | RF stats (RSSI/SNR history) |
| `GET` | `/api/observers` | List observers |
| `GET` | `/api/observers/:id` | Observer detail |
| `GET` | `/api/observers/:id/analytics` | Observer timeline + SNR + packet types (query: `days`) |
| `GET` | `/api/channels` | List channels |
| `GET` | `/api/channels/:hash/messages` | Channel message history |
| `GET` | `/api/iatas` | List IATA codes |
| `GET` | `/api/analytics/overview` | Network overview counts |
| `GET` | `/api/analytics/packets-by-type` | Packet type distribution |
| `GET` | `/api/analytics/rf` | Network-wide RF stats |
| `GET` | `/api/analytics/activity` | Activity heatmap data |
| `GET` | `/api/analytics/nodes-top` | Top nodes by packet count |
| `GET` | `/api/analytics/observers-top` | Top observers by packet count |
| `POST` | `/api/decode` | Decode a raw hex packet (body: `{"hex":"..."}`) |
| `WS` | `/ws` | Live push of new packets and observer updates |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend language | Go 1.22 |
| HTTP router | gorilla/mux |
| WebSocket | gorilla/websocket |
| MQTT client | paho.mqtt.golang |
| Database | SQLite (modernc.org/sqlite — pure Go, no CGO) |
| Frontend framework | React 19 + TypeScript |
| Build tool | Vite 6 |
| UI library | MUI v9 (Material 3 Expressive) |
| Charts | Recharts |
| Map | Leaflet 1.9 |
| i18n | i18next + react-i18next |
| Reverse proxy | Caddy 2 |
| MQTT broker | Eclipse Mosquitto 2 |
| Container runtime | Docker Compose |

---

## License

MIT — see `LICENSE`.

---

© 2025 liteScope by [riko.dev](https://riko.dev)
