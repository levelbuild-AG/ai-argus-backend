# Security Model

This document outlines the measures taken to harden the code
execution service and mitigate the risks inherent in executing
untrusted code.  The goal is to provide *defence in depth*: even if
one layer is bypassed, subsequent layers continue to protect the
host and neighbouring services.

## Container isolation

* **Non‑root user**: the container image defines and runs as a
  dedicated `codeuser` account instead of the root user.  This
  prevents the process from making privileged system calls that
  require superuser privileges.

* **Dropped capabilities**: when running under Docker (via the
  provided `docker-compose.snippet.yml`), the container drops all
  capabilities (`cap_drop: [ALL]`).  This removes access to privileged
  kernel operations such as mounting filesystems or changing
  network interfaces.

* **Read‑only root filesystem**: the container is configured with
  `read_only: true`, ensuring that the base image cannot be modified
  at runtime.  A writable volume (`/tmp/codeexec`) is used for
  session storage.

* **No new privileges**: the Docker config sets
  `no-new-privileges:true` which prevents the process from acquiring
  additional capabilities (e.g. via setuid binaries) even if such
  executables exist.

* **Resource limits**: CPU and memory limits are enforced via Docker
  (`deploy.resources.limits`) and inside the executors themselves via
  timeouts.  This reduces the risk of denial‑of‑service attacks from
  expensive code.

## In‑process safeguards

* **Wall‑clock timeout**: each code execution run is terminated
  automatically if it exceeds a configurable wall‑clock timeout
  (`CODEEXEC_MAX_EXECUTION_SECONDS`).  The base executor uses a
  separate timer thread to kill the process when the limit is hit.

* **Language filtering**: only supported languages (`python` and
  `bash`) can be executed.  Attempts to execute other languages
  receive a 400 error.

* **Session isolation**: each session has its own directory in the
  storage backend.  Processes run with their current working
  directory set to the session directory.  This prevents one session
  from reading or writing files belonging to another.

* **No package installation**: the service runs against a fixed
  environment with commonly used data science libraries pre‑installed.
  Users cannot install new packages at runtime.  This limits the
  attack surface and ensures deterministic behaviour.

## Network access

By default the service does not provide any network primitives to
executed code.  If the container image includes networking utilities
(e.g. `curl`, `wget`), these could be used by user code to make
outgoing requests.  To address this:

* Set `CODEEXEC_DISABLE_NETWORK=true`.  This flag does not enforce
  network isolation by itself but signals your intention.  In a
  production deployment you should also restrict egress at the
  container runtime level (e.g. using Docker’s `--network` option or
  Kubernetes’ network policies) to prevent outbound connections.

* Use a minimal base image that omits network tools.  The provided
  `Dockerfile` does not install `curl` or `wget` and relies on the
  Python standard library for most operations.

* For Cloud Run deployments, do not configure a Serverless VPC
  connector unless you need to reach private resources.  Without a
  connector, outbound internet traffic is still allowed; use egress
  firewall rules to block it if necessary.

## Storage considerations

Sessions are stored either on the container’s filesystem (local
backend) or in Google Cloud Storage (GCS backend).  For security:

* **Per‑session prefix**: files are scoped under a prefix derived
  from the session ID, preventing name collisions across sessions.
* **Metadata file**: session metadata (e.g. language, creation
  timestamp) is stored in `.meta.json` inside the session directory.
  The service does not expose this file to clients and it is not
  included in file listings.
* **Cleanup**: the API provides a `DELETE /v1/sessions/{id}` endpoint
  to remove session directories and their contents.  Consider
  implementing automated cleanup of stale sessions to free storage
  resources.

## Future hardening

This initial implementation lays the groundwork for a secure code
execution API.  Further enhancements could include:

* **Seccomp/AppArmor profiles**: apply kernel filters to disallow
  dangerous syscalls (e.g. `ptrace`, `mount`) even if the process is
  compromised.
* **Sandbox technologies**: use third‑party sandboxing tools
  (e.g. [`NSJail`](https://github.com/google/nsjail), `firejail`, or
  gVisor) to run user code in a more restrictive environment.
* **Input sanitisation**: implement heuristics to detect and reject
  code containing known malicious patterns (e.g. attempts to access
  `/proc`, import `os`, etc.).  This can reduce accidental harm but
  should not be solely relied upon.
* **Audit logging**: record execution requests and responses for
  forensic analysis.  Logs should include timestamps, session IDs and
  client IP addresses.

By combining container isolation, resource limits, careful
configuration and ongoing monitoring you can run user‑provided code
safely within your LibreChat deployment.