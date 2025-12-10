"""
FastAPI application for the code execution service.

This module configures the FastAPI application, registers routes for
session management, code execution and file handling, and enforces
authentication via an API key.  The service is designed to be
compatible with LibreChat's Code Interpreter API and can be deployed
both as a Docker service and on Google Cloud Run.
"""

from __future__ import annotations

import json
import logging
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from ..config import Config
from ..executor import BashExecutor, PythonExecutor
from ..models import ExecuteRequest, ExecuteResponse, FileUploadResponse, SessionCreateRequest, SessionInfo
from ..storage import GCSStorageBackend, LocalStorageBackend, StorageBackend


logger = logging.getLogger("codeexec")

if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("[codeexec] %(levelname)s - %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)

logger.setLevel(logging.INFO)


config = Config.from_env()

logger.info(
    "Loaded config: storage_backend=%s, storage_path=%s, allowed_langs=%s, max_exec=%s",
    config.storage_backend,
    config.storage_path,
    config.allowed_langs,
    config.max_execution_seconds,
)

# Determine storage backend based on config
TEMP_DIR_BASE = Path(config.storage_path)
TEMP_DIR_BASE.mkdir(parents=True, exist_ok=True)
try:
    TEMP_DIR_BASE.chmod(0o777)
except PermissionError:
    logger.warning("Unable to chmod temp dir %s; continuing", TEMP_DIR_BASE)

if config.storage_backend == "gcs":
    if config.gcs_bucket is None:
        raise RuntimeError("CODEEXEC_GCS_BUCKET must be set when using GCS storage backend")
    storage: StorageBackend = GCSStorageBackend(config.gcs_bucket)
else:
    storage = LocalStorageBackend(Path(config.storage_path))

# Prepare executors for supported languages
EXECUTORS = {
    "python": PythonExecutor(timeout=config.max_execution_seconds, max_memory_mb=config.max_memory_mb, max_cpu_secs=config.max_cpu_secs),
    "bash": BashExecutor(timeout=config.max_execution_seconds, max_memory_mb=config.max_memory_mb, max_cpu_secs=config.max_cpu_secs),
}


app = FastAPI(title="Code Execution Service", version="0.1.0")



@app.middleware("http")
async def authenticate(request, call_next):
    """Middleware to enforce API key authentication on all requests."""
    path = request.url.path
    method = request.method
    client = getattr(request.client, "host", "unknown")

    logger.info("Incoming request: %s %s from %s", method, path, client)

    provided_key = request.headers.get("x-api-key")
    if config.api_key:
        if provided_key != config.api_key:
            logger.warning(
                "Invalid API key for %s %s from %s (provided=%r)",
                method,
                path,
                client,
                provided_key,
            )
            return JSONResponse(status_code=401, content={"detail": "Invalid API key"})
    else:
        logger.info("No API key configured; skipping auth check")

    response = await call_next(request)
    logger.info("Response: %s %s -> %s", method, path, response.status_code)
    return response


@app.get("/health")
async def health() -> Dict[str, str]:
    """Return a simple health check response."""
    return {"status": "ok"}


@app.post("/exec", response_model=ExecuteResponse)
async def exec_root(req: ExecuteRequest) -> ExecuteResponse:
    """Compatibility endpoint for LibreChat's Code Interpreter client."""
    logger.info("[/exec] Received request: %s", req.model_dump())

    language = (req.language or "python").lower()
    if language not in EXECUTORS:
        logger.warning("[/exec] Unsupported language: %s", language)
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")

    executor = EXECUTORS[language]

    try:
        with tempfile.TemporaryDirectory(dir=str(TEMP_DIR_BASE)) as tmpdir:
            session_dir = Path(tmpdir)
            logger.info("[/exec] Running %s code in temp dir %s", language, session_dir)

            result = executor.execute(session_dir, req.code, req.stdin)

            files: List[str] = []
            for p in session_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    files.append(p.name)

            logger.info(
                "[/exec] Execution finished: exit_code=%s, duration_ms=%s, files=%s",
                result.exit_code,
                result.duration_ms,
                files,
            )

            return ExecuteResponse(
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
                files=files,
            )
    except Exception as exc:
        logger.exception("[/exec] Unhandled error during execution: %s", exc)
        raise HTTPException(status_code=500, detail="Execution error")


@app.post("/v1/sessions", response_model=SessionInfo)
async def create_session(req: SessionCreateRequest) -> SessionInfo:
    """Create a new execution session.

    The session directory is created in the storage backend.  A
    metadata file is stored to persist the language and creation
    timestamp.
    """
    language = req.language
    if language not in config.allowed_langs:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
    session_id = str(uuid.uuid4())
    # Write metadata
    metadata = {
        "session_id": session_id,
        "language": language,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    # Ensure directory exists and write meta file
    meta_path = Path(f"{session_id}/.meta.json")
    storage.save(session_id, ".meta.json", json.dumps(metadata).encode("utf-8"))
    return SessionInfo(
        session_id=session_id,
        language=language,
        created_at=metadata["created_at"],
        files=[],
    )


@app.get("/v1/sessions/{session_id}", response_model=SessionInfo)
async def get_session(session_id: str) -> SessionInfo:
    """Retrieve information about a session and list of files."""
    try:
        meta_bytes = storage.open(session_id, ".meta.json")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    metadata = json.loads(meta_bytes.decode("utf-8"))
    # List files excluding meta
    all_files = storage.list(session_id)
    user_files = [f for f in all_files if not f.startswith(".")]
    return SessionInfo(
        session_id=metadata["session_id"],
        language=metadata["language"],
        created_at=metadata["created_at"],
        files=user_files,
    )


@app.delete("/v1/sessions/{session_id}")
async def delete_session(session_id: str) -> Dict[str, str]:
    """Delete a session and all associated files."""
    try:
        storage.delete_session(session_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"detail": "Session deleted"}


@app.post("/v1/sessions/{session_id}/execute", response_model=ExecuteResponse)
async def execute_code(session_id: str, req: ExecuteRequest) -> ExecuteResponse:
    """Execute code in an existing session.

    If ``language`` is provided in the request body it will override
    the session's default language.  Otherwise the language stored in
    the session metadata is used.
    """
    # Determine language
    language: Optional[str] = None
    if req.language:
        language = req.language
    else:
        try:
            meta_bytes = storage.open(session_id, ".meta.json")
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Session not found")
        meta = json.loads(meta_bytes.decode("utf-8"))
        language = meta["language"]
    if language not in EXECUTORS:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {language}")
    executor = EXECUTORS[language]
    # Map session directory to storage location
    # For local storage backend, we can get path; for GCS we need to sync to local tmp
    # The storage backend returns relative paths, so we assemble a Path pointing to the base directory
    # For local backend we can access actual path; for GCS we need to download and upload around run
    if isinstance(storage, LocalStorageBackend):
        session_dir = Path(storage.base_dir) / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        # Write any input files referenced by req.files? Not implemented yet
        result = executor.execute(session_dir, req.code, req.stdin)
        # Collect list of files after execution
        all_files = [p.name for p in session_dir.iterdir() if p.is_file() and not p.name.startswith(".")]
    else:
        # For GCS storage backend we need to create a temporary local directory and sync
        with tempfile.TemporaryDirectory(dir=str(TEMP_DIR_BASE)) as tmpdir:
            temp_session_dir = Path(tmpdir)
            # Download existing files into temp dir
            for filename in storage.list(session_id):
                if filename.startswith("."):  # skip meta
                    continue
                data = storage.open(session_id, filename)
                (temp_session_dir / filename).parent.mkdir(parents=True, exist_ok=True)
                (temp_session_dir / filename).write_bytes(data)
            # Execute code
            result = executor.execute(temp_session_dir, req.code, req.stdin)
            # Upload new/modified files back
            # We simply walk all files and upload; storing meta again will overwrite
            for p in temp_session_dir.iterdir():
                if p.is_file() and not p.name.startswith("."):
                    storage.save(session_id, p.name, p.read_bytes())
            # List user files
            all_files = [f for f in storage.list(session_id) if not f.startswith(".")]
    return ExecuteResponse(
        stdout=result.stdout,
        stderr=result.stderr,
        exit_code=result.exit_code,
        duration_ms=result.duration_ms,
        files=all_files,
    )


@app.post("/v1/sessions/{session_id}/files", response_model=FileUploadResponse)
async def upload_files(session_id: str, files: List[UploadFile] = File(...)) -> FileUploadResponse:
    """Upload one or more files to a session."""
    # Ensure session exists
    try:
        storage.open(session_id, ".meta.json")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    saved_paths: List[str] = []
    for file in files:
        # Save file as provided filename; ensure directories exist
        content = await file.read()
        storage.save(session_id, file.filename, content)
        saved_paths.append(file.filename)
    return FileUploadResponse(paths=saved_paths)


@app.get("/v1/sessions/{session_id}/files/{file_path:path}")
async def download_file(session_id: str, file_path: str):
    """Download a file associated with a session."""
    # Access file
    try:
        data = storage.open(session_id, file_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    filename = Path(file_path).name
    # For local backend we can return streaming from disk
    if isinstance(storage, LocalStorageBackend):
        path_on_disk = Path(storage.base_dir) / session_id / file_path
        return FileResponse(path_on_disk, filename=filename)
    # For GCS or other backends we stream from memory
    # For in‑memory bytes we return a Response with appropriate headers
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )