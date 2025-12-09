FROM python:3.11-slim

# Install system dependencies.  Poppler provides the `pdftotext` binary used
# by pdfplumber; libfreetype and libpng enable matplotlib.  Build
# essentials are required for some Python packages with C extensions.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        libfreetype6 \
        libpng16-16 \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Create non‑root user for running the application
RUN useradd -m codeuser

WORKDIR /app

# Copy and install Python dependencies
COPY src/codeexec/requirements.txt requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY src/codeexec /app/codeexec
RUN chown -R codeuser:codeuser /app

# Switch to the non‑root user
USER codeuser

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

CMD ["uvicorn", "codeexec.api.main:app", "--host", "0.0.0.0", "--port", "8080"]