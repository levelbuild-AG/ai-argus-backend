<!--
Repo discovery notes:
- Primary compose bundle: docker-compose.yml (root) with API, MongoDB, Meilisearch, rag_api, etc.
- Application code split between ./api and ./client per upstream LibreChat layout.
- Runtime configuration: librechat.yaml lives at repo root and is mounted automatically via /app/.env + CONFIG_PATH.
- The Docker cluster loads environment from ./.env which is bind-mounted into the API container.
-->

# LibreChat Web Search Stack

This document captures the modern web search pipeline built for LibreChat. The stack combines **SearXNG + Google Programmable Search**, **Firecrawl** for page scraping, and **Jina** for reranking, all controlled through `librechat.yaml` and the root `.env` file. Plugging in the required API keys and starting the services enables end-to-end cited answers in the LibreChat UI.

## Services and assets

- **SearXNG** (`infra/searxng/`)
  - `docker-compose.searxng.yml` and `settings.yml` boot a SearXNG instance that proxies Google CSE results.
  - Run separately (`docker compose -f infra/searxng/docker-compose.searxng.yml up -d`) or merge into the main compose and ensure LibreChat can reach `http://searxng:8080`.
- **Firecrawl** (`infra/firecrawl/README.md`)
  - Instructions for cloning and starting the Firecrawl OSS stack; LibreChat hits its REST API for scraping URLs returned by SearXNG.
- **LibreChat** (root `docker-compose.yml`)
  - The API container loads `.env` and `librechat.yaml`. The new `webSearch` block + env vars wire SearXNG, Firecrawl, and Jina together.

## Configuration checklist

Environment variables (in `.env`):

```
SEARXNG_INSTANCE_URL
SEARXNG_API_KEY (optional)
FIRECRAWL_API_KEY
FIRECRAWL_API_URL
FIRECRAWL_VERSION
JINA_API_KEY
JINA_API_URL (optional)
```

External secrets consumed by SearXNG or LibreChat:

```
GOOGLE_SEARCH_API_KEY
GOOGLE_CSE_ID
```

The `librechat.yaml` `webSearch` section references these variables directly; keep the variable names in sync across environments (Compose, GCR, Cloud Run, etc.).

## Running on the GCE VM

```bash
# 1. Launch SearXNG (optional separate compose project)
cd infra/searxng
GOOGLE_SEARCH_API_KEY=... GOOGLE_CSE_ID=... docker compose -f docker-compose.searxng.yml up -d

# 2. Launch Firecrawl using the helper README as a guide (ensuring it resolves as http://firecrawl:3002)

# 3. Start or restart the main LibreChat stack
docker compose up -d
```

LibreChat resolves `searxng` and `firecrawl` over Docker DNS if the services share a network. Otherwise, point the env URLs at reachable hosts (e.g., `https://search.example.com`).

## Cloud Run / GCR considerations

- Expose SearXNG and Firecrawl over HTTPS and supply their URLs via `SEARXNG_INSTANCE_URL` / `FIRECRAWL_API_URL`.
- Provide secrets (`GOOGLE_SEARCH_API_KEY`, `GOOGLE_CSE_ID`, `JINA_API_KEY`) through Secret Manager or Cloud Run env vars.
- No host-specific volumes were added; all configs live in-repo for portability.
