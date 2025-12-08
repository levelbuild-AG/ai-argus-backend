# SearXNG Stack (LibreChat Web Search)

This directory contains a standalone Compose bundle for running a local [SearXNG](https://searxng.org) instance that LibreChat can use as its search provider. The configuration assumes Google Programmable Search (CSE) is the only active engine and reads the required secrets from environment variables exposed to the container.

## Files

- `docker-compose.searxng.yml` – spins up the `searxng` service, exposes it on `8080`, and mounts the local `settings.yml` file.
- `settings.yml` – minimal engine configuration that enables the Google CSE backend and expects `GOOGLE_SEARCH_API_KEY` and `GOOGLE_CSE_ID` to be present in the container environment.

## Running the service

You can either run SearXNG next to the main LibreChat stack or integrate it directly.

```bash
# Option A: run separately using its own project
cd infra/searxng
GOOGLE_SEARCH_API_KEY=... GOOGLE_CSE_ID=... docker compose -f docker-compose.searxng.yml up -d

# Option B: copy the service definition into your primary Compose file or
# include this Compose as an override, ensuring the LibreChat network can
# resolve the host `searxng`.
```

LibreChat reaches the service via `http://searxng:8080` when both stacks share a Docker network. If they run as separate Compose projects, connect the networks or expose the port publicly and set `SEARXNG_INSTANCE_URL` accordingly.

## Production notes

- Replace `SEARXNG_SECRET_KEY` with a strong random value before deploying.
- Consider removing the published port in locked-down environments; LibreChat needs only the internal DNS endpoint.
- Additional engines can be added to `settings.yml`, but keep the Google CSE engine enabled so the new web search flow keeps working.
