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
dump_sha=$(awk '$2=="orbis-backup-source.sql"{print $1}' "$restore_tmp/source-artifacts.sha256")
test "$dump_sha" = 45a1c2956494478faaf06b7780a3462cb03048f7f19c85211b490459d4231bdc
run target-stock-import env RESTORE_APPROVED_PHASE=stock-import RESTORE_DUMP_SHA256="$dump_sha" bash "$restore_runner" stock-import
run target-stock-catalog bash "$restore_tmp/capture-catalog.sh" target catalog
run target-stock-business restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-stock-business.log"
printf 'Stock SQL imported; full business manifest matches.\n'
