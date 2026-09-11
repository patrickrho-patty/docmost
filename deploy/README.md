# Patty KB (docmost) deploy — GitOps for a compose host

The KB is an **internal system**: no staging stage, no Argo CD (there is no k8s
app). The pipeline still owns the build and the deploy decision — the box is
just a convergence agent.

## Flow

```
push to `custom` (app paths — deploy/** ignored)
  → GARM: docker build (target: installer) → Harbor
       registry.patty.io/patty-kb/docmost:sha-<commit>
  → Kargo Warehouse → Freight
  → production Stage (MANUAL promote in https://deploy.patty.io)
       yaml-update writes the digest into
       deploy/production/docker-compose.yml → commit → push to `custom`
  → the box (systemd timer, every 2 min):
       git fetch → HEAD moved? → git reset --hard origin/custom
                                 docker compose … pull && up -d
```

## The box (contabo-japan)

| Thing | Where |
| --- | --- |
| Checkout | `/opt/docmost` — a **real git checkout** of this repo (branch `custom`) |
| Secrets | `/opt/docmost/.env` — **untracked**; survives `git reset --hard`. Never commit it |
| Prod compose | `deploy/production/docker-compose.yml` — the `image:` digest line is Kargo-owned |
| Data | Docker named volumes (`docmost_docmost-data`, `docmost_docmost-db-data`, `docmost_docmost-redis-data`, `docmost_ollama-models`) — untouched by checkout swaps |
| Convergence agent | `/opt/docmost-deploy-pull.sh` + `docmost-deploy-pull.timer` (systemd, every 2 min) |
| Edge | unchanged — Caddy Proxy Manager fronts the docmost container on `omniroute_default` |

The old `docker-compose.prod.yml` at the repo root stays as the historical
reference for how the box used to be deployed (source copy + local build).
**Never build on the box again** — images come from Harbor.

## Promote (the human step)

1. https://deploy.patty.io → project `patty-kb` → Stage `production` → **Promote**
2. Within ~2 minutes the box pulls the new digest and restarts `docmost`
3. Verify: `curl -sI https://kb.patty.io` + the KB UI

CLI equivalent:

```bash
kubectl -n patty-kb create -f - <<YAML
apiVersion: kargo.akuity.io/v1alpha1
kind: Promotion
metadata:
  generateName: production-
  namespace: patty-kb
spec:
  stage: production
  freight: <name-from: kubectl -n patty-kb get freight>
YAML
```

## Rollback

Promote the previous Freight (Kargo UI shows history), or revert the digest
commit on `custom` — the box converges to either within ~2 minutes. The DB and
its data are never part of a rollback.

## Hard rules

1. **The `image:` digest line in `deploy/production/docker-compose.yml` is Kargo-owned** — never hand-edit (one exception: the initial bootstrap commit)
2. **`.env` is box-only** — it holds `POSTGRES_PASSWORD`, `APP_SECRET`, `OPENAI_API_KEY` (MiniMax). The compose references it as `../../.env`; the timer runs compose from `/opt/docmost` so interpolation works
3. **`[skip ci]` on promotions + `deploy/**` ignored by the build workflow** — both loop guards, never remove either
4. **The DB/AI stack are not in the pipeline** — `pgvector`, `redis`, `ollama` run their pinned public images; only the app image is CI-built
5. **No staging** (owner decision 2026-09-12): manually promoting production IS the gate. The timer is mechanical convergence only — it never decides anything

## History

- **2026-09-12** — onboarded: image build moved to GARM→Harbor, Kargo production-only stage, box converted from source-copy to git-checkout + convergence timer
