# Runbook

Day-2 operations. First-time setup is in [DEPLOY.md](DEPLOY.md).

The web UI at `https://forwarder.skilphi.com` is the usual control surface:
status, start/stop, add, edit destination/secrets, delete-after-forward, and
delete. CLI below is for logs, catch-up after an outage, and image upgrades.

## Daily driving

```bash
docker compose ps                      # platform + every forwarder
docker compose logs -f api             # control API
docker compose logs -f phi             # one account
docker compose logs --since 1h         # everything recent
```

Logs are capped (10 MB x 3 files per forwarder), so they can be left alone
forever.

A card shown as **unhealthy** (or `unhealthy` in `docker compose ps`) means no
successful sync for 5+ minutes while the process is still running — almost
always an authentication failure. Check that account's logs first.

`docker compose down` stops forwarders **and** the UI (Caddy + API).

## Recovering from an outage (IMPORTANT)

Only mail that **arrived within `WINDOW_DAYS`** (default 1 day) is forwarded.
If forwarding was down longer than that - VPS outage, expired password,
La Poste block - mail that arrived during the gap is older than the window and
will never be picked up by the normal loop: it sits in the laposte INBOX,
unforwarded and undeleted, silently.

After any outage, run a catch-up with a window comfortably larger than the
downtime:

```bash
docker compose run --rm phi /usr/local/bin/laposte-forward --once --window-days 30
```

This is safe to run repeatedly: duplicate detection skips anything already in
Gmail, and deletion still only happens after a confirmed copy. It inherits the
account's `DELETE_AFTER_FORWARD` setting.

Caution: on a mailbox with a large backlog (e.g. first deployment on an
account holding years of mail), a large `--window-days` will forward *and
delete* everything in that window. If unsure, preview first:

```bash
docker compose run --rm -e DRY_RUN=true phi /usr/local/bin/laposte-forward --once --window-days 30
```

## Adding an account

Use **Add forwarder** in the UI. Keep delete-after-forward off until the
account has been validated ([DEPLOY.md](DEPLOY.md) phases 1–3).

## Rotating a password

1. Change the password / create the new Gmail app password.
2. In the UI, edit the forwarder and paste the new secret(s). Leave a field
   blank to keep the current value. Secrets are never displayed.
3. The API recreates the container (`--force-recreate`); a plain restart is
   not enough for Compose secrets on some versions.

Note: changing the Google account's *main* password revokes all its app
passwords, so expect to do this after any Google password change.

## Releasing and rolling back

Deploys are driven by tags (see "CI deploy" in [DEPLOY.md](DEPLOY.md)). To
release:

```bash
git tag prod-release-20260904
git push origin prod-release-20260904
```

The Action SSHs to the VPS and runs `scripts/deploy.sh`, which swaps the
project tree to that tag while keeping `.env`, `compose.forwarders.yaml`,
`secrets/`, and `data/`. Platform `compose.yaml` always comes from git. Each
deploy leaves a timestamped copy under `~/laposte_forwarder_backups/` (last 10
kept).

To roll back, re-tag the previous release (e.g. `git tag prod-release-rollback1
<old-commit>` and push it), or on the VPS restore the previous backup's
`.env` / overlay / secrets / data and re-run `docker compose up -d --build`.

## Upgrading imapsync

The image is pinned by tag and digest (`IMAPSYNC_IMAGE` in `.env`, used when
the API creates a forwarder, and the `image:` line of existing overlay
services). To upgrade:

```bash
curl -s https://hub.docker.com/v2/repositories/gilleslamiral/imapsync/tags/2.319 | python3 -m json.tool
```

Pick the new tag, fetch its digest the same way, update `IMAPSYNC_IMAGE` in
`.env` and each overlay `image:` (or recreate accounts from the UI after
changing the env), then `docker compose up -d`. Watch one account's logs
through a full cycle before walking away.

## Moving to another VPS

1. New host: install Docker (see [DEPLOY.md](DEPLOY.md)), clone the repo, copy
   `.env.example` to `.env` and set `LAPOSTE_PROJECT_DIR` to the **new** path.
2. Copy `.env` values (except `LAPOSTE_PROJECT_DIR`), `compose.forwarders.yaml`,
   `secrets/`, and `data/` from the old host (`scp -rp`).
3. Old host: `docker compose down`. Never run both hosts at once with deletion
   enabled - it works (dedup is server-side state), but debugging anything
   with two writers is unpleasant.
4. New host: `docker compose up -d --build`, then send a test mail per account.
5. Expect fresh Google "new sign-in" alerts from the new IP; approve them.

## Things to know

- **Forwarded mail bypasses Gmail's filters and spam scan.** Messages enter
  Gmail via IMAP APPEND, so Gmail filter rules do not run on them and no spam
  scoring happens. La Poste's own spam filter has already run (only INBOX is
  synced, not the laposte Spam folder). If Gmail-side rules are needed, most
  can be approximated with a filter on `deliveredto:` or by using Gmail search
  operators after the fact.
- **Mobile/new-mail notifications for appended mail can behave differently**
  from normally delivered mail. Verify with a test message before trusting it
  for anything urgent.
- **The effective window is 24-48 h**, not exactly 24: IMAP `SEARCH SINCE` has
  whole-day granularity. This is intentional slack.
- **Oversized messages**: there is deliberately no `--maxsize` cap. A message
  Gmail refuses to accept (>~25 MB) will fail its copy, stay in the laposte
  INBOX, and show as a recurring error in the logs rather than disappearing.
  Handle it manually (download from laposte webmail, then delete).
- **Multiple runs never overlap** for one account: the loop sleeps only after
  a run finishes, and `docker compose run` catch-ups share Gmail-side dedup
  with the loop, so worst case is a re-forward that Gmail's Message-ID
  matching filters out.
- **The API has root-equivalent access** via the Docker socket. It is only
  reachable through Caddy on HTTPS, behind the UI password. Do not publish
  the API port on the host.
