<p align="center"><img src="docs/assets/branding/patty-kb-hero.svg" width="760" alt="Patty KB — ask, and knowledge connects"/></p>

<p align="center">
<a href="./README.md">한국어</a> · English
</p>

<p align="center">
<a href="#"><img src="https://img.shields.io/badge/PATTY-INTERNAL-1769e0.svg?style=flat-square&labelColor=161616" alt="Patty Internal"/></a>
<a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-1769e0.svg?style=flat-square&labelColor=161616" alt="License: AGPL-3.0"/></a>
<a href="https://github.com/patty-io/patty-kb/actions/workflows/kb-image.yml"><img src="https://github.com/patty-io/patty-kb/actions/workflows/kb-image.yml/badge.svg?branch=main" alt="kb-image"/></a>
<a href="https://patty.io"><img src="https://img.shields.io/badge/PATTY.IO-patty.io-1769e0.svg?style=flat-square&labelColor=161616" alt="patty.io"/></a>
</p>

<h3 align="center">Ask, and knowledge connects</h3>

<p align="center">
Patty KB is Patty's internal knowledge base. Decisions, designs, learnings and runbooks all live here,<br/>
and AI semantic search finds answers by <b>meaning</b>, not keywords.<br/>
It is a docmost fork, adapted to Patty's SSO, AI stack and deployment pipeline.
</p>

---

## What this repo does

- **Web app (`apps/client`)** — page editing, tree navigation, search, AI translation UI (Next.js)
- **Server (`apps/server`)** — API, spaces/permissions, the embedding pipeline, SSO (NestJS)
- **AI stack** — embeddings are **self-hosted** (ollama + `bge-m3`, CPU); only answer generation uses the MiniMax API. Vectors live in Postgres **pgvector**
- **SSO** — OIDC login via `login.patty.io` (Keycloak)
- **Agent interface** — an MCP server (separate repo `patty-kb-mcp`) lets agents read and write the KB directly
- **Deployment** — GARM → Harbor → Kargo pipeline. **Nothing is deployed by hand** (`deploy/README.md`)

## Design philosophy

1. **Knowledge is the company's memory.** — Decisions, structures, even the dead ends get recorded here. Memory belongs to the repo, not to a person.
2. **Search is done by AI.** — Semantic (embedding) retrieval, not keyword matching. You can reach the answer without knowing the document.
3. **AI runs locally whenever possible.** — Document embeddings are computed on our own box and never leave it. Only generation goes to MiniMax.
4. **Git is the truth.** — Deploys happen only as Kargo promotions (= git commits). The box merely converges to them.
5. **Korean first.** — Korean is the primary language; an English mirror (`README.en.md`) is maintained alongside.

## Architecture

```text
browser / MCP agents
      │
      ▼
apps/client (Next.js) ── apps/server (NestJS)
      │                        │
      │                        ├── Postgres 18 + pgvector   documents + vectors
      │                        ├── Redis                     cache / sessions
      │                        ├── ollama (bge-m3)           embeddings — local, CPU
      │                        └── MiniMax API               answer generation — external

deploy:  git push → GARM build → Harbor → Kargo promotion → box converges (2-min timer)
```

## Quick start (local dev)

Prerequisites: Node 22+ · pnpm 11.25+ (per `packageManager`) · Docker

```bash
pnpm install
cp .env.example .env        # fill in APP_SECRET etc. — openssl rand -hex 32
docker compose -f docker-compose.local-test.yml up -d   # db(pgvector) · redis · ollama
pnpm dev                    # server + client together
```

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | server + client in dev mode |
| `pnpm server:dev` · `pnpm client:dev` | run individually |
| `pnpm build` | production build |
| `docker compose -f docker-compose.local-test.yml up -d` · `down` | local infra (db/redis/ollama) |

## Repository layout

```text
apps/
  client/                  Next.js web app
  server/                  NestJS API (+ database/migrations)
deploy/                    GitOps deploy tree — the source of deploy rules
  production/              production compose (what the box converges to) + convergence agent
  kargo/                   Kargo Project · Warehouse · Stage definitions
docs/
  assets/branding/         hero & branding assets
  deployment/              box operations in detail (AI stack, .env keys)
migration/                 upstream docmost migration scripts
docker-compose*.yml        dev / local-test / (legacy) prod stacks
Dockerfile                 production image (target: installer)
```

## Working order (contributors & agents alike)

1. **Read the deploy rules first.** — `deploy/README.md`. Never build on the box, never deploy by hand.
2. **Secrets live on the box only.** — `.env` exists only on the server (`/opt/docmost/.env`). Never commit it.
3. **Deploys happen as promotions only.** — commit → image build → Promote in Kargo. The box converges by itself within 2 minutes.
4. **Check the platform docs.** — KB → *Engineering Culture → CI/CD & Deployment* (pipeline structure, runbooks, incident fixes — all of it).
5. **When you learn something, write it to the KB first.** — This repo is the company's memory. The next person reads your note.

## Troubleshooting

- **Promoted, but the KB looks unchanged** — box convergence lags up to 2 minutes. Check `journalctl -t kb-deploy` for the converge log.
- **Search isn't working** — `docker ps | grep ollama` to check the embedding container (bge-m3 first load ~11s; it's kept resident).
- **Can't sign in** — check the OIDC keys in `.env` (values only exist on the box).
- **Otherwise** — start with the Hard rules in `deploy/README.md` and the KB's Pipeline Runbook.

## Reference documents

- [`deploy/README.md`](./deploy/README.md) — deploy · promotion · rollback runbook (the source of deploy rules)
- [`docs/deployment/patty-kb.md`](./docs/deployment/patty-kb.md) — box operations in detail (AI stack, `.env` keys)
- KB → *Engineering Culture → CI/CD & Deployment* — the whole platform (GARM · Harbor · Kargo · Argo CD · runbooks)
- `patty-kb-mcp` — the MCP server agents use to read/write the KB

## License

Upstream **docmost's AGPL-3.0** license is preserved ([`LICENSE`](./LICENSE)).<br/>
This repository is a **fork operated internally by Patty Co., Ltd.** All rights to Patty's modifications and internal deployment configuration belong to Patty Co., Ltd.; external redistribution and reuse are prohibited.

<p align="center"><sub>PATTY KB · single source of knowledge · AI semantic search · GitOps delivery</sub></p>
