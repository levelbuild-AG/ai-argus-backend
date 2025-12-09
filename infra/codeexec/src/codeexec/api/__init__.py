"""
Expose the FastAPI application instance.

Importing this module will create a FastAPI application and register
all routes.  This makes it easy to run the service with Uvicorn or
Gunicorn using the typical ``-m`` invocation:

```sh
python -m codeexec.api
```
"""

from .main import app

__all__ = ["app"]