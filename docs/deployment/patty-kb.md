# Patty KB deployment — contabo-japan (vmi3404035)

Production instance: **https://kb.patty.io** (fronted by Caddy Proxy Manager, upstream `10.0.0.5:8080`).

## Layout

- Box: `contabo-japan` (Tailscale `100.120.174.24`, ssh `root@contabo-japan` with `~/.ssh/t1_fetcher_ed25519`)
- Deploy dir: `/opt/docmost/` — plain source copy of this repo (not a git checkout), plus `.env` (secrets, never committed)
- Compose: `docker compose -f docker-compose.prod.yml up -d` (file is committed in this repo — keep box and repo in sync)
- Containers: `docmost` (app), `docmost-db` (Postgres 18 + **pgvector**), `docmost-redis`, `docmost-ollama` (embeddings)
- All on the external `omniroute_default` docker network

## AI / semantic search stack (PAT-2329)

| Piece | Where | Notes |
|---|---|---|
| Embeddings | `docmost-ollama` container, `bge-m3`, CPU-only | 1024 dims; `OLLAMA_KEEP_ALIVE=-1` (cold load ~11s, warm embed ~350ms); reachable only inside the docker network as `http://ollama:11434` |
| LLM (answers/chat) | MiniMax `https://api.minimax.io/v1` (OpenAI-compatible), model `MiniMax-M3` | key lives in `/opt/docmost/.env` (`OPENAI_API_KEY`) |
| Vectors | `page_embeddings` table (pgvector) in `docmost-db` | created by server migration (PAT-2330) |

Driver semantics (our fork's EE replacement, `apps/server/src/ee/`): if `OLLAMA_API_URL` is set, **embeddings go to Ollama**; **completions always go to the `AI_DRIVER`** provider (`openai-compatible` → MiniMax).

## Required `.env` keys

```
APP_URL=https://kb.patty.io
APP_SECRET=<64 hex>
DATABASE_URL=postgresql://docmost:<pw>@docmost-db:5432/docmost
REDIS_URL=redis://docmost-redis:6379
POSTGRES_PASSWORD=<pw>          # referenced by compose

OLLAMA_API_URL=http://ollama:11434
AI_EMBEDDING_MODEL=bge-m3
AI_EMBEDDING_DIMENSION=1024
AI_DRIVER=openai-compatible
OPENAI_API_URL=https://api.minimax.io/v1
OPENAI_API_KEY=<minimax key>
AI_CHAT_MODEL=MiniMax-M3
AI_COMPLETION_MODEL=MiniMax-M3
```

## Local dev parity

`docker compose -f docker-compose.yml -f docker-compose.local-test.yml up -d db redis ollama`
→ Postgres+pgvector on `:5433`, Redis on `:6380`, Ollama on `:11435`. Root `.env` mirrors the table above with local URLs.

## Deploying code changes

1. Commit + push on `custom`
2. `rsync -a --delete --exclude .env --exclude node_modules --exclude 'apps/*/dist' ./ root@contabo-japan:/opt/docmost/`
3. On the box: `cd /opt/docmost && docker compose -f docker-compose.prod.yml up -d --build docmost`

## Hosted MCP (`patty-kb-mcp`)

`https://mcp.kb.patty.io/mcp` — the same tool surface as the stdio server, for harnesses
that cannot install it locally. Clients send `Authorization: Bearer <Keycloak access token>`
(realm `internal`, scope `mcp:tools`, audience `https://mcp.kb.patty.io`); the server
exchanges that token for a per-user Docmost session at `/api/sso/oidc/exchange`, so the
group allowlist and every page permission stay exactly as they are in Docmost.

| | |
| --- | --- |
| Source | `patty-io/patty-kb-mcp` → CI-built Harbor image (`patty-kb-mcp-image.yml` on GARM) |
| Compose service | `patty-kb-mcp` in `deploy/production/docker-compose.yml` (digest owned by the Kargo `patty-kb` stage; see Deploy) |
| Container name | **`patty-kb-mcp`** — it is Caddy's upstream (`patty-kb-mcp:8080`); renaming it 502s the vhost |
| Network / port | `omniroute_default`, internal `8080` (no published ports) |
| Replicas | **one, by design** — the session cache and rate limits are in-process; scaling out needs Redis first |
| Logs | one JSON line per request on stderr (`sub`, method, status, ms). Tokens are never logged |

Environment (all optional except the first three):

```
PATTY_KB_URL=https://kb.patty.io
PATTY_KB_RESOURCE_URL=https://mcp.kb.patty.io     # token audience + PRM resource
PATTY_KB_ISSUER=https://login.patty.io/realms/internal
PATTY_KB_ALLOWED_HOSTS=mcp.kb.patty.io            # host-header allowlist (default: resource URL host)
# PATTY_KB_HTTP_PORT=8080  PATTY_KB_SESSION_TTL_SECONDS=3600  PATTY_KB_RATE_LIMIT_PER_MINUTE=60
# PATTY_KB_MAX_CONCURRENT=4  PATTY_KB_REQUEST_LIMIT_BYTES=10485760  PATTY_KB_RESULT_LIMIT_BYTES=5242880
# PATTY_KB_REQUIRED_SCOPE=mcp:tools  PATTY_KB_AUDIENCE=<override>  PATTY_KB_ISSUERS_JWKS=<override>
```

### Deploy

The digest in `deploy/production/docker-compose.yml` is the deploy version. Bump
it (or let a Kargo promotion of `patty-kb-mcp` bump it), commit on
`patty-io/patty-kb:main` — the box's `kb-deploy-pull` timer converges within
~2 minutes (`git fetch` → `reset --hard` → `compose pull && up -d`).

### Verify

```sh
curl -s https://mcp.kb.patty.io/healthz                                  # {"status":"ok","version":"1.0.0"}
curl -s https://mcp.kb.patty.io/.well-known/oauth-protected-resource     # resource + authorization_servers
curl -si -X POST https://mcp.kb.patty.io/mcp -H 'content-type: application/json' -d '{}' | head -4
#   → 401 with  www-authenticate: Bearer error="invalid_token", resource_metadata=…
```

With a real user token (device flow, client `patty-code-mcp`), a `tools/list` returns 41
tools. A **client-credentials** token — e.g. `patty-accounts-bootstrap-admin` — passes the
bearer gate but fails the exchange with a clean `HTTP 401 Invalid or expired identity
token`, because a service account has no userinfo; that is expected, not a fault.

Keycloak side (scope, audience mapper, device client) is codified in `patty-io/keycloak`:
`realm/realm-internal.json`, applied idempotently by `scripts/apply-internal-mcp.sh` and
checked by `scripts/verify-realm-internal.sh` (`PASS mcp:tools + patty-code-mcp`).

### Rollback

Change the `patty-kb-mcp` digest back to the known-good one in
`deploy/production/docker-compose.yml` and commit — the box converges within
~2 minutes. Stdio users are unaffected, and the Docmost side needs no change
(the exchange endpoint is shared with the stdio flow).

> ⚠️ If the `caddy` container on this host is ever recreated, restart the Proxy Manager
> afterwards — its routes live in the CPM database and are pushed to Caddy over the admin
> API. Without that restart the vhost serves nothing.
