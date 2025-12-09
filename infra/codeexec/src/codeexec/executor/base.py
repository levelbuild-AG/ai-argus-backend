"""
Base interfaces and dataclasses for code execution backends.

All concrete executors should inherit from :class:`CodeExecutor` and
implement the :meth:`execute` method.  Executors are responsible for
running arbitrary code snippets in a controlled environment.  The
returned :class:`ExecutionResult` captures the outcome of the
execution.

Resource limitations (such as memory, CPU time and wall clock
timeouts) are enforced by the executor itself.  Containers and
processes outside of Python are assumed to be configured with
additional safeguards (e.g. Docker isolation, seccomp profiles) to
prevent system compromise.
"""

from __future__ import annotations

import abc
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ExecutionResult:
    """Result of running a code snippet.

    Attributes
    ----------
    stdout: str
        Standard output captured from the execution.
    stderr: str
        Standard error captured from the execution.
    exit_code: int
        Exit status of the process.  Zero usually indicates success.
    duration_ms: int
        Wall‑clock execution time in milliseconds.
    """

    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int


class CodeExecutor(abc.ABC):
    """
    Abstract base class defining the interface for code executors.

    Executors run user‑supplied code in a sandboxed directory and
    return the captured output.  Subclasses should override the
    :meth:`execute` method to provide concrete implementations.
    """

    def __init__(
        self,
        timeout: int = 60,
        max_memory_mb: int = 512,
        max_cpu_secs: int = 60,
    ) -> None:
        """
        Parameters
        ----------
        timeout: int, optional
            Maximum wall‑clock time (in seconds) to allow the
            process to run.  If the process does not complete within
            this time, it will be terminated and the result will
            indicate a timeout.
        max_memory_mb: int, optional
            Maximum resident set size (RSS) in megabytes.  Platform
            dependent; on Linux this is enforced via ``ulimit``
            settings.  Executors may choose to ignore this if they
            implement their own resource limits.
        max_cpu_secs: int, optional
            Maximum CPU time in seconds.  When using
            ``resource.setrlimit`` this corresponds to the
            ``RLIMIT_CPU`` parameter.  Not all platforms support
            this limit.
        """
        self.timeout = timeout
        self.max_memory_mb = max_memory_mb
        self.max_cpu_secs = max_cpu_secs

    @abc.abstractmethod
    def execute(
        self,
        session_dir: Path,
        code: str,
        stdin: Optional[str] = None,
    ) -> ExecutionResult:
        """Run the provided code snippet in ``session_dir``.

        Parameters
        ----------
        session_dir: Path
            Directory where files should be read/written during
            execution.  Executors must guarantee that the current
            working directory of the process is set to ``session_dir``.
        code: str
            The user supplied code to run.
        stdin: str, optional
            Data to pass on standard input.  If provided, it will be
            fed to the process.  Otherwise, ``stdin`` will be closed.

        Returns
        -------
        ExecutionResult
            Captures stdout, stderr, exit status and duration.
        """
        raise NotImplementedError

    def _run_subprocess(
        self,
        args: list[str],
        session_dir: Path,
        stdin_data: Optional[str] = None,
    ) -> ExecutionResult:
        """
        Helper to invoke a subprocess with resource limits and capture
        output.

        This helper runs the given command as a subprocess in
        ``session_dir``, enforcing the configured timeouts.  The
        process is terminated if it exceeds the wall clock timeout.

        Parameters
        ----------
        args: list[str]
            Command and arguments to execute.
        session_dir: Path
            Working directory for the subprocess.
        stdin_data: str, optional
            Data to supply on standard input.

        Returns
        -------
        ExecutionResult
            Contains the process outputs and exit status.
        """
        start_time = time.perf_counter()
        # Use text mode for easier handling of stdout/stderr
        process = subprocess.Popen(
            args,
            cwd=str(session_dir),
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        timer = None
        timed_out = False

        def kill_proc() -> None:
            nonlocal timed_out
            try:
                timed_out = True
                process.kill()
            except Exception:
                pass

        # Start timer thread to enforce wall clock timeout
        timer = threading.Timer(self.timeout, kill_proc)
        timer.start()

        try:
            stdout, stderr = process.communicate(input=stdin_data)
        finally:
            duration = int((time.perf_counter() - start_time) * 1000)
            if timer:
                timer.cancel()
        exit_code = process.returncode if process.returncode is not None else -1
        # If killed by timeout, override exit code and append notice to stderr
        if timed_out:
            stderr = (stderr or "") + "\nExecution timed out after " + str(self.timeout) + " seconds."
            exit_code = -9
        return ExecutionResult(stdout or "", stderr or "", exit_code, duration)