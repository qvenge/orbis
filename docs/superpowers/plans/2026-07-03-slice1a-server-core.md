# Слайс 1a «Серверное ядро» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающий серверный слой Orbis: RLS-защищённый граф сущностей с executor-конвейером, реестром тулов, журналом действий + Undo, query-движком (парсер + SQL-компилятор), tRPC-роутерами, онбординг-сидированием и экспортом — всё проверяемо интеграционными тестами против локального Supabase и в CI.

**Architecture:** Слайс 1 разбит на три последовательных плана: **1a (этот) — серверное ядро**, 1b — AI-слой + MCP-сервер, 1c — Web UI + прод-деплой + приёмка слайса. Каждый план заканчивается работающим, тестируемым ПО и merge в main. 1a кладёт весь фундамент, на который 1b/1c только навешивают транспорты (LLM-петля, MCP-адаптер, UI): семистадийный executor (PRD 01 §9.2) — единственный путь мутаций; identity течёт через `withIdentity` (транзакционно-локальные claims + `SET LOCAL ROLE authenticated`, findings B7); чтение — единая грамматика §6 → SQL-компилятор → Postgres.

**Tech Stack:** Bun 1.2.7 workspaces, TypeScript 5.7 strict, tRPC v11 + Hono, Drizzle 0.45 + postgres-js, Supabase (локальный стек в `supabase/`, PG17), zod 3.25, ajv (валидация аспектов по JSON Schema реестра), `uuid` (v5/v7), pgTAP (RLS-тесты в CI), Biome 2.5.2, Vitest 4 (web не трогаем).

## Global Constraints

Скопировано из PRD/леджера; требования каждой задачи неявно включают эту секцию.

- **Bun 1.2.7** — CI пиннен (`bun-version: 1.2.7`); миграция на 1.3.x с перегенерацией lock-файла — вне этого плана. Тесты из корня — только `bun run test` (`bun test` из корня — footgun: игнорирует фильтры workspace).
- **TS strict**: `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — как в существующих tsconfig. Biome 2.5.2, preset `recommended` (не трогать `biome migrate` — превращает в `preset: "none"`).
- **Нейминг (D11)**: `owner_id` в БД, `actorUserId` в коде; двусмысленный `user_id` **запрещён** во всей схеме и коде.
- **Деньги (PRD 01 §3.3)**: decimal-строки (`"340.00"`), сравнение в SQL через `::numeric`; преобразование в IEEE-754 `number` запрещено везде, включая тесты.
- **Один путь мутаций (PRD 01 §9.1–9.2)**: все мутации — только через executor; tRPC-роутеры транслируют вход и не содержат бизнес-логики.
- **RLS**: `service_role`/админ-DSN — не fallback; продуктовый код знает только `DATABASE_URL` (роль `orbis_app`). Миграции/сиды реестра — только через `DATABASE_URL_ADMIN`.
- **Детерминизм тестов** (carried-решение): время, таймзона и настройки инжектируются параметрами (`today`, `timezone` в контексте компилятора; `now()`-подмена в executor-тестах через параметр `clock`); `Math.random` в логике запрещён.
- **Дословные значения из PRD**: формула uuidv5 и `ORBIS_NAMESPACE = "cb339e97-82d7-4d16-91c6-942d42df7054"` (01 §5.4); 12 категорий (02 §7.1); body трёх smart lists (02 §3.3); дефолты `user_settings` (02 §7.3); input-схемы тулов (01 §9.2). Копировать байт-в-байт, не перефразировать.
- **Порт 3001** занят чужим контейнером Grafana на машине владельца — смоуки сервера гонять на `PORT=3210`.
- Коммит на задачу (разрешение владельца зафиксировано в `.superpowers/sdd/progress.md`).

---

## Контекст: что уже есть и что делает этот план

**Есть после Вехи 0 (main, CI зелёный):** монорепо (packages/shared, apps/server, apps/web); Drizzle-схема 8 таблиц (`apps/server/src/db/schema.ts`, миграция `0000_broad_blockbuster.sql` — только таблицы, partial-uniques и FK, **без** индексов §4.9 и без RLS); `makeDb` фабрика; jose-auth (`auth.ts`: JWKS→HS256, fail-closed); tRPC-скелет (`ping`/`whoami`); AST-типы грамматики (`packages/shared/src/query/grammar.ts`); zod `entitySchema`/`relationSchema`; retry-буфер-скелет (web, не трогаем); 5 контрактов-заглушек `describe.skip` в `packages/shared/src/contracts/`; локальный Supabase-стек в `supabase/` (порт БД 54322, `[analytics] enabled = false`).

**Делает этот план (1a):** RLS + роль + identity; индексы §4.9; схемы и сид реестра 7 аспектов; query-парсер и SQL-компилятор; executor (7 стадий, идемпотентность, инварианты); журнал действий + Undo; роутеры `entity`/`relation`/`chat`/`user`/`aspect` (без `ai`-диалога); онбординг-сидирование; экспорт; auth-хоры.

**НЕ делает (уходит в 1b/1c):** LLMProvider поверх реального AI SDK, сборка контекста 5 слоёв, политика подтверждений §7.10, метеринг `ai_usage` и лимиты, MCP-сервер + PAT, «что нового» — **1b**; fast-path-парсер (клиентский!), retry-буфер-wiring, весь UI, PWA-иконки, `site_url`-порты в `supabase/config.toml`, потребление radix-ui, re-point `render.yaml`, прод-деплой — **1c**. Ретроактивная миграция и CRUD кастомных аспектов (§3.10) — вне слайса 1: у них нет потребителя до пользовательских аспектов (Future, 00-product §10); `aspect`-роутер в 1a — только чтение реестра.

### Разнесение обязательств Вехи 0 (леджер `.superpowers/sdd/progress.md`, финальная секция)

| Обязательство | Куда попало |
|---|---|
| Изоляция auth от type-графа router | **1a, Task 14** |
| JWKS algorithms-allowlist + issuer (ГЕЙТ до прод-деплоя) | **1a, Task 14** (деплой — 1c, гейт закрывается заранее) |
| FK-индексы §4.10 вместе с RLS (+ все индексы §4.9) | **1a, Task 2** |
| Timestamp-режим Drizzle vs ISO-строки + parity-тест + offset-вопрос | **1a, Task 13** |
| Пин Bun в CI | закрыто (81fc6a8); bun-types к рантайму — **1a, Task 1** |
| Guard DATABASE_URL | **1a, Task 1** |
| Concurrency-блок CI | **1a, Task 1** |
| onnotice-глушилка (не глушить в админ-скриптах) | **1a, Task 3** |
| FK `owner_id` → `auth.users` — решение при RLS | **1a, Task 2** (решение: FK не добавляем, см. «Решения» ниже) |
| Уточнение коммента `QueryExcludeTagsFilter` | **1a, Task 8** |
| UUIDv7-генератор в shared | **1a, Task 5** |
| Потребление zod/@orbis/shared | **1a** (везде); radix-ui — 1c |
| Retry-storage guard'ы, business_rejection surfacing, PWA-иконки, порты site_url, hex favicon | **1c** (перенести в план 1c при написании) |
| Echo-тест LLM пиннит префикс/usage при реальном провайдере | **1b** |
| pgTAP-тесты RLS в CI (carried) | **1a, Task 2** |

### Ключевые проектные решения плана

1. **FK `owner_id → auth.users` не объявляем.** Auth-схема управляется Supabase, наши миграции от неё не зависят (комментарий уже в `schema.ts`); целостность владения обеспечивают RLS (`auth.uid()`) и то, что `actorUserId` берётся только из проверенного JWT. Закрывает обязательство «FK auth.users решение при RLS».
2. **Шаблон политики — `(select auth.uid())`**, а не голый `auth.uid()`: семантика идентична §4.10, но подзапрос кэшируется планировщиком как InitPlan (рекомендация Supabase для RLS-перфа). Это и есть «один шаблон», из которого генерируются все политики (D11-чеклист, п. 3).
3. **Identity-механика — рекомендация findings B7**: роль `orbis_app` `LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` + членство в `authenticated`; в транзакции — `set_config('request.jwt.claims', …, true)` + `SET LOCAL ROLE authenticated`.
4. **`expectedUpdatedAt` в envelope `entity_update`.** §9.2 не показывает это поле, но §5.2 требует передавать прочитанный `updated_at` при правке `body`. Разрешение: опциональное поле envelope; executor требует его, когда в патче есть `body` (для всех источников — AI/MCP берут значение из `entity_get`). Отметить при обновлении PRD.
5. **Носитель журнала — системное audit-сообщение.** Каждый action = одно системное сообщение (`role='system'`) в целевом треде (тред диалога, а для не-чатовых источников — глобальный тред) с `metadata.actions[]` + `metadata.cards[]`. Это выполняет §7.8 (журнал в `chat_messages.metadata.actions`) единообразно для чата, quick-capture и будущего MCP. Undo — новое системное сообщение `{type:'undo', undoes}` (§7.8).
6. **Онбординг-сидирование пишет напрямую в tx под `withIdentity`, мимо журнала**: это не пользовательское действие, 15 audit-сообщений при регистрации — шум. PRD журналить сидирование не требует.
7. **Валидация аспектов — ajv по JSON Schema из реестра** (стадия 2 конвейера, §9.2); сами JSON Schema **генерируются из zod-схем shared** (`zod-to-json-schema`) при сидировании — один источник истины, порядок enum-значений сохраняется (важно для сортировки §6.1). Условная обязательность `occurred_on` (§3.3) невыразима в одной плоской схеме — живёт в доменных инвариантах стадии 4.
8. **CI-база — образ `supabase/postgres`** (тот же, что в локальном стеке: роли `anon`/`authenticated`/`service_role`, `auth.uid()`, pgTAP уже внутри) как service-container. Никакого шима auth-схемы руками.
9. **Идемпотентность без отдельной receipts-таблицы**: `entity_create` — по PK `entities.id`; `batch_execute` — по детерминированному PK audit-сообщения `uuidv5(NS, "batch:<owner_id>:<batch_id>")` (§7.8). Retention-чистка 90/180/30 — отложена (первые 90 дней данных не истекут за слайс); зафиксировать в леджере как обязательство слайса 2/3.
10. **Семантика `noneOf` включает NULL**: `status=!done&!cancelled` матчит и сущности без значения поля (`field IS NULL OR field NOT IN (…)`). «НЕ эти значения» — буквально.
11. **Защитный cap запросов**: без `limit=` компилятор ставит `LIMIT 500` (деталь реализации, не грамматики; count-запросы — без cap и без limit).
12. **Сериализация wire-датетаймов**: core-поля (`created_at`/`updated_at`) — всегда UTC ISO с `Z` (`Date.toISOString()`); аспектные datetime-поля — ISO 8601 с офсетом как введены (jsonb не трогаем). `entitySchema` остаётся `z.string().datetime()` (без офсета) — parity-тест в Task 13.

### Как исполнять

Ветка `slice1a-server-core` от main. Для интеграционных тестов нужен запущенный локальный Supabase (`bunx supabase start` из корня; БД `postgres://postgres:postgres@127.0.0.1:54322/postgres`). Env-переменные тестов: `DATABASE_URL_ADMIN` (postgres), `DATABASE_URL` (orbis_app — появится в Task 3). Интеграционные тесты живут в `apps/server` и **падают с внятной ошибкой**, если env не задан (не скипаются молча).

---

### Task 1: CI-инфраструктура интеграционных тестов + guard DATABASE_URL

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` (корень — пин bun-types)
- Modify: `apps/server/src/db/client.ts` (guard)
- Modify: `apps/server/.env.example`
- Test: `apps/server/src/db/client.test.ts`

**Interfaces:**
- Consumes: существующий `makeDb` (Веха 0).
- Produces: CI-джоб с сервисной Postgres-базой и env `DATABASE_URL`/`DATABASE_URL_ADMIN`; все последующие задачи полагаются на то, что `bun run test` в CI имеет живую БД с прогнанными миграциями.

- [ ] **Step 1: Выяснить тег образа supabase/postgres локального стека**

Run: `docker ps --format '{{.Image}}' | grep supabase/postgres`
Ожидаемо: один тег вида `public.ecr.aws/supabase/postgres:17.x.x.xxx` или `supabase/postgres:17.x.x.xxx`. Этот тег пиннится в CI (docker-hub-форма `supabase/postgres:<tag>`).

- [ ] **Step 2: Написать падающий тест guard'а**

```ts
// apps/server/src/db/client.test.ts
import { describe, expect, test } from 'bun:test';
import { makeDb } from './client';

