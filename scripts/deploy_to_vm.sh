#!/usr/bin/env bash
# Deploy LibreChat (and optional Firecrawl) to a VM via tar sync + docker compose.
# Update scope (what gets built): UPDATE_SCOPE=api,rag_api (default). Tar always includes full repo.
# Runtime: full stack by default. Use MINIMAL=1 to start only UPDATE_SCOPE services.
# Example: FULL_BOOTSTRAP=1 bash scripts/deploy_to_vm.sh   # fresh VM, all submodules + full build
#          bash scripts/deploy_to_vm.sh                    # redeploy: sync full repo, build api+rag_api, start full stack
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
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=6
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
# NOTE: Submodule contents (infra/rag_api/**) ARE included in tar - they are vendored before packaging
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

# Deployment mode: FULL_BOOTSTRAP=1 for fresh VM, default is redeploy (scoped)
FULL_BOOTSTRAP="${FULL_BOOTSTRAP:-0}"

# Update scope: which services get synced/built (default api + rag_api). Tar always includes full repo.
# Runtime is always FULL stack unless MINIMAL=1.
UPDATE_SCOPE="${UPDATE_SCOPE:-api,rag_api}"

# Minimal runtime: if 1, only start api + rag_api (and deps). If 0 (default), start full compose stack.
MINIMAL="${MINIMAL:-0}"

echo "[deploy] Ensuring submodules are initialized locally (before packaging)..."

# Initialize submodules locally before creating tar
# This vendors submodule contents into the tar, so VM doesn't need git access
(
  cd "$ROOT_DIR"
  if [ -f .gitmodules ]; then
    if [ "$FULL_BOOTSTRAP" = "1" ]; then
      echo "[deploy] FULL_BOOTSTRAP mode: Initializing all submodules..."
      # Bootstrap mode: try to initialize all submodules
      # If firecrawl commit is unreachable, vendor existing local state
      git submodule sync --recursive || {
        echo "[deploy][warning] Submodule sync failed, continuing with local state"
      }
      
      # Try to update all submodules, but handle firecrawl gracefully
      if ! git submodule update --init --recursive 2>/dev/null; then
        echo "[deploy][warning] Some submodules failed to update (likely firecrawl pinned commit)"
        echo "[deploy] Attempting to initialize rag_api only..."
        git submodule sync -- infra/rag_api || true
        git submodule update --init -- infra/rag_api || {
          echo "[deploy][error] Failed to initialize rag_api submodule"
          exit 1
        }
        
        # For firecrawl: if local state exists, use it; otherwise warn
        if [ -d "infra/firecrawl" ] && [ -n "$(ls -A infra/firecrawl 2>/dev/null)" ]; then
          echo "[deploy] ✓ Using existing firecrawl local state (commit may be unreachable)"
        else
          echo "[deploy][warning] infra/firecrawl not found and cannot be fetched"
          echo "[deploy][warning] Firecrawl will not be available on VM unless manually deployed"
        fi
      fi
    else
      # Default redeploy mode: only initialize rag_api (skip firecrawl)
      echo "[deploy] Redeploy mode: Initializing rag_api submodule only..."
      git submodule sync -- infra/rag_api || {
        echo "[deploy][error] Failed to sync rag_api submodule"
        exit 1
      }
      git submodule update --init -- infra/rag_api || {
        echo "[deploy][error] Failed to initialize rag_api submodule"
        exit 1
      }
    fi
    
    # Verify rag_api submodule is populated
    if [ ! -d "infra/rag_api" ] || [ -z "$(ls -A infra/rag_api 2>/dev/null)" ]; then
      echo "[deploy][error] infra/rag_api submodule is not populated"
      exit 1
    fi
    
    echo "[deploy] ✓ Submodules initialized and ready for packaging"
  else
    echo "[deploy][warning] .gitmodules not found, skipping submodule initialization"
  fi
)

echo "[deploy] Using portable tar-based sync (no rsync)..."

# Build tar exclude args
TAR_ARGS=()
for pattern in "${EXCLUDES[@]}"; do
  TAR_ARGS+=(--exclude="$pattern")
done

echo "[deploy] Streaming project to remote via tar (code + vendored submodules, no data)..."

(
  cd "$ROOT_DIR"
  tar -czf - "${TAR_ARGS[@]}" .
) | ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "bash -lc '
  set -euo pipefail
  cd \"$DEPLOY_PATH\"
  # Extract and if it fails, show useful context
  if ! tar -xzf - ; then
    echo \"[remote][error] tar extraction failed\"
    echo \"[remote] Disk:\"; df -h || true
    echo \"[remote] Inodes:\"; df -i || true
    exit 1
  fi
'"

echo "[deploy] Starting containers on remote host..."
echo "[deploy] Update scope (build/sync): $UPDATE_SCOPE | Full stack: $([ "$MINIMAL" = "1" ] && echo 'no (minimal)' || echo 'yes')"
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "DEPLOY_PATH='$DEPLOY_PATH' RAG_PORT='${RAG_PORT:-8000}' FULL_BOOTSTRAP='$FULL_BOOTSTRAP' UPDATE_SCOPE='$UPDATE_SCOPE' MINIMAL='$MINIMAL' bash -s" <<'EOF'
set -euo pipefail

