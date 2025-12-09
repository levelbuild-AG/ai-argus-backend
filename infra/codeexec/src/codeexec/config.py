"""Configuration loader.

The code execution service reads its configuration from environment variables to
allow the same container image to run in multiple contexts (docker‑compose,
Cloud Run, etc.).  Reasonable defaults are provided so that local
development works out of the box.

Environment variables:

``CODEEXEC_API_KEY``
    The shared secret used to authenticate incoming requests.  Each client
    (such as LibreChat) must include this value in the ``x‑api‑key`` header.

``CODEEXEC_STORAGE_BACKEND``
    Selects the storage backend.  Supported values are ``local`` and ``gcs``.
    Defaults to ``local``.

``CODEEXEC_STORAGE_PATH``
    Base directory for storing session files when using the ``local`` backend.
    Defaults to ``/tmp/codeexec`` inside the container.  A volume should be
    mounted here in production.

``CODEEXEC_GCS_BUCKET``
    Name of the Google Cloud Storage bucket to use when ``CODEEXEC_STORAGE_BACKEND``
    is ``gcs``.  Required if using the GCS backend.

``CODEEXEC_ALLOWED_LANGS``
    Comma‑separated list of languages permitted for execution.  Defaults to
    ``python,bash``.  Additional languages may be added in the future.

``CODEEXEC_MAX_MEMORY_MB``
    Hard memory limit (in megabytes) applied per code execution.  Default is 512.

``CODEEXEC_MAX_CPU_SECS``
    CPU time limit (in seconds) applied per code execution.  Default is 30.

``CODEEXEC_MAX_EXECUTION_SECONDS``
    Wall‑clock timeout (in seconds) for a single code execution.  Default is 30.

``CODEEXEC_DISABLE_NETWORK``
    If ``true``, networking is disabled during execution.  Defaults to ``true``.

``PORT``
    The port on which the API server listens.  Cloud Run sets this; otherwise
    defaults to 8080.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List


def _parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.lower() in {"1", "true", "t", "yes", "y"}


@dataclass
class Config:
    """Centralised configuration object."""

    api_key: str
    storage_backend: str
    storage_path: str
    gcs_bucket: str | None
    allowed_langs: List[str]
    max_memory_mb: int
    max_cpu_secs: int
    max_execution_seconds: int
    disable_network: bool
    port: int

    @classmethod
    def load(cls) -> "Config":
        # API key may be empty in local development but should be set in production.
        api_key = os.getenv("CODEEXEC_API_KEY", "")

        storage_backend = os.getenv("CODEEXEC_STORAGE_BACKEND", "local").lower()
        if storage_backend not in {"local", "gcs"}:
            raise ValueError(
                f"Invalid CODEEXEC_STORAGE_BACKEND: {storage_backend}. Use 'local' or 'gcs'."
            )
        storage_path = os.getenv("CODEEXEC_STORAGE_PATH", "/tmp/codeexec")
        gcs_bucket = os.getenv("CODEEXEC_GCS_BUCKET")
        if storage_backend == "gcs" and not gcs_bucket:
            raise RuntimeError(
                "CODEEXEC_GCS_BUCKET must be set when using the GCS storage backend"
            )

        allowed_langs_env = os.getenv("CODEEXEC_ALLOWED_LANGS", "python,bash")
        allowed_langs = [lang.strip().lower() for lang in allowed_langs_env.split(",") if lang.strip()]

        def _int_var(name: str, default: int) -> int:
            val = os.getenv(name)
            if val is None:
                return default
            try:
                return int(val)
            except ValueError:
                raise ValueError(f"Invalid integer for {name}: {val}")

        max_memory_mb = _int_var("CODEEXEC_MAX_MEMORY_MB", 512)
        max_cpu_secs = _int_var("CODEEXEC_MAX_CPU_SECS", 30)
        max_execution_seconds = _int_var("CODEEXEC_MAX_EXECUTION_SECONDS", 30)
        disable_network = _parse_bool(os.getenv("CODEEXEC_DISABLE_NETWORK"), True)
        port = _int_var("PORT", 8080)

        return cls(
            api_key=api_key,
            storage_backend=storage_backend,
            storage_path=storage_path,
            gcs_bucket=gcs_bucket,
            allowed_langs=allowed_langs,
            max_memory_mb=max_memory_mb,
            max_cpu_secs=max_cpu_secs,
            max_execution_seconds=max_execution_seconds,
            disable_network=disable_network,
            port=port,
        )

    @classmethod
    def from_env(cls) -> "Config":
        """
        Alternate constructor used by the API to load configuration.

        This wrapper calls :meth:`load` to construct the configuration.
        It exists to provide a more intuitive name when consumed in
        application code.
        """
        return cls.load()
