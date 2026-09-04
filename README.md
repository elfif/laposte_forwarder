# laposte_forwarder

Forwards mail from one or more **laposte.net** mailboxes to matching **Gmail** accounts.
laposte.net offers no automatic forwarding, so this stack polls each INBOX every 60
seconds over IMAP, copies new messages into the destination Gmail mailbox byte-for-byte
(IMAP `APPEND`, original headers preserved), and — once a copy is confirmed — deletes
them from laposte.net.

Everything runs in the official [imapsync](https://imapsync.lamiral.info/) Docker image
(`gilleslamiral/imapsync`), one container per account, driven by Docker Compose.
Moving to another VPS is: clone this repo, drop in the secret files, `docker compose up -d`.

## Layout

| Path | Purpose |
| --- | --- |
| `compose.example.yaml` | Template. Copy to `compose.yaml` (gitignored) and edit. |
| `bin/laposte-forward` | Wrapper around imapsync, bind-mounted into each container. |
| `secrets/` | One password file per credential (gitignored). |
| `Dockerfile` | Fallback local build (arm64 hosts, or a stale upstream base image). |
| `docs/DEPLOY.md` | First-time deployment, step by step. |
| `docs/RUNBOOK.md` | Day-2 operations: logs, outage recovery, adding accounts. |

## Quick start

```bash
cp compose.example.yaml compose.yaml         # then edit addresses / accounts
printf '%s\n' 'laposte-password'  > secrets/alice_laposte.txt
printf '%s\n' 'gmail-app-password' > secrets/alice_gmail.txt
# Dir 700 keeps other host users out; files stay 644 because the container
# reads them as user "nobody" through a bind mount that keeps host perms.
chmod 700 secrets && chmod 644 secrets/*.txt

# Validate one account before letting it delete anything (see docs/DEPLOY.md):
docker compose run --rm -e DRY_RUN=true alice /usr/local/bin/laposte-forward --once

docker compose up -d
```

Read `docs/DEPLOY.md` before the first real run: deletion on laposte.net is **off by
default** and must be enabled per account only after validation, because once it is on,
Gmail holds the only copy of forwarded mail.

## Design notes

- Only messages in `INBOX` whose **arrival date** (IMAP INTERNALDATE, not the spoofable
  `Date:` header) is within the last `WINDOW_DAYS` (default 1) are considered. IMAP
  `SEARCH SINCE` has date granularity, so the effective window is 24-48 h.
- Duplicate protection is imapsync's default header matching (`Message-ID`), so a crash
  between copy and delete re-forwards instead of losing mail.
- Passwords are Compose secrets read via `--passfile1/2`; they never appear in the
  container environment, `docker inspect`, or process listings.
- Each container loops serially (sleep starts after a run finishes), so overlapping
  runs are impossible by construction.