# Ensure we're in the correct directory (contains docker-compose.yml)
cd "$DEPLOY_PATH" || {
  echo "[remote][error] Failed to cd to $DEPLOY_PATH"
  exit 1
}

# Verify docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
  echo "[remote][error] docker-compose.yml not found in $DEPLOY_PATH"
  echo "[remote] Current directory: $(pwd)"
  echo "[remote] Contents:"
  ls -la || true
  exit 1
fi

# Make sure shared network exists for LibreChat <-> Firecrawl
docker network inspect argus-net >/dev/null 2>&1 || docker network create argus-net

# Bootstrap mode: start Firecrawl stack (only if FULL_BOOTSTRAP=1)
if [ "$FULL_BOOTSTRAP" = "1" ]; then
  echo "[remote] FULL_BOOTSTRAP mode: Starting Firecrawl stack..."
  if [ -f "infra/firecrawl/docker-compose.firecrawl.yml" ]; then
    docker compose -f infra/firecrawl/docker-compose.firecrawl.yml up -d --build || {
      echo "[remote][warning] Firecrawl stack failed to start (may be missing or broken)"
      echo "[remote][warning] Continuing with LibreChat stack..."
    }
  else
    echo "[remote][warning] infra/firecrawl/docker-compose.firecrawl.yml not found"
    echo "[remote][warning] Firecrawl will not be available"
  fi
else
  echo "[remote] Redeploy mode: Skipping Firecrawl (not rebuilding)"
fi

echo "[remote] Starting LibreChat stack..."
docker compose down || true

# Verify vendored submodule contents are present (fail fast if missing)
# Submodules are vendored into tar before deployment, so no git operations needed on VM
# Tar packaging always includes full repo (packages/, librechat-custom/, etc.); only submodule init is rag_api in redeploy
if [ ! -f "infra/rag_api/Dockerfile" ]; then
  echo "[remote][error] infra/rag_api/Dockerfile not found!"
  echo "[remote][error] Submodule contents should be vendored into tar before deployment."
  echo "[remote][error] Check that deploy script initializes submodules locally before packaging."
  exit 1
fi

echo "[remote] ✓ RAG API source verified (vendored in tar)"

# Build: in redeploy mode build only UPDATE_SCOPE (default api,rag_api) so api image reflects packages/data-provider etc.
# In bootstrap mode build all.
if [ "$FULL_BOOTSTRAP" = "1" ]; then
  echo "[remote] FULL_BOOTSTRAP mode: Building all containers..."
  docker compose build
else
  echo "[remote] Redeploy mode: Building update-scope only ($UPDATE_SCOPE)..."
  for svc in $(echo "$UPDATE_SCOPE" | tr ',' ' '); do
    docker compose build "$svc" || {
      echo "[remote][error] Failed to build $svc"
      exit 1
    }
  done
fi

# Runtime: full stack by default (meilisearch, searxng, api, rag_api, etc.). MINIMAL=1 starts only UPDATE_SCOPE.
if [ "$MINIMAL" = "1" ]; then
  echo "[remote] Minimal mode: Starting only update-scope services ($UPDATE_SCOPE)..."
  docker compose up -d --remove-orphans $(echo "$UPDATE_SCOPE" | tr ',' ' ') || {
    echo "[remote][error] Failed to start minimal stack"
    exit 1
  }
else
  echo "[remote] Full stack: Starting all services (docker compose up -d --remove-orphans)..."
  docker compose up -d --remove-orphans || {
    echo "[remote][error] Failed to start full stack"
    exit 1
  }
  # Force recreate update-scope containers so they use the images we just built (e.g. api with packages/data-provider file-config)
  echo "[remote] Forcing recreate of update-scope containers so new images are used..."
  docker compose up -d --force-recreate $(echo "$UPDATE_SCOPE" | tr ',' ' ') || true
fi

echo "[remote] Waiting for RAG API to start..."
sleep 5

# Health check with retry loop (up to 30 seconds)
MAX_WAIT=30
ELAPSED=0
HEALTHY=0

echo "[remote] Checking RAG API health..."
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if docker compose exec -T rag_api curl -sf "http://localhost:${RAG_PORT:-8000}/health" >/dev/null 2>&1; then
    echo "[remote] ✓ RAG API is healthy"
    HEALTHY=1
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ $HEALTHY -eq 0 ]; then
  echo "[remote][error] RAG API health check failed after ${MAX_WAIT}s"
  echo "[remote] Diagnostic information:"
  echo "[remote] Current directory: $(pwd)"
  echo "[remote] docker-compose.yml exists: $([ -f docker-compose.yml ] && echo 'yes' || echo 'no')"
  echo "[remote] Container status:"
  docker compose ps rag_api || true
  echo "[remote] Recent logs:"
  docker compose logs --tail 100 rag_api || true
  exit 1
fi

# Post-deploy health output so we immediately see full stack and any api/rag_api errors
echo "[remote] --- docker compose ps ---"
docker compose ps
echo "[remote] --- api logs (tail 50) ---"
docker compose logs --tail 50 api
echo "[remote] --- rag_api logs (tail 50) ---"
docker compose logs --tail 50 rag_api

echo "[remote] Containers started."
EOF

echo "[deploy] Complete."