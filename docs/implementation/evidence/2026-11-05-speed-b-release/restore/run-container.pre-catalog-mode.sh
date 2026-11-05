#!/usr/bin/env bash
# Scratch only. The coordinator must hand off the two clusters and the exact phase.
set +x
set -euo pipefail
umask 077
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# = 1 ]] || die 'usage: run-container.sh source-identity|identity|source-dump|render-acl|stock-import|acl-replay|rollback-control|rebase'
mode=$1
case "$mode" in
  source-identity|source-dump|render-acl) side=source ;;
  identity|stock-import|acl-replay|rollback-control|rebase) side=target ;;
  *) die 'unknown phase' ;;
esac
[[ "${RESTORE_APPROVED_PHASE:-}" = "$mode" ]] || die 'missing exact coordinator phase handoff'
dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd -P -- "$dir/../../../.." && pwd)"
: "${RESTORE_SOURCE_CONTAINER_ID:?pin source container id at allocation}"
: "${RESTORE_TARGET_CONTAINER_ID:?pin target container id at allocation}"
: "${RESTORE_SOURCE_SYSTEM_ID:?pin source system id at allocation}"
: "${RESTORE_TARGET_SYSTEM_ID:?pin target system id at allocation}"
[[ "$RESTORE_SOURCE_SYSTEM_ID" =~ ^[0-9]{1,20}$ &&
   "$RESTORE_TARGET_SYSTEM_ID" =~ ^[0-9]{1,20}$ &&
   "$RESTORE_SOURCE_SYSTEM_ID" != "$RESTORE_TARGET_SYSTEM_ID" ]] || die 'invalid cluster ids'

assert_container() {
  local name=$1 expected_side=$2 expected_id=$3 port=$4 observed
  [[ "$expected_id" =~ ^[0-9a-f]{64}$ ]] || die 'expected full container id'
  observed="$(docker inspect --type=container --format '{{.Id}} {{.State.Running}} {{index .Config.Labels "orbis.speed-b.restore"}} {{.Config.Image}}' "$name")"
  [[ "$observed" = "$expected_id true $expected_side supabase/postgres:17.6.1.140" ]] ||
    die 'unexpected container identity, image, label or state'
  [[ "$(docker port "$expected_id" 5432/tcp)" = "127.0.0.1:$port" ]] ||
    die 'unexpected published port'
}
assert_container orbis-speed-b-restore-source source "$RESTORE_SOURCE_CONTAINER_ID" 54342
assert_container orbis-speed-b-restore-target target "$RESTORE_TARGET_CONTAINER_ID" 54343

if [[ "$side" = source ]]; then
  id=$RESTORE_SOURCE_CONTAINER_ID
  system_id=$RESTORE_SOURCE_SYSTEM_ID
  socket="${RESTORE_SOURCE_SOCKET_DIR:-/var/run/postgresql}"
  password="${RESTORE_SOURCE_PASSWORD:?local source password required}"
else
  id=$RESTORE_TARGET_CONTAINER_ID
  system_id=$RESTORE_TARGET_SYSTEM_ID
  socket="${RESTORE_TARGET_SOCKET_DIR:-/var/run/postgresql}"
  password="${RESTORE_TARGET_PASSWORD:?local target password required}"
fi
case "$socket" in /var/run/postgresql|/tmp) ;; *) die 'unexpected Unix socket directory' ;; esac
[[ "$password" != *$'\n'* && "$password" != *$'\r'* ]] || die 'expected a single-line local password'

case "$mode" in
  source-dump|render-acl|stock-import|acl-replay)
    : "${RESTORE_TMP:?private scratch directory required}"
    root="$(cd -P -- "$RESTORE_TMP" && pwd)"
    [[ "$root" =~ ^/private/tmp/orbis-b-restore\.[[:alnum:]]+$ &&
       "$(stat -f '%u %Lp' "$root")" = "$(id -u) 700" ]] ||
      die 'expected owned private scratch directory'
    ;;
esac
case "$mode" in
  source-dump)
    outputs=(orbis-backup-source.sql source-schema.dump source-schema.toc source-artifacts.sha256)
    ;;
  render-acl) outputs=(acl.sql acl-artifact.sha256) ;;
  *) outputs=() ;;
