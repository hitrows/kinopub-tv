#!/bin/sh
# Push this checkout to a server that already runs the proxy, bumping VERSION
# so the TV picks up the change on its next "Start User App Sync".
#
# Settings come from deploy.env (not in git), e.g.:
#   DEPLOY_HOST=user@192.168.1.50
#   DEPLOY_DIR=/opt/kinopub-tv
#   DEPLOY_RESTART="cd /opt/kinopub-tv && docker compose restart kinopub"
set -e
cd "$(dirname "$0")"
[ -f deploy.env ] || { echo "deploy.env is missing (see the comment at the top of deploy.sh)"; exit 1; }
. ./deploy.env

LAST=$(cat VERSION 2>/dev/null || echo 0.0)
V=$(echo "$LAST" | awk -F. '{ printf "%d.%d", $1, $2 + 1 }')
echo "$V" > VERSION

rsync -a --delete --exclude .DS_Store tv proxy VERSION "$DEPLOY_HOST:$DEPLOY_DIR/"
ssh "$DEPLOY_HOST" "$DEPLOY_RESTART" >/dev/null 2>&1
echo "deployed v$V to $DEPLOY_HOST:$DEPLOY_DIR"
