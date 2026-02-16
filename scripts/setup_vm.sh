#!/usr/bin/env bash
set -euo pipefail

# Instructions
# In Git Bash terminal, run:
# chmod +x ./scripts/setup_vm.sh
# bash ./scripts/setup_vm.sh

########################################
# CONFIG - CHANGE THESE PER TENANT
########################################

# GCP project and VM info
PROJECT_ID="gcpxaixlevelbuildxseibert"
ZONE="europe-west4-a"                 # e.g. "europe-west4-a"
VM_NAME="levelbuild-argus-chat"       # e.g. "<tenant>-argus-chat"

# SSH / remote user
VM_USER="${VM_USER:-florian}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"

# Tenant-specific HTTPS info
TENANT_DOMAIN="levelbuild-argus-chat.levelbuild.com"
LIBRECHAT_PORT=3080                   # port where LibreChat listens on the VM
CERTBOT_EMAIL="florian.dittrich@levelbuild.com"

# If true, the script may move /var/lib/docker to the extra disk on first-time setup.
# For existing VMs or unknown disk state, keep false.
ENABLE_DOCKER_DATA_MOVE="${ENABLE_DOCKER_DATA_MOVE:-false}"

########################################
# 0. BASIC CHECKS
########################################

if ! command -v gcloud >/dev/null 2>&1; then
  echo "[error] gcloud CLI not found. Install Google Cloud SDK first."
  exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
  echo "[error] SSH key not found at $SSH_KEY"
  exit 1
fi

echo "[info] Using project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null

########################################
# 1. DISCOVER NETWORK & VM EXTERNAL IP
########################################

echo "[step] Discovering VM network and external IP..."

NETWORK_URL=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="get(networkInterfaces[0].network)")

if [ -z "$NETWORK_URL" ]; then
  echo "[error] Could not determine network for instance $VM_NAME"
  exit 1
fi

NETWORK_NAME="${NETWORK_URL##*/}"
echo "[info] VM is on network: $NETWORK_NAME"

VM_HOST=$(gcloud compute instances describe "$VM_NAME" \
  --zone="$ZONE" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

if [ -z "$VM_HOST" ]; then
  echo "[error] Could not get external IP for instance $VM_NAME"
  exit 1
fi

echo "[info] VM external IP: $VM_HOST"

########################################
# 2. FIREWALL RULES (22, 80, 443)
########################################

FWRULE_NAME="allow-librechat-ssh-http-https"

echo "[step] Ensuring firewall rule $FWRULE_NAME exists (22, 80, 443)..."

if gcloud compute firewall-rules describe "$FWRULE_NAME" >/dev/null 2>&1; then
  echo "[info] Firewall rule $FWRULE_NAME already exists, skipping creation."
else
  gcloud compute firewall-rules create "$FWRULE_NAME" \
    --network="$NETWORK_NAME" \
    --direction=INGRESS \
    --priority=1000 \
    --action=ALLOW \
    --rules=tcp:22,tcp:80,tcp:443 \
    --source-ranges=0.0.0.0/0
  echo "[info] Firewall rule $FWRULE_NAME created."
fi

########################################
# 3. SSH OPTIONS
########################################

SSH_OPTS=(
  -i "$SSH_KEY"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
)

echo "[step] Testing SSH connectivity to $VM_USER@$VM_HOST ..."
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" "echo '[remote] SSH OK on $(hostname)'" || {
  echo "[error] SSH connection failed. Check VM_USER, SSH_KEY, firewall, etc."
  exit 1
}

########################################
# 4. REMOTE SETUP (Disk, Docker, Nginx, Certbot, HTTPS)
########################################

echo "[step] Running remote setup on VM..."

ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_HOST" \
  TENANT_DOMAIN="$TENANT_DOMAIN" \
  LIBRECHAT_PORT="$LIBRECHAT_PORT" \
  CERTBOT_EMAIL="$CERTBOT_EMAIL" \
  ENABLE_DOCKER_DATA_MOVE="$ENABLE_DOCKER_DATA_MOVE" \
  bash -s << 'REMOTE_EOF'
set -euo pipefail

echo "[remote] Starting tenant setup for $TENANT_DOMAIN"

########################################
# 4.1 UPDATE OS & BASE TOOLS
########################################

echo "[remote] Updating OS packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

echo "[remote] Installing base dependencies..."
sudo apt-get install -y \
  curl \
  gnupg2 \
  ca-certificates \
  lsb-release \
  ufw \
  rsync

########################################
# 4.2 DOCKER + DOCKER COMPOSE
########################################

if ! command -v docker >/dev/null 2>&1; then
  echo "[remote] Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "[remote] Docker already installed."
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[remote] Installing docker-compose plugin..."
  sudo apt-get install -y docker-compose-plugin
