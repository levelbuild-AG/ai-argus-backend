# VM Connection
ssh florian@34.7.164.68
cd ~/librechat

**Exiting ssh:**
just run
```bash
exit
```

# VM Hygiene

## Docker

If Docker has been running for a while or feels flaky, run:
```bash
sudo systemctl restart docker
```
on the VM

If Docker errors such as
```text
failed to solve: failed to prepare extraction snapshot "extract-670618138-lo2X sha256:13433324151c865346db1996fc2c3ba8e8123e2003b2870d0fa5ac8e3817e9f3": parent snapshot sha256:1f7e160d46a52d1e60da7c52cf0f46a5d06e8e50a3134a2eadfaa73a27f35f1a does not exist: not found
```
show up, clean up the Docker builder:
```bash
# Stop everything so nothing is using the layers
docker compose down

# Prune builder / buildx cache (this is what’s blowing up)
docker builder prune -af
docker buildx prune -af || true  # depending on Docker version, may or may not exist

# (Optional but helpful) prune dangling images & stopped containers
docker image prune -af
docker container prune -f
```

# librechat.yaml issues

Detect yaml validation issues:
First, check what config the service actually uses:
```bash
# on the VM in cd ~/librechat
curl -s http://localhost:3080/api/config | jq '.interface'
```

If the yaml changes are not being respected, check for valididation issues:
```bash
florian@argus-backend-server:~/librechat$ docker compose logs api | grep -i "Custom config" -A10
LibreChat  | 2025-12-02 20:12:08 error: Invalid custom config file at /app/librechat.yaml:
LibreChat  | {
LibreChat  |   "issues": [
LibreChat  |     {
LibreChat  |       "code": "invalid_type",
LibreChat  |       "expected": "string",
LibreChat  |       "received": "boolean",
LibreChat  |       "path": [
LibreChat  |         "interface",
LibreChat  |         "mcpServers",
LibreChat  |         "placeholder"
```