describe('makeDb', () => {
  test('без DATABASE_URL бросает внятную ошибку, а не постгрес-таймаут', () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => makeDb()).toThrow(/DATABASE_URL/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});
```

Run: `cd apps/server && bun test src/db/client.test.ts` → FAIL (makeDb молча создаёт клиент с `undefined as string`).

- [ ] **Step 3: Guard в makeDb**

В `apps/server/src/db/client.ts` первой строкой `makeDb`:

```ts
export function makeDb(opts: { max?: number; prepare?: boolean } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('makeDb: DATABASE_URL не задан (см. apps/server/.env.example)');
  const client = postgres(url, {
    max: opts.max ?? 3,
    prepare: opts.prepare ?? process.env.PG_PREPARE !== 'false',
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return { db, client };
}
```

Run: `bun test src/db/client.test.ts` → PASS.

- [ ] **Step 4: Обновить ci.yml**

Заменить содержимое `.github/workflows/ci.yml` (пин bun 1.2.7 и комментарий сохранить; `<TAG>` — из Step 1):

```yaml
name: CI
on:
  push: { branches: ['**'] }
  pull_request:
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    services:
      db:
        # Тот же образ, что в локальном Supabase-стеке: роли anon/authenticated/
        # service_role, auth.uid() и pgTAP уже внутри (решение 8 плана slice1a).
        image: supabase/postgres:<TAG>
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['54329:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s
          --health-timeout 5s --health-retries 20
    env:
      DATABASE_URL_ADMIN: postgres://postgres:postgres@localhost:54329/postgres
      DATABASE_URL: postgres://orbis_app:orbis_app_ci@localhost:54329/postgres
      ORBIS_APP_PASSWORD: orbis_app_ci
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        # Пин к локально верифицированной версии: bun 1.3.x бракует integrity
        # lock-файла, созданного 1.2.x (первый прогон CI, 2026-07-03).
        with: { bun-version: 1.2.7 }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run db:prepare   # появится в Task 2/3: миграции + роль + сид реестра
      - run: bun run test
```

До Task 2 шаг `db:prepare` — заглушка в корневом package.json: `"db:prepare": "echo 'no-op until Task 2'"` (честная, видимая; задачи 2, 3 и 7 наполняют её). Туда же — пин `"bun-types": "1.2.7"` в devDependencies корня (к рантайму; если точной версии в npm нет — ближайшая существующая `1.2.x` ≤ 1.2.7, факт зафиксировать в отчёте).

- [ ] **Step 5: .env.example**

```bash
# apps/server/.env.example — добавить/уточнить:
# Продуктовое подключение (роль orbis_app, RLS enforced). Локально:
DATABASE_URL=postgres://orbis_app:orbis_app_local@127.0.0.1:54322/postgres
# Админ (миграции, setup-db, сид реестра). НЕ используется продуктовым кодом:
DATABASE_URL_ADMIN=postgres://postgres:postgres@127.0.0.1:54322/postgres
ORBIS_APP_PASSWORD=orbis_app_local
# prepare=false обязателен только для transaction-пулера :6543 (hosted)
# PG_PREPARE=false
```

- [ ] **Step 6: Локальный прогон цепочки и коммит**

Run: `bun run lint && bun run typecheck && bun run test` → зелёно (guard-тест новый, остальное как было).

```bash
git add .github/workflows/ci.yml package.json bun.lock apps/server/src/db/client.ts apps/server/src/db/client.test.ts apps/server/.env.example
git commit -m "ci: сервисная БД supabase/postgres, concurrency, guard DATABASE_URL, пин bun-types"
```

---

### Task 2: Миграция 0001 — RLS, FORCE, гранты, индексы §4.9 + pgTAP-сьют

**Files:**
- Create: `apps/server/src/db/migrations/0001_rls_and_indexes.sql` (через `bunx drizzle-kit generate --custom --name=rls_and_indexes`)
- Create: `apps/server/test/rls/rls.pgtap.sql`
- Create: `scripts/test-rls.ts` (корень)
- Modify: `package.json` (корень: скрипты `db:prepare`, `test:rls`), `apps/server/package.json` (если нужен проброс)

**Interfaces:**
- Consumes: таблицы миграции 0000; роли `authenticated`/`anon` и функция `auth.uid()` из образа Supabase.
- Produces: включённый RLS на всех 8 таблицах — все последующие интеграционные тесты работают под ним; индексы §4.9 (включая FK-индексы для RLS-подзапросов §4.10).

- [ ] **Step 1: pgTAP-тест (падает: политик ещё нет)**

```sql
-- apps/server/test/rls/rls.pgtap.sql
-- Прогон: psql $DATABASE_URL_ADMIN -v ON_ERROR_STOP=1 -f <этот файл>
-- Всё в одной транзакции с ROLLBACK: БД не мутируется.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

-- Фикстуры под суперпользователем (обходит RLS)
INSERT INTO entities (id, owner_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'A: задача'),
  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'B: задача');
INSERT INTO chat_threads (id, owner_id) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a');
INSERT INTO chat_messages (id, thread_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2', 'user', 'привет');
INSERT INTO aspect_definitions (id, owner_id, name, namespace, schema)
  VALUES ('orbis/pgtap-probe', NULL, 'Probe', 'orbis', '{}');

-- 1) RLS включён и FORCE на всех 8 таблицах
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname IN ('entities','relations','aspect_definitions','user_settings',
                       'chat_threads','chat_messages','ai_usage','entity_origins')
     AND c.relrowsecurity AND c.relforcerowsecurity),
  8, 'RLS ENABLE+FORCE на всех восьми таблицах');

-- Как пользователь A
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[1], 'A видит ровно одну (свою) сущность');
SELECT results_eq(
  $$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000b1'$$,
  ARRAY[0], 'чужая сущность невидима');
SELECT throws_ok(
  $$INSERT INTO entities (id, owner_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000b', 'подлог')$$,
  '42501', NULL, 'INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entities (id, owner_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000a', 'своя')$$,
  'INSERT со своим owner_id проходит');
SELECT throws_ok(
  $$INSERT INTO relations (id, source_id, target_id, relation_type)
    VALUES ('00000000-0000-7000-8000-0000000000c2',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000b1', 'related_to')$$,
  '42501', NULL, 'межпользовательская relation запрещена (§4.10)');
SELECT lives_ok(
  $$INSERT INTO relations (id, source_id, target_id, relation_type)
    VALUES ('00000000-0000-7000-8000-0000000000a5',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000a4', 'related_to')$$,
  'relation между двумя своими сущностями проходит');
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[1],
  'сообщения видимы через владение тредом');
SELECT results_eq($$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], 'встроенные аспекты читаемы');
-- UPDATE builtin-строки под authenticated НЕ бросает 42501: USING-фильтр политики
-- update_own молча отдаёт «UPDATE 0» (семантика RLS). Проверяем неизменность строки.
UPDATE aspect_definitions SET name = 'hack' WHERE id = 'orbis/pgtap-probe';
SELECT results_eq(
  $$SELECT name FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY['Probe'::text], 'встроенные аспекты не правятся под authenticated (UPDATE отфильтрован USING)');

-- Как пользователь B: чужой тред закрыт на чтение и вставку
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[0], 'B не видит сообщений A');
SELECT throws_ok(
  $$INSERT INTO chat_messages (id, thread_id, role, content)
    VALUES ('00000000-0000-7000-8000-0000000000c3',
            '00000000-0000-7000-8000-0000000000a2', 'user', 'вброс')$$,
  '42501', NULL, 'B не может вставить сообщение в тред A (§13.5)');

RESET ROLE;
-- Deny-by-default: без claims authenticated не видит ничего
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'без identity — 0 строк');
RESET ROLE;
-- Контроль анти-false-positive: админ видит данные обоих
SELECT cmp_ok((SELECT count(*)::int FROM entities), '>=', 3, 'админ видит строки A и B');

SELECT finish();
ROLLBACK;
```

Раннер:

```ts
// scripts/test-rls.ts — прогон pgTAP через psql; падаем на любом "not ok"
import { $ } from 'bun';
const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) throw new Error('test-rls: DATABASE_URL_ADMIN не задан');
const out = await $`psql ${admin} -v ON_ERROR_STOP=1 -f apps/server/test/rls/rls.pgtap.sql`.text();
console.log(out);
// psql в aligned-режиме печатает строки с ведущими пробелами — без \s* был бы false-green
if (/^\s*not ok/m.test(out)) {
  console.error('pgTAP: есть проваленные проверки');
  process.exit(1);
}
```

Корневой package.json: `"test:rls": "bun scripts/test-rls.ts"`. Run: `DATABASE_URL_ADMIN=postgres://postgres:postgres@127.0.0.1:54322/postgres bun run test:rls` → FAIL (тест 1: RLS не включён).

- [ ] **Step 2: Миграция 0001**

`bunx drizzle-kit generate --custom --name=rls_and_indexes` в apps/server, затем наполнить сгенерированный файл. **Важно:** drizzle-миграции исполняются чанками по маркеру `--> statement-breakpoint` — поставить его **между каждым statement**; в листинге ниже маркеры частично опущены для читаемости:

```sql
-- 0001_rls_and_indexes.sql
-- RLS + FORCE (FORCE — страховка от обхода владельцем таблицы, findings грабля 4)
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations FORCE ROW LEVEL SECURITY;
ALTER TABLE aspect_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aspect_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_origins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Политики: единый шаблон §4.10; (select auth.uid()) — InitPlan-кэширование (решение 2)
CREATE POLICY owner_owns_row ON entities FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_row ON user_settings FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_row ON chat_threads FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_row ON ai_usage FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_row ON entity_origins FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- relations: владение транзитивно — ОБЕ сущности принадлежат пользователю (§4.10)
CREATE POLICY owner_owns_both_ends ON relations FOR ALL
  USING (
    EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  );
--> statement-breakpoint
-- chat_messages: доступ только через владение тредом (§4.10)
CREATE POLICY owner_owns_thread ON chat_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id
                   AND t.owner_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id
                   AND t.owner_id = (SELECT auth.uid())));
--> statement-breakpoint
-- aspect_definitions: встроенные читаемы всеми; кастомные — по шаблону владельца;
-- встроенные изменяемы только service-role/админом (политики на запись не дают NULL-owner)
CREATE POLICY read_builtin_or_own ON aspect_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));
CREATE POLICY write_own ON aspect_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY update_own ON aspect_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY delete_own ON aspect_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- Гранты: default privileges Supabase дают authenticated права на новые таблицы
-- на hosted, но для CI-образа и детерминизма фиксируем явно.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
--> statement-breakpoint
-- Индексы §4.9 (включая FK-индексы, на которые опираются RLS-подзапросы §4.10)
CREATE INDEX entities_tags_gin ON entities USING gin (tags);
CREATE INDEX entities_aspects_gin ON entities USING gin (aspects);
CREATE INDEX entities_meta_gin ON entities USING gin (meta);
CREATE INDEX entities_body_refs_gin ON entities USING gin (body_refs);
CREATE INDEX entities_title_fts ON entities USING gin (to_tsvector('simple', title));
CREATE INDEX entities_body_fts ON entities USING gin (to_tsvector('simple', body));
CREATE INDEX entities_owner_updated ON entities (owner_id, updated_at DESC) WHERE NOT archived;
CREATE INDEX relations_source_type ON relations (source_id, relation_type);
CREATE INDEX relations_target_type ON relations (target_id, relation_type);
CREATE INDEX chat_threads_owner ON chat_threads (owner_id);
CREATE INDEX chat_messages_thread_created ON chat_messages (thread_id, created_at);
-- Поиск action по id для Undo (решение 5 плана; jsonb_path_ops — компактный containment)
CREATE INDEX chat_messages_metadata_gin ON chat_messages USING gin (metadata jsonb_path_ops);
```

- [ ] **Step 3: Применить миграцию и прогнать pgTAP**

Run: `cd apps/server && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres bun run db:migrate` (drizzle-kit использует DATABASE_URL из drizzle.config — миграции всегда админ-DSN).
Run: `DATABASE_URL_ADMIN=... bun run test:rls` → все 14 ok.

- [ ] **Step 4: Наполнить db:prepare и CI**

Корневой package.json:

```json
"db:prepare": "cd apps/server && DATABASE_URL=$DATABASE_URL_ADMIN bun run db:migrate && cd ../.. && bun run test:rls"
```

(Задачи 3 и 7 дополнят цепочку setup-db и сидом реестра.) `test:rls` включён в `db:prepare`, чтобы политика проверялась в CI на каждом прогоне — carried-решение «pgTAP-тесты RLS в CI».

- [ ] **Step 5: Коммит**

```bash
git add apps/server/src/db/migrations apps/server/test/rls scripts/test-rls.ts package.json
git commit -m "feat(db): RLS ENABLE+FORCE на 8 таблицах, политики §4.10, гранты, индексы §4.9, pgTAP-сьют"
```

---

### Task 3: Роль `orbis_app`, setup-скрипт и `withIdentity`

**Files:**
- Create: `scripts/setup-db.ts` (корень)
- Create: `apps/server/src/db/with-identity.ts`
- Test: `apps/server/src/db/with-identity.test.ts`
- Create: `apps/server/test/helpers.ts`
- Modify: `package.json` (корень: `db:prepare` += setup-db)

**Interfaces:**
- Consumes: `makeDb`, миграция 0001 (RLS активен), `DATABASE_URL_ADMIN`, `ORBIS_APP_PASSWORD`.
- Produces: `withIdentity<T>(db: Db, actorUserId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` и `type Tx` — **единственный** способ исполнять запросы от имени пользователя; хелперы `adminDb()`, `appDb()`, `freshUserId()`, `truncateAll()` для всех последующих интеграционных тестов.

- [ ] **Step 1: setup-скрипт (идемпотентный, через админ-DSN)**

```ts
// scripts/setup-db.ts — создание роли orbis_app (findings B7: NOINHERIT + членство
// в authenticated). Идемпотентен. НЕ глушит notices (findings грабля 1).
import postgres from 'postgres';

const admin = process.env.DATABASE_URL_ADMIN;
const password = process.env.ORBIS_APP_PASSWORD;
if (!admin || !password) throw new Error('setup-db: нужны DATABASE_URL_ADMIN и ORBIS_APP_PASSWORD');

const sql = postgres(admin, { max: 1 }); // без onnotice-глушилки — предупреждения должны быть видны
try {
  const [{ exists }] = await sql`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'orbis_app') AS exists`;
  if (!exists) {
    await sql.unsafe(
      `CREATE ROLE orbis_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
       PASSWORD '${password.replaceAll("'", "''")}'`,
    );
  } else {
    await sql.unsafe(`ALTER ROLE orbis_app PASSWORD '${password.replaceAll("'", "''")}'`);
  }
  await sql`GRANT authenticated TO orbis_app`;
  // Верификация вместо тихого провала (findings грабля 1)
  const [check] = await sql`
    SELECT rolbypassrls, rolsuper,
           pg_has_role('orbis_app', 'authenticated', 'MEMBER') AS is_member
    FROM pg_roles WHERE rolname = 'orbis_app'`;
  if (!check || check.rolbypassrls || check.rolsuper || !check.is_member) {
    throw new Error(`setup-db: роль в неожиданном состоянии: ${JSON.stringify(check)}`);
  }
  console.log('setup-db: orbis_app готова (NOBYPASSRLS, NOINHERIT, member of authenticated)');
} finally {
  await sql.end();
}
```

Корневой package.json — `db:prepare` теперь: setup-db → миграции → pgTAP:

```json
"db:prepare": "bun scripts/setup-db.ts && cd apps/server && DATABASE_URL=$DATABASE_URL_ADMIN bun run db:migrate && cd ../.. && bun run test:rls"
```

Run: `bun scripts/setup-db.ts` (с env) → «orbis_app готова». Проверить логин: `psql "postgres://orbis_app:orbis_app_local@127.0.0.1:54322/postgres" -c 'select current_user'` → `orbis_app`.

- [ ] **Step 2: Падающие тесты withIdentity**

```ts
// apps/server/src/db/with-identity.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv } from '../../test/helpers';
import { withIdentity } from './with-identity';

requireEnv(); // бросает с внятным сообщением, если DATABASE_URL/DATABASE_URL_ADMIN не заданы

describe('withIdentity (RLS-механика, findings B7)', () => {
  const { db, client } = appDb();
  const userA = freshUserId();
  const userB = freshUserId();

  test('невалидный actorUserId отклоняется до SQL', async () => {
    await expect(withIdentity(db, 'not-a-uuid', async () => {})).rejects.toThrow(/UUID/);
  });

  test('внутри транзакции auth.uid() = actorUserId, снаружи — NULL', async () => {
    const inside = await withIdentity(db, userA, async (tx) => {
      const r = await tx.execute(sql`SELECT auth.uid()::text AS uid, current_user AS who`);
      return r[0];
    });
    expect(inside?.uid).toBe(userA);
    expect(inside?.who).toBe('authenticated');
    // свежий checkout после транзакции чист (пул max=3, гоняем несколько раз)
    for (let i = 0; i < 5; i++) {
      const r = await db.execute(sql`SELECT auth.uid()::text AS uid, current_user AS who`);
      expect(r[0]?.uid ?? null).toBeNull();
      expect(r[0]?.who).toBe('orbis_app');
    }
  });

  test('изоляция: A создаёт, A видит, B — нет; вне identity — deny-by-default', async () => {
    const id = crypto.randomUUID();
    await withIdentity(db, userA, async (tx) => {
      await tx.execute(sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${userA}, 'своя')`);
    });
    const mine = await withIdentity(db, userA, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`));
    expect(mine[0]?.n).toBe(1);
    const theirs = await withIdentity(db, userB, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`));
    expect(theirs[0]?.n).toBe(0);
    const anon = await db.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`);
    expect(anon[0]?.n).toBe(0);
  });

  test('rollback-путь: identity и данные умирают вместе с транзакцией', async () => {
    const id = crypto.randomUUID();
    await expect(
      withIdentity(db, userA, async (tx) => {
        await tx.execute(sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${userA}, 'x')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await withIdentity(db, userA, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`));
    expect(after[0]?.n).toBe(0);
  });

  test('interleaved: A и B на одном пуле не путаются', async () => {
    const [a, b] = await Promise.all([
      withIdentity(db, userA, async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid, pg_sleep(0.05)`);
        return r[0]?.uid;
      }),
      withIdentity(db, userB, async (tx) => {
        const r = await tx.execute(sql`SELECT auth.uid()::text AS uid`);
        return r[0]?.uid;
      }),
    ]);
    expect(a).toBe(userA);
    expect(b).toBe(userB);
  });

});

