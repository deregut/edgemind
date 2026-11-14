#!/usr/bin/env bash
# Starts a throwaway local Postgres 17 + pgvector on :54329 for tests (Debian/Ubuntu).
# Install once: sudo apt-get install -y postgresql-17 postgresql-17-pgvector
set -euo pipefail
export PATH=/usr/lib/postgresql/17/bin:$PATH
DATA=${PGDATA_DIR:-/tmp/edgemind-pgdata}
if [ ! -d "$DATA" ]; then initdb -D "$DATA" -U postgres --auth=trust >/dev/null; fi
pg_ctl -D "$DATA" status >/dev/null 2>&1 || pg_ctl -D "$DATA" -o "-p 54329 -k /tmp" -l "$DATA/pg.log" start
echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres"
