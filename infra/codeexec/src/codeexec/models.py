"""Pydantic models for request and response bodies.

These models express the structure expected by the HTTP API.  They mirror
the semantics of the LibreChat Code Interpreter API as closely as possible
without having access to the official OpenAPI specification.  Fields can be
extended or adjusted once the official spec is obtained.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class SessionCreateRequest(BaseModel):
    """Request body for creating a new session."""

    language: Optional[str] = Field(
        default="python",
        description="Primary language for the session. Currently supported: 'python', 'bash'.",
    )


class SessionInfo(BaseModel):
    """Metadata about a session."""

    session_id: str
    language: str
    created_at: datetime
    files: List[str] = Field(default_factory=list)


class ExecuteRequest(BaseModel):
    """Request body for executing code within a session."""

    language: Optional[str] = Field(
        default=None,
        description="Language override for this execution. Uses session default if omitted.",
    )
    code: str = Field(..., description="Source code to execute.")
    stdin: Optional[str] = Field(
        default=None, description="Standard input to pass to the program."
    )


class ExecuteResponse(BaseModel):
    """Response body for code execution."""

    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    files: List[str] = Field(default_factory=list)


class FileUploadResponse(BaseModel):
    """Response after uploading files."""

    paths: List[str] = Field(
        ..., description="List of file paths stored in the session."
    )
