"""
Executor for running Bash scripts.

The Bash executor writes the provided script to a temporary file in
the session directory and invokes ``bash`` on that file.  Standard
output and error are captured via the base class helper.  As with
the Python executor, only a limited set of core utilities should be
available inside the container to minimise the attack surface.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .base import CodeExecutor, ExecutionResult


class BashExecutor(CodeExecutor):
    """Execute Bash scripts in an isolated directory."""

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
        session_dir.mkdir(parents=True, exist_ok=True)
        script_path = session_dir / "snippet.sh"
        # Prepend shebang for bash to ensure proper execution
        content = code
        if not code.startswith("#!/"):
            content = "#!/bin/bash\n" + code
        script_path.write_text(content, encoding="utf-8")
        # Ensure the script is executable
        script_path.chmod(0o700)
        cmd = ["bash", str(script_path)]
        return self._run_subprocess(cmd, session_dir, stdin_data=stdin)