else
  echo "[remote] docker compose plugin already installed."
fi

echo "[remote] Docker version:"
docker --version || true

echo "[remote] Docker Compose version:"
docker compose version || true

########################################
# 4.3 OPTIONAL: MOVE DOCKER/CONTAINERD TO EXTRA DATA DISK
########################################

# Strategy:
# - Detect an extra disk (e.g. /dev/sdb) that is TYPE=disk and not the boot disk.
# - Format it ext4 if it's not in /etc/fstab yet.
# - Mount it at /mnt/docker-data and persist via fstab.
# - Move /var/lib/docker and /var/lib/containerd there using rsync + symlinks.
# - Idempotent: if /var/lib/docker is already a symlink, skip.

echo "[remote] Checking for extra data disk to use for Docker..."

EXTRA_DISK=""
while read -r name type size; do
  if [ "$type" = "disk" ] && [ "$name" != "sda" ]; then
    EXTRA_DISK="/dev/$name"
    break
  fi
done < <(lsblk -ndo NAME,TYPE,SIZE)

if [ -z "$EXTRA_DISK" ]; then
  echo "[remote] No extra data disk detected (only root disk). Skipping Docker data move."
else
  echo "[remote] Detected extra disk: $EXTRA_DISK"

  if [ "${ENABLE_DOCKER_DATA_MOVE,,}" != "true" ]; then
    echo "[remote] ENABLE_DOCKER_DATA_MOVE=false; skipping formatting/mounting/moving Docker data."
  else
    echo "[remote] ENABLE_DOCKER_DATA_MOVE=true; attempting to mount extra disk safely..."
    sudo mkdir -p /mnt/docker-data

    # Detect if disk already has a filesystem (or partitions) — if so, do NOT format.
    FSTYPE="$(lsblk -ndo FSTYPE "$EXTRA_DISK" | head -n 1 || true)"
    HAS_PARTITIONS="$(lsblk -n "$EXTRA_DISK" 2>/dev/null | awk 'NR>1{print $1}' | wc -l | tr -d ' ' || true)"

    if mountpoint -q /mnt/docker-data; then
      echo "[remote] /mnt/docker-data is already mounted; leaving as-is."
    else
      if [ -n "$FSTYPE" ] || [ "${HAS_PARTITIONS:-0}" -gt 0 ]; then
        echo "[remote] Disk appears to be in use (fstype=$FSTYPE, partitions=$HAS_PARTITIONS). Will NOT format."
        echo "[remote] Attempting to mount existing filesystem..."

        if sudo mount "$EXTRA_DISK" /mnt/docker-data 2>/dev/null; then
          echo "[remote] Mounted $EXTRA_DISK -> /mnt/docker-data"
        else
          PART="$(lsblk -ndo NAME "$EXTRA_DISK" | sed -n '2p' || true)"
          if [ -n "$PART" ] && sudo mount "/dev/$PART" /mnt/docker-data 2>/dev/null; then
            echo "[remote] Mounted /dev/$PART -> /mnt/docker-data"
          else
            echo "[remote] Could not mount existing disk safely. Skipping Docker data move."
          fi
        fi
      else
        echo "[remote] Disk looks empty (no fstype, no partitions). Formatting + mounting..."
        sudo mkfs.ext4 -F "$EXTRA_DISK"
        sudo mount "$EXTRA_DISK" /mnt/docker-data
        UUID="$(sudo blkid -s UUID -o value "$EXTRA_DISK")"
        echo "UUID=$UUID /mnt/docker-data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
      fi
    fi

    # Only move data if mount succeeded and docker dir isn't already symlinked
    if mountpoint -q /mnt/docker-data && [ ! -L /var/lib/docker ]; then
      echo "[remote] Moving Docker + containerd data to /mnt/docker-data..."

      sudo systemctl stop docker docker.socket containerd || true

      sudo mkdir -p /mnt/docker-data/docker /mnt/docker-data/containerd

      [ -d /var/lib/docker ] && sudo rsync -aHAX /var/lib/docker/ /mnt/docker-data/docker/ || true
      [ -d /var/lib/containerd ] && sudo rsync -aHAX /var/lib/containerd/ /mnt/docker-data/containerd/ || true

      [ -d /var/lib/docker ] && [ ! -L /var/lib/docker ] && sudo mv /var/lib/docker /var/lib/docker.bak || true
      [ -d /var/lib/containerd ] && [ ! -L /var/lib/containerd ] && sudo mv /var/lib/containerd /var/lib/containerd.bak || true

      [ ! -e /var/lib/docker ] && sudo ln -s /mnt/docker-data/docker /var/lib/docker
      [ ! -e /var/lib/containerd ] && sudo ln -s /mnt/docker-data/containerd /var/lib/containerd

      sudo systemctl start containerd || true
      sudo systemctl start docker || true

      echo "[remote] Docker + containerd now use /mnt/docker-data (via symlinks)."
    else
      echo "[remote] Skipping docker data move (either not mounted or already moved)."
    fi
  fi
