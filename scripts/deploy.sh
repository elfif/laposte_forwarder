#!/usr/bin/env bash
#
# deploy.sh -- deploy a prod-release-* tag on this VPS.
#
# Invoked over SSH by .github/workflows/deploy.yml. Fetches the tag into the
# persistent bare clone, archives it, stops the Compose stack, backs up the
# gitignored config, replaces the project tree, restores config, and brings
# the stack back up.
#
# Usage: bash ~/laposte_forwarder/scripts/deploy.sh <tag>

set -euo pipefail

PROJECT_DIR="$HOME/laposte_forwarder"
BARE_REPO="$HOME/laposte_forwarder.git"
BACKUP_ROOT="$HOME/laposte_forwarder_backups"
KEEP_BACKUPS=10

log() {
    printf '%s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
    log "FATAL: $*" >&2
    exit 1
}

TAG="${1:-}"
[[ "$TAG" =~ ^prod-release- ]] || die "tag must start with 'prod-release-' (got: '${TAG}')"

ARCHIVE="/tmp/laposte_forwarder-${TAG}.tar.gz"
BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
BACKED_UP=0

# After a successful backup, a later failure must not leave the project dir
# without its config: restore it so a manual `docker compose up -d` can start
# the stack again.
restore_config_on_failure() {
    local rc=$?
    if [[ $rc -ne 0 && $BACKED_UP -eq 1 ]]; then
        log "deploy failed (exit $rc); restoring config from $BACKUP_DIR"
        mkdir -p "$PROJECT_DIR"
        cp -a "$BACKUP_DIR/compose.yaml" "$PROJECT_DIR/compose.yaml" 2>/dev/null || true
        if [[ -d "$BACKUP_DIR/secrets" ]]; then
            cp -a "$BACKUP_DIR/secrets" "$PROJECT_DIR/secrets"
            chmod 700 "$PROJECT_DIR/secrets" 2>/dev/null || true
            chmod 644 "$PROJECT_DIR"/secrets/*.txt 2>/dev/null || true
        fi
    fi
    exit "$rc"
}
trap restore_config_on_failure EXIT

# Fetch and archive BEFORE stopping or deleting anything: if this fails, the
# live stack keeps running.
log "fetching tags into $BARE_REPO"
git --git-dir="$BARE_REPO" fetch --tags origin

git --git-dir="$BARE_REPO" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null \
    || die "tag '$TAG' not found in $BARE_REPO"

log "archiving $TAG to $ARCHIVE"
git --git-dir="$BARE_REPO" archive --format=tar.gz --output="$ARCHIVE" "$TAG"

log "stopping containers"
(cd "$PROJECT_DIR" && docker compose down)

log "backing up config to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
cp -a "$PROJECT_DIR/compose.yaml" "$BACKUP_DIR/compose.yaml"
[[ -d "$PROJECT_DIR/secrets" ]] && cp -a "$PROJECT_DIR/secrets" "$BACKUP_DIR/secrets"
BACKED_UP=1

log "wiping $PROJECT_DIR contents"
find "$PROJECT_DIR" -mindepth 1 -delete

log "extracting archive"
tar -xzf "$ARCHIVE" -C "$PROJECT_DIR"
rm -f "$ARCHIVE"

log "restoring config"
cp -a "$BACKUP_DIR/compose.yaml" "$PROJECT_DIR/compose.yaml"
if [[ -d "$BACKUP_DIR/secrets" ]]; then
    cp -a "$BACKUP_DIR/secrets" "$PROJECT_DIR/secrets"
    chmod 700 "$PROJECT_DIR/secrets"
    chmod 644 "$PROJECT_DIR"/secrets/*.txt
fi

log "starting containers"
(cd "$PROJECT_DIR" && docker compose up -d && docker compose ps)

log "pruning old backups (keeping last $KEEP_BACKUPS)"
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -rf

log "deploy of $TAG complete"
