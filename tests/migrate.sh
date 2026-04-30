#!/usr/bin/env bash
set -e

POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_DB=${POSTGRES_DB:-sourcify}
POSTGRES_USER=${POSTGRES_USER:-sourcify}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-sourcify}

echo "Applying schema from argotorg/sourcify@staging..."
curl -fsSL \
  https://raw.githubusercontent.com/argotorg/sourcify/staging/services/database/sourcify-database.sql \
  | PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB"

echo "Migration complete."
