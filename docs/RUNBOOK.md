# Runbook

Day-2 operations. First-time setup is in [DEPLOY.md](DEPLOY.md).

## Daily driving

```bash
docker compose ps                      # container + health state per account
docker compose logs -f alice           # follow one account
docker compose logs --since 1h         # everything recent
docker compose restart alice           # bounce one account
docker compose up -d                   # apply compose.yaml changes
```

Logs are capped (10 MB x 3 files per container, set in the compose anchor), so
they can be left alone forever.

A container shown as `unhealthy` means no successful sync for 5+ minutes while
the process is still running - almost always an authentication failure. Check
its logs first.

## Recovering from an outage (IMPORTANT)

Only mail that **arrived within `WINDOW_DAYS`** (default 1 day) is forwarded.
If forwarding was down longer than that - VPS outage, expired password,
La Poste block - mail that arrived during the gap is older than the window and
will never be picked up by the normal loop: it sits in the laposte INBOX,
unforwarded and undeleted, silently.

After any outage, run a catch-up with a window comfortably larger than the
downtime:

```bash
docker compose run --rm alice /usr/local/bin/laposte-forward --once --window-days 30
```

This is safe to run repeatedly: duplicate detection skips anything already in
Gmail, and deletion still only happens after a confirmed copy. It inherits the
account's `DELETE_AFTER_FORWARD` setting.

Caution: on a mailbox with a large backlog (e.g. first deployment on an
account holding years of mail), a large `--window-days` will forward *and
delete* everything in that window. If unsure, preview first:

```bash
docker compose run --rm -e DRY_RUN=true alice /usr/local/bin/laposte-forward --once --window-days 30
```

## Adding an account

1. In `compose.yaml`: duplicate a service block and its two `secrets:` entries
   (the template has a commented-out `bob` to copy).
2. Create the two password files in `secrets/`, mode `644` (the directory is
   `700`; see the permissions rationale in [DEPLOY.md](DEPLOY.md)).
3. Follow the phased rollout in [DEPLOY.md](DEPLOY.md) for the new account -
   in particular, keep `DELETE_AFTER_FORWARD: "false"` until validated.

## Rotating a password

1. Change the password / create the new Gmail app password.
2. Update the file in `secrets/`.
3. `docker compose up -d --force-recreate alice` - secrets are mounted at
   container creation, so a plain restart is not enough for compose secrets on
   some versions; recreation is always correct.

Note: changing the Google account's *main* password revokes all its app
passwords, so expect to do this after any Google password change.

## Upgrading imapsync

The image is pinned by tag and digest in the compose anchor. To upgrade:

```bash
# See what tags exist / current digest:
curl -s https://hub.docker.com/v2/repositories/gilleslamiral/imapsync/tags/2.319 | python3 -m json.tool
```

Pick the new tag, fetch its digest the same way, update the `image:` line in
`compose.yaml` (and `compose.example.yaml` for the next deployment), then
`docker compose up -d`. Watch one account's logs through a full cycle before
walking away.

## Moving to another VPS

1. New host: install Docker (see [DEPLOY.md](DEPLOY.md)), clone the repo.
2. Copy `compose.yaml` and `secrets/` from the old host
   (`scp -rp`, they are gitignored by design).
3. Old host: `docker compose down`. Never run both hosts at once with deletion
   enabled - it works (dedup is server-side state), but debugging anything
   with two writers is unpleasant.
4. New host: `docker compose up -d`, then send a test mail per account.
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
