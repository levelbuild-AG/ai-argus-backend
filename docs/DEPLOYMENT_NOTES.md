# Deployment Notes

## Temporary Firewall Exception

- **Rule**: `allow-librechat-3080` (network `default`, tag `librechat-api`)
- **Purpose**: Allow temporary external access to LibreChat on TCP port 3080 while the service still runs on the VM.
- **Risks**: Port 3080 is publicly reachable without TLS; treat as temporary until the stack moves behind Cloud Run / HTTPS proxy.
- **Cleanup Plan**: After migrating to Cloud Run (or any managed proxy), delete the rule and remove the tag from the VM:
  - `gcloud compute firewall-rules delete allow-librechat-3080`
  - `gcloud compute instances remove-tags argus-backend-server --zone=europe-west4-a --tags=librechat-api`

### Deployment Process
- **Command**: `& "C:\Program Files\Git\bin\bash.exe" scripts/deploy_to_vm.sh`

  ## Account Creation Guardrails

  - **Allowed domains** are defined in `librechat.yaml` under `registration.allowedDomains`. The current list only permits `@levelbuild.com` emails; add more entries there when new partner domains need access.
  - The value is surfaced to the client so the registration form guides users before submission, and the server enforces the same rule inside `registerUser`.