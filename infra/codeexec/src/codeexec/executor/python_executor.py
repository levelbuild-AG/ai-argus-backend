"""
Executor for running Python code snippets.

The Python executor writes the provided code to a temporary file in
the session directory and invokes the system Python interpreter on
that file.  Standard output and error are captured and returned in an
``ExecutionResult``.  Resource limits (timeout, memory, CPU) are
enforced by the base class helper.

This executor assumes that the container image includes the
``python`` binary and any required third‑party libraries (pandas,
matplotlib, etc.) that users may call.  Users should not be allowed
to install arbitrary packages at runtime.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from .base import CodeExecutor, ExecutionResult


class PythonExecutor(CodeExecutor):
    """Execute Python code in an isolated directory using the system interpreter."""

    def __init__(
        self,
        timeout: int = 60,
        max_memory_mb: int = 512,
        max_cpu_secs: int = 60,
    ) -> None:
        super().__init__(timeout, max_memory_mb, max_cpu_secs)

    def execute(
        self,
        session_dir: Path,
        code: str,
        stdin: Optional[str] = None,
    ) -> ExecutionResult:
        # Ensure the session directory exists
        session_dir.mkdir(parents=True, exist_ok=True)
        # Write the code to a temporary file
        script_path = session_dir / "snippet.py"
        script_path.write_text(code, encoding="utf-8")
        # Build command; rely on system python interpreter on PATH
        cmd = ["python", str(script_path)]
        return self._run_subprocess(cmd, session_dir, stdin_data=stdin)