fi

########################################
# 4.4 NGINX + CERTBOT
########################################

echo "[remote] Installing Nginx and Certbot..."
sudo apt-get install -y nginx certbot python3-certbot-nginx

########################################
# 4.5 FIREWALL (UFW) ON THE VM
########################################

echo "[remote] Configuring UFW (firewall) if available..."
if sudo ufw status >/dev/null 2>&1; then
  sudo ufw allow OpenSSH || true
  sudo ufw allow 'Nginx Full' || true
  sudo ufw --force enable || true
else
  echo "[remote] UFW not available or not installed correctly, skipping firewall config."
fi

########################################
# 4.6 NGINX REVERSE PROXY CONFIG (HTTP + HTTPS-ready)
########################################

NGINX_CORS_MAP="/etc/nginx/conf.d/librechat_cors_map.conf"

echo "[remote] Writing Nginx CORS map to ${NGINX_CORS_MAP}..."
sudo tee "${NGINX_CORS_MAP}" >/dev/null <<'MAP_EOF'
# This file is included by nginx.conf via conf.d/*.conf (http context)
# Add any origin that may embed the chat (e.g. portal) so preflight OPTIONS succeeds.
# LibreChat CORS_ALLOWED_ORIGINS (.env) must also include these origins for actual responses.

map $http_origin $cors_allow_origin {
    default "";

    "http://localhost:5173"                      $http_origin;
    "https://development.levelbuild.com"         $http_origin;
    "https://portal.levelbuild.com"              $http_origin;
    "https://cloud.jaeger-gruppe.de"             $http_origin;
    "https://mobau.demmelhuber.de"               $http_origin;
    "https://implenia.levelbuild.com"            $http_origin;
    "https://dagu.mainka-bau.de"                 $http_origin;
    "https://levelbuild-argus-chat.levelbuild.com" $http_origin;
}
MAP_EOF


NGINX_CONF="/etc/nginx/sites-available/librechat"
NGINX_SNIPPET="/etc/nginx/snippets/librechat_proxy.conf"

echo "[remote] Writing Nginx proxy snippet to ${NGINX_SNIPPET}..."

# Snippet contains routing logic (shared by :80 and :443 blocks)
sudo tee "${NGINX_SNIPPET}" >/dev/null <<'SNIP_EOF'
client_max_body_size 512M;

# Basic hardening header
add_header X-Content-Type-Options "nosniff" always;

# -------------------------------------------------------
# External API: /api/ext/v1/*  ->  upstream /ext/v1/*
# CORS: handled ONLY for preflight to avoid duplicate headers
# -------------------------------------------------------
location ^~ /api/ext/v1/ {

    # Preflight: nginx answers directly (no upstream)
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin $cors_allow_origin always;
        add_header Access-Control-Allow-Credentials "true" always;
        add_header Vary Origin always;
        add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization,Content-Type,Accept,X-Requested-With,x-user-id,x-user-email,x-user-name,x-user-role" always;
        add_header Access-Control-Max-Age 600 always;
        return 204;
    }

    # Normal requests: proxy to LibreChat and DO NOT add CORS here
    add_header Access-Control-Allow-Credentials "true" always;
    proxy_pass http://127.0.0.1:__LIBRECHAT_PORT__/ext/v1/;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_read_timeout 3600s;
}

# -------------------------------------------------------
# External API: /api/ext/v2/*  ->  upstream /ext/v2/*
# CORS: handled ONLY for preflight to avoid duplicate headers
# -------------------------------------------------------
location ^~ /api/ext/v2/ {

    # Preflight: nginx answers directly (no upstream)
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin $cors_allow_origin always;
        add_header Access-Control-Allow-Credentials "true" always;
        add_header Vary Origin always;
        add_header Access-Control-Allow-Methods "GET,POST,PUT,PATCH,DELETE,OPTIONS" always;
        add_header Access-Control-Allow-Headers "Authorization,Content-Type,Accept,X-Requested-With,x-user-id,x-user-email,x-user-name,x-user-role" always;
        add_header Access-Control-Max-Age 600 always;
        return 204;
    }

    # Normal requests: proxy to LibreChat and DO NOT add CORS here
    add_header Access-Control-Allow-Credentials "true" always;
    proxy_pass http://127.0.0.1:__LIBRECHAT_PORT__/ext/v2/;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_read_timeout 3600s;
}

