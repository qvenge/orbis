#!/bin/bash
set -euo pipefail
umask 077
source /private/tmp/orbis-b-restore.oE4t8P/phase-env.sh
side=$1
mode=$2
case "$side:$mode" in target:managed) input=target-managed-dependencies.sql ;; source:catalog|target:catalog) input=catalog-inventory.sql ;; *) exit 2 ;; esac
id="$RESTORE_TARGET_CONTAINER_ID"; pass="$RESTORE_TARGET_PASSWORD"
if [[ "$side" = source ]]; then id="$RESTORE_SOURCE_CONTAINER_ID"; pass="$RESTORE_SOURCE_PASSWORD"; fi
test "$(docker inspect --type=container "$id" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")"
{
  printf '%s\n' "$pass"
  cat "$restore_tmp/$input"
} | docker exec -i --user 0 "$id" env -i PATH=/usr/lib/postgresql/17/bin:/usr/bin:/bin LC_ALL=C /bin/bash -c '
  IFS= read -r PGPASSWORD
  export PGPASSWORD PGCONNECT_TIMEOUT=5
  exec psql -X -w -h /var/run/postgresql -p 5432 -d postgres -U supabase_admin -v ON_ERROR_STOP=1 -At
' > "$restore_tmp/log/$side-$mode-repaired.log" 2>&1
