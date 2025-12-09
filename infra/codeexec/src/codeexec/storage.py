"""Storage backend abstractions for session files.

Sessions can produce and consume files.  To decouple the API from the
underlying storage mechanism, an abstract backend is defined with a common
interface.  Two concrete backends are provided:

* ``LocalStorageBackend`` – stores files on the local filesystem under a
  configurable base directory.  Suitable for docker‑compose deployments where
  each tenant has its own VM and volume.

* ``GCSStorageBackend`` – stores files in Google Cloud Storage.  Suitable
  when deploying to Cloud Run and requiring durable cross‑instance storage.

Backends are not thread‑safe and should be instantiated per worker process.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import List

try:
    from google.cloud import storage  # type: ignore
except ImportError:
    storage = None  # type: ignore


class StorageBackend:
    """Protocol for storage backends."""

    def save(self, session_id: str, relative_path: str, content: bytes) -> str:
        raise NotImplementedError

    def open(self, session_id: str, relative_path: str) -> bytes:
        raise NotImplementedError

    def delete(self, session_id: str, relative_path: str) -> None:
        raise NotImplementedError

    def list(self, session_id: str) -> List[str]:
        raise NotImplementedError

    def delete_session(self, session_id: str) -> None:
        raise NotImplementedError


class LocalStorageBackend(StorageBackend):
    """Store session files on a local filesystem."""

    def __init__(self, base_dir: str) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _session_dir(self, session_id: str) -> Path:
        return self.base_dir / session_id

    def save(self, session_id: str, relative_path: str, content: bytes) -> str:
        session_dir = self._session_dir(session_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        dest = session_dir / relative_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
        # Return a path relative to the session root for API clients
        return f"{session_id}/{relative_path}"

    def open(self, session_id: str, relative_path: str) -> bytes:
        dest = self._session_dir(session_id) / relative_path
        return dest.read_bytes()

    def delete(self, session_id: str, relative_path: str) -> None:
        path = self._session_dir(session_id) / relative_path
        if path.exists():
            path.unlink()

    def list(self, session_id: str) -> List[str]:
        session_dir = self._session_dir(session_id)
        if not session_dir.exists():
            return []
        files = []
        for file in session_dir.rglob("*"):
            if file.is_file():
                files.append(f"{session_id}/{file.relative_to(session_dir)}")
        return files

    def delete_session(self, session_id: str) -> None:
        session_dir = self._session_dir(session_id)
        if session_dir.exists():
            for path in session_dir.rglob("*"):
                if path.is_file():
                    path.unlink()
            for path in sorted(session_dir.rglob("*"), reverse=True):
                if path.is_dir():
                    try:
                        path.rmdir()
                    except OSError:
                        pass
            try:
                session_dir.rmdir()
            except OSError:
                pass


class GCSStorageBackend(StorageBackend):
    """Store session files in Google Cloud Storage.

    Files are stored under the prefix ``session_id/``.  This backend requires
    ``google-cloud-storage`` to be installed and appropriate service
    credentials to be available (Cloud Run automatically provides credentials
    via its service account).
    """

    def __init__(self, bucket_name: str) -> None:
        if storage is None:
            raise RuntimeError(
                "google-cloud-storage is not installed; cannot use GCSStorageBackend"
            )
        client = storage.Client()
        self.bucket = client.bucket(bucket_name)

    def save(self, session_id: str, relative_path: str, content: bytes) -> str:
        blob_name = f"{session_id}/{relative_path}"
        blob = self.bucket.blob(blob_name)
        blob.upload_from_string(content)
        return blob_name

    def open(self, session_id: str, relative_path: str) -> bytes:
        blob_name = f"{session_id}/{relative_path}"
        blob = self.bucket.blob(blob_name)
        return blob.download_as_bytes()

    def delete(self, session_id: str, relative_path: str) -> None:
        blob_name = f"{session_id}/{relative_path}"
        blob = self.bucket.blob(blob_name)
        blob.delete()

    def list(self, session_id: str) -> List[str]:
        prefix = f"{session_id}/"
        blobs = self.bucket.list_blobs(prefix=prefix)
        return [blob.name for blob in blobs if not blob.name.endswith("/")]

    def delete_session(self, session_id: str) -> None:
        prefix = f"{session_id}/"
        blobs = list(self.bucket.list_blobs(prefix=prefix))
        for blob in blobs:
            blob.delete()
