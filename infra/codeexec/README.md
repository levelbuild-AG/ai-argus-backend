# Code Execution Service for LibreChat

This directory contains a self‑hosted implementation of the
LibreChat Code Interpreter API.  It allows you to run Python and
Bash code, manage files and persist session state, serving as a drop‑in
replacement for LibreChat’s enterprise Code Interpreter service.

The service is designed with security and flexibility in mind:

* Only **Python** and **Bash** are supported initially; additional
  languages can be added by implementing new executors in
  `src/codeexec/executor/`.
* Uses FastAPI for the HTTP interface and can be deployed both
  alongside LibreChat via Docker Compose and independently on
  Google Cloud Run.
* Enforces API key authentication via the `x-api-key` header.
* Provides a minimal API surface that mimics LibreChat’s Code
  Interpreter endpoints (`/v1/sessions`, `/v1/sessions/{id}/execute`, etc.).
* Stores session files either on the container’s local filesystem or
  in Google Cloud Storage, configurable via environment variables.

## Quick start (Docker Compose)

1. Add the contents of `docker-compose.snippet.yml` to your main
   `docker-compose.yml`.  This defines a `codeexec` service.
2. Define environment variables in LibreChat’s `.env`:

   ```env
   LIBRECHAT_CODE_API_KEY=super‑secret‑key
   LIBRECHAT_CODE_BASEURL=http://codeexec:8080
   ```
3. Bring up the stack:

   ```sh
   docker compose up -d
   ```
4. In the LibreChat UI, enable Code Interpreter for agents.  When you
   run code, LibreChat will send requests to the local `codeexec`
   service.

See `docs/integration_guide.md` for a detailed step‑by‑step guide.

## Deploy to Cloud Run

Use the `deploy_gcr.sh` script to build and deploy the image to
Google Cloud Run.  Remember to update the project ID, region,
service name, repository and API key before running the script.

After deployment, set `LIBRECHAT_CODE_BASEURL` in LibreChat’s `.env`
to the Cloud Run URL.  You can then scale the service independently
of your main LibreChat stack.

## Development

* Code lives in `src/codeexec/`.  Executable entry point is
  `codeexec.api.main:app`.
* Tests are located in `tests/` and can be run with `pytest`.
* Configuration is loaded from environment variables; see
  `src/codeexec/config.py` for a list of supported options.
* Additional documentation can be found in the `docs/` folder.

Contributions, bug reports and suggestions are welcome!