afterAll(async () => {
  await client.end();
});
```

Хелперы:

```ts
// apps/server/test/helpers.ts
import { sql } from 'drizzle-orm';
import { makeDb } from '../src/db/client';

export function requireEnv(): void {
  for (const k of ['DATABASE_URL', 'DATABASE_URL_ADMIN']) {
    if (!process.env[k]) {
      throw new Error(`Интеграционные тесты требуют ${k} (локально: bunx supabase start, см. apps/server/.env.example)`);
    }
  }
}

export function appDb() {
  return makeDb({ max: 3 });
}

export function adminDb() {
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;
  try {
    return makeDb({ max: 1 });
  } finally {
    process.env.DATABASE_URL = prev;
  }
}

/** Случайный owner: FK на auth.users не объявлен (решение 1 плана), строка в auth не нужна. */
export function freshUserId(): string {
  return crypto.randomUUID();
}

/** Полная зачистка данных между сьютами (админ-DSN, обходит RLS). */
export async function truncateAll(): Promise<void> {
  const { db, client } = adminDb();
  await db.execute(sql`TRUNCATE entities, relations, user_settings, chat_threads,
    chat_messages, ai_usage, entity_origins RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM aspect_definitions WHERE owner_id IS NOT NULL`);
  await client.end();
}
```

Run: `cd apps/server && bun test src/db/with-identity.test.ts` → FAIL (модуля нет).

- [ ] **Step 3: Реализация**

```ts
// apps/server/src/db/with-identity.ts
// Транзакционно-локальная identity (findings B7, SPIKE-01 доказан в 3 средах):
// set_config(..., is_local=true) умирает на commit И rollback; SET LOCAL ROLE
// authenticated даёт default-гранты Supabase и рабочий auth.uid() в политиках.
import { sql } from 'drizzle-orm';
import type { Db } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withIdentity<T>(
  db: Db,
  actorUserId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(actorUserId)) {
    throw new Error(`withIdentity: actorUserId не UUID: ${JSON.stringify(actorUserId)}`);
  }
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: actorUserId.toLowerCase(), role: 'authenticated' });
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}
```

- [ ] **Step 4: Прогон и коммит**

Run: `bun test src/db/with-identity.test.ts` → PASS (все 6). Затем полная цепочка: `bun run lint && bun run typecheck && bun run test` из корня.

```bash
git add scripts/setup-db.ts apps/server/src/db/with-identity.ts apps/server/src/db/with-identity.test.ts apps/server/test/helpers.ts package.json apps/server/.env.example
git commit -m "feat(db): роль orbis_app + withIdentity (B7: NOINHERIT + SET LOCAL ROLE) + тест-хелперы"
```

---

### Task 4: shared — генераторы ID и формулы детерминированных UUID

**Files:**
- Create: `packages/shared/src/ids.ts`
- Test: `packages/shared/src/ids.test.ts`
- Modify: `packages/shared/src/index.ts` (экспорт), `packages/shared/package.json` (dep `uuid@^11`)

**Interfaces:**
- Consumes: npm `uuid` (v5, v7, validate).
- Produces:
  - `ORBIS_NAMESPACE: string` — `"cb339e97-82d7-4d16-91c6-942d42df7054"` (01 §5.4, байт-точно);
  - `newId(): string` — UUIDv7 (client-generated id сущностей/сообщений; закрывает обязательство «UUIDv7-генератор»);
  - `globalThreadId(ownerId: string): string` — `uuidv5(NS, "<owner_id>:global-thread")` (01 §4.5);
  - `entityThreadId(ownerId: string, entityId: string): string` — `uuidv5(NS, "<owner_id>:entity-thread:<entity_id>")`;
  - `batchAuditMessageId(ownerId: string, batchId: string): string` — `uuidv5(NS, "batch:<owner_id>:<batch_id>")` (01 §7.8);
  - `recurringInstanceId(templateId: string, dateISO: string): string` — `uuidv5(NS, "<template_id>:<YYYY-MM-DD>")` (01 §5.4; материализация — слайс 2, формула нужна уже сейчас для полноты и тестов);
  - все `*Id`-аргументы нормализуются в lowercase до вычисления (01 §5.4 «UUID шаблона в lowercase» — применяем ко всем формулам единообразно).

- [ ] **Step 1: Падающий тест с byte-точной фикстурой из PRD**

```ts
// packages/shared/src/ids.test.ts
import { describe, expect, test } from 'bun:test';
import {
  ORBIS_NAMESPACE, batchAuditMessageId, entityThreadId, globalThreadId,
  newId, recurringInstanceId,
} from './ids';

describe('детерминированные ID (01 §5.4, §4.5, §7.8)', () => {
  test('пример из PRD §5.4 воспроизводится байт-точно', () => {
    expect(recurringInstanceId('019ded47-d100-717a-8307-a5b7a5be722f', '2026-07-01'))
      .toBe('e7d0bfa4-f62a-59c1-b560-1c17cb32e89f');
  });
  test('lowercase-нормализация входа', () => {
    expect(recurringInstanceId('019DED47-D100-717A-8307-A5B7A5BE722F', '2026-07-01'))
      .toBe('e7d0bfa4-f62a-59c1-b560-1c17cb32e89f');
  });
  test('формулы тредов детерминированы и различны', () => {
    const owner = '00000000-0000-4000-8000-00000000000a';
    const entity = '00000000-0000-7000-8000-0000000000a1';
    expect(globalThreadId(owner)).toBe(globalThreadId(owner));
    expect(entityThreadId(owner, entity)).toBe(entityThreadId(owner, entity));
    expect(globalThreadId(owner)).not.toBe(entityThreadId(owner, entity));
    expect(batchAuditMessageId(owner, entity)).not.toBe(entityThreadId(owner, entity));
  });
  test('newId — валидный UUIDv7, монотонный по времени в префиксе', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b || a.slice(0, 13) === b.slice(0, 13)).toBe(true);
  });
  test('константа namespace дословно из PRD', () => {
    expect(ORBIS_NAMESPACE).toBe('cb339e97-82d7-4d16-91c6-942d42df7054');
  });
});
```

Run: `cd packages/shared && bun test src/ids.test.ts` → FAIL.

- [ ] **Step 2: Реализация**

`bun add uuid@^11` в packages/shared, затем:

```ts
// packages/shared/src/ids.ts
// Формулы — дословно PRD 01 §5.4 (инстансы), §4.5 (треды), §7.8 (batch-audit).
// Формулы с owner_id — workspace-scoped при введении workspace'ов (D11).
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

export const ORBIS_NAMESPACE = 'cb339e97-82d7-4d16-91c6-942d42df7054';

/** Client-generated id (UUIDv7 — время в префиксе, 01 §2.1). */
export function newId(): string {
  return uuidv7();
}

export function globalThreadId(ownerId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:global-thread`, ORBIS_NAMESPACE);
}

export function entityThreadId(ownerId: string, entityId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:entity-thread:${entityId.toLowerCase()}`, ORBIS_NAMESPACE);
}

export function batchAuditMessageId(ownerId: string, batchId: string): string {
  return uuidv5(`batch:${ownerId.toLowerCase()}:${batchId.toLowerCase()}`, ORBIS_NAMESPACE);
}

export function recurringInstanceId(templateId: string, dateISO: string): string {
  return uuidv5(`${templateId.toLowerCase()}:${dateISO}`, ORBIS_NAMESPACE);
}
```

Добавить `export * from './ids';` в `packages/shared/src/index.ts`.

- [ ] **Step 3: Прогон и коммит**

Run: `bun test src/ids.test.ts` → PASS. Если фикстура `e7d0bfa4-…` не сошлась — проверить порядок аргументов `uuidv5(name, namespace)` у пакета `uuid` (имя первым); ошибка здесь молча сломает идемпотентность по всей системе, тест обязателен.

```bash
git add packages/shared/src/ids.ts packages/shared/src/ids.test.ts packages/shared/src/index.ts packages/shared/package.json bun.lock
git commit -m "feat(shared): генераторы UUIDv7/uuidv5 и детерминированные формулы ID (§5.4, §4.5, §7.8)"
```

---

### Task 5: shared — zod-схемы семи аспектов и генерация JSON Schema реестра

**Files:**
- Create: `packages/shared/src/schemas/aspects.ts`
- Test: `packages/shared/src/schemas/aspects.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/package.json` (dep `zod-to-json-schema@^3`)

**Interfaces:**
- Consumes: zod, `zod-to-json-schema`.
- Produces:
  - `ASPECT_SCHEMAS: Record<AspectId, z.ZodObject<...>>` — zod-схемы 7 аспектов, поля и обязательность дословно по PRD 01 §3.1–§3.7;
  - `aspectJsonSchema(id: AspectId): Record<string, unknown>` — JSON Schema для реестра (порядок enum-значений = порядок объявления в zod — критично для сортировки §6.1);
  - `decimalString` — переиспользуемый zod-тип decimal-строки (`/^-?\d+(\.\d+)?$/`; для `amount` — строго положительная, для `carryover` — со знаком);
  - типы `ScheduleAspect`, `TaskAspect`, `FinancialAspect`, `NoteAspect`, `BudgetAspect`, `CategoryAspect`, `MemoryAspect` (z.infer).

- [ ] **Step 1: Падающие тесты (валидные/невалидные фикстуры на каждый аспект)**

```ts
// packages/shared/src/schemas/aspects.test.ts
import { describe, expect, test } from 'bun:test';
import { ASPECT_SCHEMAS, aspectJsonSchema } from './aspects';

describe('схемы аспектов (01 §3.1–§3.7)', () => {
  test('orbis/task: полный и минимальный валидны; статус вне enum — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/task'];
    expect(s.safeParse({ status: 'inbox' }).success).toBe(true);
    expect(s.safeParse({
      status: 'done', priority: 'high', due_date: '2026-07-10',
      completed_at: '2026-07-03T10:00:00Z', effort_min: 30, waiting_for: 'ответ',
    }).success).toBe(true);
    expect(s.safeParse({ status: 'todo' }).success).toBe(false);
    expect(s.safeParse({}).success).toBe(false); // status обязателен
  });
  test('orbis/financial: amount — положительная decimal-строка, number запрещён', () => {
    const s = ASPECT_SCHEMAS['orbis/financial'];
    const base = { direction: 'expense', category_ref: crypto.randomUUID(), occurred_on: '2026-07-03' };
    expect(s.safeParse({ ...base, amount: '340.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, amount: 340 }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '-1.00' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '0' }).success).toBe(false);
    expect(s.safeParse({ ...base, amount: '3.4e2' }).success).toBe(false);
  });
  test('orbis/schedule: start_at обязателен; recurrence — структурный объект', () => {
    const s = ASPECT_SCHEMAS['orbis/schedule'];
    expect(s.safeParse({ start_at: '2026-07-05T09:00:00+03:00' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({
      start_at: '2026-07-05T09:00:00+03:00',
      recurrence: { freq: 'weekly', interval: 1, byweekday: ['mo'] },
    }).success).toBe(true);
    expect(s.safeParse({
      start_at: '2026-07-05T09:00:00+03:00', recurrence: { freq: 'yearly', interval: 1 },
    }).success).toBe(false);
  });
  test('orbis/budget: carryover может быть отрицательным, limit — нет', () => {
    const s = ASPECT_SCHEMAS['orbis/budget'];
    const base = {
      category_ref: crypto.randomUUID(), limit: '30000.00',
      period_start: '2026-06-01', period_end: '2026-06-30',
    };
    expect(s.safeParse({ ...base, carryover: '-1200.00' }).success).toBe(true);
    expect(s.safeParse({ ...base, limit: '-1.00' }).success).toBe(false);
  });
  test('orbis/memory: kind обязателен', () => {
    expect(ASPECT_SCHEMAS['orbis/memory'].safeParse({ kind: 'rule', scope: 'orbis/financial' }).success).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/memory'].safeParse({}).success).toBe(false);
  });
  test('orbis/note и orbis/category: пустой объект валиден (все поля опциональны)', () => {
    expect(ASPECT_SCHEMAS['orbis/note'].safeParse({}).success).toBe(true);
    expect(ASPECT_SCHEMAS['orbis/category'].safeParse({}).success).toBe(true);
  });
  test('неизвестные ключи отклоняются (strict) — защита от опечаток в meta→aspects', () => {
    expect(ASPECT_SCHEMAS['orbis/task'].safeParse({ status: 'inbox', prioritty: 'high' }).success).toBe(false);
  });
  test('JSON Schema: enum-порядок сохранён (сортировка §6.1)', () => {
    const js = aspectJsonSchema('orbis/task') as {
      properties: { status: { enum: string[] }, priority: { enum: string[] } },
      required: string[],
    };
    expect(js.properties.status.enum).toEqual(['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled']);
    expect(js.properties.priority.enum).toEqual(['low', 'medium', 'high']);
    expect(js.required).toContain('status');
  });
});
```

Run: `bun test src/schemas/aspects.test.ts` → FAIL.

- [ ] **Step 2: Реализация**

`bun add zod-to-json-schema@^3` в packages/shared, затем:

```ts
// packages/shared/src/schemas/aspects.ts
// Нормативное содержание схем — PRD 01 §3.1–§3.7 (поля, типы, Req, enum-порядок).
// JSON Schema реестра генерируется отсюда (единый источник, решение 7 плана 1a);
// условная обязательность occurred_on (§3.3) — доменный инвариант executor'а, не схема.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AspectId } from '../constants';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date YYYY-MM-DD');
const timestampString = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  'ISO 8601 timestamp',
);
/** Денежная decimal-строка (§3.3): base-10 без экспоненты. */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal-строка');
const positiveDecimal = decimalString.refine(
  (v) => !v.startsWith('-') && Number.parseFloat(v) > 0,
  'строго положительная decimal-строка',
);
const nonNegativeDecimal = decimalString.refine((v) => !v.startsWith('-'), '>= 0');

export const scheduleAspectSchema = z.object({
  start_at: timestampString,
  end_at: timestampString.optional(),
  duration_min: z.number().int().positive().optional(),
  all_day: z.boolean().optional(),
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().positive(),
    byweekday: z.array(z.string()).optional(),
    until: dateString.optional(),
  }).strict().optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
}).strict();

