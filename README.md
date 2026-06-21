# FastMessage

A self-hosted, **end-to-end-encrypted** messenger that runs on your own
Raspberry Pi and is reachable from anywhere at your own domain via a Cloudflare
Tunnel. The server stores **only ciphertext** — as the operator, you cannot read
any conversation you are not a participant in.

- 🔒 **Real E2E encryption** — Olm **Double Ratchet** (X3DH-style key agreement,
  forward secrecy, post-compromise security). Keys are generated and kept on the
  client; the server only ever sees opaque ciphertext + routing metadata.
- 🍓 **Runs on a Pi, in Docker** — one `docker compose up`. SQLite for storage,
  no external database.
- ☁️ **Cloud-fronted, no open ports** — `cloudflared` dials out to Cloudflare,
  so `message.calvingunther.com` reaches the Pi behind home NAT.
- 📱 **Installable PWA** — one React app that works as the website *and* the
  phone "app" (`message.calvingunther.com` for the UI, `…/app` for the backend
  connector).

## How it fits together

```
[Web PWA] [Phone PWA]
     │  HTTPS + WSS
     ▼
message.calvingunther.com   (Cloudflare edge: DNS + TLS)
     │  Cloudflare Tunnel (outbound connection FROM the Pi)
     ▼
Raspberry Pi 5  (Docker)
  ├── cloudflared        the tunnel
  ├── server (Node+TS)   REST at /app/v1, WebSocket at /app/ws, serves the PWA at /
  ├── SQLite             accounts, PUBLIC keys, ciphertext mailbox
  └── coturn (optional)  STUN/TURN for calls
```

## Trust model

What the server **can** see: usernames, which devices exist, who sends to whom,
timestamps and message sizes (standard metadata for this class of system).

What the server **cannot** see: message content. Plaintext is encrypted on the
sender's device and only the recipient devices hold the keys to decrypt it.
Private keys never leave the browser (they live in origin-isolated IndexedDB).

This is enforced and tested: `server/scripts/e2e-check.ts` sends a real
encrypted message between two users and then opens the server's SQLite file to
assert the plaintext is **not** present anywhere.

## Repository layout

```
packages/shared   wire protocol: types + zod schemas (server & client share this)
packages/crypto   Olm Double Ratchet wrappers (the only place private keys live)
server            Fastify API + WebSocket gateway + SQLite (runs on the Pi)
web               React PWA (the website and the phone app)
Dockerfile        multi-stage build (builds the PWA, runs the server)
docker-compose.yml server + cloudflared + (optional) coturn
infra/            cloudflared + coturn configs
```

## Local development

Requirements: Node 20+ and pnpm 10+.

```bash
pnpm install

# Terminal 1 — the server (http://localhost:8080, data in ./server/data)
pnpm dev:server

# Terminal 2 — the web app (http://localhost:5173, proxies /app to :8080)
pnpm dev:web
```

Open `http://localhost:5173` in two separate browser profiles, create two
accounts (e.g. `alice` and `bob`), start a chat by username, and send messages.

### Tests & checks

```bash
pnpm -r typecheck                       # typecheck every package
pnpm --filter @fastmessage/crypto test  # Double Ratchet round-trip unit tests

# Full end-to-end + trust-model assertion against a live server:
rm -rf /tmp/fmtest && DATA_DIR=/tmp/fmtest PORT=8099 \
  SESSION_SECRET=dev-secret-please-change pnpm --filter @fastmessage/server start &
BASE=http://127.0.0.1:8099 DB=/tmp/fmtest/fastmessage.sqlite \
  pnpm --filter @fastmessage/server exec tsx scripts/e2e-check.ts
```

## Deploying on the Raspberry Pi

1. **Point your domain at Cloudflare** (DNS hosted on Cloudflare; free plan is
   fine).

2. **Create a tunnel.** In the Cloudflare Zero Trust dashboard →
   Networks → Tunnels → *Create a tunnel* (cloudflared). Add a **public
   hostname**: `message.calvingunther.com` → service `http://server:8080`. Copy
   the tunnel **token**. (Or use the file-based setup in
   `infra/cloudflared/config.example.yml`.)

3. **Configure secrets** on the Pi:

   ```bash
   git clone <this repo> && cd fastmessage
   cp .env.example .env
   # set a strong SESSION_SECRET:
   node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
   # paste that, plus TUNNEL_TOKEN, into .env
   ```

4. **Run it:**

   ```bash
   docker compose up -d --build
   ```

   Visit `https://message.calvingunther.com` — install it to your phone's home
   screen to use it as the app. Encrypted message data lives in the
   `fastmessage-data` Docker volume; back that up.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Pepper for opaque session tokens. **Required in prod.** |
| `PUBLIC_ORIGIN` | Public URL, e.g. `https://message.calvingunther.com`. |
| `CORS_ORIGINS` | Comma-separated allowed web origins. |
| `DATA_DIR` | Where SQLite + attachment blobs live (`/data` in Docker). |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token (used by the `cloudflared` service). |
| `VAPID_*` | Web Push keys (Phase 6) — generate with `node server/scripts/gen-vapid.mjs`. |
| `TURN_*` | coturn settings for voice/video (Phase 7). |

## Status & roadmap

Implemented and verified:

- ✅ Accounts, devices, opaque-token auth (Argon2id password hashing)
- ✅ Public prekey directory (claim / replenish, fallback keys)
- ✅ **1:1 end-to-end messaging** over WebSocket with offline store-and-forward
- ✅ **Group chats** — Megolm group ratchet with room-key distribution over 1:1
  Olm sessions and rotation on membership change (unit-tested + e2e-tested)
- ✅ **Encrypted attachments** — files are AES-256-GCM encrypted in the browser
  before upload; the server stores ciphertext blobs and never sees the key
- ✅ Olm/Megolm client library (unit-tested) + IndexedDB persistence
- ✅ Installable PWA; Dockerized server that serves it; Cloudflare Tunnel stack

Planned next (scaffolding in place):

- ⏳ **Multi-device** — QR device-linking + fan-out to all of a user's devices
- ⏳ **Web Push** notifications (VAPID)
- ⏳ **Voice/video calls** — WebRTC with encrypted signaling + coturn

### Notes & caveats

- **Calls vs. the tunnel:** Cloudflare Tunnel proxies HTTP/WS, not the UDP that
  TURN needs. When calls land, coturn must be reachable another way (a single
  port-forward for TURN, a small public host, or a hosted TURN service). It does
  not affect messaging.
- **Key backup / recovery:** device keys currently live only in the browser. A
  passphrase-encrypted key backup and cross-signing are part of the hardening
  phase; until then, clearing browser storage means re-registering the device.
- **At-rest encryption:** SQLCipher for the server DB is a planned hardening
  step. The strong guarantee (server can't read messages) already holds because
  the rows contain only ciphertext.
