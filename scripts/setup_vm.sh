#!/usr/bin/env bash
set -euo pipefail

# Update OS
sudo apt-get update -y

# Install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
fi

# Install Docker Compose plugin
if ! docker compose version >/dev/null 2>&1; then
  echo "Installing docker-compose plugin..."
  sudo apt-get install -y docker-compose-plugin
fi

echo "Docker version:"
docker --version

echo "Docker Compose version:"
docker compose version