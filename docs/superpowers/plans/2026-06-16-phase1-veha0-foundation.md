# Orbis Фаза 1 — Веха 0 «Фундамент» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Ревизия 2026-07-02 под v3.1 (онлайн-первый разрез)** — план подрезан под `docs/superpowers/specs/2026-07-02-prd-v3.1-online-first-agent-loop-design.md` §7: минус клиентская локальная БД и её коннектор, плюс retry-буфер и `entity_origins`. Источник контрактов — `docs/prd/` (00–04) v3.1 и `docs/implementation/00-architecture.md`.

**Goal:** Поднять каркас монорепо Orbis под решённый стек — так, чтобы на нём можно было начать Слайс 1 («Агентная петля + ввод»): рабочие `typecheck`/`lint`/`test`/CI, дизайн-система с токенами, скелеты server (tRPC + Supabase auth), web (React PWA + Tailwind v4 + Radix + TanStack Query + retry-буфер fast-path-ввода) и acceptance-харнесс для проверяемых контрактов PRD.

**Architecture:** Bun-монорепо из трёх workspace-пакетов — `packages/shared` (Zod-схемы, типы, константы, грамматика запросов), `apps/server` (Hono + tRPC + Drizzle + Supabase + LLMProvider), `apps/web` (Vite + React PWA + Tailwind v4 + Radix + Zustand + TanStack Query + retry-буфер). Источник истины — PRD `docs/prd/` (01-architecture — фундамент). Веха 0 ставит скелеты и инструменты, НЕ фичи: фичи идут слайсами (фаза 0 + слайсы 1–3, см. «Очерки слайсов»).

**Tech Stack:** Bun + TypeScript · tRPC v11 · Drizzle ORM · PostgreSQL (Supabase, локально через Supabase CLI) · Vite + React 19 PWA · Tailwind v4 + Radix · Zustand · TanStack Query (server-state-кэш) · LLMProvider поверх Vercel AI SDK (в Вехе 0 — только интерфейс-скелет) · Biome (lint+format) · Bun test + Vitest + React Testing Library · GitHub Actions CI.

**Решения по инструментам (зафиксированы при пересмотре стека):**
- Линтер/формат — **Biome** (один бинарь, без ESLint+Prettier).
- Тесты — **Bun test** для `shared`/`server`, **Vitest + React Testing Library + jsdom** для `web`.
- Локальная БД — **Supabase CLI** (Docker): Postgres + Auth локально, без облака; PostgreSQL — единственный источник истины, у клиента собственной базы нет (01-architecture §4.12).
- Офлайн — **retry-буфер** ввода (не режим работы, D2 спеки): буферизуются только create-мутации fast-path; персист — localStorage-скелет в Вехе 0 (интерфейс хранения отделён от логики, чтобы заменить на IndexedDB позже).

**Примечание о версиях:** версии в сниппетах плана (Zod `^3.24`, Biome `2`, tRPC `v11`, React `19`) — актуальны на дату написания; перепроверить при исполнении.

**ВАЖНО — без коммитов без спроса:** владелец коммитит сам или по явной просьбе. Шаги плана НЕ делают `git commit`, кроме тех, что помечены явно как контрольная точка — и даже их выполнять только если владелец разрешил коммиты в этой сессии. По умолчанию — оставлять изменения в рабочей копии.

**Текущая ветка:** работа идёт в ветке `prd-v3-clean-start` (создана при чистом старте). Рабочая копия содержит только `docs/` — код пишется с нуля.

---

## Карта файлов Вехи 0

Что создаётся (по задачам):

```
orbis/
├─ package.json                 # T1: корень, Bun workspaces, скрипты
├─ tsconfig.base.json           # T1: общий TS-конфиг
├─ biome.json                   # T2: lint + format
├─ .github/workflows/ci.yml     # T4: typecheck + lint + test
├─ packages/shared/
│  ├─ package.json              # T1
│  ├─ tsconfig.json             # T1
│  └─ src/
│     ├─ index.ts               # T1: реэкспорт
│     ├─ constants.ts           # T6: ASPECT_IDS, RELATION_TYPES, namespaces
│     └─ schemas/               # T6: Zod-схемы сущности/связей (без аспектов — Слайс 1)
├─ apps/server/
│  ├─ package.json              # T1
│  ├─ tsconfig.json             # T1
│  ├─ drizzle.config.ts         # T5
│  └─ src/
│     ├─ index.ts               # T7: Hono + tRPC адаптер, /health
│     ├─ trpc.ts                # T7: initTRPC, context, protectedProcedure
│     ├─ router.ts              # T7: appRouter (ping)
│     ├─ db/
│     │  ├─ client.ts           # T5: Drizzle client
│     │  └─ schema.ts           # T5: 8 таблиц (entities, relations, aspect_definitions,
│     │                         #     user_settings, chat_threads, chat_messages, ai_usage,
│     │                         #     entity_origins) — скелет
│     └─ llm/
│        └─ provider.ts         # T8: LLMProvider интерфейс + типы (скелет)
├─ apps/web/
│  ├─ package.json              # T1
│  ├─ tsconfig.json             # T1
│  ├─ vite.config.ts            # T3: Vite + PWA + Vitest
│  ├─ index.html                # T3
│  ├─ src/
│  │  ├─ main.tsx               # T3: точка входа
│  │  ├─ App.tsx                # T3 / T9: оболочка
│  │  ├─ styles/
│  │  │  ├─ tokens.css          # T9: @theme дизайн-токены
│  │  │  └─ globals.css         # T9: Tailwind v4 import + база
│  │  ├─ ui/                    # T9: Button, Card (Radix + токены)
│  │  ├─ trpc.ts                # T7: tRPC React client
│  │  └─ lib/
│  │     └─ retry-buffer/       # T10: retry-буфер fast-path-create (01 §5.3)
│  │        ├─ index.ts         # T10: RetryBuffer интерфейс + реализация
│  │        ├─ storage.ts       # T10: localStorage-персист (заменяемый на IndexedDB позже)
│  │        └─ retry-buffer.test.ts   # T10: RED/GREEN тесты enqueue/flush/cancel
│  └─ tests/setup.ts            # T3: jsdom + RTL setup
├─ packages/shared/src/query/   # T11: грамматика (типы AST) + общие фикстуры
└─ packages/shared/src/contracts/  # T11: acceptance-харнесс — 5 skipped-тестов новых
                                #     контрактов v3.1 (fast-path, идемпотентность,
                                #     optimistic-check, политика подтверждений, CSV-дедуп)
```

