# Integration Guide

This document explains how to integrate the self‑hosted code execution
service with LibreChat as well as how to deploy the service to
Google Cloud Run.  The goal is to provide a drop‑in replacement for
the official Code Interpreter API so that LibreChat agents can run
Python and Bash code securely in your own infrastructure.

## Environment variables in LibreChat

LibreChat reads its configuration from a `.env` file.  For the
Code Interpreter integration two environment variables are of
interest:

| Variable | Description | Example |
|---------|-------------|---------|
| `LIBRECHAT_CODE_API_KEY` | API key for the Code Interpreter service.  When set globally, provides access to all users.【424738187294248†L1204-L1209】 | `LIBRECHAT_CODE_API_KEY=super‑secret‑key` |
| `LIBRECHAT_CODE_BASEURL` | Custom base URL for the Code Interpreter API (Enterprise plans only).  Set this to point to your self‑hosted endpoint.【424738187294248†L1204-L1209】 | `LIBRECHAT_CODE_BASEURL=http://codeexec:8080` |

If these variables are not present in your `.env` file you can add
them manually.  `LIBRECHAT_CODE_API_KEY` should be a long random
secret; LibreChat will send this value in the `x-api-key` header
when talking to the code execution service.  `LIBRECHAT_CODE_BASEURL`
should point to the internal URL of the service when running
alongside LibreChat in Docker Compose or to the public Cloud Run
URL when deployed there.

For example, in your LibreChat `.env` file:

```env
# Code Interpreter (self‑hosted)
LIBRECHAT_CODE_API_KEY=super‑secret‑key
LIBRECHAT_CODE_BASEURL=http://codeexec:8080
```

Make sure to restart the LibreChat server after editing `.env` so
that the new variables take effect.

## Adding the service to Docker Compose

The repository includes a `docker-compose.snippet.yml` file that
defines a `codeexec` service.  To enable the service in your
LibreChat deployment:

1. Copy the contents of `infra/codeexec/docker-compose.snippet.yml`
   into your main `docker-compose.yml` (or `deploy-compose.yml`) file
   under the `services:` section.  Ensure the `codeexec` service is
   defined alongside the LibreChat API, UI, MongoDB and Redis
   services.
2. Mount a volume for session storage and configure environment
   variables as needed.  The default snippet stores session files in
   `/tmp/codeexec` inside the container and limits execution to 2 GiB
   of RAM and 120 seconds per run.
3. Set `LIBRECHAT_CODE_API_KEY` and `LIBRECHAT_CODE_BASEURL` in
   `.env` as shown above.  The base URL should point at
   `http://codeexec:8080` so that the API container can reach
   `codeexec` via the Docker network.
4. (Optional) Adjust resource limits, the storage backend and other
   parameters via environment variables prefixed with `CODEEXEC_`.
   See `src/codeexec/config.py` for the full list of options.

Once the `codeexec` service is defined and the environment variables
are set, bring up the stack:

```sh
docker compose up -d
```

You can verify that the service is running by executing the health
endpoint from within the LibreChat API container:

```sh
docker exec -it <librechat-api-container> \
  curl -H "x-api-key: $LIBRECHAT_CODE_API_KEY" http://codeexec:8080/health
```

## Deploying to Google Cloud Run

If you prefer to run the code execution service separately from
LibreChat (for example to scale independently), you can deploy it to
Google Cloud Run.  Use the provided `deploy_gcr.sh` script:

1. Edit the variables at the top of `infra/codeexec/deploy_gcr.sh`:
   - `PROJECT_ID`: your GCP project ID
   - `REGION`: the region for Cloud Run (e.g. `europe-west1`)
   - `SERVICE_NAME`: the Cloud Run service name
   - `REPO`: the Artifact Registry repository name
   - `CODEEXEC_API_KEY`: the same secret used in your LibreChat `.env`
   - `CODEEXEC_GCS_BUCKET`: name of the GCS bucket for file storage when
     using the `gcs` storage backend
2. Run the script:

   ```sh
   bash infra/codeexec/deploy_gcr.sh
   ```

   This will build the container image, push it to Artifact Registry
   and deploy a new Cloud Run revision.  The script sets
   `CODEEXEC_STORAGE_BACKEND=gcs` automatically.  If you prefer to
   store files on the container's local disk instead, modify the
   script accordingly.
3. After deployment completes, retrieve the service URL:

   ```sh
   gcloud run services describe $SERVICE_NAME --project $PROJECT_ID --region $REGION --format='get(status.url)'
   ```

4. Update your LibreChat `.env` so that
   `LIBRECHAT_CODE_BASEURL` points to this URL:

   ```env
   LIBRECHAT_CODE_BASEURL=https://<your-cloud-run-url>
   LIBRECHAT_CODE_API_KEY=super‑secret‑key
   ```

   Restart LibreChat.  All code execution requests will now be
   forwarded to Cloud Run.

## API overview

The service exposes the following HTTP endpoints:

| Method | Path | Description |
|------|------|-------------|
| `GET` | `/health` | Returns `{"status": "ok"}` for health checks. |
| `POST` | `/v1/sessions` | Create a new session.  Requires a JSON body with a `language` field (`"python"` or `"bash"`).  Returns a `session_id`. |
| `GET` | `/v1/sessions/{session_id}` | Get session metadata and list of stored files. |
| `DELETE` | `/v1/sessions/{session_id}` | Delete a session and its files. |
| `POST` | `/v1/sessions/{session_id}/execute` | Execute code.  Requires a JSON body with a `code` string and optional `stdin` and `language` fields.  Returns captured `stdout`, `stderr`, `exit_code`, execution duration and list of files. |
| `POST` | `/v1/sessions/{session_id}/files` | Upload files via multipart form data.  Returns the saved file paths. |
| `GET` | `/v1/sessions/{session_id}/files/{file_path}` | Download a file previously uploaded or generated by code. |

All requests must include an `x-api-key` header matching the value of
`CODEEXEC_API_KEY` in order to be authorised.  The API is stateless;
sessions are represented by directories in the configured storage
backend.

## Recommended practices

- **Limit resources**: adjust `CODEEXEC_MAX_MEMORY_MB`, `CODEEXEC_MAX_CPU_SECS` and
  `CODEEXEC_MAX_EXECUTION_SECONDS` according to your hardware to
  prevent runaway jobs from consuming all resources.
- **Disable network access**: set `CODEEXEC_DISABLE_NETWORK=true` to
  avoid untrusted code from reaching the internet.  This flag can
  eventually be enforced via kernel namespaces or firewall rules.
- **Use a random API key**: generate a unique secret for
  `LIBRECHAT_CODE_API_KEY` and share it only with your LibreChat
  instance.  Do not check this key into source control.
- **Upgrade base image**: periodically rebuild the container to get
  security patches for system libraries and Python dependencies.

For further details on environment variables supported by LibreChat
refer to the [official documentation]【424738187294248†L1204-L1209】.