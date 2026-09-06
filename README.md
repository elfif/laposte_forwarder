# laposte_forwarder

Forwards mail from one or more **laposte.net** mailboxes to matching **Gmail**
accounts. laposte.net offers no automatic forwarding, so this stack polls each
INBOX every 60 seconds over IMAP, copies new messages into the destination
Gmail mailbox byte-for-byte (IMAP `APPEND`, original headers preserved), and —
once a copy is confirmed — can delete them from laposte.net.

A small web UI at **https://forwarder.skilphi.com** lists forwarders, shows
last-run and 24h message counts, and can start, stop, add, edit, and delete
accounts. Passwords are write-only: the UI never displays stored secrets.

## Layout

| Path | Purpose |
| --- | --- |
| `compose.yaml` | Platform stack: Caddy (TLS + SPA) and the control API. |
| `compose.forwarders.yaml` | Per-account overlay, gitignored, written by the API. |
| `compose.forwarders.example.yaml` | Example overlay (not used in production). |
| `.env.example` | Copy to `.env`: UI password, domain, host project path. |
| `bin/laposte-forward` | Wrapper around imapsync, bind-mounted into each forwarder. |
| `api/` | TypeScript (Hono) control API. |
| `web/` | React + Vite SPA, baked into the Caddy image. |
| `Caddyfile` / `Dockerfile.caddy` | TLS terminator and static file server. |
| `secrets/` | One password file per credential (gitignored). |
| `data/stats/` | Per-run JSONL stats (gitignored). |
| `Dockerfile` | Fallback local imapsync build (arm64 hosts). |
| `docs/DEPLOY.md` | First-time deployment. |
| `docs/RUNBOOK.md` | Day-2 operations. |

## Quick start

```bash
cp .env.example .env
# set UI_PASSWORD, UI_SESSION_SECRET (openssl rand -hex 32),
# LAPOSTE_PROJECT_DIR to the absolute path of this directory

mkdir -p data/stats secrets
chmod 777 data/stats
chmod 700 secrets

# Overlay must exist (empty is fine; add accounts from the UI):
test -f compose.forwarders.yaml \
  || printf '%s\n' 'services: {}' > compose.forwarders.yaml

docker compose up -d --build
```

Open `https://forwarder.skilphi.com` (or the `DOMAIN` in `.env`). Sign in with
`UI_PASSWORD`. Add a forwarder with delete-after-forward **off** until that
account has been validated — see `docs/DEPLOY.md`.

`.env` sets `COMPOSE_FILE=compose.yaml:compose.forwarders.yaml`, so
`docker compose up` starts Caddy, the API, and every forwarder.

Forwarder containers still publish **no ports**. The imapsync image bundles a
web UI (`servimapsync`) that must not be exposed on a box holding mail
credentials. Only Caddy binds `80`/`443`.

## Design notes

- Only messages in `INBOX` whose **arrival date** (IMAP INTERNALDATE, not the
  spoofable `Date:` header) is within the last `WINDOW_DAYS` (default 1) are
  considered. IMAP `SEARCH SINCE` has date granularity, so the effective window
  is 24-48 h.
- Duplicate protection is imapsync's default header matching (`Message-ID`), so
  a crash between copy and delete re-forwards instead of losing mail.
- Passwords are Compose secrets read via `--passfile1/2`; they never appear in
  the container environment, `docker inspect`, or the web API.
- Each container loops serially (sleep starts after a run finishes), so
  overlapping runs are impossible by construction.
- After every sync the wrapper appends a JSON line under `data/stats/` so the
  UI can show last-run and 24h transfer counts.
