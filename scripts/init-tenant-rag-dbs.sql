-- Local dev helper: create per-tenant RAG databases with template0 to avoid collation mismatch issues.
-- This script is intended for the canonical docker-compose Postgres only.

CREATE DATABASE tenant_levelbuild TEMPLATE template0;
CREATE DATABASE tenant_jaeger TEMPLATE template0;
CREATE DATABASE tenant_mainka TEMPLATE template0;
CREATE DATABASE tenant_spitzke TEMPLATE template0;
CREATE DATABASE tenant_bd TEMPLATE template0;
CREATE DATABASE tenant_bickhardt TEMPLATE template0;

