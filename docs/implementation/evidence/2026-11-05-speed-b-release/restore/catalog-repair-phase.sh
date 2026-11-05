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
test "$RESTORE_TARGET_CONTAINER_ID" = ac87003ee607a16065ca91192394987cf2bbd04d41826e68cde40d85d053928f
test "$RESTORE_TARGET_SYSTEM_ID" = 7704502933634711586
for id in "$RESTORE_SOURCE_CONTAINER_ID" "$RESTORE_TARGET_CONTAINER_ID"; do
  test "$(docker inspect --type=container "$id" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")"
done
case "$(date -u +%H:%M)" in 03:1[5-9]|03:2[0-9]) echo 'too close to the old cleanup schedule' >&2; exit 1 ;; esac
actual="$(shasum -a 256 < "$restore_runner")"
test "${actual%% *}" = d0767fa7da64d242e5a6c7e88f054d3b0ff6c32b08ea2a004fd5fcedc87a4e36
run target-repair-business-before restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-repair-business-before.log"
run target-repair-catalog-sql env RESTORE_APPROVED_PHASE=catalog-repair bash "$restore_runner" catalog-repair
run target-repair-acl-sql env RESTORE_APPROVED_PHASE=acl-replay RESTORE_REVIEWED_ACL_SHA256=9e63ef542939dd175f252bf6f97ddbee13eeb5fa0c33f51caf82d66befc7b512 bash "$restore_runner" acl-replay
run target-repair-catalog-capture bash "$restore_tmp/capture-catalog-repaired.sh" target catalog
run target-repair-business-after restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/source-business-before.log" "$restore_tmp/log/target-repair-business-after.log"
printf 'Reviewed phases committed, business manifest preserved. Compare catalog before writer.\n'
