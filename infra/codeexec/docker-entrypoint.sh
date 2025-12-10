#!/usr/bin/env sh
set -e

: "${CODEEXEC_STORAGE_PATH:=/tmp/codeexec}"

echo "[entrypoint] Starting as UID=$(id -u) GID=$(id -g)"
echo "[entrypoint] CODEEXEC_STORAGE_PATH=${CODEEXEC_STORAGE_PATH}"

if [ "$(id -u)" -eq 0 ]; then
  echo "[entrypoint] Running as root, attempting to ensure storage directory exists..."
  mkdir -p "${CODEEXEC_STORAGE_PATH}" 2>&1 || \
    echo "[entrypoint] WARN: mkdir may have failed (possibly read-only), continuing anyway"
else
  echo "[entrypoint] Not running as root; skipping mkdir"
fi

echo "[entrypoint] Starting application..."
exec "$@"
