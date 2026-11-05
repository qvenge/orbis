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
run source-dump env RESTORE_APPROVED_PHASE=source-dump bash "$restore_runner" source-dump
run source-business-after restore_bun source scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/source-business-after.log"
(cd "$restore_tmp" && shasum -a 256 -c source-artifacts.sha256)
