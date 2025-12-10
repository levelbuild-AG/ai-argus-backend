FROM python:3.11-slim

# Install system dependencies for scientific/python tooling
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        libfreetype6-dev \
        libpng-dev \
        libjpeg62-turbo-dev \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for running the service
RUN useradd -m -u 1000 -s /bin/bash codeuser

WORKDIR /app

# Copy dependencies and install
COPY src/codeexec/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy application code and entrypoint
COPY src/codeexec /app/codeexec
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1
ENV CODEEXEC_STORAGE_PATH=/tmp/codeexec

EXPOSE 8080

# Run entrypoint as root to prep storage, then it will drop privileges
USER root
ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["uvicorn", "codeexec.api.main:app", "--host", "0.0.0.0", "--port", "8080"]