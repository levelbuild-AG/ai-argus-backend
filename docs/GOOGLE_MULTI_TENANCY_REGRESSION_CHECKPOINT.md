## Google / Gemini MT regression checkpoint (Argus backend)

**Scope:** Canonical Argus backend stack with multi-tenancy enabled and `tenant-levelbuild` bootstrap.

- **Canonical proof path (local):**
  1. `node scripts/provision-tenants.js`
  2. This script:
     - PATCHes `/api/admin/tenants/:tenantId` with raw JSON Google creds,
     - Calls `POST /ext/v2/agents/chat/google`,
     - Performs ext/v2 readback,
     - Runs deep Mongo verification **inside** the docker network.
- **What is proven:**
  - For `tenant-levelbuild`, a Google/Gemini conversation created via `/ext/v2/agents/chat/google`:
    - Persists its conversation + messages **only** in the tenant Mongo DB (`tenant_levelbuild`),
    - Does **not** create the same `conversationId` in the system Mongo (`LibreChat`).
- **Critical bug that was found:**
  - Symptom: conversation “shell” existed in tenant Mongo but full conversation + messages were written to system Mongo for ext/v2 Google/Gemini.
  - Root cause: `api/app/clients/BaseClient.js` used global models from `~/models` without passing tenant-scoped `models`, causing writes to default to the system DB.
  - Fix location: `api/app/clients/BaseClient.js` now resolves tenant models via `~/db/tenantHelpers.getTenantModels()` and passes them explicitly into `saveConvo`, `saveMessage`, `getConvo`, `getMessages`, and `updateMessage`.
- **Why deep Mongo verification is non-optional:**
  - API-level success and ext/v2 readback alone cannot detect split-writes between system and tenant Mongo.
  - The bootstrap Google verifier asserts both:
    - `conversationId` exists in the tenant `conversations` + `messages` collections and contains the unique marker, and
    - The same `conversationId` does **not** exist in the system `conversations` collection.
  - This check must remain enabled for bootstrap Google verification in canonical environments to prevent regressions in tenant isolation.

