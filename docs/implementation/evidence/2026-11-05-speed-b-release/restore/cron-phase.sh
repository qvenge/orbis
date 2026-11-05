#!/bin/bash
set -euo pipefail
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
run() {
  local label=$1 code=0
  shift
  "$@" > "$restore_tmp/log/$label.log" 2>&1 || code=$?
  printf '%s %s\n' "$label" "$code" >> "$restore_tmp/log/phase-three-exits.txt"
  return "$code"
}
test ! -e "$restore_tmp/log/target-cron-actual.log"
test "$(docker inspect --type=container "$RESTORE_TARGET_CONTAINER_ID" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")"
case "$(date -u +%H:%M)" in 03:1[5-9]|03:2[0-9]) echo 'too close to old cleanup schedules' >&2; exit 1 ;; esac
run target-cron-business-before restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/post-rebase-delivery-business.log" "$restore_tmp/log/target-cron-business-before.log"
run target-cron-actual restore_bun target scripts/restore-rehearsal-cron.ts
run target-cron-business-after restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/post-rebase-delivery-business.log" "$restore_tmp/log/target-cron-business-after.log"
run target-end-clients restore_psql target -At -c "select count(*) from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid()"
grep -qx 0 "$restore_tmp/log/target-end-clients.log"
printf '%s\n' 'Actual target scheduler verified and restored; no live target client backends.'
