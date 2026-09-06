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
#
# Restored from backup (never overwritten by git): .env, compose.forwarders.yaml,
# secrets/, data/. Platform compose.yaml always comes from the tagged tree.

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

ensure_overlay() {
    if [[ ! -f "$PROJECT_DIR/compose.forwarders.yaml" ]]; then
        printf '%s\n' '# Managed by the laposte-forwarder API. Do not edit by hand.' 'services: {}' \
            >"$PROJECT_DIR/compose.forwarders.yaml"
        log "wrote empty compose.forwarders.yaml"
    fi
}

# Local state: overlay, secrets, env, stats. Platform compose.yaml is versioned.
restore_config() {
    if [[ -f "$BACKUP_DIR/.env" ]]; then
        cp -a "$BACKUP_DIR/.env" "$PROJECT_DIR/.env"
    fi
    if [[ -f "$BACKUP_DIR/compose.forwarders.yaml" ]]; then
        cp -a "$BACKUP_DIR/compose.forwarders.yaml" "$PROJECT_DIR/compose.forwarders.yaml"
    elif [[ -f "$BACKUP_DIR/compose.yaml" ]]; then
        # Pre-UI backup: the old compose.yaml held account services. Keep it for
        # the operator; do not replace the platform compose.yaml from git.
        cp -a "$BACKUP_DIR/compose.yaml" "$PROJECT_DIR/compose.yaml.pre-ui-backup"
        log "WARNING: no compose.forwarders.yaml in backup; saved pre-UI compose.yaml as compose.yaml.pre-ui-backup"
    fi
    ensure_overlay
    if [[ -d "$BACKUP_DIR/secrets" ]]; then
        mkdir -p "$PROJECT_DIR/secrets"
        cp -a "$BACKUP_DIR/secrets/." "$PROJECT_DIR/secrets/"
        chmod 700 "$PROJECT_DIR/secrets"
        shopt -s nullglob
        chmod 644 "$PROJECT_DIR"/secrets/*.txt
        shopt -u nullglob
    fi
    if [[ -d "$BACKUP_DIR/data" ]]; then
        mkdir -p "$PROJECT_DIR/data"
        cp -a "$BACKUP_DIR/data/." "$PROJECT_DIR/data/"
        chmod 777 "$PROJECT_DIR/data/stats" 2>/dev/null || true
    else
        mkdir -p "$PROJECT_DIR/data/stats"
        chmod 777 "$PROJECT_DIR/data/stats"
    fi
}

restore_config_on_failure() {
    local rc=$?
    if [[ $rc -ne 0 && $BACKED_UP -eq 1 ]]; then
        log "deploy failed (exit $rc); restoring config from $BACKUP_DIR"
        mkdir -p "$PROJECT_DIR"
        restore_config || true
    fi
    exit "$rc"
}
trap restore_config_on_failure EXIT

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
[[ -f "$PROJECT_DIR/compose.yaml" ]] && cp -a "$PROJECT_DIR/compose.yaml" "$BACKUP_DIR/compose.yaml"
[[ -f "$PROJECT_DIR/compose.forwarders.yaml" ]] && cp -a "$PROJECT_DIR/compose.forwarders.yaml" "$BACKUP_DIR/compose.forwarders.yaml"
[[ -f "$PROJECT_DIR/.env" ]] && cp -a "$PROJECT_DIR/.env" "$BACKUP_DIR/.env"
[[ -d "$PROJECT_DIR/secrets" ]] && cp -a "$PROJECT_DIR/secrets" "$BACKUP_DIR/secrets"
[[ -d "$PROJECT_DIR/data" ]] && cp -a "$PROJECT_DIR/data" "$BACKUP_DIR/data"
BACKED_UP=1

log "wiping $PROJECT_DIR contents"
find "$PROJECT_DIR" -mindepth 1 -delete

log "extracting archive"
tar -xzf "$ARCHIVE" -C "$PROJECT_DIR"
rm -f "$ARCHIVE"

log "restoring config"
restore_config

log "starting containers"
(cd "$PROJECT_DIR" && docker compose up -d --build && docker compose ps)

log "pruning old backups (keeping last $KEEP_BACKUPS)"
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -rf

log "deploy of $TAG complete"