esac
# Bash 3.2 nounset treats an empty array as unset. Expand zero outputs safely.
for name in ${outputs[@]+"${outputs[@]}"}; do
  [[ ! -e "$root/$name" && ! -L "$root/$name" ]] || die 'output already exists'
done

path_in_container=/usr/lib/postgresql/17/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
box=(docker exec --user 0 "$id" env -i "PATH=$path_in_container" LC_ALL=C)
stage="$("${box[@]}" mktemp -d /tmp/orbis-b-restore-cli.XXXXXX)"
[[ "$stage" =~ ^/tmp/orbis-b-restore-cli\.[[:alnum:]]+$ ]] || die 'unexpected staged directory'
cleanup() {
  local status=$?
  "${box[@]}" rm -f -- "$stage"/{assert-source.sql,assert-target.sql,assert-target-socket.sql,stock-drop.sql,rebase-target.sql,backup.sh,orbis-backup-source.sql,source-schema.dump,source-schema.toc,source-artifacts.sha256,acl.toc,acl.sql,acl-artifact.sha256,acl-reviewed.sql} || :
  "${box[@]}" rmdir -- "$stage" || :
  return "$status"
}
trap cleanup EXIT
checks=()
stage_file() {
  local src=$1 name=$2 expected=$3 observed
  [[ "$expected" =~ ^[0-9a-f]{64}$ && -f "$src" && ! -L "$src" ]] ||
    die 'expected regular reviewed input with exact SHA-256'
  observed="$(shasum -a 256 < "$src")"
  [[ "${observed%% *}" = "$expected" ]] || die "input changed: $name"
  docker cp "$src" "$id:$stage/$name"
  checks+=("$name" "$expected")
}
if [[ "$side" = source ]]; then
  stage_file "$dir/assert-source.sql" assert-source.sql ce8518fce3f8aaca0ddd2a413b5506b01b0f3d01dbbc2b7c4553f9e70d3c3ea1
else
  stage_file "$dir/../logical-restore-runner/assert-target.sql" assert-target.sql 47293a3e0c4e2db98600989f94bcbe6c91378416b32d6c1351c747bea463cd63
  stage_file "$dir/assert-target-socket.sql" assert-target-socket.sql b5e2d131e5e5dd072db375bf5d4688addd331b38de813f3325b46dfa668c4eb6
fi
old_floor=0
witness=0
inject=off
case "$mode" in
  source-dump)
    stage_file "$repo/scripts/backup.sh" backup.sh eb708e09f1561175f5d59ac9ac7dd898dcb5b5f49faf49cadb0e35b1496c001a
    ;;
  render-acl)
    stage_file "$root/source-schema.dump" source-schema.dump "${RESTORE_SCHEMA_SHA256:?pin exact archive}"
    stage_file "$root/acl.toc" acl.toc "${RESTORE_ACL_TOC_SHA256:?pin reviewed ACL-only TOC}"
    ;;
  stock-import)
    stage_file "$dir/../logical-restore-runner/stock-drop.sql" stock-drop.sql 3d7e1fc1fddb2c8c332495e7f1a1c7f112acbc9b6060c169a4b63e7e24c210ce
    stage_file "$root/orbis-backup-source.sql" orbis-backup-source.sql "${RESTORE_DUMP_SHA256:?pin exact stock dump}"
    ;;
  acl-replay)
    stage_file "$root/acl-reviewed.sql" acl-reviewed.sql "${RESTORE_REVIEWED_ACL_SHA256:?pin reviewed ACL script}"
    ;;
  rollback-control|rebase)
    old_floor="${RESTORE_EXPECTED_OLD_FLOOR:?pin old floor from witness}"
    witness="${RESTORE_EXPECTED_WITNESS_XID:?pin committed target witness}"
    [[ "$old_floor" =~ ^[0-9]{1,20}$ && "$witness" =~ ^[0-9]{1,20}$ ]] || die 'invalid witness'
    stage_file "$dir/../logical-restore-runner/rebase-target.sql" rebase-target.sql 679c4d9ab927cfb39fe5356da96244f9bd17dad0b809d3a5ecb1cb70289a93dc
    [[ "$mode" != rollback-control ]] || inject=on
    ;;
esac

