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