---

### Task 1: Монорепо-скелет (Bun workspaces + TypeScript)

**Files:**
- Create: `package.json`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`

- [ ] **Step 1: Корневой `package.json` с workspaces**

```json
{
  "name": "orbis",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "bun run --filter '*' test"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: `tsconfig.base.json`** (общие строгие настройки)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: `packages/shared`** — package.json + tsconfig + пустой реэкспорт

`packages/shared/package.json`:
```json
{
  "name": "@orbis/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": { "zod": "^3.24.0" }
}
```
`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
`packages/shared/src/index.ts`:
```typescript
export const PLACEHOLDER_SHARED = true;
```

- [ ] **Step 4: `apps/server`** — package.json + tsconfig

`apps/server/package.json`:
```json
{
  "name": "@orbis/server",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@orbis/shared": "workspace:*",
    "hono": "^4.6.0",
    "@hono/trpc-server": "^0.3.4",
    "@trpc/server": "^11.0.0",
    "zod": "^3.24.0"
  }
}
```
`apps/server/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 5: `apps/web`** — package.json + tsconfig (зависимости доставим в T3/T9/T10)

`apps/web/package.json`:
```json
{
  "name": "@orbis/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@orbis/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
```
`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": [] },
  "include": ["src"]
}
```

- [ ] **Step 6: Установка и проверка typecheck**

Run: `bun install && bun run typecheck`
Expected: установка проходит; `typecheck` зелёный по всем трём пакетам (ошибок 0). Если `bun run --filter` недоступен в этой версии Bun — заменить корневые скрипты на последовательный вызов `bun --cwd packages/shared run typecheck && bun --cwd apps/server run typecheck && bun --cwd apps/web run typecheck`.

---

### Task 2: Biome (lint + format)

**Files:**
- Create: `biome.json`
- Modify: корневой `package.json` (devDependency biome — добавить)

- [ ] **Step 1: Установить Biome**

Run: `bun add -d -E @biomejs/biome@2`
Expected: добавлен в корневые devDependencies.

- [ ] **Step 2: `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": { "ignore": ["dist", "node_modules", "**/*.gen.ts"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } }
}
```

- [ ] **Step 3: Проверка**

Run: `bun run lint`
Expected: Biome проходит по репозиторию без ошибок (на скелете — чисто). `bun run format` форматирует без диффов на свежесозданных файлах.

---

### Task 3: Vite + React PWA + Vitest (web)

**Files:**
- Modify: `apps/web/package.json` (devDeps)
- Create: `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/tests/setup.ts`
- Create: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Установить web-зависимости**

Run: `bun add --cwd apps/web vite @vitejs/plugin-react vite-plugin-pwa && bun add -d --cwd apps/web vitest @testing-library/react @testing-library/jest-dom jsdom`
Expected: пакеты добавлены в `apps/web`.

- [ ] **Step 2: `vite.config.ts`** (Vite + PWA + Vitest в одном)

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', manifest: { name: 'Orbis', short_name: 'Orbis', display: 'standalone' } })],
  server: { port: 5173, proxy: { '/trpc': 'http://localhost:3001' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./tests/setup.ts'] },
});
```

- [ ] **Step 3: `index.html` + `main.tsx` + `App.tsx`**

`apps/web/index.html`:
```html
<!doctype html>
<html lang="ru"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><title>Orbis</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
`apps/web/src/main.tsx`:
```typescript
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```
`apps/web/src/App.tsx`:
```typescript
export function App() {
  return <main>Orbis</main>;
}
```

- [ ] **Step 4: `tests/setup.ts`**

```typescript
import '@testing-library/jest-dom';
```

- [ ] **Step 5: Написать тест-проверку рендера**

`apps/web/src/App.test.tsx`:
```typescript
import { render, screen } from '@testing-library/react';
import { App } from './App';

test('рендерит оболочку Orbis', () => {
  render(<App />);
  expect(screen.getByText('Orbis')).toBeInTheDocument();
});
```

- [ ] **Step 6: Прогон**

Run: `bun run --cwd apps/web test`
Expected: 1 тест зелёный. `bun run --cwd apps/web build` собирается без ошибок (PWA-манифест генерируется).

---

### Task 4: CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Workflow**

```yaml
name: CI
on:
  push: { branches: ['**'] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test
```

- [ ] **Step 2: Проверка локально**

Run: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test`
Expected: все три шага зелёные локально (это то, что выполнит CI). Реальный прогон в GitHub Actions — после первого push (владельцем).

---

### Task 5: Drizzle + Supabase (локально) — схема-скелет 8 таблиц

**Files:**
- Modify: `apps/server/package.json` (deps: drizzle-orm, postgres; devDeps: drizzle-kit)
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`
- Create: `apps/server/.env.example`

**Контекст:** таблицы — по 01-architecture §4 (entities, relations, aspect_definitions, user_settings, chat_threads, chat_messages, ai_usage, entity_origins). Здесь — структура столбцов и индексы; RLS-политики и сид аспектов — Слайс 1. Цель Вехи 0: схема компилируется, миграция генерируется и применяется к локальному Supabase.

- [ ] **Step 1: Supabase CLI — поднять локальный стек**

