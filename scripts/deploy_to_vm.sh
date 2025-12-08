#!/usr/bin/env bash
set -euo pipefail

# Root of your project (one level above infra/)
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Remote VM configuration
# # Dev VM dev-argus-chat
# VM_HOST="${VM_HOST:-34.7.17.103}"
# VM_USER="${VM_USER:-florian}"
# SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# DEPLOY_PATH="${DEPLOY_PATH:-/home/florian/librechat}"

# Prod VM levelbuild-argus-chat
VM_HOST="${VM_HOST:-34.32.215.131}"
VM_USER="${VM_USER:-florian}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/florian/librechat}"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
)

# echo "[deploy] Building Docker images locally (optional sanity check)..." # commented out to speed up deploy
# (
#   cd "$ROOT_DIR"
#   docker compose build
# )

echo "[deploy] Ensuring remote base directory exists ($VM_USER@$VM_HOST:$DEPLOY_PATH)..."
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "
  set -e
  sudo mkdir -p '$DEPLOY_PATH'
  sudo chown '$VM_USER':'$VM_USER' '$DEPLOY_PATH'
"

# Things we don't want to ship (they'll be rebuilt / re-created locally on the VM)
# ALSO: these are intentionally not overwritten on the VM, so they act as persistent data dirs.
EXCLUDES=(
  '.git'
  'node_modules'
  'packages/*/node_modules'
  'client/node_modules'
  'api/node_modules'
  'logs'
  'uploads'
  'data-node'
  'meili_data_v1.12'
)

echo "[deploy] Using portable tar-based sync (no rsync)..."

# IMPORTANT CHANGE:
# We NO LONGER nuke $DEPLOY_PATH. We just overlay code on top, leaving data dirs intact.
# echo "[deploy] Nuking remote deploy dir with sudo (DISABLED - we keep data now)..."
# ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "
#   set -e;
#   sudo rm -rf '$DEPLOY_PATH';
#   sudo mkdir -p '$DEPLOY_PATH';
#   sudo chown '$VM_USER':'$VM_USER' '$DEPLOY_PATH';
# "

# Build tar exclude args
TAR_ARGS=()
for pattern in "${EXCLUDES[@]}"; do
  TAR_ARGS+=(--exclude="$pattern")
done

echo "[deploy] Streaming project to remote via tar (code only, no data)..."
(
  cd "$ROOT_DIR"
  tar -czf - "${TAR_ARGS[@]}" .
) | ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "
  set -e
  cd '$DEPLOY_PATH'
  # Extract over existing tree; excluded dirs (uploads, meili_data_v1.12, etc.) are untouched
  tar -xzf -
"

echo "[deploy] Starting containers on remote host..."
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "DEPLOY_PATH='$DEPLOY_PATH' bash -s" <<'EOF'
set -euo pipefail

cd "$DEPLOY_PATH"

# Make sure shared network exists for LibreChat <-> Firecrawl
docker network inspect argus-net >/dev/null 2>&1 || docker network create argus-net

echo "[remote] Starting Firecrawl stack..."
docker compose -f infra/firecrawl/docker-compose.firecrawl.yml up -d --build

echo "[remote] Starting LibreChat stack..."
docker compose down || true
docker compose up -d --build

echo "[remote] Containers started."
EOF

echo "[deploy] Complete."