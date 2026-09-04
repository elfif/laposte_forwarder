# Deployment

First-time setup on a fresh VPS. Day-2 operations (logs, recovery, adding
accounts) are in [RUNBOOK.md](RUNBOOK.md).

Requirements: an **amd64** VPS (the official imapsync image has no arm64 build;
for ARM see the `Dockerfile` at the repo root) with Docker Engine and the
Compose plugin.

## 1. Host preparation

```bash
# Docker (Debian/Ubuntu, official convenience script)
curl -fsSL https://get.docker.com | sh

# Make containers come back after a host reboot; restart: unless-stopped
# only works if the Docker daemon itself starts at boot.
sudo systemctl enable --now docker
```

Anyone in the `docker` group has effective root on the host and can read the
mounted secrets. On a single-admin VPS, either stay with `sudo docker` or add
only yourself to the group.

```bash
git clone <this-repo> laposte_forwarder
cd laposte_forwarder
cp compose.example.yaml compose.yaml
```

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
first sign-in from a datacenter IP. If the first `--once` run fails auth with a
correct app password, check the Gmail security page / alert email, approve the
attempt, and retry. Do this per account before considering it live.

## 3. Configure

Edit `compose.yaml`: one service block per account (the template contains
`alice` plus a commented-out `bob`), with the laposte and Gmail addresses and
matching entries in the top-level `secrets:` block.

Create the password files, first line only, no quoting:

```bash
printf '%s\n' 'the-laposte-password'      > secrets/alice_laposte.txt
printf '%s\n' 'the-16-char-app-password'  > secrets/alice_gmail.txt
chmod 700 secrets && chmod 644 secrets/*.txt
```

Permissions rationale: Compose file secrets are bind mounts that keep host
ownership and mode, and the container runs as `nobody` (uid 65534), so a
`0600` file owned by you is unreadable in the container (the wrapper fails
with "cannot read PASSFILE1"). The `700` directory provides the host-side
protection instead; the `644` files are only reachable through it.

Keep `DELETE_AFTER_FORWARD: "false"` for now.

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

```bash
docker compose run --rm alice /usr/local/bin/laposte-forward --once
```

Check the messages arrived intact in Gmail (sender, date, attachments). Then
run the exact same command a second time and confirm it transfers **zero**
messages: that second run is what proves duplicate detection (Message-ID
matching) works, which is the safety net if a run ever dies between copy and
delete.

Optionally leave the account running in this mode for a day or two
(`docker compose up -d alice`): mail keeps flowing to Gmail while laposte still
has every original.

### Phase 3 - enable deletion

Set `DELETE_AFTER_FORWARD: "true"` for the account in `compose.yaml`, then:

```bash
docker compose up -d alice
```

Send yourself a test mail to the laposte address and watch it: it should
appear in Gmail and vanish from the laposte INBOX within ~60 seconds
(`docker compose logs -f alice`).

### Phase 4 - repeat and finish

Repeat phases 1-3 for each remaining account, then bring everything up and
check health state:

```bash
docker compose up -d
docker compose ps    # every container should reach "healthy" within ~2 minutes
```

## 5. CI deploy (optional)

Releases are deployed by pushing a tag that starts with `prod-release-`.
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) SSHs into the
VPS and runs [`scripts/deploy.sh`](../scripts/deploy.sh), which fetches the tag,
stops the stack, backs up `compose.yaml` and `secrets/`, replaces the project
tree, restores the config, and brings the stack back up.

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

## 6. Set up the dead-man's-switch (strongly recommended)

A container can be "running" while every sync fails (expired password, La Poste
block). Two layers catch this:

- The built-in Docker healthcheck flips the container to `unhealthy` after
  5 minutes without a successful sync - visible in `docker compose ps`, but
  nobody watches that.
- `HEALTHCHECK_URL`: create a check per account at e.g.
  [healthchecks.io](https://healthchecks.io) with a ~5 minute grace period, put
  the ping URL in the account's environment, and re-run `docker compose up -d`.
  The wrapper pings it after every successful sync, so you get an email/push
  when forwarding *stops*. This matters because mail older than `WINDOW_DAYS`
  is never forwarded: an unnoticed multi-day outage strands mail silently
  (recovery for that is in [RUNBOOK.md](RUNBOOK.md)).
