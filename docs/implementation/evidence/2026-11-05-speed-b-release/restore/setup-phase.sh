#!/bin/bash
set -euo pipefail
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
run() {
  local label=$1 code=0
  shift
  "$@" > "$restore_tmp/log/$label.log" 2>&1 || code=$?
  printf '%s %s\n' "$label" "$code" >> "$restore_tmp/log/exit-codes.txt"
  return "$code"
}
run guard-source env RESTORE_APPROVED_PHASE=source-identity bash "$restore_runner" source-identity
run guard-target env RESTORE_APPROVED_PHASE=identity bash "$restore_runner" identity
if run guard-wrong-target env RESTORE_APPROVED_PHASE=identity RESTORE_TARGET_SYSTEM_ID=1 bash "$restore_runner" identity; then
  echo 'Wrong system identifier passed unexpectedly' >&2
  exit 1
fi
grep -q 'wrong restore target' "$restore_tmp/log/guard-wrong-target.log"
run source-setup restore_bun source scripts/setup-db.ts
run target-setup restore_bun target scripts/setup-db.ts
run source-pgcron restore_psql source -c 'CREATE EXTENSION IF NOT EXISTS pg_cron'
run source-migrate restore_bun source run --filter @orbis/server db:migrate
run source-seed restore_bun source scripts/seed-registries.ts
cat "$restore_tmp/log/exit-codes.txt"
