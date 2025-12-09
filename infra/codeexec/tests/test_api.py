"""
Basic API tests for the code execution service.

These tests exercise the core HTTP endpoints using FastAPI's
TestClient.  They verify that sessions can be created, code can be
executed in Python and Bash, files can be uploaded and downloaded,
and that the health check is operational.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List

import pytest
from fastapi.testclient import TestClient

from codeexec.api.main import app, storage, config


# Use the same API key as in the config for tests
API_KEY_HEADER = {"x-api-key": config.api_key or ""}


@pytest.fixture(autouse=True)
def isolate_storage(tmp_path, monkeypatch):
    """Provide a temporary directory for local storage during tests."""
    # If using local storage backend, point it to a tmpdir
    if hasattr(storage, "base_dir"):
        monkeypatch.setattr(storage, "base_dir", Path(tmp_path))
    yield


def test_health():
    client = TestClient(app)
    response = client.get("/health", headers=API_KEY_HEADER)
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_session_lifecycle():
    client = TestClient(app)
    # Create session
    res = client.post("/v1/sessions", json={"language": "python"}, headers=API_KEY_HEADER)
    assert res.status_code == 200
    data = res.json()
    session_id = data["session_id"]
    assert data["language"] == "python"
    # Get session
    res = client.get(f"/v1/sessions/{session_id}", headers=API_KEY_HEADER)
    assert res.status_code == 200
    data = res.json()
    assert data["session_id"] == session_id
    # Delete session
    res = client.delete(f"/v1/sessions/{session_id}", headers=API_KEY_HEADER)
    assert res.status_code == 200
    assert res.json()["detail"] == "Session deleted"
    # Ensure session gone
    res = client.get(f"/v1/sessions/{session_id}", headers=API_KEY_HEADER)
    assert res.status_code == 404


def test_execute_python_simple():
    client = TestClient(app)
    # Create Python session
    res = client.post("/v1/sessions", json={"language": "python"}, headers=API_KEY_HEADER)
    session_id = res.json()["session_id"]
    # Execute code
    payload = {"code": "print(1 + 1)"}
    res = client.post(f"/v1/sessions/{session_id}/execute", json=payload, headers=API_KEY_HEADER)
    assert res.status_code == 200
    data = res.json()
    assert data["stdout"].strip() == "2"
    assert data["exit_code"] == 0


def test_execute_python_file_creation():
    client = TestClient(app)
    res = client.post("/v1/sessions", json={"language": "python"}, headers=API_KEY_HEADER)
    session_id = res.json()["session_id"]
    # Execute code that writes a file
    code = """
with open('output.txt', 'w') as f:
    f.write('hello world')
print('done')
"""
    res = client.post(
        f"/v1/sessions/{session_id}/execute",
        json={"code": code},
        headers=API_KEY_HEADER,
    )
    assert res.status_code == 200
    data = res.json()
    # 'output.txt' should be listed
    assert 'output.txt' in data["files"]
    # Download the file
    res = client.get(
        f"/v1/sessions/{session_id}/files/output.txt",
        headers=API_KEY_HEADER,
    )
    assert res.status_code == 200
    assert res.content == b"hello world"


def test_execute_bash_simple():
    client = TestClient(app)
    res = client.post("/v1/sessions", json={"language": "bash"}, headers=API_KEY_HEADER)
    session_id = res.json()["session_id"]
    code = "echo 'test bash'"
    res = client.post(
        f"/v1/sessions/{session_id}/execute", json={"code": code}, headers=API_KEY_HEADER
    )
    assert res.status_code == 200
    data = res.json()
    assert "test bash" in data["stdout"]