# Only the local password is streamed. psql reads its complete hash-verified files.
printf '%s\n' "$password" | docker exec -i --user 0 "$id" env -i "PATH=$path_in_container" LC_ALL=C \
  /bin/bash -c '
    set -euo pipefail
    umask 077
    mode=$1; stage=$2; socket=$3; system_id=$4; old_floor=$5; witness=$6; inject=$7
    shift 7
    cd "$stage"
    while (( $# )); do
      actual="$(sha256sum "$1")"
      [[ "${actual%% *}" = "$2" ]] || { printf "%s\n" "staged input digest mismatch: $1" >&2; exit 1; }
      shift 2
    done
    version_pattern="PostgreSQL\) 17\.([0-9]+)"
    for cli in psql pg_dump pg_restore; do
      version="$("$cli" --version)"
      [[ "$version" =~ $version_pattern ]] && (( 10#${BASH_REMATCH[1]} >= 6 )) ||
        { printf "%s\n" "container PG17.6+ CLI required" >&2; exit 1; }
    done
    IFS= read -r PGPASSWORD
    export PGPASSWORD PGCONNECT_TIMEOUT=5
    conn=(-X --no-password --host="$socket" --port=5432 --username=supabase_admin
          --dbname=postgres --set=ON_ERROR_STOP=1 --single-transaction)
    case "$mode" in
      source-identity|source-dump|render-acl)
        psql "${conn[@]}" --set="restore_source_system_id=$system_id" --file=assert-source.sql
        ;;
    esac
    case "$mode" in
      source-identity) ;;
      source-dump)
        case "$socket" in
          /var/run/postgresql) encoded=%2Fvar%2Frun%2Fpostgresql ;;
          /tmp) encoded=%2Ftmp ;;
          *) exit 1 ;;
        esac
        dsn="postgresql:///postgres?user=supabase_admin&host=$encoded&port=5432"
        ADMIN_DSN="$dsn" BACKUP_DIR="$stage" BACKUP_TS=source bash ./backup.sh
        pg_dump --dbname="$dsn" --schema-only --format=custom \
          --schema=public --schema=drizzle --file=source-schema.dump
        pg_restore --list source-schema.dump > source-schema.toc
        sha256sum orbis-backup-source.sql source-schema.dump source-schema.toc > source-artifacts.sha256
        ;;
      render-acl)
        awk "/^(;|[[:space:]]*$)/ {next} /^[0-9]+; [0-9]+ [0-9]+ (ACL |DEFAULT ACL )/ {n++; next} {bad=1} END{exit (bad || !n)}" acl.toc
        pg_restore --use-list=acl.toc --file=acl.sql source-schema.dump
        sha256sum acl.sql > acl-artifact.sha256
        ;;
      identity|stock-import|acl-replay|rollback-control|rebase)
        conn+=(--set="restore_target_system_id=$system_id" --file=assert-target.sql --file=assert-target-socket.sql)
        if [[ "$mode" = stock-import ]]; then
          conn+=(--file=stock-drop.sql --file=orbis-backup-source.sql)
        elif [[ "$mode" = acl-replay ]]; then
          conn+=(--file=acl-reviewed.sql)
        elif [[ "$mode" = rollback-control || "$mode" = rebase ]]; then
          conn+=(--set="restore_expected_old_floor=$old_floor"
                 --set="restore_expected_witness_xid=$witness"
                 --set="restore_inject_failure=$inject" --file=rebase-target.sql)
        fi
        exec psql "${conn[@]}"
        ;;
    esac
  ' restore-cli "$mode" "$stage" "$socket" "$system_id" "$old_floor" "$witness" "$inject" "${checks[@]}"

for name in ${outputs[@]+"${outputs[@]}"}; do
  docker cp "$id:$stage/$name" "$root/$name"
done
case "$mode" in
  source-dump)
    (cd "$root" && shasum -a 256 orbis-backup-source.sql source-schema.dump source-schema.toc | cmp -s - source-artifacts.sha256) ||
      die 'copied source artifacts do not match container hashes'
    ;;
  render-acl)
    (cd "$root" && shasum -a 256 acl.sql | cmp -s - acl-artifact.sha256) ||
      die 'copied ACL SQL does not match container hash'
    ;;
esac
