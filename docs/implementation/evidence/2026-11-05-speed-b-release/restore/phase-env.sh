# Only source this private rehearsal file with tracing disabled.
set +x
restore_tmp=/private/tmp/orbis-b-restore.oE4t8P
restore_runner=/Users/birzhan/.codex/worktrees/853d/orbis/.superpowers/sdd/2026-11-05-speed-b-release/logical-restore-container-runner/run-container.sh
export RESTORE_TMP="$restore_tmp"
export RESTORE_SOURCE_CONTAINER_ID="$(cat "$restore_tmp/log/source-container-id.txt")"
export RESTORE_TARGET_CONTAINER_ID="$(cat "$restore_tmp/log/target-container-id.txt")"
export RESTORE_SOURCE_SYSTEM_ID="$(cat "$restore_tmp/log/source-system-id.txt")"
export RESTORE_TARGET_SYSTEM_ID="$(cat "$restore_tmp/log/target-system-id.txt")"
export RESTORE_SOURCE_PASSWORD="$(cat "$restore_tmp/secret/source-admin")"
export RESTORE_TARGET_PASSWORD="$(cat "$restore_tmp/secret/target-admin")"
restore_psql() {
  local side=$1 id password
  shift
  case "$side" in
    source) id=$RESTORE_SOURCE_CONTAINER_ID; password=$RESTORE_SOURCE_PASSWORD ;;
    target) id=$RESTORE_TARGET_CONTAINER_ID; password=$RESTORE_TARGET_PASSWORD ;;
    *) return 2 ;;
  esac
  test "$(docker inspect --type=container "$id" --format '{{.Image}}')" = "$(cat "$restore_tmp/log/image-id.txt")" || return 2
  printf '%s\n' "$password" |
    docker exec -i --user 0 "$id" env -i PATH=/usr/lib/postgresql/17/bin:/usr/bin:/bin LC_ALL=C /bin/bash -c '
      IFS= read -r PGPASSWORD
      export PGPASSWORD PGCONNECT_TIMEOUT=5
      exec psql -X -w -h /var/run/postgresql -p 5432 -d postgres -U supabase_admin -v ON_ERROR_STOP=1 "$@"
    ' restore-admin "$@"
}
restore_bun() {
  local side=$1 port admin_password app_password
  shift
  case "$side" in source) port=54342 ;; target) port=54343 ;; *) return 2 ;; esac
  admin_password="$(cat "$restore_tmp/secret/$side-admin")"
  app_password="$(cat "$restore_tmp/secret/$side-app")"
  (cd "$restore_tmp/src" &&
    env -i PATH="$PATH" LC_ALL=C TZ=UTC ORBIS_ROUTINE_SCHEDULER=0 \
      DATABASE_URL_ADMIN="postgresql://supabase_admin:$admin_password@127.0.0.1:$port/postgres" \
      DATABASE_URL="postgresql://orbis_app:$app_password@127.0.0.1:$port/postgres" \
      ORBIS_APP_PASSWORD="$app_password" bun "$@")
}
