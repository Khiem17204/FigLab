#!/bin/sh
set -eu

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS figlab_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO figlab_schema_migrations(name)
SELECT '0000_initial.sql'
WHERE to_regclass('public.users') IS NOT NULL
  AND to_regclass('public.workspaces') IS NOT NULL
  AND to_regclass('public.workspace_members') IS NOT NULL
  AND to_regclass('public.projects') IS NOT NULL
  AND to_regclass('public.project_documents') IS NOT NULL
  AND to_regclass('public.project_versions') IS NOT NULL
  AND to_regclass('public.upload_sessions') IS NOT NULL
  AND to_regclass('public.assets') IS NOT NULL
  AND to_regclass('public.audit_events') IS NOT NULL
  AND to_regclass('public.export_records') IS NOT NULL
ON CONFLICT (name) DO NOTHING;
SQL

for migration_file in "${MIGRATIONS_DIR:-/migrations}"/*.sql; do
  migration_name="$(basename "$migration_file")"
  already_applied="$(
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
      "SELECT 1 FROM figlab_schema_migrations WHERE name = '$migration_name'"
  )"
  if [ "$already_applied" = "1" ]; then
    continue
  fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v migration_name="$migration_name" <<SQL
BEGIN;
\i $migration_file
INSERT INTO figlab_schema_migrations(name) VALUES (:'migration_name');
COMMIT;
SQL
done