Run: `bunx supabase init && bunx supabase start`
Expected: поднимается локальный Postgres + Auth (Docker); CLI печатает `API URL`, `DB URL`, `anon key`, `service_role key`. Записать `DB URL` (обычно `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) в `apps/server/.env` как `DATABASE_URL`, anon/url — для T7.

- [ ] **Step 2: Установить Drizzle**

Run: `bun add --cwd apps/server drizzle-orm postgres && bun add -d --cwd apps/server drizzle-kit`

- [ ] **Step 3: `db/schema.ts`** — 8 таблиц по 01 §4

Точные столбцы — из 01-architecture §4.1–§4.8. Ключевые места (нейминг владельца — `owner_id` везде, не `user_id`): `entities` (id uuid PK, owner_id, title, emoji, body text default '', body_refs text[] default {}, tags text[] default {}, meta jsonb default {}, aspects jsonb default {}, created_at, updated_at, archived bool default false); `relations` (id, source_id, target_id, relation_type, meta jsonb default {}, created_at, updated_at; удаление — обычный `DELETE`, без `deleted_at`; unique index — полный `UNIQUE (source_id,target_id,relation_type)` без partial-условия; CHECK source≠target); `aspect_definitions` (id text, owner_id nullable, name, namespace, description, icon, schema jsonb, ai_instructions, tag_mappings text[], aggregations jsonb, view_config jsonb, created_at; уникальность — два partial unique index, без surrogate PK); `user_settings` (owner_id PK, plan text default 'dev', timezone default 'Europe/Moscow', defaultCurrency default 'RUB', weekStartDay default 'monday', tagColors jsonb default {}, installedViews text[] default {}, pinnedEntities jsonb default [], viewPreferences jsonb default {}, updated_at — имена столбцов настроек в camelCase, историческое соответствие коду, 01 §4.4); `chat_threads` (id uuid PK, owner_id, entity_id uuid nullable, title, archived bool, created_at, updated_at; два partial unique index — глобальный тред и тред сущности, см. грабля ниже); `chat_messages` (id uuid PK, thread_id, role text, content text, metadata jsonb default {}, created_at — append-only, без updated_at); `ai_usage` (owner_id, date, model, input_tokens bigint default 0, output_tokens bigint default 0, request_count integer default 0 — PK (owner_id,date,model)); `entity_origins` (id uuid PK, owner_id, entity_id uuid FK → entities, namespace text, external_id text, created_at — UNIQUE (owner_id, namespace, external_id), 01 §4.8).

Скелет (привести все 8; здесь — образец трёх, остальные по тому же образцу и таблицам 01 §4):
```typescript
import { pgTable, uuid, text, jsonb, timestamp, boolean, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  emoji: text('emoji'),
  body: text('body').notNull().default(''),
  bodyRefs: text('body_refs').array().notNull().default(sql`'{}'`),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  meta: jsonb('meta').notNull().default({}),
  aspects: jsonb('aspects').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archived: boolean('archived').notNull().default(false),
});

export const relations = pgTable('relations', {
  id: uuid('id').primaryKey(),
  sourceId: uuid('source_id').notNull(),
  targetId: uuid('target_id').notNull(),
  relationType: text('relation_type').notNull(),
  meta: jsonb('meta').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqLive: unique('rel_uniq').on(t.sourceId, t.targetId, t.relationType),
  noSelf: check('rel_no_self', sql`${t.sourceId} <> ${t.targetId}`),
}));

export const entityOrigins = pgTable('entity_origins', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull(),
  entityId: uuid('entity_id').notNull(),
  namespace: text('namespace').notNull(),
  externalId: text('external_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqOrigin: unique('entity_origins_uniq').on(t.ownerId, t.namespace, t.externalId),
}));
// ... остальные 5 таблиц по 01-architecture §4 (aspect_definitions, user_settings, chat_threads, chat_messages, ai_usage) ...
```
Примечание-грабля: drizzle-kit может не выражать partial unique индексы декларативно — конкретный пример в этой схеме: unique-тред `WHERE entity_id IS NULL` в `chat_threads` (01 §4.5, два partial unique index — `UNIQUE (owner_id) WHERE entity_id IS NULL` и `UNIQUE (owner_id, entity_id) WHERE entity_id IS NOT NULL`). Если декларативно не выразилось — SQL дописывается в сгенерированную миграцию вручную (отметить комментарием в миграции). У `relations` и `entity_origins` unique-индексы теперь полные (без partial-условия) — этой граблей не задеты.

- [ ] **Step 4: `drizzle.config.ts` + `db/client.ts`**

`drizzle.config.ts`:
```typescript
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```
`db/client.ts`:
```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const client = postgres(process.env.DATABASE_URL!);
export const db = drizzle(client, { schema });
```

- [ ] **Step 5: Сгенерировать и применить миграцию**

Run: `cd apps/server && bunx drizzle-kit generate && bunx drizzle-kit migrate`
Expected: создаётся SQL-миграция со всеми 8 таблицами; применяется к локальному Supabase без ошибок. Проверка: `bunx supabase db diff` не показывает расхождений (или таблицы видны в Studio на `54323`). Если partial unique для `chat_threads` не попал в миграцию декларативно — дописать вручную `CREATE UNIQUE INDEX chat_threads_global_uniq ON chat_threads (owner_id) WHERE entity_id IS NULL;` и `CREATE UNIQUE INDEX chat_threads_entity_uniq ON chat_threads (owner_id, entity_id) WHERE entity_id IS NOT NULL;`, затем переприменить.

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd apps/server typecheck`
Expected: зелёно.

---

### Task 6: `packages/shared` — базовые Zod-схемы и константы

**Files:**
- Create: `packages/shared/src/constants.ts`, `packages/shared/src/schemas/entity.ts`, `packages/shared/src/schemas/relation.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/schemas/entity.test.ts`

**Контекст:** схемы аспектов (financial/task/...) — Слайс 1. Здесь — каркас Entity/Relation и константы реестра, чтобы server и web делили типы.

- [ ] **Step 1: Написать падающий тест на парс Entity**

