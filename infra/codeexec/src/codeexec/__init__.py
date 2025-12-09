"""Code execution service package.

This package exposes a secure code execution API compatible with LibreChat's
Code Interpreter API.  It implements a subset of the API focused on Python
and Bash and is designed to run as a microservice either via docker‑compose
alongside LibreChat or deployed separately to Google Cloud Run.

The top‑level modules include:

* ``config`` – configuration handling for environment variables.
* ``models`` – Pydantic models defining request and response schemas.
* ``storage`` – pluggable backends for storing uploaded and generated files.
* ``executor`` – language‑specific execution engines for Python and Bash.
* ``api`` – FastAPI application exposing HTTP endpoints.
"""

from . import api  # noqa: F401