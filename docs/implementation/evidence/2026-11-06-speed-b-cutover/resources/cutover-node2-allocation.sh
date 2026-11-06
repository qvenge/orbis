#!/usr/bin/env bash
# Fresh disposable P-node allocation only; no old-container reuse or reset.
set +x
set -euo pipefail
umask 077
run=$1
[[ "$run" =~ ^/private/tmp/orbis-cutover-node2-allocation\.[[:alnum:]]+$ && -d "$run" && ! -L "$run" ]]
[[ ! -e "$run/container-id" && ! -e "$run/private.env" && ! -e "$run/handoff.json" ]]
name=orbis-speed-b-cutover-p-node2
port=54347
image=sha256:6501843661b1f8ff97e85c02de33edc0ee2e2693888ad596ee86222f02dc8ecc
docker_cmd=(docker --context desktop-linux)
[[ "$("${docker_cmd[@]}" context inspect desktop-linux --format '{{.Endpoints.docker.Host}}')" == unix://* ]]
[[ "$("${docker_cmd[@]}" image inspect "$image" --format '{{.Id}}')" == "$image" ]]
if "${docker_cmd[@]}" inspect --type=container "$name" >/dev/null 2>&1; then
  echo 'Fresh allocation name already exists; refusing reuse' >&2; exit 1
fi
if lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
  echo 'Fresh allocation port is occupied' >&2; exit 1
fi
old="$(python3 - "$run" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1])
expected={'old':'7b5182a818bceb6839659923e5937af0c085ffcb6aeb93747deae7ae92a003eb',
          'current':'2ec1888a7d71ebd2e93bca482da11620a087a6f479403cc86968d4e71b048abe'}
old=None
for label,digest in expected.items():
 raw=(p/'manifests'/(label+'.json')).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==digest
 m=json.loads(raw); tree=Path(m['tree']).resolve()
 assert str(tree).startswith('/private/tmp/orbis-')
 for name,wanted in m['source'].items():
  f=tree/name; assert hashlib.sha256(f.read_bytes()).hexdigest()==wanted,name
 for directory in [tree,tree/'apps/server',tree/'apps/web']:
  assert all(f.name=='.env.example' for f in directory.glob('.env*'))
 if label=='old':
  assert m['commit']=='b5abb7fe70068c06b7075ed54a2a0f3c3d729d7b' and len(m['source'])==1425
  old=tree
 else:
  assert m['commit']=='c7ccb9dd1f4cc1f68d43255ecf313768ebc2b315' and len(m['source'])==2132
assert old
print(old)
PY
)"
bun_bin="$(command -v bun)"
[[ "$("$bun_bin" --version)" = 1.2.7 ]]
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
admin_password="$(openssl rand -hex 24)"
runtime_password="$(openssl rand -hex 24)"
export POSTGRES_PASSWORD
id="$("${docker_cmd[@]}" run -d --pull=never --restart=no --cpus=1 --memory=1g \
  --name "$name" --label orbis.cutover.lane=p-node2 \
  -p "127.0.0.1:$port:5432" -e POSTGRES_PASSWORD -e POSTGRES_DB=postgres "$image" \
  -c 'listen_addresses=*' -c shared_preload_libraries=pg_cron \
  -c cron.database_name=postgres -c cron.use_background_workers=on -c cron.timezone=UTC)"
unset POSTGRES_PASSWORD
[[ "$id" =~ ^[a-f0-9]{64}$ ]]
printf '%s\n' "$id" > "$run/container-id"
[[ "$("${docker_cmd[@]}" inspect --format '{{.Id}} {{.Image}} {{index .Config.Labels "orbis.cutover.lane"}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' "$id")" = "$id $image p-node2 1000000000 1073741824" ]]
[[ "$("${docker_cmd[@]}" port "$id" 5432/tcp)" = "127.0.0.1:$port" ]]
ready=0
for _ in $(seq 1 60); do
  if pg_isready -q -h 127.0.0.1 -p "$port" -U supabase_admin -d postgres &&
    "${docker_cmd[@]}" exec --user 0 "$id" psql -X -qAt -w -h /var/run/postgresql \
      -U supabase_admin -d postgres -c 'select current_user' > "$run/socket-ready.log" 2>&1 &&
    [[ "$(cat "$run/socket-ready.log")" = supabase_admin ]]; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || { echo 'Fresh owned database was not ready' >&2; exit 1; }
printf "ALTER ROLE supabase_admin PASSWORD '%s';\n" "$admin_password" | \
  "${docker_cmd[@]}" exec -i --user 0 "$id" psql -X -q -w -h /var/run/postgresql \
    -U supabase_admin -d postgres -v ON_ERROR_STOP=1
identity="$(PGCONNECT_TIMEOUT=5 PGPASSWORD="$admin_password" psql -X -qAt -w \
  -h 127.0.0.1 -p "$port" -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -F '|' -c \
  "select current_database(),current_user,session_user,inet_server_port(),system_identifier::text,(select rolsuper from pg_roles where rolname='supabase_admin'),(select rolsuper from pg_roles where rolname='postgres') from pg_control_system()")"
[[ "$identity" =~ ^postgres\|supabase_admin\|supabase_admin\|5432\|([0-9]+)\|t\|f$ ]]
system_id="${BASH_REMATCH[1]}"
printf '%s\n' "$identity" > "$run/admin-identity.log"
printf '%s\n' "$system_id" > "$run/system-id"
admin_dsn="postgresql://supabase_admin:$admin_password@127.0.0.1:$port/postgres"
runtime_dsn="postgresql://orbis_app:$runtime_password@127.0.0.1:$port/postgres"
printf 'export DATABASE_URL_ADMIN=%s\nexport DATABASE_URL=%s\n' "$admin_dsn" "$runtime_dsn" > "$run/private.env"
(
  cd "$old"
  env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" ORBIS_APP_PASSWORD="$runtime_password" \
    "$bun_bin" scripts/setup-db.ts
  env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" "$bun_bin" run --cwd apps/server db:migrate
  env -i PATH="$PATH" DATABASE_URL_ADMIN="$admin_dsn" "$bun_bin" scripts/seed-registries.ts
) > "$run/b5-setup.log" 2>&1
head="$(PGCONNECT_TIMEOUT=5 PGPASSWORD="$admin_password" psql -X -qAt -w -h 127.0.0.1 -p "$port" \
  -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c 'select max(created_at)::text from drizzle.__drizzle_migrations')"
[[ "$head" = 1790767973713 ]]
runtime_identity="$(PGCONNECT_TIMEOUT=5 PGPASSWORD="$runtime_password" psql -X -qAt -w \
  -h 127.0.0.1 -p "$port" -U orbis_app -d postgres -v ON_ERROR_STOP=1 -F '|' -c \
  "select current_database(),current_user,session_user,inet_server_port(),rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,pg_has_role(current_user,'authenticated','MEMBER'),exists(select 1 from pg_roles p where p.rolname in ('postgres','supabase_admin','service_role','orbis_change_feed_owner') and pg_has_role(r.oid,p.oid,'MEMBER')) from pg_roles r where rolname=current_user")"
[[ "$runtime_identity" = 'postgres|orbis_app|orbis_app|5432|f|f|f|f|f|f|t|f' ]]
printf '%s\n' "$runtime_identity" > "$run/runtime-identity.log"
python3 - "$run" "$image" <<'PY'
from pathlib import Path
import hashlib,json,sys
p=Path(sys.argv[1])
h={'lane':'P','container':{'id':(p/'container-id').read_text().strip(),'image':sys.argv[2]},
   'db':{'port':54347,'name':'postgres','admin':'supabase_admin','runtime':'orbis_app',
         'systemId':(p/'system-id').read_text().strip()},
   'manifests':{name:hashlib.sha256((p/'manifests'/(name+'.json')).read_bytes()).hexdigest()
                for name in ['old','current']}}
f=p/'handoff.json'; f.write_text(json.dumps(h,indent=2)+'\n')
print(json.dumps({'container':h['container']['id'],'port':54347,'migration':'0026',
                 'handoffSha256':hashlib.sha256(f.read_bytes()).hexdigest(),'resourceLimit':'1 CPU / 1 GiB'}))
PY
