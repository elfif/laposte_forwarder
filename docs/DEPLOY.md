# Deployment

First-time setup on a fresh VPS. Day-2 operations (logs, recovery, adding
accounts) are in [RUNBOOK.md](RUNBOOK.md).

Requirements: an **amd64** VPS (the official imapsync image has no arm64 build;
for ARM see the `Dockerfile` at the repo root) with Docker Engine and the
Compose plugin. Ports **80** and **443** must be free. The DNS **A record** for
`forwarder.skilphi.com` should already point at this host (Caddy obtains the
certificate automatically).

## 1. Host preparation

```bash
# Docker (Debian/Ubuntu, official convenience script)
curl -fsSL https://get.docker.com | sh

# Make containers come back after a host reboot; restart: unless-stopped
# only works if the Docker daemon itself starts at boot.
sudo systemctl enable --now docker
```

Anyone in the `docker` group has effective root on the host and can read the
mounted secrets. The control API also mounts the Docker socket. On a
single-admin VPS, either stay with `sudo docker` or add only yourself to the
group.

```bash
git clone <this-repo> laposte_forwarder
cd laposte_forwarder
cp .env.example .env
```

Edit `.env`:

- `UI_PASSWORD` — shared login for the web UI (no username)
- `UI_SESSION_SECRET` — `openssl rand -hex 32`
- `DOMAIN=forwarder.skilphi.com`
- `LAPOSTE_PROJECT_DIR` — **absolute** path of this directory on the host
  (required so the API's nested `docker compose` resolves bind mounts)
- `COOKIE_SECURE=true` in production

```bash
mkdir -p secrets data/stats
chmod 700 secrets
chmod 777 data/stats
printf '%s\n' 'services: {}' > compose.forwarders.yaml
docker compose up -d --build
```

Caddy should obtain a certificate for `DOMAIN`. Open `https://forwarder.skilphi.com`
and sign in with `UI_PASSWORD`.

`compose.yaml` is the versioned platform stack (Caddy + API). Per-account
services live in gitignored `compose.forwarders.yaml`, which the API writes.
`.env` sets `COMPOSE_FILE` so both files are used together.

## 2. Prepare the accounts

### La Poste side

Since 2023-2024 laposte.net requires TLS for IMAP and an activated **Identité
Numérique** on the account, otherwise IMAP logins fail even with the right
password. If the mailbox has been dormant, first verify from your own machine
(e.g. Thunderbird, `imap.laposte.net:993` SSL/TLS, full address as username)
that IMAP login works at all. Debugging this through the container on a remote
VPS is miserable; do it locally first.

### Gmail side

The Gmail account's normal password does not work over IMAP. For each Gmail
account:

1. Enable 2-Step Verification (mandatory for the next step).
2. Create an app password at <https://myaccount.google.com/apppasswords>
   (16 characters; this is what goes in the secret file).

Expect Google to send a **"Critical security alert"** and possibly block the
first sign-in from a datacenter IP. If the first sync fails auth with a
correct app password, check the Gmail security page / alert email, approve the
attempt, and retry. Do this per account before considering it live.

## 3. Add an account (web UI)

Use **Add forwarder** in the UI. Leave **delete after copy** off until the
account has passed the validation phases below. The La Poste address cannot be
changed later. Stored passwords are never shown again; leave the password
fields blank on edit to keep them.

Password files are still written under `secrets/` as Compose secrets (first
line only). Permissions rationale: Compose file secrets are bind mounts that
keep host ownership and mode, and the container runs as `nobody` (uid 65534),
so a `0600` file owned by you is unreadable in the container. The `700`
directory provides the host-side protection instead; the `644` files are only
reachable through it.

## 4. Phased rollout (per account)

Do not skip phases. Once deletion is enabled, Gmail holds the only copy of
forwarded mail, so validation happens while laposte still retains everything.

### Phase 1 - dry run

Proves both logins and shows what would be transferred without touching
anything:

```bash
docker compose run --rm -e DRY_RUN=true alice /usr/local/bin/laposte-forward --once
```

Read the output: both hosts authenticated, the INBOX message count within the
window looks plausible, and the planned copies make sense.

### Phase 2 - real copies, no deletion

Keep delete-after-forward off in the UI. Start the forwarder and confirm mail
arrives intact in Gmail (sender, date, attachments). A second cycle should
transfer **zero** messages: that proves duplicate detection (Message-ID
matching), which is the safety net if a run ever dies between copy and delete.

Optionally leave the account running in this mode for a day or two: mail keeps
flowing to Gmail while laposte still has every original.

### Phase 3 - enable deletion

In the UI, edit the forwarder, enable delete-after-forward, and confirm. The
API recreates the container.

Send yourself a test mail to the laposte address and watch it: it should
appear in Gmail and vanish from the laposte INBOX within ~60 seconds
(`docker compose logs -f alice`).

### Phase 4 - repeat and finish

Repeat phases 1-3 for each remaining account. In the UI every card should show
**running** (or `docker compose ps`: healthy within ~2 minutes).

## 5. CI deploy (optional)

Releases are deployed by pushing a tag that starts with `prod-release-`.
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) SSHs into the
VPS and runs [`scripts/deploy.sh`](../scripts/deploy.sh), which fetches the tag,
stops the stack, backs up `.env`, `compose.forwarders.yaml`, `secrets/`, and
`data/`, replaces the project tree (including the platform `compose.yaml` from
git), restores that local state, and brings the stack back up with `--build`.

