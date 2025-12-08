#!/usr/bin/env bash
set -euo pipefail

########################################
# CONFIG - EDIT THESE FOR EACH VM
########################################

# GCP project, zone, and instance name
PROJECT_ID="CHANGE_ME_PROJECT_ID"
ZONE="CHANGE_ME_ZONE"                  # e.g. "europe-west4-a"
VM_NAME="CHANGE_ME_VM_NAME"           # e.g. "levelbuild-argus-chat"

# Linux username that should be able to SSH into the VM
GCE_USERNAME="florian"

# Path to your SSH PUBLIC key (NOT the private key!)
# This should be something like: ~/.ssh/id_ed25519.pub
SSH_PUBKEY_PATH="$HOME/.ssh/id_ed25519.pub"

# Temporary file to hold formatted key (safe to leave as default)
TMP_KEY_FILE="gce_key"


########################################
# 0. BASIC CHECKS
########################################

echo "[*] Validating environment..."

if ! command -v gcloud >/dev/null 2>&1; then
  echo "[ERROR] gcloud CLI not found. Please install the Google Cloud SDK first."
  exit 1
fi

if [ ! -f "$SSH_PUBKEY_PATH" ]; then
  echo "[ERROR] SSH public key not found at: $SSH_PUBKEY_PATH"
  echo "        Make sure you point SSH_PUBKEY_PATH to something like ~/.ssh/id_ed25519.pub"
  exit 1
fi

echo "[INFO] Using project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null

########################################
# 1. BUILD FORMATTED GCE METADATA KEY
########################################

echo "[*] Building formatted SSH key for GCE metadata..."

# Read the .pub file into a variable (strip trailing newlines)
PUBKEY_CONTENT=$(tr -d '\r\n' < "$SSH_PUBKEY_PATH")

# Simple sanity check: public keys should start with "ssh-"
if [[ "$PUBKEY_CONTENT" != ssh-* ]]; then
  echo "[WARNING] SSH public key does not start with 'ssh-'."
  echo "          Are you sure $SSH_PUBKEY_PATH is a public key file (ending in .pub)?"
fi

# Create metadata entry: username:<pubkey>
# Result looks like:
#   florian:ssh-ed25519 AAAAC3...etc...
echo -n "${GCE_USERNAME}:" > "$TMP_KEY_FILE"
echo "$PUBKEY_CONTENT" >> "$TMP_KEY_FILE"

echo "[INFO] Created metadata key file: $TMP_KEY_FILE"
echo "------"
cat "$TMP_KEY_FILE"
echo
echo "------"

########################################
# 2. ADD METADATA TO THE VM
########################################

echo "[*] Adding SSH key metadata to instance: $VM_NAME (zone: $ZONE)..."

gcloud compute instances add-metadata "$VM_NAME" \
  --zone="$ZONE" \
  --metadata-from-file ssh-keys="$TMP_KEY_FILE"

echo "[SUCCESS] SSH key added to instance metadata."

########################################
# 3. OPTIONAL: CLEAN UP TEMP FILE
########################################

# Comment out if you want to keep it for debugging
rm -f "$TMP_KEY_FILE"

echo "[DONE] You should now be able to SSH with:"
echo "  ssh -i ~/.ssh/id_ed25519 ${GCE_USERNAME}@<VM_EXTERNAL_IP>"