# -------------------------------------------------------
# Default: everything else (LibreChat UI + internal API)
# -------------------------------------------------------
location / {
    proxy_pass http://127.0.0.1:__LIBRECHAT_PORT__/;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket support
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
SNIP_EOF

# Inject the actual port into the snippet (avoid nginx variable expansion issues)
sudo sed -i "s/__LIBRECHAT_PORT__/${LIBRECHAT_PORT}/g" "${NGINX_SNIPPET}"

echo "[remote] Writing Nginx HTTP site config to ${NGINX_CONF}..."

# HTTP server block only (HTTPS block will be written after certs exist)
sudo tee "${NGINX_CONF}" >/dev/null <<NGINX_EOF
server {
    listen 80;
    listen [::]:80;
    server_name $TENANT_DOMAIN;

    include /etc/nginx/snippets/librechat_proxy.conf;
}
NGINX_EOF

echo "[remote] Enabling Nginx site..."

sudo rm -f /etc/nginx/sites-enabled/default || true
sudo ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/librechat

echo "[remote] Testing Nginx configuration..."
sudo nginx -t

echo "[remote] Reloading Nginx..."
sudo systemctl reload nginx

########################################
# 4.7 LET'S ENCRYPT (CERTBOT) - HTTPS (certonly, we own nginx)
########################################

echo "[remote] Ensuring Let's Encrypt certificate exists for $TENANT_DOMAIN (certonly)..."

# Try to obtain cert if missing; do not fail the whole run if LE is temporarily unavailable
sudo certbot certonly --nginx \
  --non-interactive \
  --agree-tos \
  --email "$CERTBOT_EMAIL" \
  -d "$TENANT_DOMAIN" || true

# Resolve cert paths via certbot lineage (most reliable)
LINEAGE="$(sudo certbot certificates 2>/dev/null | awk -v d="$TENANT_DOMAIN" '
  $0 ~ "Certificate Name:" {name=$3}
  $0 ~ "Domains:" && $0 ~ d {print name; exit}
')"

if [ -z "$LINEAGE" ]; then
  # Fallback: assume lineage equals domain (common case)
  LINEAGE="$TENANT_DOMAIN"
fi

FULLCHAIN="/etc/letsencrypt/live/$LINEAGE/fullchain.pem"
PRIVKEY="/etc/letsencrypt/live/$LINEAGE/privkey.pem"

if ! sudo test -f "$FULLCHAIN" || ! sudo test -f "$PRIVKEY"; then
  echo "[remote][error] Expected cert files not accessible/found (root-only path):"
  echo "  fullchain=$FULLCHAIN"
  echo "  privkey=$PRIVKEY"
  echo "[remote][error] Refusing to overwrite nginx config (to avoid downtime)."
  echo "[remote][error] Run on VM: sudo certbot certificates"
  exit 1
fi

echo "[remote] Writing Nginx HTTPS + redirect config (managed by this script)..."

sudo tee "${NGINX_CONF}" >/dev/null <<NGINX_SITE_EOF
server {
    listen 80;
    listen [::]:80;
    server_name $TENANT_DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $TENANT_DOMAIN;

    ssl_certificate     $FULLCHAIN;
    ssl_certificate_key $PRIVKEY;

    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    include /etc/nginx/snippets/librechat_proxy.conf;
}
NGINX_SITE_EOF

sudo rm -f /etc/nginx/sites-enabled/default || true
sudo ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/librechat

echo "[remote] Testing Nginx configuration..."
sudo nginx -t

echo "[remote] Reloading Nginx..."
sudo systemctl reload nginx

echo "[remote] Testing Certbot auto-renewal (dry run)..."
sudo certbot renew --dry-run || true

########################################
# 4.8 SIMPLE HTTPS HEALTH CHECK
########################################

echo "[remote] Performing simple HTTPS check (this may fail if LibreChat is not up yet)..."
set +e
curl -k -I "https://$TENANT_DOMAIN" || echo "[remote] HTTPS check: LibreChat not responding yet (this is fine if containers aren't running)."
set -e

echo
echo "============================================="
echo " [remote] Setup complete for tenant: $TENANT_DOMAIN"
echo " Nginx is configured to proxy -> 127.0.0.1:$LIBRECHAT_PORT"
echo " LibreChat should be reachable at:"
echo "   https://$TENANT_DOMAIN"
echo "============================================="
REMOTE_EOF

echo "[done] Remote setup finished for $TENANT_DOMAIN"
echo "[info] Next: make sure your LibreChat containers are running on port $LIBRECHAT_PORT on $VM_HOST."