`packages/shared/src/schemas/entity.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { entitySchema } from './entity';

test('entitySchema принимает минимальную сущность и проставляет дефолты', () => {
  const e = entitySchema.parse({
    id: '018e4a2c-0000-7000-8000-000000000000',
    ownerId: '018e4a2c-0000-7000-8000-000000000001',
    title: 'Обед',
    createdAt: '2026-06-16T10:00:00Z',
    updatedAt: '2026-06-16T10:00:00Z',
  });
  expect(e.body).toBe('');
  expect(e.tags).toEqual([]);
  expect(e.archived).toBe(false);
});
```

- [ ] **Step 2: Прогнать — упадёт (нет модуля)**

Run: `bun test --cwd packages/shared src/schemas/entity.test.ts`
Expected: FAIL — `Cannot find module './entity'`.

- [ ] **Step 3: `constants.ts`**

```typescript
export const RELATION_TYPES = ['parent', 'blocks', 'related_to', 'derived_from'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const BUILTIN_ASPECT_IDS = [
  'orbis/schedule', 'orbis/task', 'orbis/financial',
  'orbis/note', 'orbis/budget', 'orbis/category', 'orbis/memory',
] as const;
export type AspectId = (typeof BUILTIN_ASPECT_IDS)[number];
```

- [ ] **Step 4: `schemas/entity.ts` + `schemas/relation.ts`** (по 01 §2/§4.1, Зод-типы)

```typescript
import { z } from 'zod';

export const entitySchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  title: z.string().min(1),
  emoji: z.string().nullable().default(null),
  body: z.string().default(''),
  bodyRefs: z.array(z.string().uuid()).default([]),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.any()).default({}),
  aspects: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.boolean().default(false),
});
export type Entity = z.infer<typeof entitySchema>;
```
`relation.ts`:
```typescript
import { z } from 'zod';
import { RELATION_TYPES } from '../constants';

export const relationSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES),
  meta: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Relation = z.infer<typeof relationSchema>;
```
Примечание: Zod-схему для `entity_origins` в Вехе 0 не добавляем — это server-only таблица (provenance импорта), клиентского контракта у неё нет до слайса 2 (CSV-импорт, 03 §3.4.1); добавление — YAGNI до появления слайса импорта.

- [ ] **Step 5: Реэкспорт в `index.ts`**

```typescript
export * from './constants';
export * from './schemas/entity';
export * from './schemas/relation';
```

- [ ] **Step 6: Прогнать — зелено**

Run: `bun test --cwd packages/shared && bun run --cwd packages/shared typecheck`
Expected: тест проходит, typecheck зелёный.

---

### Task 7: tRPC-каркас + Supabase auth-контекст

**Files:**
- Modify: `apps/server/package.json` (deps: @supabase/supabase-js)
- Create: `apps/server/src/trpc.ts`, `apps/server/src/router.ts`, `apps/server/src/index.ts`
- Create: `apps/web/src/trpc.ts`
- Modify: `apps/web/package.json` (deps: @trpc/client @trpc/react-query @tanstack/react-query @supabase/supabase-js)
- Create: `apps/server/src/router.test.ts`

- [ ] **Step 1: Установить зависимости**

Run: `bun add --cwd apps/server @supabase/supabase-js && bun add --cwd apps/web @trpc/client @trpc/react-query @tanstack/react-query @supabase/supabase-js`

- [ ] **Step 2: `trpc.ts`** — контекст с валидацией Supabase JWT (по 01 §9 / api-принципам)

Нейминг контекста — `actorUserId` (не `userId`): identity течёт только через request-контекст, двусмысленное имя `user_id`/`userId` запрещено (D11, workspace-ready граница).

```typescript
import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';

export interface Context { actorUserId: string | null; }

export async function createContext({ req }: { req: Request }): Promise<Context> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { actorUserId: null };
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data } = await supabase.auth.getUser(token);
  return { actorUserId: data.user?.id ?? null };
}

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.actorUserId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { actorUserId: ctx.actorUserId } });
});
```

- [ ] **Step 3: `router.ts`** — пинг (public) + whoami (protected)

```typescript
import { router, publicProcedure, protectedProcedure } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ actorUserId: ctx.actorUserId })),
});
export type AppRouter = typeof appRouter;
```

- [ ] **Step 4: `index.ts`** — Hono + tRPC + /health

```typescript
import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { appRouter } from './router';
import { createContext } from './trpc';

const app = new Hono();
app.use('/trpc/*', trpcServer({ router: appRouter, createContext }));
app.get('/health', (c) => c.json({ status: 'ok' }));

export default { port: Number(process.env.PORT) || 3001, fetch: app.fetch };
```

- [ ] **Step 5: Тест роутера (вызов ping напрямую)**

`apps/server/src/router.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { appRouter } from './router';

test('ping возвращает ok', async () => {
  const caller = appRouter.createCaller({ actorUserId: null });
  expect(await caller.ping()).toEqual({ ok: true });
});

test('whoami без авторизации бросает UNAUTHORIZED', async () => {
  const caller = appRouter.createCaller({ actorUserId: null });
  await expect(caller.whoami()).rejects.toThrow();
});
```

Run: `bun test --cwd apps/server`
Expected: оба теста зелёные.

- [ ] **Step 6: web tRPC-клиент**

`apps/web/src/trpc.ts`:
```typescript
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@orbis/server/src/router';
export const trpc = createTRPCReact<AppRouter>();
```

- [ ] **Step 7: Смоук end-to-end (вручную, разово)**

Run: `bun run --cwd apps/server dev` (в отдельном терминале), затем `curl localhost:3001/health` и `curl localhost:3001/trpc/ping`.
Expected: `/health` → `{"status":"ok"}`; `/trpc/ping` → результат с `{"ok":true}`. Typecheck: `bun run typecheck` зелёный по всем пакетам.

---

### Task 8: LLMProvider — интерфейс-скелет (поверх Vercel AI SDK)

