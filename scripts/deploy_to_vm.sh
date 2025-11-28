#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

VM_HOST="${VM_HOST:-34.13.167.238}"
VM_USER="${VM_USER:-florian}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
DEPLOY_PATH="${DEPLOY_PATH:-/home/florian/librechat}"

SSH_OPTS=("-i" "$SSH_KEY" "-o" "StrictHostKeyChecking=no" "-o" "UserKnownHostsFile=$HOME/.ssh/known_hosts")

echo "[deploy] Building Docker images locally..."
(cd "$ROOT_DIR" && docker compose build)

echo "[deploy] Ensuring remote directory exists ($VM_USER@$VM_HOST:$DEPLOY_PATH)..."
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "mkdir -p '$DEPLOY_PATH'"

EXCLUDES=(
  '.git'
  'node_modules'
  'packages/*/node_modules'
  'client/node_modules'
  'api/node_modules'
  'logs'
  'uploads'
  'images'
  'data-node'
  'meili_data_v1.12'
)

if command -v rsync >/dev/null 2>&1; then
	echo "[deploy] Syncing project files with rsync..."
	RSYNC_ARGS=(-avz --delete)
	for pattern in "${EXCLUDES[@]}"; do
		RSYNC_ARGS+=(--exclude "$pattern")
	done

	rsync "${RSYNC_ARGS[@]}" \
		-e "ssh ${SSH_OPTS[*]}" \
		"$ROOT_DIR/" "$VM_USER@$VM_HOST:$DEPLOY_PATH/"
else
	echo "[deploy] rsync not found; falling back to tar stream copy (remote dir will be cleared)."
	if [[ -z "$DEPLOY_PATH" || "$DEPLOY_PATH" == "/" ]]; then
		echo "[deploy] Refusing to clear unsafe deploy path: '$DEPLOY_PATH'" >&2
		exit 1
	fi

    echo "[deploy] Clearing remote directory before tar copy (excluding data dirs)..."
    ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "find '$DEPLOY_PATH' -mindepth 1 \
    ! -name 'data-node' \
    ! -name 'meili_data_v1.12' \
    ! -name 'logs' \
    ! -name 'uploads' \
    ! -name 'images' \
    -exec rm -rf {} + || true"

	TAR_ARGS=()
	for pattern in "${EXCLUDES[@]}"; do
		TAR_ARGS+=(--exclude="./$pattern")
	done

	(cd "$ROOT_DIR" && tar -cf - "${TAR_ARGS[@]}" .) | \
		ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "cd '$DEPLOY_PATH' && tar -xf -"
fi

echo "[deploy] Starting containers on remote host..."
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" \
	"cd '$DEPLOY_PATH' && docker compose up -d"

echo "[deploy] Complete."