`docker compose down` during a deploy also stops the UI (Caddy + API) for the
duration of the swap.

### GitHub configuration

| Name | Type | Purpose |
| --- | --- | --- |
| `SSH_PRIVATE_KEY` | secret | Private key the Action uses to SSH into the VPS |
| `SSH_LOGIN` | variable | SSH user on the VPS |
| `SSH_VPS_IP` | variable | VPS hostname or IP |
| `SSH_KNOWN_HOSTS` | variable | Output of `ssh-keyscan <vps-ip>` |

Two different keys, do not reuse them:

- Action → VPS: the key pair behind `SSH_PRIVATE_KEY`; put the public half in
  `~/.ssh/authorized_keys` for `SSH_LOGIN`.
- VPS → GitHub: a **read-only deploy key** on this (private) repo, installed as
  `~/.ssh/` on the VPS, so the deploy script can `git fetch`.

### One-time VPS bootstrap

```bash
# Read-only deploy key for GitHub, then:
git clone --bare git@github.com:<org>/<repo>.git ~/laposte_forwarder.git
```

The working tree at `~/laposte_forwarder` must already contain
`scripts/deploy.sh` (it does once this file is merged and the tree is current).
`SSH_LOGIN` must be able to run `docker compose` (docker group or root).
`LAPOSTE_PROJECT_DIR` in `.env` must be that working tree's absolute path.

### Migrating from the pre-UI compose.yaml

If this host still has a single `compose.yaml` that defines account services
(e.g. `phi`), move those services into `compose.forwarders.yaml` before the
first UI deploy. `scripts/deploy.sh` will not restore the old `compose.yaml`
over the new platform file; it keeps a copy as `compose.yaml.pre-ui-backup`
if the overlay is missing.

## 6. Set up the dead-man's-switch (strongly recommended)

A container can be "running" while every sync fails (expired password, La Poste
block). Two layers catch this:

- The built-in Docker healthcheck flips the container to `unhealthy` after
  5 minutes without a successful sync — visible in the UI and
  `docker compose ps`.
- `HEALTHCHECK_URL` in the overlay environment: create a check per account at
  e.g. [healthchecks.io](https://healthchecks.io) with a ~5 minute grace period.
  The wrapper pings it after every successful sync. This matters because mail
  older than `WINDOW_DAYS` is never forwarded: an unnoticed multi-day outage
  strands mail silently (recovery for that is in [RUNBOOK.md](RUNBOOK.md)).
