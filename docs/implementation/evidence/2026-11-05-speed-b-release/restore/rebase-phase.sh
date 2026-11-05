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
test "$RESTORE_TARGET_CONTAINER_ID" = ac87003ee607a16065ca91192394987cf2bbd04d41826e68cde40d85d053928f
test "$RESTORE_TARGET_SYSTEM_ID" = 7704502933634711586
test "$(docker inspect --type=container "$RESTORE_TARGET_CONTAINER_ID" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")"
test ! -e "$restore_tmp/log/rebase-run.log"
case "$(date -u +%H:%M)" in 03:1[5-9]|03:2[0-9]) echo 'too close to the old cleanup schedule' >&2; exit 1 ;; esac
actual="$(shasum -a 256 < "$restore_runner")"
test "${actual%% *}" = d0767fa7da64d242e5a6c7e88f054d3b0ff6c32b08ea2a004fd5fcedc87a4e36
feed_sql="SET TIME ZONE 'UTC'; SELECT to_jsonb(t)::text FROM public.change_feed t ORDER BY id; SELECT to_jsonb(t)::text FROM public.change_feed_floor t ORDER BY id;"
run rebase-feed-before restore_psql target -At -c "$feed_sql"
run rebase-business-before restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/target-business-after-witness.log" "$restore_tmp/log/rebase-business-before.log"
run rebase-count-before restore_psql target -At -c "select count(*), max(id), count(*) filter (where tx_id='1001'::xid8), (select floor::text from public.change_feed_floor where id=1) from public.change_feed"
grep -qx '86|87|2|5250' "$restore_tmp/log/rebase-count-before.log"
export RESTORE_EXPECTED_OLD_FLOOR=5250 RESTORE_EXPECTED_WITNESS_XID=1001
if run rebase-rollback-control env RESTORE_APPROVED_PHASE=rollback-control bash "$restore_runner" rollback-control; then
  echo 'rollback control unexpectedly succeeded' >&2
  exit 1
else
  test "$?" -eq 3
fi
grep -q 'target identity verified' "$restore_tmp/log/rebase-rollback-control.log"
grep -q 'target Unix socket verified' "$restore_tmp/log/rebase-rollback-control.log"
grep -qx 'TRUNCATE TABLE' "$restore_tmp/log/rebase-rollback-control.log"
grep -q 'intentional rollback control after feed truncate and before floor update' "$restore_tmp/log/rebase-rollback-control.log"
run rebase-feed-after-rollback restore_psql target -At -c "$feed_sql"
cmp "$restore_tmp/log/rebase-feed-before.log" "$restore_tmp/log/rebase-feed-after-rollback.log"
run rebase-business-after-rollback restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/rebase-business-before.log" "$restore_tmp/log/rebase-business-after-rollback.log"
run rebase-run env RESTORE_APPROVED_PHASE=rebase bash "$restore_runner" rebase
run rebase-business-after restore_bun target scripts/restore-rehearsal-business.ts
cmp "$restore_tmp/log/target-business-after-witness.log" "$restore_tmp/log/rebase-business-after.log"
run rebase-feed-after restore_psql target -At -c "$feed_sql"
run rebase-state-after restore_psql target -At -c "select (select count(*) from public.change_feed),count(*),min(floor::text),pg_snapshot_xmin(pg_current_snapshot())::text,(select last_value from public.change_feed_id_seq) from public.change_feed_floor"
python3 - "$restore_tmp/log/rebase-run.log" "$restore_tmp/log/rebase-state-after.log" <<'PY'
from pathlib import Path
import re,sys
reset,floor=map(int,re.search(r'target restore reset xid (\d+), floor (\d+)',Path(sys.argv[1]).read_text()).groups())
n,singleton,saved,xmin,seq=map(int,Path(sys.argv[2]).read_text().strip().split('|'))
assert n==0 and singleton==1 and saved==floor==reset+1 and floor<=xmin<5250 and seq==87
print(f'Rollback preserved all bytes. Committed rebase XID {reset}, floor {floor}, xmin {xmin}, sequence {seq}; business bytes unchanged.')
PY
