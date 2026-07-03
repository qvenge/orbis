# Фаза 0 Orbis: SPIKE-01 (RLS через Drizzle/Bun) + SPIKE-05 (деплой-связность)

## Context

PRD v3.1 принят; роадмап (00-product §9) требует до начала кода Вехи 0 закрыть два блокирующих спайка. **SPIKE-01** доказывает несущую ставку безопасности: транзакционно-локальная identity через RLS работает на продакшен-стеке (Bun + drizzle-orm + postgres-js пул), pooled-соединения не «текут», service-role не fallback. **SPIKE-05** выбирает хостинг по матрице DEPLOY-04 и доводит hello-world Bun API до продакшена (агентная петля живёт только на задеплоенном приложении). Ответы владельца: регион — **Франкфурт (eu-central-1), выбран без замера**; **только free tier** на старте; Supabase-аккаунт есть; провайдера выбирает спайк.

Порядок: SPIKE-01 локально → SPIKE-05 (регион, hosted-проект, провайдер, деплой) → перепрогон RLS-матрицы против hosted через оба пулера. Таймбокс ~1 день на спайк; провал SPIKE-01 → fallback (политики на `current_setting('app.user_id')`), провал fallback → стоп, эскалация.

**Ветка:** `spike/phase-0`. **Первым шагом** сохранить этот план в репо как `docs/superpowers/plans/2026-07-03-phase0-spikes.md` (конвенция superpowers) и закоммитить.

## Структура кода (standalone bun-пакеты, НЕ workspace — монорепо ещё нет)

```
spikes/spike-01-rls/
├─ package.json (drizzle-orm, postgres, jose; dev: @supabase/supabase-js, @types/bun)
├─ tsconfig.json (strict, noUncheckedIndexedAccess, verbatimModuleSyntax — как Веха 0)
├─ .env.example, README.md, supabase/ (bunx supabase init — локальный стек в скоупе спайка)
├─ sql/01-role.sql, 02-table.sql, 02b-table-fallback.sql
├─ scripts/setup-db.ts (идемпотентно, через ADMIN DSN, работает с local и hosted)
├─ src/db.ts (фабрика пула makeDb({max, prepare})), schema.ts, with-identity.ts
└─ test/setup.ts, rls.test.ts, jwt.test.ts

spikes/spike-05-deploy/
├─ package.json (hono, postgres), tsconfig.json, Dockerfile (oven/bun:1.2), .env.example, README.md
├─ scripts/backup.sh (pg_dump через session-пулер)
└─ src/index.ts (Hono: /health, /db-check, /spike-check с x-spike-token), db.ts
```

`.gitignore`: `spikes/**/.env`, `spikes/**/node_modules`, `spikes/spike-01-rls/supabase/.temp`. Секреты не коммитятся.

## SPIKE-01 — ключевые решения

**SQL** (не полная схема — только тестовая таблица; полная схема и косвенные политики relations/chat_messages — Веха 0/Слайс 1):
- `01-role.sql`: `CREATE ROLE orbis_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` (пароль подставляет setup-скрипт из env); `GRANT USAGE ON SCHEMA public, auth; GRANT EXECUTE ON FUNCTION auth.uid()`.
- `02-table.sql`: `spike_items (id uuid PK, owner_id uuid NOT NULL, title text)`; `ENABLE + FORCE ROW LEVEL SECURITY` (страховка от грабли владельца таблицы); политика — **дословно шаблон PRD 01 §4.10** (`owner_owns_row FOR ALL USING/WITH CHECK owner_id = auth.uid()`); гранты CRUD для `orbis_app`.

**Механика identity** (`with-identity.ts`): `db.transaction` → `set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true)` — `is_local=true` умирает на commit И rollback; claims — параметром (без инъекции). Режимы через `IDENTITY_MODE`: `claims` (основной) | `app_setting` (fallback B8). Нейминг: `owner_id` в БД, `actorUserId` в коде (D11).

