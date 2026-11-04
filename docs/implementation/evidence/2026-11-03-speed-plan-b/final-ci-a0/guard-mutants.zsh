#!/bin/zsh
set -eu
c="$1"
s="$2"
writer=apps/server/src/routers/b13-writer-mutant.ts
cache=apps/web/src/b13-cache-family-mutant.ts
link=apps/web/src/b13-record-link-mutant.tsx
cd "$c"
[[ -z "$(git status --porcelain)" ]]
all=(scripts/write-paths.test.ts scripts/cache-dependencies.test.ts scripts/record-links.test.ts)
bun test "${all[@]}" > "$s/b13-guards-clean.log" 2>&1
cleanup() {
  rm -f "$writer" "$cache" "$link"
  git rm -q --cached --ignore-unmatch "$writer" "$cache" "$link" || true
}
trap cleanup EXIT
cat > "$writer" <<'CODE'
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export const forbiddenWriter = (db: Db) => db.execute(sql`update entities set archived = true`);
CODE
cat > "$cache" <<'CODE'
import { QueryClient } from '@tanstack/react-query';

export function undeclaredFamily(client: QueryClient) {
  const { setQueryData: put } = client;
  put(['b13-unregistered-family'], 'proof');
}
CODE
cat > "$link" <<'CODE'
import { useNav } from './state/navigation';

export function BypassRecordLink() {
  const { openRecord: jump } = useNav.getState();
  return <button type="button" onClick={() => jump('018cd857-511b-7f25-870e-377777ceca00')}>Открыть</button>;
}
CODE
git add -- "$writer" "$cache" "$link"
bun run typecheck > "$s/b13-guards-mutant-typecheck.log" 2>&1
for name in write-paths cache-dependencies record-links; do
  set +e
  bun test "scripts/$name.test.ts" > "$s/b13-guards-$name-red.log" 2>&1
  result=$?
  set -e
  [[ "$result" == 1 ]]
done
rg -F 'b13-writer-mutant.ts' "$s/b13-guards-write-paths-red.log"
rg -F 'b13-unregistered-family' "$s/b13-guards-cache-dependencies-red.log"
rg -F 'b13-record-link-mutant.tsx' "$s/b13-guards-record-links-red.log"
cleanup
trap - EXIT
[[ -z "$(git status --porcelain)" ]]
bun test "${all[@]}" > "$s/b13-guards-restored.log" 2>&1
