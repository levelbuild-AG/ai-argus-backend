# LibreChat Code Interpreter API

LibreChat offers a Code Interpreter feature that enables agents to
execute code snippets, manage files and generate artifacts within a
chat.  The official API is part of LibreChat’s paid enterprise plan
and provides a secure sandbox for running languages such as Python,
JavaScript, Go, C/C++ and more.  The API is authenticated via an API
key and integrates with LibreChat through environment variables and
configuration files.

## Key concepts

- **Sessions**: a session encapsulates a working directory and runtime
  context.  Clients create a session before executing code so that
  state can persist across multiple runs.  The official API limits
  the number of files per session and imposes memory/upload size
  restrictions depending on subscription tier【775106307751082†L276-L356】.

- **Execution**: within a session, clients can submit code to be
  executed.  The API returns captured standard output, standard
  error, exit status and a list of files produced.  It also exposes
  system information and execution statistics.  In the official
  service, many languages are supported; this implementation focuses
  on Python and Bash.

- **File operations**: clients may upload input files to a session,
  download generated files and list existing files.  The API
  enforces a limit of 10 files per session and manages file size
  restrictions per plan【775106307751082†L276-L356】.

- **Authentication**: requests must include an `x-api-key` header.
  LibreChat will send the value of `LIBRECHAT_CODE_API_KEY` when
  communicating with the service.  Enterprise users can override the
  default base URL via `LIBRECHAT_CODE_BASEURL`【424738187294248†L1204-L1209】.

## Limitations of this implementation

The official Code Interpreter API’s full OpenAPI specification is not
publicly accessible.  Therefore this project implements a subset of
the documented behaviours, focusing on the needs of a self‑hosted
environment:

- **Supported languages**: only Python and Bash are available.  Other
  languages (Node.js, Java, C/C++, etc.) may be added in the future.
- **No built‑in package management**: users cannot install arbitrary
  Python packages at runtime.  Instead a curated list of common data
  analysis libraries is pre‑installed in the Docker image.
- **Stateful sessions**: sessions are stored locally or in GCS.
  Execution state (variables, imported modules) does not persist
  beyond the process boundary; each run starts fresh in the same
  working directory.
- **Limited concurrency**: by default the service runs a single Uvicorn
  worker.  When deploying to Cloud Run or scaling with Docker
  Compose you can increase concurrency via additional instances.

Although incomplete, this subset is designed to be **compatible**
with LibreChat’s expectations so that agents using the Code
Interpreter can function transparently when pointed at this service.

## Future improvements

Once the official specification becomes available, this project can
be expanded to match it more closely.  Potential enhancements include:

- Additional endpoints for listing all sessions, retrieving system
  information and streaming incremental outputs.
- Support for more programming languages.
- Alignment of request/response schemas with the official JSON
  definitions.
- Error reporting and logging improvements.

Contributions and issue reports are welcome; please open a pull
request or an issue in your internal repository to propose changes.