export const taskAspectSchema = z.object({
  status: z.enum(['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled']),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  due_date: dateString.optional(),
  completed_at: timestampString.optional(),
  effort_min: z.number().int().positive().optional(),
  waiting_for: z.string().optional(),
}).strict();

export const financialAspectSchema = z.object({
  amount: positiveDecimal,
  currency: z.string().length(3).optional(),
  direction: z.enum(['income', 'expense']),
  category_ref: z.string().uuid(),
  occurred_on: dateString.optional(), // условная обязательность — инвариант §3.3 в executor'е
  planned: z.boolean().optional(),
  recurring: z.boolean().optional(),
  payment_method: z.string().optional(),
  counterparty: z.string().optional(),
}).strict();

export const noteAspectSchema = z.object({
  content_type: z.enum(['markdown', 'plain', 'checklist']).optional(),
  pinned: z.boolean().optional(),
}).strict();

export const budgetAspectSchema = z.object({
  category_ref: z.string().uuid(),
  limit: nonNegativeDecimal,
  currency: z.string().length(3).optional(),
  period_start: dateString,
  period_end: dateString,
  carryover: decimalString.optional(),
}).strict();

export const categoryAspectSchema = z.object({
  icon: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  aliases: z.array(z.string()).optional(),
  spend_class: z.enum(['fixed', 'discretionary']).optional(),
}).strict();

export const memoryAspectSchema = z.object({
  kind: z.enum(['fact', 'rule']),
  scope: z.string().optional(),
}).strict();

export const ASPECT_SCHEMAS = {
  'orbis/schedule': scheduleAspectSchema,
  'orbis/task': taskAspectSchema,
  'orbis/financial': financialAspectSchema,
  'orbis/note': noteAspectSchema,
  'orbis/budget': budgetAspectSchema,
  'orbis/category': categoryAspectSchema,
  'orbis/memory': memoryAspectSchema,
} as const satisfies Record<AspectId, z.ZodTypeAny>;

export function aspectJsonSchema(id: AspectId): Record<string, unknown> {
  return zodToJsonSchema(ASPECT_SCHEMAS[id], { $refStrategy: 'none' }) as Record<string, unknown>;
}

export type ScheduleAspect = z.infer<typeof scheduleAspectSchema>;
export type TaskAspect = z.infer<typeof taskAspectSchema>;
export type FinancialAspect = z.infer<typeof financialAspectSchema>;
export type NoteAspect = z.infer<typeof noteAspectSchema>;
export type BudgetAspect = z.infer<typeof budgetAspectSchema>;
export type CategoryAspect = z.infer<typeof categoryAspectSchema>;
export type MemoryAspect = z.infer<typeof memoryAspectSchema>;
```

Добавить `export * from './schemas/aspects';` в index.ts.

- [ ] **Step 3: Прогон и коммит**

Run: `bun test src/schemas/aspects.test.ts` → PASS; `bun run typecheck` из корня.

```bash
git add packages/shared/src/schemas/aspects.ts packages/shared/src/schemas/aspects.test.ts packages/shared/src/index.ts packages/shared/package.json bun.lock
git commit -m "feat(shared): zod-схемы 7 аспектов + генерация JSON Schema реестра (§3.1–§3.7)"
```

---

### Task 6: Сид реестра встроенных аспектов

**Files:**
- Create: `scripts/seed-aspects.ts` (корень)
- Create: `packages/shared/src/aspect-registry.ts` (метаданные: name, icon, description, ai_instructions, tag_mappings, view_config)
- Test: `apps/server/test/seed-aspects.test.ts`
- Modify: `package.json` (корень: `db:prepare` += сид), `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `aspectJsonSchema` (Task 5), `DATABASE_URL_ADMIN` (builtin-записи пишет только админ — RLS Task 2 не даёт `authenticated` писать `owner_id IS NULL`).
- Produces: 7 строк `aspect_definitions` с `owner_id IS NULL`; `BUILTIN_ASPECT_META` в shared — единственный источник метаданных реестра (потребляется сидом сейчас, MCP/AI-слоем в 1b).

- [ ] **Step 1: Метаданные реестра**

```ts
// packages/shared/src/aspect-registry.ts
// tag_mappings — дословно PRD 01 §3.1–§3.7; ai_instructions — короткие правила
// применения аспекта (попадают в описание attach_<aspect>-тулов, §7.6).
import type { AspectId } from './constants';

export interface BuiltinAspectMeta {
  id: AspectId;
  name: string;
  namespace: 'orbis';
  description: string;
  icon: string;
  aiInstructions: string;
  tagMappings: string[];
  viewConfig: { keyFields: string[] };
}

export const BUILTIN_ASPECT_META: BuiltinAspectMeta[] = [
  {
    id: 'orbis/schedule', name: 'Schedule', namespace: 'orbis', icon: '📅',
    description: 'Привязка сущности ко времени: событие, встреча, дедлайн по времени.',
    aiInstructions:
      'Применяй, когда во вводе есть дата или время события. start_at обязателен (ISO 8601 с таймзоной пользователя). recurrence задаётся только на шаблоне повторения; инстансы порождает сервер.',
    tagMappings: ['schedule', 'event', 'meeting', 'appointment'],
    viewConfig: { keyFields: ['start_at', 'end_at', 'all_day'] },
  },
  {
    id: 'orbis/task', name: 'Task', namespace: 'orbis', icon: '✅',
    description: 'Задача: действие с состоянием, приоритетом и сроком.',
    aiInstructions:
      'Применяй к действиям. status по умолчанию inbox; явный срок → due_date (date, не timestamp). completed_at проставляет сервер при переходе в done — не передавай его сам.',
    tagMappings: ['task', 'todo', 'action', 'deadline'],
    viewConfig: { keyFields: ['status', 'due_date', 'priority'] },
  },
  {
    id: 'orbis/financial', name: 'Financial', namespace: 'orbis', icon: '💸',
    description: 'Финансовая операция: расход или доход.',
    aiInstructions:
      'amount — строка decimal (например "340.00"), всегда положительная; знак задаёт direction. category_ref — uuid категории-сущности: резолви по aliases категорий через entity_query. occurred_on — дата операции в таймзоне пользователя.',
    tagMappings: ['expense', 'income', 'payment', 'cost'],
    viewConfig: { keyFields: ['amount', 'direction', 'category_ref'] },
  },
  {
    id: 'orbis/note', name: 'Note', namespace: 'orbis', icon: '📝',
    description: 'Маркер «главное назначение — текст»; содержимое живёт в body сущности.',
    aiInstructions:
      'Применяй, когда пользователь фиксирует мысль/заметку/документ. Текст кладётся в body сущности, не в поля аспекта.',
    tagMappings: ['note', 'thought', 'idea', 'journal'],
    viewConfig: { keyFields: ['content_type', 'pinned'] },
  },
  {
    id: 'orbis/budget', name: 'Budget', namespace: 'orbis', icon: '✉️',
    description: 'Конверт бюджета: лимит по категории на период.',
    aiInstructions:
      'Конверт на период: category_ref, limit (decimal-строка), period_start/period_end включительно. spent не хранится — вычисляется из транзакций-детей.',
    tagMappings: ['budget', 'envelope', 'limit'],
    viewConfig: { keyFields: ['limit', 'period_start', 'period_end'] },
  },
  {
    id: 'orbis/category', name: 'Category', namespace: 'orbis', icon: '🏷️',
    description: 'Категория финансовых операций: иерархия, синонимы, правила.',
    aiInstructions:
      'Категория — сущность, не строка. aliases — синонимы в нижнем регистре (рус+англ) для резолва ввода. Иерархия — через relation parent.',
    tagMappings: ['category'],
    viewConfig: { keyFields: ['icon', 'color', 'spend_class'] },
  },
  {
    id: 'orbis/memory', name: 'Memory', namespace: 'orbis', icon: '🧠',
    description: 'Память AI: факты о пользователе и правила обработки ввода.',
    aiInstructions:
      'kind=fact — знание о пользователе; kind=rule — правило обработки («бар → Развлечения»). scope — aspect-id домена, к которому правило привязано; пусто = глобально.',
    tagMappings: ['memory', 'preference', 'rule'],
    viewConfig: { keyFields: ['kind', 'scope'] },
  },
];
```

Экспортировать из index.ts.

- [ ] **Step 2: Падающий тест сид-результата**

```ts
// apps/server/test/seed-aspects.test.ts
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_IDS, aspectJsonSchema } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, requireEnv } from './helpers';

requireEnv();

describe('сид реестра аспектов', () => {
  test('7 builtin-строк; schema в БД байт-в-байт равна сгенерированной из shared', async () => {
    const { db, client } = adminDb();
    try {
      const rows = await db.execute(
        sql`SELECT id, schema FROM aspect_definitions WHERE owner_id IS NULL ORDER BY id`,
      );
      expect(rows.map((r) => r.id).sort()).toEqual([...BUILTIN_ASPECT_IDS].sort());
      for (const row of rows) {
        expect(row.schema).toEqual(aspectJsonSchema(row.id as (typeof BUILTIN_ASPECT_IDS)[number]));
      }
    } finally {
      await client.end();
    }
  });
});
```

Run → FAIL (реестр пуст).

- [ ] **Step 3: Сид-скрипт (идемпотентный upsert)**

```ts
// scripts/seed-aspects.ts — upsert builtin-аспектов; только DATABASE_URL_ADMIN.
import { BUILTIN_ASPECT_META, aspectJsonSchema } from '@orbis/shared';
import postgres from 'postgres';

const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) throw new Error('seed-aspects: DATABASE_URL_ADMIN не задан');
const sql = postgres(admin, { max: 1 });
try {
  for (const meta of BUILTIN_ASPECT_META) {
    await sql`
      INSERT INTO aspect_definitions
        (id, owner_id, name, namespace, description, icon, schema,
         ai_instructions, tag_mappings, view_config)
      VALUES
        (${meta.id}, NULL, ${meta.name}, ${meta.namespace}, ${meta.description},
         ${meta.icon}, ${sql.json(aspectJsonSchema(meta.id))}, ${meta.aiInstructions},
         ${meta.tagMappings}, ${sql.json(meta.viewConfig)})
      ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
        schema = EXCLUDED.schema, ai_instructions = EXCLUDED.ai_instructions,
        tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config`;
  }
  console.log(`seed-aspects: ${BUILTIN_ASPECT_META.length} builtin-аспектов upsert'нуто`);
} finally {
  await sql.end();
}
```

`db:prepare` в корне дополняется: `… && bun scripts/seed-aspects.ts && bun run test:rls`.

- [ ] **Step 4: Прогон и коммит**

Run: `bun scripts/seed-aspects.ts` (env админ) → 7 upsert'ов; повторный прогон — тоже 7, без дублей. `cd apps/server && bun test test/seed-aspects.test.ts` → PASS.

```bash
git add scripts/seed-aspects.ts packages/shared/src/aspect-registry.ts packages/shared/src/index.ts apps/server/test/seed-aspects.test.ts package.json
git commit -m "feat(registry): метаданные и идемпотентный сид 7 встроенных аспектов"
```

---

### Task 7: Query-парсер грамматики §6.1 (shared)

**Files:**
- Create: `packages/shared/src/query/parse.ts`
- Create: `packages/shared/src/query/catalog.ts`
- Test: `packages/shared/src/query/parse.test.ts`
- Modify: `packages/shared/src/query/grammar.ts` (только коммент `QueryExcludeTagsFilter`), `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: AST-типы `grammar.ts` (Веха 0, менять типы нельзя — фикстуры `fixtures.ts` на них завязаны), `BUILTIN_ASPECT_META`/`aspectJsonSchema` косвенно через каталог.
- Produces:
  - `interface FieldCatalog { fields: Record<string, FieldInfo[]> }` где `FieldInfo = { aspect: string; type: 'string'|'number'|'integer'|'decimal'|'date'|'timestamp'|'boolean'; enumValues?: string[] }`;
  - `buildFieldCatalog(defs: Array<{id: string; schema: Record<string, unknown>}>): FieldCatalog` — из JSON Schema реестра (обходит `properties`; `format: 'decimal'`/pattern decimal → `decimal`; pattern даты → `date`; timestamp-pattern → `timestamp`; `enum` → enumValues в порядке объявления);
  - `parseQuery(input: string, catalog: FieldCatalog): ParseResult` где `ParseResult = { ok: true; ast: QueryAst } | { ok: false; error: { message: string; position: number } }` — `position` — индекс символа в исходной строке (§6.4 «с указанием места»);
  - `CORE_FIELDS` — `created_at`/`updated_at` (тип `timestamp`); `title` в фильтре недоступен (§6.1).

Правила, которые парсер обязан реализовать дословно (§6.1, «Лексика и экранирование»):
1. Запрос — конструкции через запятую; значение в двойных кавычках может содержать `,`, `|`, `&`, пробелы по краям; внутри кавычек `\"` — экранированная кавычка; переводы строк эквивалентны пробелам.
2. Смешивание `|` и `&` в одном значении — ошибка парсинга.
3. Резолв имени: зарезервированные ключи (`tags`, `excludeTags`, `aspect`, `children_of`, `parents_of`, `excludeBlocked`, `archived`, `sortBy`, `search`, `limit`, `display`, `title`) → core-поля (`created_at`, `updated_at`) → поля аспектов по каталогу. `due` — алиас `due_date` (`orbis/task`). Неизвестное имя — ошибка; имя в двух аспектах без `aspect=` в запросе — ошибка «неоднозначное поле».
4. Date-токены `today|overdue|next_7d|after_7d` — только для полей типов `date`/`timestamp`.
5. Сравнения `>`/`<` и диапазон `..` — для `number`/`integer`/`decimal` (kind `decimal`) и core-timestamp (kind `timestamp`, значение — валидный ISO 8601).
6. `archived=true|any`; `excludeBlocked=true` (другие значения — ошибка); `limit` — целое > 0; `display` — из трёх значений.
7. `{{query: …}}`-обёртку парсер НЕ снимает — на вход приходит уже содержимое (снятие обёртки — забота рендерера body, 1c).

- [ ] **Step 1: Уточнить коммент `QueryExcludeTagsFilter`** (обязательство Вехи 0): заменить текст коммента на «Исключение тегов: `excludeTags=x|y` — исключить сущности, имеющие хотя бы один из перечисленных тегов. Семантика множественных значений выведена симметрично `tags=` (PRD 01 §6.1 фиксирует только форму `excludeTags=x`); при расхождении с PRD канон — PRD.»

- [ ] **Step 2: Падающие тесты (каждая строка грамматики + ошибки)**

