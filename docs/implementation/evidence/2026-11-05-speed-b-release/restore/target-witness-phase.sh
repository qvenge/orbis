#!/bin/bash
set -euo pipefail
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
run() {
  local label=$1 code=0
  shift
  "$@" > "$restore_tmp/log/$label.log" 2>&1 || code=$?
  printf '%s %s\n' "$label" "$code" >> "$restore_tmp/log/phase-two-exits.txt"
  return "$code"
}
python3 "$restore_tmp/compare-repaired-catalog.py"
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-repair-business-after.log"
test ! -e "$restore_tmp/log/target-low-xid-witness.log"
run target-low-xid-witness restore_bun target test apps/server/test/restore-rehearsal-target-xid.test.ts
sed -n 's/^RESTORE_TARGET_WRITE //p' "$restore_tmp/log/target-low-xid-witness.log" > "$restore_tmp/log/target-witness-write.json"
sed -n 's/^RESTORE_TARGET_RECONCILE //p' "$restore_tmp/log/target-low-xid-witness.log" > "$restore_tmp/log/target-witness-reconcile.json"
run target-business-after-witness restore_bun target scripts/restore-rehearsal-business.ts
printf 'Target witness and fresh business manifest captured; no rebase.\n'
