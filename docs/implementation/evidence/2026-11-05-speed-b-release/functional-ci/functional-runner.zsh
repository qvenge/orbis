#!/bin/zsh
set -u
root="${0:A:h}"
r="$root/reports"
sha=356a610f5ae92efe429bdb6891c5bde6f9c09e9f
cd "$root/candidate" || exit 2
[[ "$(git rev-parse HEAD)" == "$sha" && -z "$(git status --porcelain)" && -z "$(git remote)" ]] || exit 2
unset NODE_ENV CI PORT ORBIS_CHANGE_STREAM ORBIS_ROUTINE_SCHEDULER SUPABASE_URL SUPABASE_JWKS_URL VITE_API_URL VITE_RESPONSE_PERSISTENCE WEB_DIST_DIR
export VITE_SUPABASE_URL=http://localhost:54321
date -u +%FT%TZ > "$r/functional.started"
stage() {
  local label="$1"
  shift
  date -u +%FT%TZ > "$r/$label.started"
  printf '%s\n' "$*" > "$r/$label.command"
  "$@" > "$r/$label.log" 2>&1
  local result=$?
  echo "$result" > "$r/$label.exit"
  date -u +%FT%TZ > "$r/$label.ended"
  echo "$label exit=$result"
  return "$result"
}
stage lint bun run lint
lint=$?
stage db-prepare bun run db:prepare
db=$?
tests=2
if (( db == 0 )); then
  stage workspace-test bun run test
  tests=$?
  if (( tests != 0 )); then
    stage scripts-independent bun test scripts/
  fi
else
  echo 'workspace-test skipped: local DB prepare failed'
fi
stage legacy-form bun scripts/check-legacy-form.ts --gate
legacy=$?
stage build env VITE_BUILD_ID="$sha" bun run --filter @orbis/web build
build=$?
git status --porcelain > "$r/functional-after.status"
date -u +%FT%TZ > "$r/functional.ended"
(( lint == 0 && db == 0 && tests == 0 && legacy == 0 && build == 0 ))
e=$?
echo "$e" > "$r/functional.exit"
exit "$e"