```ts
// packages/shared/src/query/parse.test.ts
import { describe, expect, test } from 'bun:test';
import { buildFieldCatalog, parseQuery } from './parse';
import { BUILTIN_ASPECT_IDS } from '../constants';
import { aspectJsonSchema } from '../schemas/aspects';

const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);
const parse = (q: string) => parseQuery(q, catalog);

describe('parseQuery: позитивные случаи §6.1', () => {
  test('Daily Planning «Сегодня» — блок из 02 §3.3 парсится целиком', () => {
    const r = parse(
      'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n' +
      '         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n' +
      '         display=list, title=Сегодня',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters).toEqual([
      { kind: 'aspect', aspect: 'orbis/task' },
      { kind: 'field', field: 'due_date', condition: { kind: 'anyOf', values: [
        { kind: 'date_token', token: 'today' }, { kind: 'date_token', token: 'overdue' },
      ] } },
      { kind: 'field', field: 'status', condition: { kind: 'noneOf', values: [
        { kind: 'literal', value: 'done' }, { kind: 'literal', value: 'cancelled' },
        { kind: 'literal', value: 'waiting' },
      ] } },
      { kind: 'excludeBlocked' },
    ]);
    expect(r.ast.sortBy).toEqual([
      { field: 'priority', direction: 'desc' }, { field: 'due_date', direction: 'asc' },
    ]);
    expect(r.ast.display).toBe('list');
    expect(r.ast.title).toBe('Сегодня');
  });
  test('теги, исключение тегов, кавычки с запятой и экранированием', () => {
    const r = parse('tags=work|personal, excludeTags=archived-tag, title="My Tasks, \\"важное\\""');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters[0]).toEqual({ kind: 'tags', values: ['work', 'personal'] });
    expect(r.ast.filters[1]).toEqual({ kind: 'excludeTags', values: ['archived-tag'] });
    expect(r.ast.title).toBe('My Tasks, "важное"');
  });
  test('сравнение, диапазон, timestamp-курсор агента', () => {
    const r1 = parse('aspect=orbis/financial, amount>1000');
    expect(r1.ok && r1.ast.filters[1]).toEqual(
      { kind: 'comparison', field: 'amount', op: '>', value: { kind: 'decimal', value: '1000' } });
    const r2 = parse('aspect=orbis/financial, amount=500..2000');
    expect(r2.ok && r2.ast.filters[1]).toEqual({
      kind: 'range', field: 'amount',
      min: { kind: 'decimal', value: '500' }, max: { kind: 'decimal', value: '2000' } });
    const r3 = parse('updated_at>2026-07-02T09:00:00Z');
    expect(r3.ok && r3.ast.filters[0]).toEqual({
      kind: 'comparison', field: 'updated_at', op: '>',
      value: { kind: 'timestamp', value: '2026-07-02T09:00:00Z' } });
  });
  test('children_of/parents_of: uuid и this', () => {
    const id = '019ea8b1-4778-7f3d-9a5c-6a521fa1cc24';
    const r = parse(`children_of=${id}, parents_of=this`);
    expect(r.ok && r.ast.filters).toEqual([
      { kind: 'children_of', of: { kind: 'id', id } },
      { kind: 'parents_of', of: { kind: 'this' } },
    ]);
  });
  test('archived, limit, search, алиас due', () => {
    const r = parse('archived=any, limit=30, search=API, due=today');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters).toContainEqual({ kind: 'archived', value: 'any' });
    expect(r.ast.limit).toBe(30);
    expect(r.ast.search).toBe('API');
    expect(r.ast.filters).toContainEqual({ kind: 'field', field: 'due_date',
      condition: { kind: 'anyOf', values: [{ kind: 'date_token', token: 'today' }] } });
  });
});

describe('parseQuery: ошибки §6.4 (message + position)', () => {
  const fail = (q: string) => {
    const r = parse(q);
    expect(r.ok).toBe(false);
    return r.ok ? { message: '', position: -1 } : r.error;
  };
  test('смешивание | и & в одном значении', () => {
    expect(fail('status=a|b&!c').message).toMatch(/смешивание/i);
  });
  test('неизвестное поле — с позицией', () => {
    const e = fail('aspect=orbis/task, statuss=done');
    expect(e.message).toMatch(/неизвестное поле/i);
    expect(e.position).toBe('aspect=orbis/task, '.length);
  });
  test('неоднозначное поле без aspect=', () => {
    // category_ref есть и в orbis/financial, и в orbis/budget
    expect(fail('category_ref=019d48ea-2e00-7a52-876a-c301529b0456').message).toMatch(/неоднозначн/i);
  });
  test('date-токен на нечисловом/недатовом поле', () => {
    expect(fail('aspect=orbis/task, status=today').message).toMatch(/date-токен|дат/i);
  });
  test('title в позиции фильтра занят параметром — отбор по заголовку только search=', () => {
    const r = parse('title=My');
    expect(r.ok && r.ast.title).toBe('My'); // это параметр заголовка, не фильтр
  });
  test('незакрытая кавычка, нулевой limit, кривой display', () => {
    expect(fail('title="oops').message).toMatch(/кавычк/i);
    expect(fail('limit=0').message).toMatch(/limit/i);
    expect(fail('display=grid').message).toMatch(/display/i);
  });
});
```

Run → FAIL (модуля parse нет).

- [ ] **Step 3: Реализация**

Каталог — прямой обход JSON Schema:

```ts
// packages/shared/src/query/catalog.ts
export type FieldType = 'string' | 'number' | 'integer' | 'decimal' | 'date' | 'timestamp' | 'boolean';
export interface FieldInfo { aspect: string; type: FieldType; enumValues?: string[] }
export interface FieldCatalog { fields: Record<string, FieldInfo[]> }

const DATE_PATTERN = String.raw`^\d{4}-\d{2}-\d{2}$`;

export function buildFieldCatalog(
  defs: Array<{ id: string; schema: Record<string, unknown> }>,
): FieldCatalog {
  const fields: Record<string, FieldInfo[]> = {};
  for (const def of defs) {
    const props = (def.schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      const info: FieldInfo = { aspect: def.id, type: propType(prop) };
      if (Array.isArray(prop.enum)) info.enumValues = prop.enum as string[];
      (fields[name] ??= []).push(info);
    }
  }
  return { fields };
}

function propType(prop: Record<string, unknown>): FieldType {
  if (prop.type === 'number') return 'number';
  if (prop.type === 'integer') return 'integer';
  if (prop.type === 'boolean') return 'boolean';
  if (prop.type === 'string') {
    const pattern = typeof prop.pattern === 'string' ? prop.pattern : '';
    if (pattern === DATE_PATTERN || /ISO date/.test(String((prop as { errorMessage?: unknown }).errorMessage ?? ''))) return 'date';
    if (pattern.includes('T\\d{2}') || pattern.includes('T\\\\d{2}')) return 'timestamp';
    if (pattern.includes(String.raw`^-?\d+(\.\d+)?$`)) return 'decimal';
    return 'string';
  }
  return 'string';
}
```

(Точная эвристика `propType` подгоняется под фактический вывод zod-to-json-schema — покрыть отдельным юнит-тестом в этом же файле теста: `catalog.fields.due_date[0].type === 'date'`, `amount → decimal`, `start_at → timestamp`, `status → string + enumValues`. Тип из фактического паттерна, а не из догадки.)

Парсер — один файл, «токенайзер верхнего уровня + словарь обработчиков». Обязательные элементы реализации:

```ts
// packages/shared/src/query/parse.ts — скелет обязательной структуры
// splitTopLevel: режет строку по запятым вне кавычек, помнит позицию каждой части.
// parsePart: находит оператор (=, >, <) вне кавычек; ключ слева, значение справа.
// unquote: снимает кавычки и \" внутри; незакрытая кавычка — ошибка с позицией открытия.
// resolveField: reserved → core → каталог (+ алиас due); собирает и валидирует.
export function parseQuery(input: string, catalog: FieldCatalog): ParseResult {
  const normalized = input.replaceAll('\n', ' '); // переводы строк = пробелы (§6.1)
  const parts = splitTopLevel(normalized);        // [{ text, offset }]
  const filters: QueryFilter[] = [];
  const ast: QueryAst = { filters };
  const aspectsInQuery = new Set<string>();
  for (const part of parts) { /* … диспетчеризация по ключу … */ }
  return { ok: true, ast };
}
```

Ключевые ветки диспетчера (полный список — интерфейсная секция выше): `tags`/`excludeTags` (split по `|`), `aspect` (запомнить в `aspectsInQuery` — участвует в резолве неоднозначных полей), `children_of`/`parents_of` (uuid-регекс или `this`), `excludeBlocked`, `archived`, `sortBy` (split `|`, каждый — `field:direction`), `search`, `limit` (`Number.parseInt`, `>0`), `display`, `title`; оператор `>`/`<` → comparison (валидация типа поля по каталогу: decimal-типы → `{kind:'decimal'}`, core-timestamp → ISO-проверка → `{kind:'timestamp'}`); значение с `..` → range; иначе поле-фильтр: значение с `&` (все элементы обязаны начинаться с `!`) → `noneOf`; с `|` или одиночное → `anyOf`; элементы-токены дат распознаются по множеству `today|overdue|next_7d|after_7d` и допускаются только для полей типа date/timestamp. Ошибки — всегда `{ message, position }`, каждая ветка знает offset своей части.

- [ ] **Step 4: Прогон и коммит**

Run: `cd packages/shared && bun test src/query/` → PASS (parse + существующие fixtures). Полная цепочка из корня.

```bash
git add packages/shared/src/query packages/shared/src/index.ts
git commit -m "feat(query): парсер грамматики §6.1 с каталогом полей и структурными ошибками §6.4"
```

---

### Task 8: SQL-компилятор query-движка (server) + golden-тесты

**Files:**
- Create: `apps/server/src/query/compile.ts`
- Test: `apps/server/src/query/compile.golden.test.ts` (SQL-снапшоты), `apps/server/src/query/compile.dataset.test.ts` (эталонный датасет)
- Create: `apps/server/test/golden/query-sql.json` (фикстуры «запрос → SQL+params»)

**Interfaces:**
- Consumes: `QueryAst`, `FieldCatalog`, `parseQuery` (shared); `withIdentity`/`Tx` (Task 3); реестр из БД (Task 6).
- Produces:
  - `interface CompileContext { catalog: FieldCatalog; thisEntityId: string | null; today: string; timezone: string }` — `today` (YYYY-MM-DD в таймзоне пользователя) и `timezone` **инжектируются вызывающим** (детерминизм, Global Constraints);
  - `compileQuery(ast: QueryAst, ctx: CompileContext): SQL` — drizzle-`sql`-фрагмент полного SELECT;
  - `compileCount(ast: QueryAst, ctx: CompileContext): SQL` — `SELECT count(*)`, игнорирует `limit`/`sortBy` (бейджи 02 §3.2);
  - `loadCatalog(tx: Tx): Promise<FieldCatalog>` — каталог из `aspect_definitions` (builtin + свои; кэш на процесс с инвалидацией не нужен в 1a — читается на запрос, оптимизация позже).

Обязательная семантика компиляции (из §6.1 и решений плана):

| Конструкция | SQL-фрагмент |
|---|---|
| базовый | `SELECT id, owner_id, title, emoji, body, body_refs, tags, meta, aspects, created_at, updated_at, archived FROM entities WHERE true` (owner-фильтр НЕ добавляем — его даёт RLS; исполнение только под `withIdentity`) |
| `tags=a\|b` | `AND tags && ARRAY[a,b]::text[]` (OR = overlap) |
| `excludeTags=x` | `AND NOT (tags && ARRAY[x]::text[])` |
| `aspect=A` | `AND aspects ? A` |
| поле anyOf (literal) | `AND aspects->'A'->>'f' IN (…)`; поле без аспекта в запросе, найденное в одном аспекте каталога — путь этого аспекта |
| поле noneOf | `AND (aspects->'A'->>'f' IS NULL OR aspects->'A'->>'f' NOT IN (…))` (решение 10: NULL проходит) |
| date-токены (поле типа date) | `today` → `(…->>'f')::date = ctx.today::date`; `overdue` → `< ctx.today::date`; `next_7d` → `BETWEEN ctx.today::date AND ctx.today::date + 7` (обе границы включительно); `after_7d` → `> ctx.today::date + 7`; несколько токенов/литералов в anyOf — OR по скобкам |
| date-токены (поле типа timestamp) | те же сравнения над `((…->>'f')::timestamptz AT TIME ZONE ctx.timezone)::date` |
| `f>v` / `f<v` / `f=a..b` (decimal) | `(aspects->'A'->>'f')::numeric > v::numeric` / `BETWEEN a::numeric AND b::numeric` — сравнение через numeric, не float (§3.3) |
| `created_at`/`updated_at` сравнения | прямые колонки, `> ${v}::timestamptz` |
| `children_of=X` | `AND id IN (SELECT target_id FROM relations WHERE source_id = X AND relation_type = 'parent')`; `this` → `ctx.thisEntityId`, а если он NULL — структурированная ошибка компиляции «this вне контекста сущности» |
| `parents_of=X` | зеркально по `source_id` |
| `excludeBlocked=true` | `AND NOT EXISTS (SELECT 1 FROM relations r JOIN entities b ON b.id = r.source_id WHERE r.target_id = entities.id AND r.relation_type = 'blocks' AND COALESCE(b.aspects->'orbis/task'->>'status','') NOT IN ('done','cancelled'))` — блокер без task-аспекта считается живым (§6.1: статус НЕ в done\|cancelled) |
| archived | нет узла → `AND NOT archived`; `true` → `AND archived`; `any` → ничего |
| `search=q` | `AND (to_tsvector('simple', title) @@ plainto_tsquery('simple', q) OR to_tsvector('simple', body) @@ plainto_tsquery('simple', q))` |
| `sortBy` enum-поля | `ORDER BY CASE aspects->'A'->>'f' WHEN v0 THEN 0 WHEN v1 THEN 1 … END {ASC\|DESC} NULLS LAST` — порядок из `enumValues` каталога (§6.1) |
| `sortBy` прочие | `(aspects->'A'->>'f') {dir} NULLS LAST`; date/numeric-поля — с кастом `::date`/`::numeric`; core-поля — колонкой |
| limit | `LIMIT n`; без `limit=` — `LIMIT 500` (решение 11); `compileCount` — без LIMIT вовсе |

- [ ] **Step 1: Golden-фикстуры и падающий SQL-тест**

`apps/server/test/golden/query-sql.json` — минимум 12 пар, включая обязательные: запрос-иллюстрацию §6.1 (блок «Активные задачи проекта» — сверить форму с псевдо-SQL PRD), все три smart-list-блока Daily Planning, `updated_at>…Z` (курсор агента §9.3), `amount=500..2000`, `archived=any`, `search=API`, `excludeTags`. Тест:

```ts
// apps/server/src/query/compile.golden.test.ts
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import goldens from '../../test/golden/query-sql.json';
import { buildFieldCatalog, parseQuery, aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { compileQuery } from './compile';

const dialect = new PgDialect();
const catalog = buildFieldCatalog(BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })));
const CTX = { catalog, thisEntityId: '00000000-0000-7000-8000-0000000000f1',
  today: '2026-07-03', timezone: 'Europe/Moscow' } as const;

describe('golden: грамматика → SQL (§6.2)', () => {
  for (const g of goldens as Array<{ name: string; query: string; sql: string; params: unknown[] }>) {
    test(g.name, () => {
      const parsed = parseQuery(g.query, catalog);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const q = dialect.sqlToQuery(compileQuery(parsed.ast, CTX));
      expect(q.sql.replaceAll(/\s+/g, ' ').trim()).toBe(g.sql);
      expect(q.params).toEqual(g.params);
    });
  }
});
```