**Files:**
- Create: `apps/server/src/llm/provider.ts`, `apps/server/src/llm/types.ts`
- Create: `apps/server/src/llm/provider.test.ts`

**Контекст (01 §7.7):** реализация — поверх Vercel AI SDK, но **типы AI SDK не протекают наружу**. В Вехе 0 — только наши типы + интерфейс + заглушка-реализация (echo), без реального вызова модели. Реальная интеграция — Слайс 1 (LLM-путь с тулами входит в скоуп Слайса 1, PRD 00-product §9).

- [ ] **Step 1: `types.ts`** — наши типы (не из AI SDK)

```typescript
export interface LLMMessage { role: 'user' | 'assistant' | 'system'; content: string; }
export interface LLMToolDef { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface LLMToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface LLMRequest { system: string; messages: LLMMessage[]; tools: LLMToolDef[]; maxTokens: number; }
export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}
export interface LLMProvider { chat(req: LLMRequest): Promise<LLMResponse>; }
```

- [ ] **Step 2: Тест на echo-заглушку**

`apps/server/src/llm/provider.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { EchoProvider } from './provider';

test('EchoProvider возвращает наши типы без tool-call', async () => {
  const p = new EchoProvider();
  const r = await p.chat({ system: '', messages: [{ role: 'user', content: 'привет' }], tools: [], maxTokens: 100 });
  expect(r.content).toContain('привет');
  expect(r.toolCalls).toEqual([]);
  expect(r.stopReason).toBe('end_turn');
});
```

- [ ] **Step 3: `provider.ts`** — заглушка (реальный Vercel-AI-SDK-провайдер — Слайс 1)

```typescript
import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export class EchoProvider implements LLMProvider {
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const last = req.messages.at(-1)?.content ?? '';
    return { content: `echo: ${last}`, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
  }
}
export type { LLMProvider } from './types';
```

Run: `bun test --cwd apps/server src/llm/provider.test.ts`
Expected: зелёно.

---

### Task 9: Дизайн-система — Tailwind v4 + Radix + токены

**Files:**
- Modify: `apps/web/package.json` (deps: tailwindcss@4, @tailwindcss/vite, radix-ui; зависит от выбора набора Radix)
- Modify: `apps/web/vite.config.ts` (плагин Tailwind)
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/globals.css`
- Create: `apps/web/src/ui/Button.tsx`, `apps/web/src/ui/Card.tsx`
- Create: `apps/web/src/ui/Button.test.tsx`
- Modify: `apps/web/src/main.tsx` (импорт globals), `apps/web/src/App.tsx`

**Контекст:** это та самая «дизайн-система с первого шага». Визуальный язык (палитра, типографика, радиусы, тени, движение) задаётся через `@theme`-токены — **при исполнении этой задачи применить скилл `frontend-design`** для проектирования отличительного, не-generic облика. Здесь план фиксирует каркас и приёмочную проверку; конкретные значения токенов — продукт frontend-design.

- [ ] **Step 1: Установить Tailwind v4 + Radix-примитивы**

Run: `bun add --cwd apps/web tailwindcss @tailwindcss/vite && bun add --cwd apps/web radix-ui`
(Radix распространяется как единый пакет `radix-ui`; если используются раздельные пакеты — ставить нужные `@radix-ui/react-*` по мере добавления компонентов.)

- [ ] **Step 2: Подключить Tailwind-плагин в `vite.config.ts`**

Добавить `import tailwind from '@tailwindcss/vite'` и `tailwind()` в массив `plugins` (перед/после react — порядок не критичен).

- [ ] **Step 3: `tokens.css`** — каркас дизайн-токенов (значения — через frontend-design)

```css
@theme {
  /* Заполняется при применении скилла frontend-design: */
  /* --color-bg, --color-surface, --color-text, --color-accent-*, */
  /* --font-sans, --text-* шкала, --radius-*, --shadow-*, --ease-* */
  --color-bg: #0b0b0f;
  --color-surface: #16161d;
  --color-text: #e7e7ea;
  --color-accent: #6366f1;
  --radius-card: 0.75rem;
}
```

- [ ] **Step 4: `globals.css`**

```css
@import 'tailwindcss';
@import './tokens.css';

html, body, #root { height: 100%; }
body { background: var(--color-bg); color: var(--color-text); }
```
В `main.tsx` добавить `import './styles/globals.css';`.

- [ ] **Step 5: Тест на базовый компонент**

`apps/web/src/ui/Button.test.tsx`:
```typescript
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

