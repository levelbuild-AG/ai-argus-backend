"""
Execution backends for the code execution API.

This package exposes concrete executors for supported languages.  When a
session is created, the API will select the appropriate executor based on
the requested language.  Each executor is responsible for writing user
code to a temporary file, invoking the interpreter/shell, enforcing
resource limits and returning the captured output.  Additional
executors can be added in the future by implementing the
``CodeExecutor`` interface from ``base.py``.
"""

from .base import ExecutionResult, CodeExecutor
from .python_executor import PythonExecutor
from .bash_executor import BashExecutor

__all__ = [
    "ExecutionResult",
    "CodeExecutor",
    "PythonExecutor",
    "BashExecutor",
]