**Тест-матрица** (bun test, реальная БД; RED→GREEN, коммит на тест):
- (а) A видит только свои строки (сидирование через сам `withIdentity` — заодно happy-path WITH CHECK)
- (б) A не может INSERT с `owner_id=B` (ошибка 42501), UPDATE/SELECT строк B → 0 rows
- (в) **важнейший**: interleaved-транзакции A/B на пуле max=2 (latch-хелпер) + последовательный A→B→A на переиспользованных коннекшнах — нет перекрёстного чтения
- (г) после транзакции на свежем checkout (пул max=1): `auth.uid()` NULL, claims пусты
- (д) deny-by-default: под `orbis_app` без identity — 0 строк, insert падает
- (е) service-role только в test/setup.ts (создание auth-юзера); `src/*` знает только `DATABASE_URL_APP`; ассерт `current_user='orbis_app'`
- (ж) `pg_roles`: `rolbypassrls=false, rolsuper=false` у `orbis_app`
- (з) generic plan: один параметризованный SELECT 7+ раз под A (пул max=1), затем под B → только строки B
- (и) rollback-путь: `withIdentity(A, tx => {insert; throw})` → строки нет, следующий checkout чист
- (к) session-гигиена: `current_user`/`search_path` не изменились после транзакций; мусорные claims (не-JSON, sub не-uuid) → ошибка/0 строк, но не «всё видно»
- (л) контроль анти-false-positive: admin-DSN видит строки A и B (изоляция доказана относительно существующих данных)

**JWT в Bun** (`jwt.test.ts`): реальный access_token тестового пользователя (admin createUser + signInWithPassword) верифицируется через jose — сначала JWKS (`/auth/v1/.well-known/jwks.json`), fallback HS256 legacy secret; `payload.sub` → `withIdentity(sub, …)` — сквозной путь «токен → identity → RLS». Вердикт (JWKS vs HS256, рекомендация заменить сетевой `auth.getUser` в T7 Вехи 0 на jose) — в findings.

**Опционально B7** (30 мин): вариант `SET LOCAL ROLE authenticated` — прогнать матрицу, вердикт в findings. **B8 только при провале**: `02b-table-fallback.sql` — политика на `current_setting('app.user_id', true)::uuid`, `IDENTITY_MODE=app_setting`, тот же харнес.

Мёртвое (зафиксировать в findings, не проверять): advisory locks и «PowerSync identity consistency» из AUTH-10 — умерли с D1.

## SPIKE-05 — ключевые решения

1. **C1 Регион**: Франкфурт (eu-central-1) — решение владельца без замера (зафиксировать в D12 как «выбран владельцем»); хостинг API — строго co-located с Франкфуртом (API↔DB чаттивее, чем ноутбук↔API).
2. **C2 Hosted-проект — ИНТЕРАКТИВНО**: владелец создаёт Free-проект в eu-central-1; собрать session (5432) и transaction (6543) DSN. **Риск IPv4**: прямой `db.<ref>.supabase.co` — IPv6-only, всё (включая admin/pg_dump) через Supavisor. `setup-db.ts` против hosted. **Verify-блокер**: логин кастомной ролью через пулер (username `orbis_app.<project-ref>`) — если не пускает, это критический finding.
3. **C3 Перепрогон матрицы против hosted**: 5432 с `prepare:true`; 6543 с **`prepare:false`** (postgres-js prepared statements несовместимы с transaction-режимом). Таблица local/5432/6543 — в findings. На 6543 тест (г) особо ценен: Supavisor шарит backend-коннекшны между клиентами, только `is_local` спасает.
4. **C4 Матрица провайдеров — checkpoint с владельцем**: Render free (сон ~15 мин) / Koyeb free / Cloud Run always-free (карта) / Oracle Always Free VPS (ops-налог) / Fly и Railway — как путь апгрейда (~$3–5/мес). Обязательное условие: регион Франкфурт или ближайший к нему. Колонки — ровно DEPLOY-04. Факты перепроверяются живыми доками при исполнении. **Честный компромисс**: персистентного контейнера на free нет — принимаем сон/cold-start на фазу 0/Слайс 1, путь апгрейда фиксируем.
5. **C5 Hello-world**: Hono `/health`, `/db-check` (SELECT 1 + тайминг = замер API↔DB), `/spike-check` (по токену — мини-сабсет RLS-матрицы против hosted, JSON pass/fail); Dockerfile `oven/bun:1.2`; локальная docker-проверка.
6. **C6 Деплой — ИНТЕРАКТИВНО** (аккаунт провайдера): секреты через UI/CLI (`DATABASE_URL` session-пулер, `SPIKE_CHECK_TOKEN`); прод-проверки `/health`, `/db-check`, `/spike-check` (= RLS-проверки С хостинга); логи + замер cold start.
7. **C7 Бэкап**: `backup.sh` через session-пулер (пре-чек версии pg_dump ≥ PG сервера, иначе `brew install libpq`); реальный прогон, дамп содержит spike_items; runbook в README. Риск паузы Supabase Free (~7 дней неактивности) — операционное правило в findings.

