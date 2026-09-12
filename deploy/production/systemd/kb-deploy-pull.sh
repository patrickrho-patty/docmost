#!/bin/sh
# Patty KB convergence agent (contabo-japan).
#
# Mechanics only: converge the box to whatever git says. A failed apply is
# retried on the next tick (the last-applied marker only advances on success).
#
# Installed as: /opt/docmost-deploy-pull.sh + kb-deploy-pull.{service,timer}
set -eu

REPO_DIR=/opt/docmost
BRANCH=main
COMPOSE=deploy/production/docker-compose.yml
ENV_FILE=/opt/docmost/.env   # explicit: compose interpolation ($POSTGRES_PASSWORD) must see it
STATE_DIR=/var/lib/kb-deploy
STATE=$STATE_DIR/last-applied

cd "$REPO_DIR"
git fetch -q origin "$BRANCH"
REMOTE=$(git rev-parse "origin/$BRANCH")
APPLIED=$(cat "$STATE" 2>/dev/null || echo none)

[ "$APPLIED" = "$REMOTE" ] && exit 0

logger -t kb-deploy "converging: $(echo "$APPLIED" | cut -c1-7) -> $(echo "$REMOTE" | cut -c1-7)"
git reset -q --hard "origin/$BRANCH"

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE" pull -q && \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE" up -d; then
  mkdir -p "$STATE_DIR"
  echo "$REMOTE" > "$STATE"
  logger -t kb-deploy "converged to $(echo "$REMOTE" | cut -c1-7)"
else
  logger -t kb-deploy "converge FAILED at $(echo "$REMOTE" | cut -c1-7) — retrying next tick"
  exit 1
fi
