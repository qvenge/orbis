#!/bin/bash
set -euo pipefail
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
run() {
  local label=$1 code=0
  shift
  "$@" > "$restore_tmp/log/$label.log" 2>&1 || code=$?
  printf '%s %s\n' "$label" "$code" >> "$restore_tmp/log/exit-codes.txt"
  return "$code"
}
run target-managed-capture bash "$restore_tmp/capture-catalog.sh" target managed
run source-fixture restore_bun source test apps/server/test/restore-rehearsal.fixture.test.ts
sed -n 's/^RESTORE_WITNESS //p' "$restore_tmp/log/source-fixture.log" > "$restore_tmp/log/source-witness.json"
run source-catalog-capture bash "$restore_tmp/capture-catalog.sh" source catalog
run source-business-before restore_bun source scripts/restore-rehearsal-business.ts
printf 'Fixture and manifests captured.\n'
