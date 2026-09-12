#!/bin/sh
# Patty KB convergence agent (contabo-japan).
#
# Mechanics only: if the deploy branch moved, hard-reset the checkout and let
# compose converge to the Kargo-pinned digest. It never decides anything —
# every deploy decision lives in git (written by the Kargo production Stage).
#
# Installed as: /opt/docmost-deploy-pull.sh + docmost-deploy-pull.{service,timer}
set -eu

REPO_DIR=/opt/docmost
BRANCH=main
COMPOSE=deploy/production/docker-compose.yml

cd "$REPO_DIR"
git fetch -q origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

[ "$LOCAL" = "$REMOTE" ] && exit 0

logger -t kb-deploy "converging: ${LOCAL%????????} -> ${REMOTE%????????}"
git reset -q --hard "origin/$BRANCH"
docker compose -f "$COMPOSE" pull -q
docker compose -f "$COMPOSE" up -d
logger -t kb-deploy "converged to ${REMOTE%????????}"