test('Button рендерит подпись и реагирует на variant', () => {
  render(<Button variant="primary">Сохранить</Button>);
  const btn = screen.getByRole('button', { name: 'Сохранить' });
  expect(btn).toBeInTheDocument();
  expect(btn.className).toContain('bg-');
});
```

- [ ] **Step 6: `Button.tsx` + `Card.tsx`** (Tailwind-классы поверх токенов)

```typescript
type Variant = 'primary' | 'ghost';
export function Button({ variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = 'inline-flex items-center justify-center rounded-[var(--radius-card)] px-4 py-2 text-sm font-medium transition';
  const styles = variant === 'primary' ? 'bg-[var(--color-accent)] text-white' : 'bg-transparent text-[var(--color-text)]';
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}
```
`Card.tsx`:
```typescript
export function Card({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-[var(--radius-card)] bg-[var(--color-surface)] p-4 ${className}`} {...props} />;
}
```

- [ ] **Step 7: Прогон + сборка**

Run: `bun run --cwd apps/web test && bun run --cwd apps/web build`
Expected: тест Button зелёный; production-сборка проходит, Tailwind-классы попадают в CSS-бандл.

---

### Task 10: Retry-буфер — скелет

**Files:**
- Create: `apps/web/src/lib/retry-buffer/index.ts`, `apps/web/src/lib/retry-buffer/storage.ts`
- Create: `apps/web/src/lib/retry-buffer/retry-buffer.test.ts`

**Контекст (PRD 01 §5.3, §4.12; решение D2 спеки 2026-07-02):** офлайн в Orbis — не режим работы, а буфер на входе. Буферизуются **только** create-мутации fast-path-ввода (01 §7.5): каждая — с client-generated UUIDv7, складывается в локальную очередь, если запрос не ушёл на сервер. Буфер — единственное персистентное клиентское состояние (01 §4.12: у клиента нет собственной БД). Прежний скелет клиентской локальной БД (Task 10 версии v3) удалён целиком — общего кода нет, модуль пишется с нуля.

Контракт (PRD 01 §5.3):
```ts
interface QueuedCreate {
  clientId: string;      // UUIDv7, генерируется при постановке
  tool: string;          // имя тула реестра, например 'entity_create'
  payload: unknown;
  createdAt: string;     // ISO, для отображения в списке ожидающих
}

interface RetryBuffer {
  enqueue(op: Omit<QueuedCreate, 'clientId' | 'createdAt'>): QueuedCreate;
  flush(send: (op: QueuedCreate) => Promise<FlushOutcome>): Promise<void>;
  cancel(clientId: string): void;   // отмена до отправки (02-core-os §2.6)
  size(): number;                    // бейдж Chat «ждут отправки: N»
}

type FlushOutcome = 'confirmed' | 'transport_failure' | 'business_rejection';
// confirmed → удалить из очереди; transport_failure → оставить (ретрай);
// business_rejection → удалить + отдать ошибку наружу
```

- [ ] **Step 1: Написать падающие тесты — enqueue→flush(confirmed)→удаление, различение исходов**

`apps/web/src/lib/retry-buffer/retry-buffer.test.ts`:
```typescript
import { createRetryBuffer, type FlushOutcome } from './index';

test('enqueue кладёт запись в очередь; flush(confirmed) удаляет её', async () => {
  const buffer = createRetryBuffer();
  const queued = buffer.enqueue({ tool: 'entity_create', payload: { title: 'Обед 340' } });
  expect(buffer.size()).toBe(1);
  expect(queued.clientId).toBeTruthy();

  await buffer.flush(async () => 'confirmed');

  expect(buffer.size()).toBe(0);
});

test('transport_failure оставляет запись в очереди; business_rejection удаляет её с ошибкой', async () => {
  const buffer = createRetryBuffer();
  buffer.enqueue({ tool: 'entity_create', payload: { title: 'A' } }); // получит transport_failure
  buffer.enqueue({ tool: 'entity_create', payload: { title: 'B' } }); // получит business_rejection

  const outcomes: FlushOutcome[] = ['transport_failure', 'business_rejection'];
  await buffer.flush(async () => outcomes.shift() ?? 'confirmed'); // noUncheckedIndexedAccess-safe

  expect(buffer.size()).toBe(1); // осталась только transport_failure-запись, ретраится следующим flush()
});
```
(Тест на `cancel()` — не в скелете Вехи 0: интерфейс реализуется и покрыт typecheck'ом, поведенческий UI-тест «отмена до отправки» — Слайс 1, 02-core-os §2.6, когда появится сам индикатор «ждут отправки: N».)

- [ ] **Step 2: Прогнать — упадёт (нет модуля)**

Run: `bun run --cwd apps/web test`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: `storage.ts`** — персист в localStorage за отдельным интерфейсом

```typescript
import type { QueuedCreate } from './index';

const STORAGE_KEY = 'orbis:retry-buffer:v1';

export interface QueueStorage {
  load(): QueuedCreate[];
  save(items: QueuedCreate[]): void;
}

export const localStorageQueue: QueueStorage = {
  load: () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'),
  save: (items) => localStorage.setItem(STORAGE_KEY, JSON.stringify(items)),
};
```
`QueueStorage` — единственная точка замены на IndexedDB позже; логика буфера не знает, где физически хранятся записи.

- [ ] **Step 4: `index.ts`** — минимальная реализация `createRetryBuffer`

```typescript
import type { QueueStorage } from './storage';
import { localStorageQueue } from './storage';

export interface QueuedCreate {
  clientId: string;
  tool: string;
  payload: unknown;
  createdAt: string;
}

export type FlushOutcome = 'confirmed' | 'transport_failure' | 'business_rejection';

export interface RetryBuffer {
  enqueue(op: Omit<QueuedCreate, 'clientId' | 'createdAt'>): QueuedCreate;
  flush(send: (op: QueuedCreate) => Promise<FlushOutcome>): Promise<void>;
  cancel(clientId: string): void;
  size(): number;
}

export function createRetryBuffer(storage: QueueStorage = localStorageQueue): RetryBuffer {
  let queue: QueuedCreate[] = storage.load();

  return {
    enqueue(op) {
      // UUIDv7 (01 §5.3) — генератор из packages/shared при исполнении слайса;
      // crypto.randomUUID() здесь placeholder-скелет (v4, не сортируемый по времени).
      const item: QueuedCreate = { ...op, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() };
      queue = [...queue, item];
      storage.save(queue);
      return item;
    },
    async flush(send) {
      for (const item of [...queue]) {
        const outcome = await send(item);
        if (outcome === 'confirmed' || outcome === 'business_rejection') {
          queue = queue.filter((q) => q.clientId !== item.clientId);
          storage.save(queue);
        }
        // transport_failure — запись остаётся, ретрай следующим вызовом flush()
      }
    },
    cancel(clientId) {
      queue = queue.filter((q) => q.clientId !== clientId);
      storage.save(queue);
    },
    size: () => queue.length,
  };
}
```

- [ ] **Step 5: Прогон — зелено**

Run: `bun run --cwd apps/web test && bun run --cwd apps/web typecheck`
Expected: оба теста зелёные (enqueue→flush(confirmed)→удаление; transport_failure остаётся/business_rejection удаляется); typecheck без ошибок.

- [ ] **Step 6: Контрольная точка (коммит — только по явному разрешению владельца в этой сессии)**

Run: `git add apps/web/src/lib/retry-buffer && git commit -m "feat(web): retry-буфер fast-path-create — enqueue/flush/cancel (PRD 01 §5.3)"`
Expected: по умолчанию НЕ выполняется — см. шапку плана («без коммитов без спроса»); коммит делается только если владелец в этой сессии явно разрешил коммиты. Иначе изменения остаются в рабочей копии до Task 12.

---

### Task 11: Acceptance-харнесс контрактов PRD (RED-тесты)

**Files:**
- Create: `packages/shared/src/query/grammar.ts` (типы AST грамматики — скелет)
- Create: `packages/shared/src/query/fixtures.ts` (общие фикстуры сущностей)
- Create: `packages/shared/src/contracts/fast-path.test.ts` (RED, пропущен до Слайса 1)
- Create: `packages/shared/src/contracts/retry-idempotency.test.ts` (RED, пропущен до Слайса 1)
- Create: `packages/shared/src/contracts/optimistic-check.test.ts` (RED, пропущен до Слайса 1)
- Create: `packages/shared/src/contracts/confirmation-policy.test.ts` (RED, пропущен до Слайса 1)
- Create: `packages/shared/src/contracts/csv-dedup.test.ts` (RED, пропущен до Слайса 2)

**Контекст:** PRD содержит проверяемые контракты поведения. Веха 0 кодирует их как **исполняемый каркас тестов** — намеренно RED/skipped, они станут GREEN в слайсах, где реализуется соответствующая механика. Это и есть «PRD-контракт = исполняемый skipped-тест» — метод, а не конкретный набор тестов v3: тест на сравнение результата двух SQL-бэкендов query-движка и тест матрицы конфликтов синхронизации (оба — v3) удалены целиком — оба контракта вырезаны из PRD v3.1 (один бэкенд query-движка, 01 §6.2; конфликты — LWW + optimistic-check, а не матрица, 01 §5.2). Метод переиспользован для пяти новых контрактов v3.1.

- [ ] **Step 1: Типы AST грамматики (скелет, по 01 §6.1)**

`grammar.ts`: объявить TS-типы фильтра запроса (теги, исключения, аспект, поле=значения с `|`, отрицания `!`/`&`, date-токены, числовые сравнения/диапазоны, `children_of`/`parents_of`, `excludeBlocked`, `sortBy`, `search`, `limit`, `display`, `title`) как discriminated unions. Без парсера — только типы (парсер клиентского fast-path и серверного SQL-компилятора — Слайс 1/2, оба потребляют эти типы, 00-architecture §1/§3).

- [ ] **Step 2: Общие фикстуры**

`fixtures.ts`: экспортировать ~10 сущностей-образцов (задачи с разными status/priority/due_date, заметка, финансовая запись) как массив `Entity[]` — единый вход для будущих golden-тестов грамматика→SQL (01 §6.2) и для контрактных тестов ниже.

- [ ] **Step 3: Скелет контрактного теста fast-path-грамматики (skipped, PRD 01 §7.5)**

`contracts/fast-path.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 01 §7.5: клиентский детерминированный парсер (apps/web, без LLM) распознаёт
// частотные паттерны ввода и уступает LLM-пути при любой неуверенности.
describe.skip('fast-path: детерминированный парсер (Слайс 1)', () => {
  test('"обед 340" → orbis/financial expense, amount=340.00, категория по aliases', () => {
    // Слайс 1: см. таблицу паттернов 01 §7.5
  });
  test('"+150000 зарплата" → orbis/financial income, amount=150000.00', () => {
    // Слайс 1
  });
  test('"кофе 4 usd" → expense с явной currency=USD', () => {
    // Слайс 1
  });
  test('неизвестная категория / несколько сумм / вопросительная форма → уступает LLM-пути', () => {
    // Слайс 1: правила передачи в LLM, 01 §7.5
  });
});
```

- [ ] **Step 4: Скелет контрактного теста идемпотентности досылки (skipped, PRD 01 §5.3)**

`contracts/retry-idempotency.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 01 §5.3: сервер обязан принимать повторный create с тем же client-UUID
// как один и тот же результат — идемпотентность обязательна и онлайн, не только офлайн.
describe.skip('retry-буфер: идемпотентность досылки по client-UUID (Слайс 1)', () => {
  test('повторный entity_create с тем же clientId не создаёт дубль, возвращает тот же результат', () => {
    // Слайс 1: см. 01 §5.3 + sequence-диаграмму 00-architecture §4.1
  });
  test('transport_failure остаётся в очереди и ретраится; business_rejection удаляется с ошибкой', () => {
    // Слайс 1
  });
});
```

- [ ] **Step 5: Скелет контрактного теста optimistic-check (skipped, PRD 01 §5.2)**

`contracts/optimistic-check.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 01 §5.2: правка body обязана передать updated_at прочитанной версии;
// расхождение с серверным значением — отказ, а не тихая перезапись.
describe.skip('конкурентность: optimistic-check по updated_at для body (Слайс 1)', () => {
  test('правка с текущим updated_at применяется, версия обновляется', () => {
    // Слайс 1
  });
  test('правка с устаревшим updated_at отклоняется структурированной ошибкой 409', () => {
    // Слайс 1: см. sequence-диаграмму 00-architecture §4.4
  });
  test('поля вне body (например tags) разрешаются простым LWW, без optimistic-check', () => {
    // Слайс 1
  });
});
```

- [ ] **Step 6: Скелет контрактного теста политики подтверждений (skipped, PRD 01 §7.10)**

`contracts/confirmation-policy.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 01 §7.10: уровень подтверждения (execute/preview/explicit-confirmation/forbidden)
// определяет политика Orbis после структурной валидации tool-call, не модель.
describe.skip('политика подтверждений AI-действий: классификация уровней (Слайс 1)', () => {
  test('execute — исполняется немедленно, карточка и журнал постфактум', () => {
    // Слайс 1
  });
  test('preview — исполняется с информационным diff-предпросмотром', () => {
    // Слайс 1
  });
  test('explicit-confirmation — не исполняется до подтверждения; approve ревалидирует состояние без повторного вызова модели', () => {
    // Слайс 1: см. sequence-диаграмму 00-architecture §4.2
  });
  test('forbidden — отклоняется структурированной ошибкой до исполнения', () => {
    // Слайс 1
  });
});
```

- [ ] **Step 7: Скелет контрактного теста дедупа CSV (skipped, PRD 03 §3.4.1)**

`contracts/csv-dedup.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 03 §3.4.1: уникальность (owner_id, namespace, external_id) в entity_origins
// ловит повтор той же строки источника; критерий (1)+(2)+(3) — вероятные дубли между источниками.
describe.skip('CSV-импорт: дедуп через entity_origins (Слайс 2)', () => {
  test('совпадение (owner_id, namespace, external_id) → статус "уже импортирована", без новой записи', () => {
    // Слайс 2
  });
  test('amount+direction точно, occurred_on ±1 день, counterparty-similarity ≥0.85 → "вероятный дубль"', () => {
    // Слайс 2: нормализация и порог — 03 §3.4.1
  });
  test('ни origin, ни содержательное совпадение → статус "новая"', () => {
    // Слайс 2
  });
  test('Undo импорта физически удаляет entity_origins → повторный импорт того же файла без ложных "уже импортирована"', () => {
    // Слайс 2
  });
});
```

- [ ] **Step 8: Прогон — каркас виден, skipped**

Run: `bun test --cwd packages/shared`
Expected: все пять контрактных тестов числятся как skipped (не fail, не молча отсутствуют); существующие зелёные тесты (entity) проходят. Так контракты PRD v3.1 зафиксированы исполняемо и ждут своих слайсов.

---

### Task 12: Веха 0 — итоговая проверка

- [ ] **Step 1: Полный прогон корневых проверок**

Run: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test`
Expected: всё зелёное (skipped-контракты — это не fail). Это то, что гоняет CI.

- [ ] **Step 2: Смоук дев-режима**

Run: `bun run --cwd apps/server dev` + `bun run --cwd apps/web dev`, открыть `localhost:5173`.
Expected: страница «Orbis» рендерится с применёнными токенами (фон/цвет из `tokens.css`); прокси `/trpc` достаёт сервер; `localhost:3001/health` отвечает.

- [ ] **Step 3: Отчёт владельцу (БЕЗ коммита)**

Сводка: что поднято, версии ключевых пакетов, состояние skipped-контрактов, что готово к Слайсу 1. Предложить владельцу проверить и решить про коммит контрольной точки Вехи 0.

---

## Очерки слайсов (детализируются JIT перед стартом каждого)

Полный bite-sized план каждой фазы/слайса пишется отдельным документом непосредственно перед его исполнением — детали будут точнее после Вехи 0. Здесь — границы и главные задачи; канонический состав — PRD 00-product §9 (пометки «слайс N» в 02-core-os.md и 03-budget.md ссылаются на эту разбивку, не дублируют её). Слайс «Sync» из v3 удалён целиком вместе с клиентской локальной БД и её коннектором (D1 спеки 2026-07-02).

- **Фаза 0 — спайки (блокирующие, до старта Слайса 1).** **SPIKE-01**: RLS через Drizzle/Bun — pooled-переиспользование соединений не путает identity пользователей, service-role — не fallback. **SPIKE-05**: деплой-связность — хостинг (регион, session-pool, персистентный контейнер, секреты, бэкапы, стоимость). Продакшен нужен рано: агентная петля живёт только на задеплоенном приложении.
- **Слайс 1 — «Агентная петля + ввод» (продакшен).** Сущности/проекты/задачи/заметки — CRUD через executor со статусами и связями `parent`; Browser-lite (список, сайдбар pinned, три сидированных smart lists, минимальный detail-экран: title/теги/body/аспекты/подзадачи); Chat — глобальный тред и треды сущностей, fast-path (расходы копятся с первого дня без Budget-view — данные существуют до views), LLM-путь с тулами, карточки, журнал и Undo, политика подтверждений — снять `skip` с контрактных тестов fast-path/идемпотентности/optimistic-check/политики подтверждений (T11), сделать GREEN; MCP-сервер — PAT, тот же реестр тулов, паттерн «что нового»; retry-буфер (растёт из скелета T10), онбординг-сидирование (категории, smart lists, настройки, глобальный тред), экспорт данных, деплой в продакшен. **Приёмка:** агент создал в Orbis проект «Orbis», перенёс документацию (спеки/планы — note-сущности), и разработка Слайса 2 дальше ведётся через задачи в самом Orbis — агент двигает статусы и пишет заметки, владелец наблюдает и отвечает в тредах с телефона.
- **Слайс 2 — «Финансовый контур + время».** Budget Overview и конверты (сразу показывают историю, накопленную со Слайса 1), quick-add бар, recurring-платежи и события с Coming up и переходом planned→fact, Agenda-lite, rollover на границе месяца, CSV-импорт банковских выписок (дедуп на `entity_origins` — снять `skip` с контрактного теста CSV-дедупа, T11, GREEN), экран памяти AI с эскалацией повторных исправлений в правила, полный detail-экран сущности (блокировки, backlinks). На выходе: полный финансовый контур, покрытие транзакций измеримо метрикой (00-product §8).
- **Слайс 3 — «Полировка и глубина».** Suggestion chips, бейджи вкладок, deep links, визуальная форма query-builder поверх грамматики (T11: типы AST из query/grammar.ts получают парсер и SQL-компилятор), перф-бюджеты как гейты релиза, аспект `orbis/goal` и планирование горизонтов (день/неделя/месяц/год/жизнь) как AI-сценарии поверх уже готового механизма `progress_source`. На выходе: продукт, которым не страшно пользоваться как единственным хранилищем жизни.

После Вехи 0: детализировать фазу 0 (спайки) и Слайс 1 отдельными планами (`writing-plans`), затем исполнять.