Порядок работы: реализация → снять фактический `{sql, params}` → **вручную проверить каждый** против таблицы семантики выше → зафиксировать в JSON. Golden-файл — не «что вышло», а проверенный эталон; в отчёте задачи перечислить проверки.

- [ ] **Step 2: Датасет-тест (реальная БД, под RLS)**

`compile.dataset.test.ts`: `beforeAll` — `truncateAll()`, затем под `withIdentity(userA)` вставить эталонный набор из 10 сущностей (2 пользователя, задачи со статусами/сроками/приоритетами, financial-транзакции с decimal-суммами `"0.10"`/`"0.20"`/`"1000.00"`, blocks-связь, архивная сущность, родитель+дети) — датасет описать константой в файле теста. Обязательные проверки состава И порядка (§6.2):
1. блок «Сегодня» Daily Planning возвращает просроченную и сегодняшнюю задачи, отсортированные priority:desc, без заблокированной (`excludeBlocked`) и без чужих (RLS);
2. `amount>500` находит `"1000.00"`, но не `"340.00"`; `amount=0.10..0.30` находит `"0.10"`,`"0.20"` (decimal, не float);
3. `updated_at>` середины вставки возвращает только позднюю половину (курсор агента);
4. `children_of=<проект>` — только дети; `archived=any` включает архивную; `search=` находит по слову из body;
5. сортировка `priority:desc` даёт high→medium→low→NULL (порядок enum, NULLS LAST);
6. userB через `withIdentity(userB)` на тех же запросах получает 0 строк.

- [ ] **Step 3: Реализация compile.ts**

Структура: `compileQuery` строит массив `SQL`-фрагментов условий через `sql.append`/`sql.join`; каждый фильтр — своя функция; путь поля — helper `fieldExpr(field, catalog, aspectsInQuery)` возвращающий `{ expr: SQL; type: FieldType }` (ошибки резолва невозможны — их отсёк парсер, но `this=NULL` проверяется здесь). Кастинг по типу — helper `castExpr`. `loadCatalog`:

```ts
export async function loadCatalog(tx: Tx): Promise<FieldCatalog> {
  const rows = await tx.execute(
    sql`SELECT id, schema FROM aspect_definitions`); // RLS: builtin + свои (§4.10)
  return buildFieldCatalog(rows as Array<{ id: string; schema: Record<string, unknown> }>);
}
```

- [ ] **Step 4: Прогон и коммит**

Run: `cd apps/server && bun test src/query/` → PASS оба сьюта; полная цепочка из корня.

```bash
git add apps/server/src/query apps/server/test/golden
git commit -m "feat(query): SQL-компилятор §6.1→Postgres + golden-снапшоты и эталонный датасет (§6.2)"
```

---

### Task 9: Executor — конвейер 7 стадий, entity_create/entity_update/attach, идемпотентность

**Files:**
- Create: `packages/shared/src/contracts/tools.ts` (zod-envelopes тулов §9.2 — wire-контракт, общий для tRPC/AI/MCP)
- Create: `apps/server/src/executor/types.ts`, `apps/server/src/executor/executor.ts`, `apps/server/src/executor/normalize.ts`, `apps/server/src/executor/aspects-validate.ts`, `apps/server/src/executor/errors.ts`, `apps/server/src/entitlements.ts`
- Test: `apps/server/src/executor/executor.test.ts`
- Delete: `packages/shared/src/contracts/retry-idempotency.test.ts` (контракт реализуется настоящим интеграционным тестом здесь; в отчёте задачи сослаться)
- Modify: `packages/shared/src/index.ts`, `apps/server/package.json` (dep `ajv@^8`, `ajv-formats@^3`)

**Interfaces:**
- Consumes: `withIdentity`/`Tx`, `newId`, `ASPECT_SCHEMAS`-реестр из БД (ajv), zod.
- Produces (на них встают Task 10–15 и весь 1b):

```ts
// executor/types.ts — точные сигнатуры
export type ActorKind = 'owner' | 'ai' | 'agent';
export type MutationSource = 'chat' | 'fast_path' | 'quick_capture' | 'mcp' | 'system';
export interface ExecuteRequest {
  actorUserId: string;          // владелец графа (D11); в MVP актор-владелец = owner
  actorKind: ActorKind;
  source: MutationSource;
  threadId?: string;            // тред для audit-сообщения; нет → глобальный тред владельца
  operations: Array<{ tool: string; input: unknown }>; // 1 элемент = одиночный вызов
  batchId?: string;             // обязателен при operations.length > 1
  clock?: () => Date;           // инъекция времени (тесты); default () => new Date()
}
export interface ExecuteOk {
  ok: true;
  actionId: string;
  results: unknown[];           // по одному на операцию (wire-формы сущностей/relations)
  idempotentReplay: boolean;    // true: повтор — ничего не применялось
}
export interface ExecuteErr {
  ok: false;
  error: { code: string; message: string; details?: unknown }; // структурированная (§9.2)
}
export type ExecuteResult = ExecuteOk | ExecuteErr;
export function execute(db: Db, req: ExecuteRequest): Promise<ExecuteResult>;
```

- Envelope-схемы (shared, дословно §9.2 + решение 4 плана): `entityCreateInput`, `entityUpdateInput`, `attachAspectInput`, `relationCreateInput`, `relationDeleteInput`, `batchExecuteInput`, `entityQueryInput`, `entityGetInput`;
- Коды ошибок (`errors.ts`): `VALIDATION` (стадии 1–2), `NOT_FOUND`, `STALE_VERSION` (optimistic-check §5.2), `INVARIANT` (доменные §4.2/§3.3, в `details` — специфика, для цикла — `path`), `FORBIDDEN_LEVEL` (зарезервирован под §7.10, 1b), `LIMIT` (entitlements);
- `entitlements.ts`: `resolveEntitlement(subjectUserId: string, key: string): { allowed: true; limit: number | null }` — план `'dev'` → всё разрешено без лимитов (§8: субъект — параметром, D11); вызывается стадией 4 (в 1a — no-op гейт, точка врезки для 1b).

В этой задаче конвейер реализуется для `entity_create`, `entity_update`, `attach_<aspect>` (одиночные, без batch); стадии 6–7 (inverse+cards, audit) — временный интерфейс `JournalSink` с in-memory реализацией для тестов; настоящий синк в chat_messages подключает Task 11. Стадии:

1. **validate envelope** — zod-схема тула; неизвестный тул → `VALIDATION`.
2. **validate aspects** — ajv по `schema` из `aspect_definitions` (кэш скомпилированных валидаторов per aspect id+owner в `aspects-validate.ts`); для `entity_update` — валидация **результата merge** (см. ниже), не патча.
3. **load state** — текущие строки затронутых сущностей (под `withIdentity` тем же tx).
4. **validate all before first write** — доменные правила (ниже) + entitlements-гейт.
5. **apply in transaction** — все операции в одном `withIdentity`-tx.
6. **inverse ops + cards** — обратные операции §7.8 + данные карточки.
7. **audit** — `JournalSink.write(...)` в том же tx.

Доменные правила стадии 4 (`normalize.ts` + проверки):
- `tags` нормализуются в нижний регистр и дедуплицируются;
- `body_refs` извлекаются из body регексом `/\[\[entity:([0-9a-f-]{36})(?:\|[^\]]*)?\]\]/gi` при каждом create/update, затрагивающем body;
- `entity_update.aspects` — merge §9.2: ключ-аспект `null` → detach; объект → shallow merge полей поверх текущих; поле `null` внутри → удалить поле; **результат** валидируется ajv;
- переход `status` в `done` без переданного `completed_at` → проставить `clock()`; уход из `done` → очистить `completed_at` (01 §3.2);
- `body` в патче → `expectedUpdatedAt` обязателен; несовпадение с текущим `updated_at` (сравнение миллисекунд ISO) → `STALE_VERSION` (§5.2); патчи без body — LWW без проверки;
- financial-инвариант §3.3: аспект с `recurring=true` валиден только при `orbis/schedule.recurrence` на той же сущности (или входящей `derived_from` — проверка появится с relations в Task 10; до того — только recurrence-ветка); не-шаблон (`recurring` falsy) обязан иметь `occurred_on`;
- `updated_at` проставляется сервером на каждый успешный update; `created_at`/`updated_at` create — сервером (`clock()`).

Идемпотентность `entity_create` (§5.3, §9.1): `INSERT … ON CONFLICT (id) DO NOTHING RETURNING *`; пусто → `SELECT` существующей (RLS гарантирует владение) → `{ ok: true, idempotentReplay: true, results: [существующая] }`, стадии 6–7 пропускаются.

- [ ] **Step 1: Envelope-схемы + юнит-тесты (shared)** — `tools.ts` дословно §9.2 (нотация `*`/`?`), например:

```ts
// packages/shared/src/contracts/tools.ts (фрагмент — остальные по той же схеме §9.2)
import { z } from 'zod';
import { RELATION_TYPES } from '../constants';

export const entityCreateInput = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1),
  emoji: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()),          // обязателен по §9.2 (может быть пустым)
  meta: z.record(z.unknown()).optional(),
  aspects: z.record(z.record(z.unknown())).optional(),
}).strict();

export const entityUpdateInput = z.object({
  id: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime().optional(), // §5.2; обязателен при body — executor
  title: z.string().min(1).optional(),
  emoji: z.string().nullable().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.unknown()).optional(),
  aspects: z.record(z.union([z.record(z.unknown()), z.null()])).optional(),
  archived: z.boolean().optional(),
}).strict();

export const attachAspectInput = z.object({
  entity_id: z.string().uuid(),
  data: z.record(z.unknown()),
}).strict();

export const relationCreateInput = z.object({
  source_id: z.string().uuid(),
  target_id: z.string().uuid(),
  relation_type: z.enum(RELATION_TYPES),
}).strict();
export const relationDeleteInput = relationCreateInput;

export const batchExecuteInput = z.object({
  batch_id: z.string().uuid(),
  operations: z.array(z.object({ tool: z.string(), input: z.record(z.unknown()) })).min(1),
}).strict();

export const entityQueryInput = z.object({ query: z.string().min(1) }).strict();
export const entityGetInput = z.object({
  id: z.string().uuid(),
  include: z.array(z.enum(['body', 'relations', 'backlinks', 'thread'])).optional(),
}).strict();

export type EntityCreateInput = z.infer<typeof entityCreateInput>;
export type EntityUpdateInput = z.infer<typeof entityUpdateInput>;
export type AttachAspectInput = z.infer<typeof attachAspectInput>;
export type RelationCreateInput = z.infer<typeof relationCreateInput>;
export type RelationDeleteInput = z.infer<typeof relationDeleteInput>;
export type BatchExecuteInput = z.infer<typeof batchExecuteInput>;
export type EntityQueryInput = z.infer<typeof entityQueryInput>;
export type EntityGetInput = z.infer<typeof entityGetInput>;
```

- [ ] **Step 2: Падающие интеграционные тесты executor'а** — минимум:
1. create: happy path — сущность в БД, tags lowercased, body_refs извлечены, `createdAt` от `clock`;
2. create: невалидный аспект (`amount: 340` числом) → `VALIDATION`, в БД строки нет (стадии до записи);
3. create: financial без `occurred_on` и без recurring → `INVARIANT`;
4. **идемпотентность: повторный create с тем же id → `idempotentReplay: true`, count строк = 1, результат равен первому** (контракт `retry-idempotency`, §13.2);
5. update: merge аспектов — передали `{status:'done'}` → `priority` сохранился, `completed_at` проставлен; `{aspects:{'orbis/task':null}}` → detach; поле `null` → удалено;
6. update body без `expectedUpdatedAt` → `VALIDATION`; со stale-значением → `STALE_VERSION`; после перечитывания — успех (§13.1); патч tags со stale-версией — проходит (LWW);
7. чужая сущность (userB) → `NOT_FOUND` (RLS скрывает);
8. `attach_orbis_task` на сущность без аспекта → аспект появился, валидация данными реестра работает.

- [ ] **Step 3: Реализация** (`executor.ts` — конвейер как последовательность чистых функций над `ExecCtx {tx, actor, clock, registry}`; `aspects-validate.ts` — ajv с `addFormats` и кастом-форматом `decimal`). Удалить `packages/shared/src/contracts/retry-idempotency.test.ts`.

- [ ] **Step 4: Прогон и коммит**

```bash
git add packages/shared/src/contracts apps/server/src/executor apps/server/src/entitlements.ts apps/server/package.json bun.lock packages/shared/src/index.ts
git commit -m "feat(executor): конвейер 7 стадий, entity_create/update/attach, идемпотентность по client-UUID"
```

---

### Task 10: Executor — relations, доменные инварианты графа, batch_execute

**Files:**
- Create: `apps/server/src/executor/invariants.ts`
- Modify: `apps/server/src/executor/executor.ts` (тулы `relation_create`/`relation_delete`, ветка batch)
- Test: `apps/server/src/executor/relations.test.ts`, `apps/server/src/executor/batch.test.ts`

**Interfaces:**
- Consumes: Task 9 (конвейер, envelopes, `JournalSink`), `batchAuditMessageId` (Task 4).
- Produces: полный набор мутирующих core-тулов §9.2; `assertAcyclicBlocks(tx, sourceId, targetId): Promise<void>` (бросает `INVARIANT` с `details.path`), `assertSingleBudgetParent(tx, sourceId, targetId): Promise<void>`.

Инварианты (§4.2):

**Ацикличность `blocks`** — перед вставкой `blocks(source→target)` проверить, достижим ли `source` из `target` по существующим blocks-рёбрам; если да — цикл, путь вернуть в ошибке:

```sql
WITH RECURSIVE walk AS (
  SELECT r.target_id, ARRAY[r.source_id, r.target_id] AS path
  FROM relations r WHERE r.source_id = $target AND r.relation_type = 'blocks'
  UNION ALL
  SELECT r.target_id, walk.path || r.target_id
  FROM relations r JOIN walk ON r.source_id = walk.target_id
  WHERE r.relation_type = 'blocks' AND NOT r.target_id = ANY(walk.path)
)
SELECT path FROM walk WHERE target_id = $source LIMIT 1;
```

Непустой результат → `INVARIANT`, `details.path` = `[$source, …найденный путь…]` в порядке «A → B → C → A» (титулы подтягиваются для сообщения; UI-текст — 02 §6).

**Один budget-parent** (§4.2, §13.7) — при `parent(source→target)`, где source имеет `orbis/budget` и target — `orbis/financial`: сериализовать конкурентов блокировкой строки транзакции: `SELECT id FROM entities WHERE id = $target FOR UPDATE`, затем проверить `NOT EXISTS` другой живой `parent`-связи от сущности с `orbis/budget` к этому target; нарушение → `INVARIANT`.

**derived_from-ветка financial-инварианта** (§3.3, отложено из Task 9): `recurring=true` без `recurrence` валиден, если существует входящая `derived_from` ИЛИ она создаётся в том же batch (стадия 4 видит все операции batch).

