# Infrastructure Services

This directory contains infrastructure services and submodules used by LibreChat.

## Submodules

This repository uses git submodules for external dependencies:

- **firecrawl** (`infra/firecrawl/`): Web scraping service
- **rag_api** (`infra/rag_api/`): RAG (Retrieval Augmented Generation) API service for file embeddings

## Cloning the Repository with Submodules

When cloning this repository for the first time, initialize submodules:

```bash
git clone <repo-url>
cd ai-argus-backend
git submodule update --init --recursive
```

Or clone with submodules in one command:

```bash
git clone --recurse-submodules <repo-url>
```

## Updating Submodules

To update submodules to their latest upstream commits:

```bash
git submodule update --remote --merge
```

To update to a specific commit/tag:

```bash
cd infra/rag_api  # or infra/firecrawl
git fetch origin
git checkout <commit-hash-or-tag>
cd ../..
git add infra/rag_api  # or infra/firecrawl
git commit -m "Update submodule to <tag>"
```

## Building Services

### RAG API

The RAG API is built from the `infra/rag_api` submodule. It's automatically built when running:

```bash
docker compose build rag_api
```

Or as part of the full stack:

```bash
docker compose build
docker compose up -d
```

**Build context**: `./infra/rag_api`  
**Image tag**: `librechat-rag-api-dev:local`

**Note**: The RAG API uses the **dev** (full) build variant, not dev-lite. See `infra/rag_api/README.md` for details on build variants.

### Code Execution Service

The code execution service is built from `infra/codeexec`:

```bash
docker compose build codeexec
```

## Running on VM

After cloning and initializing submodules on the VM:

```bash
# Ensure submodules are initialized
git submodule update --init --recursive

# Build all services (including RAG API from submodule)
docker compose -f deploy-compose.yml build

# Start services
docker compose -f deploy-compose.yml up -d

# Check RAG API health
curl http://localhost:${RAG_PORT:-8000}/health
```

## Service-Specific Documentation

- **RAG API**: See `infra/rag_api/README.md`
- **Firecrawl**: See `infra/firecrawl/README.md`
- **Code Execution**: See `infra/codeexec/README.md`
- **Web Search Stack**: See `infra/README-websearch.md`
