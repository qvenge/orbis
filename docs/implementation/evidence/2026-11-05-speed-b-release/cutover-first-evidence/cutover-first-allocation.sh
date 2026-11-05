#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
run=$1
[[ "$run" =~ ^/private/tmp/orbis-cutover-first\.[[:alnum:]]+$ ]]
old="$(cat "$run/old.path")"
[[ "$old" =~ ^/private/tmp/orbis-cutover-old\.[[:alnum:]]+$ ]]
BUN_BIN="$(command -v bun)"
image=sha256:6501843661b1f8ff97e85c02de33edc0ee2e2693888ad596ee86222f02dc8ecc
[[ "$(docker image inspect "$image" --format '{{.Id}}')" == "$image" ]]
resume_n=${CUTOVER_RESUME_OWNED_N:-0}
if [[ "$resume_n" = 1 ]]; then
  [[ "$(cat "$run/n.container-id")" = e2fd1fa7e35c9554ec799e40bdb03c70ce2ef5be2394d4b52b9c44b1c1a986d1 ]]
  [[ ! -e "$run/n.private.env" && ! -e "$run/p.container-id" ]]
  [[ "$(docker ps -a --filter 'name=orbis-speed-b-cutover-' --format '{{.Names}}')" = orbis-speed-b-cutover-n ]]
  if lsof -nP -iTCP:54345 -sTCP:LISTEN; then exit 1; fi
  printf 'resume same owned N after TCP readiness stop; p name and port still free\n'
else
  [[ -z "$(docker ps -a --filter 'name=orbis-speed-b-cutover-' --format '{{.Names}}')" ]]
  if lsof -nP -iTCP:54344 -iTCP:54345 -sTCP:LISTEN; then
    echo 'Expected unused cutover ports' >&2
    exit 1
  fi
  printf 'preflight image=%s names=free tcp54344/54345=free\n' "$image"
fi