**batch_execute** (§7.8, §9.2): допустимы мутирующие core- и attach-тулы, кроме вложенного batch; весь batch валидируется до первой записи (стадии 1–4 для всех операций над «виртуальным» состоянием: create в операции N виден проверкам операции N+1); применяется одним tx; action получает `id = batch_id`; идемпотентность — вставка audit-сообщения с PK `batchAuditMessageId(ownerId, batchId)`: конфликт по PK (ловить `23505` именно этого constraint'а) → откат tx → прочитать сохранённое сообщение → вернуть его `results` с `idempotentReplay: true`.

- [ ] **Step 1: Падающие тесты** — минимум: relation happy-path + `rel_uniq`-повтор (повторная вставка той же тройки → структурированная ошибка, не 500); самосвязь → ошибка (CHECK); цикл A→B→C→A отклонён с путём (§13-стиль); две конкурентные привязки транзакции к двум конвертам (`Promise.all`) → ровно одна живая связь, второй вызов — `INVARIANT` (§13.7); batch «create + attach + relation» атомарен — вторая операция с невалидным аспектом откатывает все три (§13.4); повтор успешного batch с тем же `batch_id` → `idempotentReplay: true`, данные не задвоены (§13.4); `relation_delete` удаляет; пересоздание после удаления — новая строка.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3: Прогон, полная цепочка, коммит**

```bash
git add apps/server/src/executor
git commit -m "feat(executor): relations, ацикличность blocks с путём цикла, один budget-parent, атомарный batch_execute"
```

---

### Task 11: Треды, журнал действий и Undo

**Files:**
- Create: `apps/server/src/chat/threads.ts`, `apps/server/src/chat/messages.ts`
- Create: `apps/server/src/executor/journal.ts` (настоящий `JournalSink`), `apps/server/src/executor/undo.ts`
- Test: `apps/server/src/chat/threads.test.ts`, `apps/server/src/executor/journal.test.ts`, `apps/server/src/executor/undo.test.ts`

**Interfaces:**
- Consumes: `globalThreadId`/`entityThreadId` (Task 4), executor (Task 9–10), `newId`.
- Produces:
  - `ensureGlobalThread(tx, ownerId): Promise<string>` / `ensureEntityThread(tx, ownerId, entityId): Promise<string>` — `INSERT … ON CONFLICT DO NOTHING` + `SELECT`; детерминированные ID → конкурентные вызовы сходятся к одной строке (§4.5, §13.3);
  - `appendMessage(tx, {id, threadId, role, content, metadata}): Promise<WireChatMessage>` — append-only вставка;
  - `JournalSink` (боевой): пишет системное audit-сообщение в целевой тред (решение 5 плана) — `metadata = { actions: [action], cards: [card] }`, формат action — **дословно §7.8** + атрибуция `actor_user_id`, `actor_kind` (D11);
  - `undoAction(db, {actorUserId, actionId}): Promise<ExecuteResult>` и `undoLast(db, {actorUserId}): Promise<ExecuteResult>`.

Формат элемента журнала (§7.8 + атрибуция):

```json
{
  "id": "<uuid: batch_id для batch, иначе новый uuidv7>",
  "type": "entity_created | entity_updated | relation_created | relation_deleted | batch",
  "entity_id": "<uuid | null>",
  "actor_user_id": "<uuid>",
  "actor_kind": "owner | ai | agent",
  "source": "chat | fast_path | quick_capture | mcp | system",
  "operations": [{ "op": "entity_create", "payload": { "...": "как исполнено" } }],
  "inverse": [{ "op": "entity_update", "payload": { "id": "...", "archived": true } }]
}
```

Обратные операции (§7.8): create → `{op:'entity_update', payload:{id, archived:true}}` (создание → архивация; жёсткого удаления нет); update → `entity_update` с прежними значениями изменённых полей (для аспектов — прежнее значение всего затронутого аспект-ключа: shallow-merge делает пофазовый откат ненадёжным, восстанавливаем ключ целиком); attach → `entity_update` с прежним значением аспект-ключа (`null`, если не было); relation_create → `relation_delete` с той же тройкой; relation_delete → `relation_create`. Для batch `inverse` — в обратном порядке исполнения.

Семантика Undo (§7.8, дословно):
- отмена НЕ правит записанное сообщение — добавляет **новое системное сообщение** `{ type: 'undo', undoes: '<action_id>' }` в тот же тред;
- действие отменено ⇔ существует undo-сообщение с его id; повторная отмена отклоняется этой проверкой (`VALIDATION`, «уже отменено»);
- `undoLast` сканирует сообщения владельца с конца (по `created_at DESC`), пропуская отменённые действия и сами undo-записи, применяет `inverse` первого неотменённого;
- применение inverse — в одном tx с записью undo-сообщения; нового action **не порождает** (undo неотменяем);
- поиск действия по id — containment-запрос `metadata @> '{"actions":[{"id":"<actionId>"}]}'::jsonb` (GIN-индекс из Task 2).

- [ ] **Step 1: Падающие тесты тредов** — конкурентный `ensureEntityThread` с двух промисов → одна строка с ожидаемым `entityThreadId(...)` (§13.3); `ensureGlobalThread` идемпотентен; сообщение в чужой тред под userB → ошибка RLS.
- [ ] **Step 2: Падающие тесты журнала** — после `execute(entity_create, source:'fast_path')` в глобальном треде владельца есть системное сообщение: `metadata.actions[0]` содержит все поля формата, `inverse` = архивация; после batch — ровно одно сообщение с `id = batch_id`; `idempotentReplay` не пишет второго сообщения.
- [ ] **Step 3: Падающие тесты Undo** — undo create → сущность `archived=true`, в треде undo-сообщение; повторный undo того же action → `VALIDATION`; undo update возвращает прежний title и прежний аспект-ключ целиком; `undoLast` пропускает уже отменённое и берёт следующее; undo relation_create удаляет связь.
- [ ] **Step 4: Реализация; подключить боевой `JournalSink` в executor (in-memory остаётся для юнитов).**
- [ ] **Step 5: Прогон, полная цепочка, коммит**

```bash
git add apps/server/src/chat apps/server/src/executor
git commit -m "feat(journal): треды с детерминированными ID, журнал действий §7.8 и Undo"
```

---

### Task 12: tRPC-роутеры entity / relation / chat / ai(undo) + wire-сериализация таймстампов

**Files:**
- Create: `apps/server/src/routers/entity.ts`, `apps/server/src/routers/relation.ts`, `apps/server/src/routers/chat.ts`, `apps/server/src/routers/ai.ts`, `apps/server/src/wire.ts`
- Modify: `apps/server/src/router.ts` (сборка), `apps/server/src/trpc.ts` (в `Context` добавляется `db: Db`), `apps/server/src/index.ts` (создание `db` при старте)
- Test: `apps/server/src/routers/entity.test.ts`, `apps/server/src/routers/chat.test.ts`, `apps/server/src/wire.test.ts`
- Delete: `packages/shared/src/contracts/optimistic-check.test.ts` (контракт закрыт интеграционными тестами Task 9 + маппингом 409 здесь; сослаться в отчёте)

**Interfaces:**
- Consumes: executor (`execute`), `compileQuery`/`compileCount`/`loadCatalog`, `parseQuery`, треды/Undo (Task 11), envelope-схемы shared.
- Produces (сигнатуры — контракт для web 1c и MCP 1b):
  - `entity.create({ input: EntityCreateInput; source: 'fast_path' | 'quick_capture' }) → WireEntity` (мутация; `actorKind: 'owner'`);
  - `entity.update(EntityUpdateInput) → WireEntity`;
  - `entity.get(EntityGetInput) → { entity: WireEntity; relations?: WireRelation[]; backlinks?: WireEntity[]; thread?: { threadId: string; messages: WireChatMessage[] } }` — `include` по §9.2: default `body`+`relations`; `backlinks` — `WHERE body_refs @> ARRAY[id]`; `thread` — детерминированный `entityThreadId` (лениво НЕ создаёт: нет треда → `thread: { threadId, messages: [] }`);
  - `entity.query({ query: string; thisEntityId?: string }) → WireEntity[]` (query-процедура; ошибка парсинга → TRPCError `BAD_REQUEST` с `{ message, position }` в `cause` — §6.4 «структурированная ошибка»);
  - `entity.count({ query: string; thisEntityId?: string }) → { count: number }` (без limit — бейджи 02 §3.2);
  - `relation.create(RelationCreateInput) → WireRelation`; `relation.delete(RelationDeleteInput) → { ok: true }`; `relation.listFor({ entityId }) → WireRelation[]` (обе стороны);
  - `chat.ensureThread({ entityId?: string }) → { threadId: string }` (без entityId — глобальный);
  - `chat.listMessages({ threadId: string; before?: string; limit?: number }) → WireChatMessage[]` (по `created_at DESC`, default limit 50);
  - `chat.appendUserMessage({ id: string; threadId: string; content: string }) → WireChatMessage` (role `user`; id — client-generated UUIDv7);
  - `ai.undo({ actionId }) → ExecuteResult-обёртка`; `ai.undoLast() → …` (роутер `ai` по §9.1 владеет журналом; sendMessage добавит 1b);
  - `wire.ts`: `toWireEntity(row): WireEntity` и аналоги — **единственное** место преобразования Drizzle-строк в wire-формы; core-таймстампы → `date.toISOString()` (UTC `Z`, решение 12).

Правила роутеров: только трансляция вход → executor/компилятор и результат → wire (§1.1 implementation-карты, п. 8); `protectedProcedure`; все ошибки executor'а мапятся кодов в TRPCError: `VALIDATION`→`BAD_REQUEST`, `NOT_FOUND`→`NOT_FOUND`, `STALE_VERSION`→`CONFLICT` (409 — §5.2, диаграмма 00-арх §4.4), `INVARIANT`→`UNPROCESSABLE_CONTENT`, `LIMIT`→`TOO_MANY_REQUESTS`; исходная структурированная ошибка — в `cause`.

- [ ] **Step 1: Падающий parity-тест таймстампов (обязательство Вехи 0)**

```ts
// apps/server/src/wire.test.ts
import { describe, expect, test } from 'bun:test';
import { entitySchema } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv } from '../test/helpers';
import { withIdentity } from './db/with-identity';
import { toWireEntity } from './wire';

requireEnv();

describe('wire-сериализация (решение 12 плана)', () => {
  test('строка из Postgres → toWireEntity → entitySchema.parse проходит; формат — UTC Z', async () => {
    const { db, client } = appDb();
    const owner = freshUserId();
    const id = crypto.randomUUID();
    try {
      const row = await withIdentity(db, owner, async (tx) => {
        await tx.execute(sql`INSERT INTO entities (id, owner_id, title) VALUES (${id}, ${owner}, 'parity')`);
        const rows = await tx.query.entities.findMany({ where: (e, { eq }) => eq(e.id, id) });
        return rows[0];
      });
      const wire = toWireEntity(row!);
      expect(() => entitySchema.parse(wire)).not.toThrow();      // zod datetime() без офсета
      expect(wire.createdAt.endsWith('Z')).toBe(true);            // не '+00:00'
      expect(wire.updatedAt).toBe(row!.updatedAt.toISOString());
    } finally {
      await client.end();
    }
  });
});
```

Run → FAIL (wire.ts нет). Реализовать `toWireEntity`/`toWireRelation`/`toWireChatMessage`/`toWireThread` (camelCase-поля как в `entitySchema`; `aspects`/`meta` — как есть, jsonb не трогаем).

- [ ] **Step 2: Падающие тесты роутеров** (через `createCallerFactory(appRouter)` — экспортировать `export const createCallerFactory = t.createCallerFactory;` из `trpc.ts`; ctx `{ actorUserId: userA, db }`): create→get круговой (aspects сохранены); update body со stale `expectedUpdatedAt` → TRPCError `CONFLICT`, повтор со свежим — успех (перенесённый контракт optimistic-check, включая «tags — LWW без проверки»); `entity.query` блока Inbox находит созданную задачу, `entity.count` игнорирует `limit`; невалидный запрос → `BAD_REQUEST` с позицией; `chat.ensureThread` глобальный/сущностный + `appendUserMessage` + `listMessages`; `ai.undoLast` гасит последний create; `relation.listFor` видит обе стороны.
- [ ] **Step 3: Реализация роутеров + сборка `appRouter` (существующие `ping`/`whoami` сохранить); `index.ts` создаёт `const { db } = makeDb()` и передаёт в контекст.**
- [ ] **Step 4: Прогон, полная цепочка, коммит**

```bash
git add apps/server/src packages/shared/src/contracts
git commit -m "feat(api): роутеры entity/relation/chat/ai(undo), wire-сериализация UTC Z, маппинг ошибок"
```

---

### Task 13: user/aspect-роутеры — онбординг-сидирование, настройки, экспорт

**Files:**
- Create: `apps/server/src/seed/onboarding.ts`, `apps/server/src/seed/categories.ts`, `apps/server/src/seed/smart-lists.ts`, `apps/server/src/routers/user.ts`, `apps/server/src/routers/aspect.ts`, `apps/server/src/export.ts`
- Modify: `apps/server/src/router.ts`
- Test: `apps/server/src/seed/onboarding.test.ts`, `apps/server/src/export.test.ts`

**Interfaces:**
- Consumes: `withIdentity`, `newId`, `globalThreadId`, uuidv5-хелперы, `toWire*`.
- Produces:
  - `user.seedOnboarding() → { seeded: boolean }` (мутация; `seeded: false` = уже было);
  - `user.getSettings() → WireUserSettings`; `user.updateSettings(partial) → WireUserSettings`;
  - `user.exportData() → OrbisExport` (§9.4);
  - `aspect.list() → WireAspectDefinition[]` (реестр: builtin + свои; CRUD кастомных и §3.10 — вне слайса 1, см. «Контекст»);
  - `seedOnboarding(tx, ownerId, clock)` — переиспользуется в 1c при первом логине.

Сидирование (02 §7, дословно; **напрямую в tx, мимо журнала** — решение 6):
1. Guard: `SELECT 1 FROM user_settings WHERE owner_id = …` → есть → `{ seeded: false }` (одноразовость 02 §7).
2. **12 категорий** — данные `SEED_CATEGORIES` копировать из 02 §7.1 байт-в-байт (title/icon/spend_class/aliases), плюс слаги и цвета (деталь реализации, 02 §7.1):

```ts
// apps/server/src/seed/categories.ts — данные дословно 02-core-os §7.1
export const SEED_CATEGORIES = [
  { slug: 'food',          title: 'Еда',          icon: '🍔', spendClass: 'discretionary', color: '#e0885a',
    aliases: ['еда', 'food', 'продукты', 'groceries', 'обед', 'lunch', 'ужин', 'завтрак', 'кофе'] },
  { slug: 'transport',     title: 'Транспорт',    icon: '🚕', spendClass: 'fixed',         color: '#5a9ee0',
    aliases: ['транспорт', 'transport', 'такси', 'метро'] },
  { slug: 'housing',       title: 'Жильё',        icon: '🏠', spendClass: 'fixed',         color: '#8a7ce0',
    aliases: ['жильё', 'housing', 'аренда', 'коммуналка'] },
  { slug: 'health',        title: 'Здоровье',     icon: '💊', spendClass: 'fixed',         color: '#e05a6f',
    aliases: ['здоровье', 'health', 'аптека', 'врач'] },
  { slug: 'subscriptions', title: 'Подписки',     icon: '🔁', spendClass: 'fixed',         color: '#5ac8e0',
    aliases: ['подписки', 'subscriptions'] },
  { slug: 'entertainment', title: 'Развлечения',  icon: '🎉', spendClass: 'discretionary', color: '#e05ab8',
    aliases: ['развлечения', 'entertainment', 'бар', 'кино'] },
  { slug: 'clothing',      title: 'Одежда',       icon: '👕', spendClass: 'discretionary', color: '#a3e05a',
    aliases: ['одежда', 'clothing'] },
  { slug: 'education',     title: 'Образование',  icon: '📚', spendClass: 'discretionary', color: '#e0c35a',
    aliases: ['образование', 'education', 'курсы', 'книги'] },
  { slug: 'travel',        title: 'Путешествия',  icon: '✈️', spendClass: 'discretionary', color: '#5ae09e',
    aliases: ['путешествия', 'travel'] },
  { slug: 'gifts',         title: 'Подарки',      icon: '🎁', spendClass: 'discretionary', color: '#c95ae0',
    aliases: ['подарки', 'gifts'] },
  { slug: 'salary',        title: 'Зарплата',     icon: '💰', spendClass: null,            color: '#6fe05a',
    aliases: ['зарплата', 'salary'] },
  { slug: 'freelance',     title: 'Фриланс',      icon: '💻', spendClass: null,            color: '#5a6fe0',
    aliases: ['фриланс', 'freelance'] },
] as const;
```

Каждая категория — сущность: `id = uuidv5(ORBIS_NAMESPACE, "<owner_id>:seed-category:<slug>")` (страховка от гонки двух устройств поверх guard'а; owner в формуле — workspace-scoped оговорка D11), `tags: ['category']`, `aspects: { 'orbis/category': { icon, color, aliases, ...(spendClass ? { spend_class: spendClass } : {}) } }`.

3. **3 smart lists** — `id = uuidv5(NS, "<owner_id>:seed-smartlist:<daily-planning|upcoming|all-tasks>")`, `tags: ['smart-list']`, emoji `☀️`/`🗓️`/`📋`, body — **байт-в-байт из 02 §3.3** (`apps/server/src/seed/smart-lists.ts`, template-литералы с сохранением переносов и отступов):

```ts
export const DAILY_PLANNING_BODY = `Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».

{{query: aspect=orbis/task, status=inbox,
         sortBy=created_at:desc, display=list, title=Inbox}}

{{query: aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,
         excludeBlocked=true, sortBy=priority:desc|due_date:asc,
         display=list, title=Сегодня}}

{{query: aspect=orbis/task, status=waiting,
         sortBy=updated_at:asc, display=compact, title=Ожидание}}`;

export const UPCOMING_BODY = `Горизонт планирования: неделя и дальше.

{{query: aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,
         sortBy=due_date:asc|priority:desc, display=list, title=Ближайшие 7 дней}}

{{query: aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,
         sortBy=due_date:asc, limit=30, display=compact, title=Позже}}`;

export const ALL_TASKS_BODY = `{{query: aspect=orbis/task, status=!done&!cancelled,
         sortBy=updated_at:desc, display=list, title=Все незакрытые задачи}}`;
```

4. **user_settings** — дефолты 02 §7.3 (`timezone: 'Europe/Moscow'`, `defaultCurrency: 'RUB'`, `weekStartDay: 'monday'`, `plan: 'dev'`), `pinnedEntities: [{id: <daily>, order: 0}, {id: <upcoming>, order: 1}, {id: <allTasks>, order: 2}]` (§4.4, порядок 02 §7.2); `INSERT … ON CONFLICT (owner_id) DO NOTHING`.
5. **Глобальный тред** — `ensureGlobalThread` (id по формуле §4.5).

Экспорт (§9.4, D8): `OrbisExport = { format: 'orbis-export', version: 1, exportedAt: string, entities: WireEntity[], relations: WireRelation[], chatThreads: WireThread[], chatMessages: WireChatMessage[], userSettings: WireUserSettings | null, aspectDefinitions: WireAspectDefinition[] /* только owner_id = актор — встроенные не экспортируются */ }` — все чтения одним `withIdentity`-tx (RLS сам ограничивает владельцем).

- [ ] **Step 1: Падающие тесты** — `seedOnboarding` создаёт ровно 12+3 сущностей, настройки, глобальный тред; повторный вызов → `{ seeded: false }`, count не растёт; конкурентные два вызова (`Promise.all` под разными коннекшнами) → без дублей (детерминированные id + ON CONFLICT); body Daily Planning **парсится собственным парсером**: все три `{{query:…}}`-блока извлекаются регексом `/\{\{query:\s*([\s\S]*?)\}\}/g` и `parseQuery(...).ok === true` (страховка от опечатки в сиде); категория «Еда» находится `entity.query('tags=category, search=Еда')`; экспорт после сидирования содержит 15 сущностей, настройки, тред и 0 aspectDefinitions (кастомных нет); экспорт userB — пустой.
- [ ] **Step 2: Реализация + роутеры + сборка.**
- [ ] **Step 3: Прогон, полная цепочка, коммит**

```bash
git add apps/server/src/seed apps/server/src/routers apps/server/src/export.ts apps/server/src/router.ts
git commit -m "feat(user): онбординг-сидирование (12 категорий, 3 smart lists, настройки, глобальный тред) и экспорт §9.4"
```

---

### Task 14: Auth-хоры — изоляция type-графа, JWKS hardening, min-compatible-version

**Files:**
- Create: `apps/server/src/context.ts`
- Modify: `apps/server/src/trpc.ts`, `apps/server/src/index.ts`, `apps/server/src/auth.ts`, `apps/server/src/router.test.ts`, `packages/shared/src/constants.ts`, `apps/web/tsconfig.json` (если содержит bun-types)
- Test: `apps/server/src/auth.test.ts` (расширить), `apps/server/src/context.test.ts`

**Interfaces:**
- Consumes: существующий `auth.ts`, `verifyAccessToken`.
- Produces: `createContext` в `context.ts` (runtime-импорты auth/db живут здесь); `trpc.ts` больше **не импортирует** `./auth` — type-граф `AppRouter → router → trpc` чист от bun-окружения (обязательство «изоляция auth от type-графа router»); `MIN_COMPATIBLE_CLIENT_VERSION = '0.1.0'` и `CLIENT_VERSION_HEADER = 'x-orbis-client-version'` в shared.

- [ ] **Step 1: Изоляция** — перенести `createContext` в `context.ts` (тип `Context` остаётся в `trpc.ts`, расширен `db`); `index.ts` импортирует из `context.ts`. Проверка: `cd apps/web && bun run typecheck` проходит **после** удаления `"bun-types"` из `types` веб-tsconfig (если его там нет — зафиксировать в отчёте, что изоляция валидна по построению: `grep -r 'from.*auth' apps/server/src/trpc.ts apps/server/src/router.ts` пуст).
- [ ] **Step 2: JWKS hardening (падающие тесты → фикс)** — в `verifyViaJwks`: `jwtVerify(token, jwks, { audience: AUDIENCE, algorithms: ['RS256', 'ES256'], ...(issuer ? { issuer } : {}) })`, где `issuer = process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/auth/v1` : undefined`. Тесты: HS256-токен, поданный в JWKS-путь, отвергается allowlist'ом (не доходит до ключей); токен с чужим `iss` → null; легитимный HS256-путь (fallback) продолжает работать. Существующий тестовый харнесс auth.test.ts расширить, не переписывать. Это закрывает **гейт до прод-деплоя** из леджера.
- [ ] **Step 3: whoami-тест ассертит код** — в `router.test.ts` заменить слабую проверку: вызов `whoami` без identity обязан бросать TRPCError с `code === 'UNAUTHORIZED'` (Minor Вехи 0).
- [ ] **Step 4: min-compatible-version (§9.1)** — middleware в `trpc.ts` (до protectedProcedure): если заголовок `CLIENT_VERSION_HEADER` присутствует и семver-меньше `MIN_COMPATIBLE_CLIENT_VERSION` → TRPCError `PRECONDITION_FAILED` с `cause: { code: 'CLIENT_OUTDATED', min: … }`; заголовок отсутствует → пропустить (curl/смоуки). Сравнение — покомпонентно `split('.') → Number`, без зависимостей. Тест: старая версия → отказ; равная/новая/без заголовка → ок.
- [ ] **Step 5: Прогон, полная цепочка, коммит**

```bash
git add apps/server/src apps/web/tsconfig.json packages/shared/src/constants.ts
git commit -m "feat(auth): изоляция auth от type-графа, JWKS allowlist+issuer (гейт прод-деплоя), min-compatible-version"
```

---

### Task 15: Сквозной e2e-тест слайса 1a и финальная проверка

**Files:**
- Create: `apps/server/test/e2e.slice1a.test.ts`
- Modify: `.superpowers/sdd/progress.md` не трогать (ведёт контроллер); README-заметок не требуется.

**Interfaces:**
- Consumes: весь собранный `appRouter` через `createCallerFactory` (без HTTP — транспорт проверяет смоук ниже).

- [ ] **Step 1: e2e-сценарий (один тест-файл, последовательные шаги, два пользователя)**

Сценарий — «день из 02 §5» на уровне API:
1. `user.seedOnboarding()` для A → 15 сущностей, настройки, глобальный тред;
2. эмуляция fast-path-результата (сам парсер — 1c): `chat.appendUserMessage('обед 340')` в глобальный тред + `entity.create({ source: 'fast_path', input: { id: newId(), title: 'Обед', tags: ['expense'], aspects: { 'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: <id «Еда» из сидов>, occurred_on: '2026-07-03' } } } })` → в глобальном треде появилось audit-сообщение с action и inverse;
3. `entity.create` задачи «купить кроссовки» с `orbis/task` + `orbis/financial` (`planned: true`, `occurred_on: '2026-07-05'` — planned-операция обязана иметь дату, §3.3) + `orbis/schedule` — cross-aspect сущность (§2.4);
4. `entity.query` Inbox-блока Daily Planning находит задачу; `entity.count` без limit совпадает;
5. `entity.update` статуса в `done` → `completed_at` проставлен; `ai.undoLast()` → статус вернулся, карточка-действие отменено; повторный undo того же action → ошибка;
6. `relation.create(blocks)` + запрос `excludeBlocked=true` скрывает заблокированную;
7. `user.exportData()` содержит все созданные сущности, связи, сообщения (включая audit) и настройки;
8. пользователь B: `seedOnboarding` независим; `entity.query('tags=category')` B видит 12 своих, ни одной чужой; `ai.undoLast()` B не дотягивается до действий A.

- [ ] **Step 2: Полная CI-цепочка локально**

Run: `bun run lint && bun run typecheck && DATABASE_URL=… DATABASE_URL_ADMIN=… bun run db:prepare && bun run test && bun run test:rls` → всё зелёное.

- [ ] **Step 3: Смоук HTTP-транспорта**

Run: `cd apps/server && PORT=3210 bun run dev &`, затем `curl -s localhost:3210/health` → `{"status":"ok"}`; `curl -s localhost:3210/trpc/ping` → `ok: true`; процесс остановить. (Порт 3210 — 3001 занят, Global Constraints.)

- [ ] **Step 4: Коммит**

```bash
git add apps/server/test/e2e.slice1a.test.ts
git commit -m "test(e2e): сквозной сценарий слайса 1a — сид, ввод, query, undo, изоляция, экспорт"
```

---

## Verification (приёмка плана целиком)

1. **CI зелёный** на ветке `slice1a-server-core`: lint, typecheck, `db:prepare` (миграции + роль + сид реестра + pgTAP), тесты всех трёх workspace.
2. **Приёмочные проверки PRD 01 §13, закрываемые в 1a** — все покрыты именованными тестами: §13.1 optimistic-check (Task 9/12), §13.2 идемпотентность досылки (Task 9), §13.3 один entity-тред (Task 11), §13.4 атомарный batch + повтор batch_id (Task 10), §13.5 RLS чатов и связей (Task 2 pgTAP), §13.6 decimal `0.10+0.20=0.30` без IEEE-754 (Task 8 датасет: диапазон `0.10..0.30` и сравнение сумм через `::numeric`; проверить и persisted JSON), §13.7 один budget-parent (Task 10). В финальном ревью — явная сверка списка.
3. **RLS-инварианты**: `bun run test:rls` — 14/14 ok; `pg_roles` — `orbis_app` NOBYPASSRLS/NOSUPERUSER (ассерт в setup-db).
4. **Грамматика**: все query-блоки сидированных smart lists парсятся и исполняются на реальной БД (Task 13 Step 1 + Task 8 датасет).
5. **Сквозной сценарий** e2e (Task 15) зелёный.
6. **Обязательства Вехи 0**, замапленные на 1a (таблица в «Контексте»), — каждое закрыто конкретной задачей; финальному ревью сверить по таблице. Оставшиеся (1b/1c) — перенесены в соответствующие планы при их написании.
7. `grep -rn 'TODO\|FIXME' apps/server/src packages/shared/src` — пусто (кроме осознанных ссылок на 1b/1c в комментариях вида «слайс 1b»).

## Критические файлы и документы

- `docs/prd/01-architecture.md` — §3 (схемы аспектов), §4 (таблицы, RLS §4.10, индексы §4.9), §5 (идемпотентность, optimistic-check, uuidv5-формулы §5.4), §6 (грамматика, golden §6.2, ошибки §6.4), §7.8 (журнал/Undo), §9.1–9.2 (роутеры, реестр тулов, конвейер), §13 (приёмка);
- `docs/prd/02-core-os.md` — §3.3 (body smart lists — копировать дословно), §7 (сидирование: категории §7.1, настройки §7.3);
- `docs/implementation/01-phase0-findings.md` — механика identity (B7), грабли 1–8 (обязательное чтение перед Task 2–3);
- `docs/prd/04-decision-log.md` — D11 (нейминг, workspace-ready чек-лист), D12 (пулер/prepare);
- `.superpowers/sdd/progress.md` — финальная секция Вехи 0 (источник таблицы обязательств);
- существующий код Вехи 0: `apps/server/src/db/schema.ts`, `packages/shared/src/query/grammar.ts` (AST — не менять), `packages/shared/src/contracts/*` (какие skip'ы гасятся — см. Task 9/12).

## После merge 1a

Написать план **1b «AI + MCP»** (writing-plans): LLMProvider поверх Vercel AI SDK, сборка контекста §7.1, политика подтверждений §7.10 (+ contracts/confirmation-policy), метеринг `ai_usage` + entitlements-лимиты, лимит multi-step-циклов (carried), версионированные промпты (carried), MCP-сервер + PAT (hash-only, constant-time) + «что нового»; затем план **1c «Web UI + прод»** (fast-path-парсер + contracts/fast-path, retry-wiring + обязательства по retry-storage, auth-флоу + site_url-порты, чат/Browser-lite/detail, PWA-иконки, radix-ui, re-point `render.yaml`, деплой, приёмка слайса 1 из 00-product §8).



