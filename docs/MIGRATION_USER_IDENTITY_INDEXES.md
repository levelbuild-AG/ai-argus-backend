# User identity index migration (Package 2)

Operational guide for `api/server/services/migrations/migrateUserIdentityIndexes.js`. Run this **before** enabling same-email-across-tenants in production (ext/v2 MT rollout).

---

## 1. What the script does

- **Target:** System Mongo database — the **User** collection on the default connection (`MONGO_URI` / `SYSTEM_MONGO_URI`). This is the same DB where Tenants and system identity live; **not** tenant DBs.
- **Drops** (if present):
  - `email_1` — legacy global unique index on `email`
  - `platformUserId_1` — legacy global unique index on `platformUserId`
- **Creates** (idempotent; skips if already present):
  - Compound unique sparse index: `(tenantId, email)`
  - Compound unique sparse index: `(tenantId, platformUserId)`

**Why:** The app now allows the same email in different tenants (and same `platformUserId` per tenant). The old global unique indexes would block that. The new compound indexes enforce uniqueness per tenant only.

---

## 2. Preconditions before running

- **Mongo connection string:** You must set **one** of these (in the environment or in a `.env` file the script loads):
  - **`MONGO_URI`** — system Mongo URI (where Users and Tenants live).
  - **`SYSTEM_MONGO_URI`** — system Mongo URI; used as fallback if `MONGO_URI` is not set.
  The script loads `.env` from **repo root** then **api/** (so either `./.env` or `api/.env` works). It then resolves the URI in that order and logs which variable was used. If neither is set, the script exits with a clear error naming both variables.
- **No API writes during migration:** Prefer running during a maintenance window or while the API is not writing to the User collection. Dropping/creating indexes can briefly block writes on that collection.
- **Backup (recommended):** Snapshot or dump the system Mongo database (or at least the `users` collection) before the first run in a given environment. Index changes are low-risk but backups are standard practice.

---

## 3. Risks if run against a populated DB

- **Duplicate emails across tenants:** If you already have users with the same `email` in different tenants (e.g. created before the schema change), the **drop** of `email_1` will succeed. The **create** of `(tenantId, email)` unique will succeed only if there are no duplicate `(tenantId, email)` pairs. If you have two users with the same `(tenantId, email)`, `createIndex` will fail and the script exits 1. Resolve duplicates (e.g. merge or rename) before re-running.
- **Legacy users with `tenantId` null/empty:** Sparse indexes ignore documents where the indexed fields are null/empty. So legacy users (no `tenantId`) are not constrained by the new compound indexes. No hazard from that.
- **Rollback:** There is no automatic rollback. To revert you would need to manually drop the new compound indexes and recreate the old global ones — only if you also revert application code that relies on same-email-across-tenants. For a forward-only rollout, rollback is “revert app + re-run an older migration shape”; not provided in this repo.

---

## 4. Legacy users and existing indexes

- **Legacy global indexes:** The script only drops `email_1` and `platformUserId_1`. If your DB has different names (e.g. from an older Mongoose version), the script will not drop them; you may need to drop them manually and then run the script to create the compound indexes.
- **Existing compound indexes:** If the compound indexes already exist (e.g. from a previous run or from schema sync), the script detects them and skips create (idempotent).
- **Other indexes:** Any other indexes on the User collection (e.g. `tenantId_1`) are left unchanged.

---

## 5. Recommended rollout order for production

1. **Backup** system Mongo (or at least `users`).
2. Ensure **`MONGO_URI`** or **`SYSTEM_MONGO_URI`** is set (e.g. in `api/.env` or repo root `.env`).
3. **Dry run** in the target environment (see §7 for exact commands). Confirm logs: which indexes would be dropped, which created (or “already exists”), and `Using connection string from: MONGO_URI` or `SYSTEM_MONGO_URI`.
4. **Maintenance window** (optional but recommended): reduce or stop API traffic that writes to Users.
5. **Run for real** (see §7). Exit 0 = success; exit 1 = failure (e.g. drop failed or duplicate key when creating compound index).
6. **Verify:** Re-run with `--dry-run` and confirm logs show “already exists” for both compound indexes.
7. **Deploy** API version that uses tenant-scoped identity (Package 2 code).

---

## 6. Dry-run, verification, and failure behavior

- **Dry run:** Set `DRY_RUN=1` or pass `--dry-run`. The script connects, lists current indexes, and logs what it would drop/create without making changes. Exit 0.
- **Verification:** After a real run, run again with `DRY_RUN=1` and check that both compound indexes are reported as “already exists”. Alternatively inspect indexes in Mongo shell: `db.users.getIndexes()`.
- **Failure behavior:**
  - **Drop fails** (e.g. index in use, permissions): script logs error and **exits 1**. Fix environment and re-run.
  - **Create fails** (e.g. duplicate key): script throws, logs error, **exits 1**. Resolve duplicate `(tenantId, email)` or `(tenantId, platformUserId)` and re-run.
- **Idempotency:** Safe to run multiple times. Drops only run if the legacy index exists; creates only run if the compound index does not already exist.

---

## 7. Env and commands (copy-paste)

### Env requirement

Set **one** of these (in shell or in `.env` at repo root or in `api/.env`):

- **`MONGO_URI`** — system Mongo connection string
- **`SYSTEM_MONGO_URI`** — system Mongo connection string (used if `MONGO_URI` is not set)

The script loads `.env` from repo root then from `api/` before connecting, so you can put the variable in either `.env` and run from any directory. If neither is set, it exits with an error that names both variables.

### Dry run (no changes)

From **repo root** (recommended — script then finds both possible `.env` locations):

```bash
cd /c/Coding/ai-argus-backend
node api/server/services/migrations/migrateUserIdentityIndexes.js --dry-run
```

Or with env in shell (Git Bash / Linux / macOS):

```bash
cd /c/Coding/ai-argus-backend
DRY_RUN=1 node api/server/services/migrations/migrateUserIdentityIndexes.js
```

From **api/** (uses `api/.env` or repo root `.env`):

```bash
cd /c/Coding/ai-argus-backend/api
node server/services/migrations/migrateUserIdentityIndexes.js --dry-run
```

### Real run

From **repo root**:

```bash
cd /c/Coding/ai-argus-backend
node api/server/services/migrations/migrateUserIdentityIndexes.js
```

From **api/**:

```bash
cd /c/Coding/ai-argus-backend/api
node server/services/migrations/migrateUserIdentityIndexes.js
```

### Recommended for Git Bash on Windows (Flo)

Use repo root and the full path to the script so `.env` is found regardless of where it lives:

```bash
cd /c/Coding/ai-argus-backend
# Dry run
node api/server/services/migrations/migrateUserIdentityIndexes.js --dry-run
# Real run (after backup and dry-run check)
node api/server/services/migrations/migrateUserIdentityIndexes.js
```

Ensure `MONGO_URI` or `SYSTEM_MONGO_URI` is set in `api/.env` or `./.env` (repo root). The script will log: `Using connection string from: MONGO_URI` or `Using connection string from: SYSTEM_MONGO_URI`.