for lane in n p; do
  port=54344
  [[ "$lane" = p ]] && port=54345
  name="orbis-speed-b-cutover-$lane"
  # All passwords below are generated for these two newly allocated containers.
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  admin_password="$(openssl rand -hex 24)"
  runtime_password="$(openssl rand -hex 24)"
  if [[ "$lane" = n && "$resume_n" = 1 ]]; then
    id="$(cat "$run/n.container-id")"
  else
    export POSTGRES_PASSWORD
    id="$(docker run -d --pull=never --name "$name" --label "orbis.cutover.lane=$lane" \
      -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD -e POSTGRES_DB=postgres "$image" \
      -c 'listen_addresses=*' -c shared_preload_libraries=pg_cron \
      -c cron.database_name=postgres -c cron.use_background_workers=on -c cron.timezone=UTC)"
  fi
  unset POSTGRES_PASSWORD
  [[ "$id" =~ ^[a-f0-9]{64}$ ]]
  printf '%s\n' "$id" > "$run/$lane.container-id"
  observed="$(docker inspect --type=container --format '{{.Id}} {{.Image}} {{index .Config.Labels "orbis.cutover.lane"}}' "$id")"
  [[ "$observed" = "$id $image $lane" ]]
  [[ "$(docker port "$id" 5432/tcp)" = "127.0.0.1:$port" ]]
  printf 'allocated name=%s %s port=%s\n' "$name" "$observed" "$port"
  ready=0
  for _ in $(seq 1 90); do
    if pg_isready -q -h 127.0.0.1 -p "$port" -U supabase_admin -d postgres &&
      docker exec --user 0 "$id" psql -X -qAt -w -h /var/run/postgresql -U supabase_admin -d postgres \
      -c 'select current_user' > "$run/$lane.socket-ready.log" 2>&1 &&
      [[ "$(cat "$run/$lane.socket-ready.log")" = supabase_admin ]]; then
      ready=1; break
    fi
    sleep 1
  done
  [[ "$ready" = 1 ]] || { echo "No owned admin socket readiness for $name" >&2; exit 1; }
  # Pass the temporary credential on stdin. Do not print the SQL or change any
  # role flag, including the image-native flags on postgres.
  printf "ALTER ROLE supabase_admin PASSWORD '%s';\n" "$admin_password" | \
    docker exec -i --user 0 "$id" psql -X -q -w -h /var/run/postgresql -U supabase_admin \
      -d postgres -v ON_ERROR_STOP=1
  identity="$(PGPASSWORD="$admin_password" psql -X -qAt -w -h 127.0.0.1 -p "$port" \
    -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -F '|' -c \
    "select current_database(), current_user, session_user, inet_server_port(), system_identifier::text, (select rolsuper from pg_roles where rolname='supabase_admin'), (select rolsuper from pg_roles where rolname='postgres') from pg_control_system()")"
  [[ "$identity" =~ ^postgres\|supabase_admin\|supabase_admin\|5432\|([0-9]+)\|t\|f$ ]]
  system_id="${BASH_REMATCH[1]}"
  printf '%s\n' "$identity" > "$run/$lane.admin-identity.log"
  printf '%s\n' "$system_id" > "$run/$lane.system-id"
  printf 'verified-admin-tcp %s port=%s system_id=%s postgres_superuser=false\n' "$name" "$port" "$system_id"
  admin_dsn="postgresql://supabase_admin:$admin_password@127.0.0.1:$port/postgres"
  runtime_dsn="postgresql://orbis_app:$runtime_password@127.0.0.1:$port/postgres"
  printf 'export DATABASE_URL_ADMIN=%s\nexport DATABASE_URL=%s\n' "$admin_dsn" "$runtime_dsn" > "$run/$lane.private.env"
  # b5 setup and stock migration/registry commands on this lane only.
  (
    cd "$old"
    env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" ORBIS_APP_PASSWORD="$runtime_password" \
      "$BUN_BIN" scripts/setup-db.ts
    env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" "$BUN_BIN" run --cwd apps/server db:migrate
    env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" "$BUN_BIN" scripts/seed-registries.ts
  ) > "$run/$lane.b5-setup.log" 2>&1
  head="$(PGPASSWORD="$admin_password" psql -X -qAt -w -h 127.0.0.1 -p "$port" -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 -c 'select max(created_at)::text from drizzle.__drizzle_migrations')"
  [[ "$head" = 1790767973713 ]]
  runtime_identity="$(PGPASSWORD="$runtime_password" psql -X -qAt -w -h 127.0.0.1 -p "$port" -U orbis_app -d postgres \
    -v ON_ERROR_STOP=1 -F '|' -c "select current_database(),current_user,session_user,inet_server_port(),rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,pg_has_role(current_user,'authenticated','MEMBER'),exists(select 1 from pg_roles p where p.rolname in ('postgres','supabase_admin','service_role','orbis_change_feed_owner') and pg_has_role(r.oid,p.oid,'MEMBER')) from pg_roles r where rolname=current_user")"
  [[ "$runtime_identity" = 'postgres|orbis_app|orbis_app|5432|f|f|f|f|f|f|t|f' ]]
  printf '%s\n' "$runtime_identity" > "$run/$lane.runtime-identity.log"
  printf 'verified-runtime-tcp %s exact migration=0026 body_revision\n' "$name"
done
[[ "$(cat "$run/n.system-id")" != "$(cat "$run/p.system-id")" ]]
python3 - "$run" "$image" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1])
m={k: hashlib.sha256((p/'manifests'/(k+'.json')).read_bytes()).hexdigest() for k in ('old','current')}
for lane,port in [('n',54344),('p',54345)]:
 f=p/(lane+'.handoff.json')
 f.write_text(json.dumps({
   'lane':lane.upper(),
   'container':{'id':(p/(lane+'.container-id')).read_text().strip(),'image':sys.argv[2]},
   'db':{'port':port,'name':'postgres','admin':'supabase_admin','runtime':'orbis_app',
         'systemId':(p/(lane+'.system-id')).read_text().strip()},
   'manifests':m,
 }, indent=2)+'\n')
 print(f"{lane} handoff SHA-256 {hashlib.sha256(f.read_bytes()).hexdigest()}")
PY