## Артефакты (часть D)

- **D1** `docs/implementation/01-phase0-findings.md`: матрица (а)–(л) × (local/5432/6543); принятая механика identity + паттерн `withIdentity` как рекомендация для T5/T7 Вехи 0; JWT-вердикт; грабли (prepare:false на 6543, FORCE RLS, IPv4→пулер, `role.<ref>` у Supavisor); регион (Франкфурт, решение владельца) + латентность API↔DB из /db-check; матрица провайдеров + выбор + компромисс free tier; прод-URL; секреты/логи/бэкап; открытые вопросы для Вехи 0.
- **D2** Новая запись **D12 «Хостинг и регион»** в `docs/prd/04-decision-log.md` (формат D1–D11: решение/статус/обоснование/заменяет — конкретизирует carried DEPLOY-03/04 минус PowerSync/детали → findings).
- **D3** Починка хвоста плана Вехи 0 (~строка 1126): «После Вехи 0: детализировать фазу 0…» противоречит канону 00 §9 (фаза 0 — ПЕРЕД Вехой 0) → заменить ссылкой на план фазы 0 + «findings SPIKE-01 — обязательный вход T5/T7».
- **D4** Финал: обе тест-среды зелёные, прод-`/health` живой, merge `spike/phase-0` → main (с согласия владельца).

## Точки участия владельца (интерактивно)

C2 (создать hosted-проект в dashboard во Франкфурте, передать DSN/пароль), C4 (утвердить провайдера; возможна карта), C6 (аккаунт хостинга). Остальное — автономно.

## Verification

- SPIKE-01: `bun test` в `spikes/spike-01-rls/` зелёный в трёх средах (local, hosted-5432, hosted-6543 с prepare:false); тест (л) подтверждает не-пустоту данных; `pg_roles` подтверждает NOBYPASSRLS.
- SPIKE-05: `curl https://<prod>/health` → `{"ok":true}`; `/db-check` → латентность API↔DB единицы мс (co-location); `/spike-check` → все pass; `backup.sh` даёт валидный дамп.
- Документы: findings полон (все секции D1), D12 в decision-log грепается как `### D12`, хвост плана Вехи 0 согласован с 00 §9; `grep -rn 'TBD\|TODO' docs/` пусто.

## Критические файлы

- `docs/prd/01-architecture.md` §4.10 — дословный шаблон политики для `02-table.sql`
- `docs/prd/04-decision-log.md` — D11-нейминг; сюда пишется D12
- `docs/implementation_old/01-application-architecture.md` §6.1–6.2 — критерии доказательства + fallback для B8
- `docs/superpowers/plans/2026-06-16-phase1-veha0-foundation.md` — стек-конвенции (tsconfig, T5/T7 — адресаты findings); строка ~1126 для D3
- `docs/prd/00-product.md` §9 — канонический скоуп фазы 0
