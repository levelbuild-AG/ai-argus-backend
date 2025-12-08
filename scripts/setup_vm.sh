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
# Find first non-root disk (assumes root is sda; adjust if your template differs)
while read -r name type size; do
  if [ "$type" = "disk" ] && [ "$name" != "sda" ]; then
    EXTRA_DISK="/dev/$name"
    break
  fi
done < <(lsblk -ndo NAME,TYPE,SIZE)

if [ -n "$EXTRA_DISK" ]; then
  echo "[remote] Detected extra disk: $EXTRA_DISK"

  # Check if it's already in fstab (then assume it's configured)
  if ! grep -q "$EXTRA_DISK" /etc/fstab; then
    echo "[remote] Extra disk not yet in fstab. Formatting and mounting..."
    sudo mkfs.ext4 -F "$EXTRA_DISK"
    sudo mkdir -p /mnt/docker-data
    sudo mount "$EXTRA_DISK" /mnt/docker-data
    UUID=$(sudo blkid -s UUID -o value "$EXTRA_DISK")
    echo "UUID=$UUID /mnt/docker-data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
  else
    echo "[remote] Extra disk already in fstab. Ensuring /mnt/docker-data exists and is mounted..."
    sudo mkdir -p /mnt/docker-data
    # Try mounting; if already mounted, this is harmless
    sudo mount /mnt/docker-data || true
  fi

  # Only move data if /var/lib/docker is NOT already a symlink
  if [ ! -L /var/lib/docker ]; then
    echo "[remote] Moving Docker + containerd data to /mnt/docker-data..."

    sudo systemctl stop docker docker.socket containerd || true

    sudo mkdir -p /mnt/docker-data/docker
    sudo mkdir -p /mnt/docker-data/containerd

    if [ -d /var/lib/docker ]; then
      sudo rsync -aHAX /var/lib/docker/ /mnt/docker-data/docker/ || true
    fi

    if [ -d /var/lib/containerd ]; then
      sudo rsync -aHAX /var/lib/containerd/ /mnt/docker-data/containerd/ || true
    fi

    # Backup old dirs (if they still exist) and replace with symlinks
    if [ -d /var/lib/docker ] && [ ! -L /var/lib/docker ]; then
      sudo mv /var/lib/docker /var/lib/docker.bak || true
    fi
    if [ -d /var/lib/containerd ] && [ ! -L /var/lib/containerd ]; then
      sudo mv /var/lib/containerd /var/lib/containerd.bak || true
    fi

    [ ! -e /var/lib/docker ] && sudo ln -s /mnt/docker-data/docker /var/lib/docker
    [ ! -e /var/lib/containerd ] && sudo ln -s /mnt/docker-data/containerd /var/lib/containerd

    sudo systemctl start containerd || true
    sudo systemctl start docker || true

    echo "[remote] Docker + containerd now use /mnt/docker-data (via symlinks)."
    echo "[remote] Once you're confident it's working, you can remove /var/lib/docker.bak and /var/lib/containerd.bak to free space."
  else
    echo "[remote] /var/lib/docker is already a symlink. Skipping Docker data move."
  fi
else
  echo "[remote] No extra data disk detected (only root disk). Skipping Docker data move."
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
# 4.6 NGINX REVERSE PROXY CONFIG
########################################

NGINX_CONF="/etc/nginx/sites-available/librechat"

echo "[remote] Writing Nginx config to ${NGINX_CONF}..."

sudo tee "${NGINX_CONF}" >/dev/null <<NGINX_EOF
server {
    listen 80;
    listen [::]:80;
    server_name $TENANT_DOMAIN;

    client_max_body_size 200M;

    # Basic hardening header
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://127.0.0.1:$LIBRECHAT_PORT;

        # Forward real client info
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX_EOF

echo "[remote] Enabling Nginx site..."

# Disable default site if present
sudo rm -f /etc/nginx/sites-enabled/default || true

# Enable our LibreChat site
sudo ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/librechat

echo "[remote] Testing Nginx configuration..."
sudo nginx -t

echo "[remote] Reloading Nginx..."
sudo systemctl reload nginx

########################################
# 4.7 LET'S ENCRYPT (CERTBOT) - HTTPS
########################################

echo "[remote] Requesting Let's Encrypt certificate for $TENANT_DOMAIN..."

sudo certbot --nginx \
  --non-interactive \
  --agree-tos \
  --email "$CERTBOT_EMAIL" \
  -d "$TENANT_DOMAIN" \
  --redirect

echo "[remote] Testing Certbot auto-renewal (dry run)..."
sudo certbot renew --dry-run

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