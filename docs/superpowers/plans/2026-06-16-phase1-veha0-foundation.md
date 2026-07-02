# Orbis Фаза 1 — Веха 0 «Фундамент» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять каркас монорепо Orbis под решённый стек — так, чтобы на нём можно было начать Слайс 1 («Обед 340»): рабочие `typecheck`/`lint`/`test`/CI, дизайн-система с токенами, скелеты server (tRPC + Supabase auth), web (React PWA + Tailwind v4 + Radix + PowerSync-клиент с локальной SQLite) и acceptance-харнесс для проверяемых контрактов PRD.

**Architecture:** Bun-монорепо из трёх workspace-пакетов — `packages/shared` (Zod-схемы, типы, константы, грамматика запросов), `apps/server` (Hono + tRPC + Drizzle + Supabase + LLMProvider + PowerSync backend), `apps/web` (Vite + React PWA + Tailwind v4 + Radix + Zustand + PowerSync client). Источник истины — PRD `docs/prd/` (01-architecture — фундамент). Веха 0 ставит скелеты и инструменты, НЕ фичи: фичи идут слайсами 1–5.

**Tech Stack:** Bun + TypeScript · tRPC v11 · Drizzle ORM · PostgreSQL (Supabase, локально через Supabase CLI) · PowerSync (Postgres↔SQLite) · Vite + React 19 PWA · Tailwind v4 + Radix · Zustand · LLMProvider поверх Vercel AI SDK (в Вехе 0 — только интерфейс-скелет) · Biome (lint+format) · Bun test + Vitest + React Testing Library · GitHub Actions CI.

**Решения по инструментам (зафиксированы при пересмотре стека):**
- Линтер/формат — **Biome** (один бинарь, без ESLint+Prettier).
- Тесты — **Bun test** для `shared`/`server`, **Vitest + React Testing Library + jsdom** для `web`.
- Локальная БД — **Supabase CLI** (Docker): Postgres + Auth локально, без облака.
- PowerSync — в Вехе 0 ставится клиентский SDK с **локальной SQLite** (offline-first работает с первого слайса); коннектор Postgres↔SQLite (логическая репликация) подключается в **Слайсе 3**.

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
│     │  └─ schema.ts           # T5: 8 таблиц (скелет)
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
│  │  └─ db/
│  │     └─ powersync.ts        # T10: PowerSync client + локальная SQLite-схема (скелет)
│  └─ tests/setup.ts            # T3: jsdom + RTL setup
└─ packages/shared/src/query/   # T11: acceptance-харнесс (фикстуры + RED-тесты контрактов)
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

**Контекст:** таблицы — по 01-architecture §4 (entities, relations, aspect_definitions, user_settings, chat_threads, chat_messages, ai_usage, sync_log). Здесь — структура столбцов и индексы; RLS-политики и сид аспектов — Слайс 1. Цель Вехи 0: схема компилируется, миграция генерируется и применяется к локальному Supabase.

- [ ] **Step 1: Supabase CLI — поднять локальный стек**

Run: `bunx supabase init && bunx supabase start`
Expected: поднимается локальный Postgres + Auth (Docker); CLI печатает `API URL`, `DB URL`, `anon key`, `service_role key`. Записать `DB URL` (обычно `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) в `apps/server/.env` как `DATABASE_URL`, anon/url — для T7.

- [ ] **Step 2: Установить Drizzle**

Run: `bun add --cwd apps/server drizzle-orm postgres && bun add -d --cwd apps/server drizzle-kit`

- [ ] **Step 3: `db/schema.ts`** — 8 таблиц по 01 §4

Точные столбцы — из 01-architecture §4.1–§4.8. Ключевые места: `entities` (id uuid PK, user_id, title, emoji, body text default '', body_refs text[] default {}, tags text[] default {}, meta jsonb default {}, aspects jsonb default {}, created_at, updated_at, synced_at nullable, archived bool default false); `relations` (+ updated_at, + deleted_at nullable; partial unique `(source_id,target_id,relation_type) WHERE deleted_at IS NULL`; CHECK source≠target); `aspect_definitions` (id text PK, user_id nullable, name, namespace, description, icon, schema jsonb, ai_instructions, tag_mappings text[], aggregations jsonb, view_config jsonb, created_at); `user_settings` (user_id PK, display_name, timezone default 'Europe/Moscow', default_currency default 'RUB', week_start_day default 'monday', plan text default 'dev', aspect_statuses jsonb, tag_colors jsonb, installed_views text[], pinned_entities jsonb, view_preferences jsonb, updated_at); `chat_threads` (id uuid PK, user_id, entity_id uuid nullable, title, archived bool, created_at, updated_at); `chat_messages` (id uuid PK, thread_id, role text, content text, metadata jsonb, created_at); `ai_usage` (user_id, date, input_tokens, output_tokens, request_count, model — PK (user_id,date,model)); `sync_log` (id, user_id, device_id, last_sync_at, entity_count, conflicts jsonb, created_at).

Скелет (привести все 8; здесь — образец двух, остальные по тому же образцу и таблицам 01 §4):
```typescript
import { pgTable, uuid, text, jsonb, timestamp, boolean, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  emoji: text('emoji'),
  body: text('body').notNull().default(''),
  bodyRefs: text('body_refs').array().notNull().default(sql`'{}'`),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  meta: jsonb('meta').notNull().default({}),
  aspects: jsonb('aspects').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
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
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  uniqLive: unique('rel_uniq_live').on(t.sourceId, t.targetId, t.relationType).nullsNotDistinct(),
  noSelf: check('rel_no_self', sql`${t.sourceId} <> ${t.targetId}`),
}));
// ... остальные 6 таблиц по 01-architecture §4 ...
```
Примечание: partial unique `WHERE deleted_at IS NULL` (01 §4.2) — drizzle-kit может не выразить partial-условие декларативно; если так, добавить его SQL-ом в сгенерированную миграцию вручную (отметить комментарием в миграции).

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
Expected: создаётся SQL-миграция со всеми 8 таблицами; применяется к локальному Supabase без ошибок. Проверка: `bunx supabase db diff` не показывает расхождений (или таблицы видны в Studio на `54323`). Если partial unique не попал — дописать в миграцию `CREATE UNIQUE INDEX rel_uniq_live ON relations (source_id,target_id,relation_type) WHERE deleted_at IS NULL;` и переприменить.

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
    userId: '018e4a2c-0000-7000-8000-000000000001',
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
  userId: z.string().uuid(),
  title: z.string().min(1),
  emoji: z.string().nullable().default(null),
  body: z.string().default(''),
  bodyRefs: z.array(z.string().uuid()).default([]),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.any()).default({}),
  aspects: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  syncedAt: z.string().datetime().nullable().default(null),
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
  deletedAt: z.string().datetime().nullable().default(null),
});
export type Relation = z.infer<typeof relationSchema>;
```

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

```typescript
import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';

export interface Context { userId: string | null; }

export async function createContext({ req }: { req: Request }): Promise<Context> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { userId: null };
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data } = await supabase.auth.getUser(token);
  return { userId: data.user?.id ?? null };
}

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { userId: ctx.userId } });
});
```

- [ ] **Step 3: `router.ts`** — пинг (public) + whoami (protected)

```typescript
import { router, publicProcedure, protectedProcedure } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
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
  const caller = appRouter.createCaller({ userId: null });
  expect(await caller.ping()).toEqual({ ok: true });
});

test('whoami без авторизации бросает UNAUTHORIZED', async () => {
  const caller = appRouter.createCaller({ userId: null });
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

**Контекст (01 §7.7):** реализация — поверх Vercel AI SDK, но **типы AI SDK не протекают наружу**. В Вехе 0 — только наши типы + интерфейс + заглушка-реализация (echo), без реального вызова модели. Реальная интеграция — Слайс 4.

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

- [ ] **Step 3: `provider.ts`** — заглушка (реальный Vercel-AI-SDK-провайдер — Слайс 4)

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

### Task 10: PowerSync client — локальная SQLite (offline-only скелет)

**Files:**
- Modify: `apps/web/package.json` (deps: PowerSync web SDK + react)
- Create: `apps/web/src/db/powersync.ts`, `apps/web/src/db/schema.ts` (клиентская SQLite-схема)
- Create: `apps/web/src/db/powersync.test.ts`

**Контекст (01 §4.12, §5):** PowerSync держит локальную SQLite (WASM/OPFS), работает offline-only без коннектора. Коннектор Postgres↔SQLite — Слайс 3. В Вехе 0: SDK установлен, клиентская SQLite-схема `entities`/`relations` объявлена, БД открывается, локальная вставка+чтение работают (смоук offline-first). Точные имена API PowerSync уточнить по актуальной версии SDK при исполнении.

- [ ] **Step 1: Установить PowerSync web SDK**

Run: `bun add --cwd apps/web @powersync/web @powersync/react`
Expected: пакеты добавлены. (Если имена пакетов в актуальной версии отличаются — взять из текущей документации PowerSync для web/React; цель неизменна: web SDK + React-биндинги.)

- [ ] **Step 2: Клиентская SQLite-схема `db/schema.ts`**

Объявить таблицы `entities` и `relations` средствами PowerSync schema-builder, зеркало серверной структуры (id, title, body, tags, meta, aspects как text/json-колонки SQLite — JSONB на клиенте хранится строкой). Точный синтаксис — из PowerSync SDK (`new Schema({...})` с `Table`/`column`).

- [ ] **Step 3: `db/powersync.ts`** — инициализация локальной БД (без коннектора)

Создать и открыть PowerSync-базу с этой схемой, экспортировать инстанс. Коннектор НЕ подключать (offline-only). Экспортировать функцию `initLocalDb()` и helper для вставки/запроса сущности.

- [ ] **Step 4: Смоук-тест локальной вставки/чтения**

`apps/web/src/db/powersync.test.ts`: открыть локальную БД (в jsdom-окружении PowerSync использует WASM; если в Vitest/jsdom WASM-драйвер недоступен — пометить тест как интеграционный и проверять схему/инициализацию мокнутым драйвером, а реальный смоук вынести в ручной прогон `bun run --cwd apps/web dev` с тестовой кнопкой). Минимум: тест проверяет, что схема объявлена и `initLocalDb()` не бросает.

Run: `bun run --cwd apps/web test`
Expected: тест зелёный (или явно помечен интеграционным со ссылкой на ручной смоук). Зафиксировать в комментарии, какой путь выбран и почему — не оставлять молчаливый пропуск.

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd apps/web typecheck`
Expected: зелёно.

---

### Task 11: Acceptance-харнесс контрактов PRD (RED-тесты)

**Files:**
- Create: `packages/shared/src/query/grammar.ts` (типы AST грамматики — скелет)
- Create: `packages/shared/src/query/fixtures.ts` (общие фикстуры сущностей)
- Create: `packages/shared/src/query/equivalence.test.ts` (RED, пропущен до Слайса 2)
- Create: `packages/shared/src/sync/conflict.fixtures.ts`, `packages/shared/src/sync/conflict.test.ts` (RED, пропущен до Слайса 3)

**Контекст:** PRD содержит проверяемые контракты — эквивалентность двух SQL-бэкендов query-движка (01 §6.2) и матрица конфликтов (01 §5.2). Веха 0 кодирует их как **исполняемый каркас тестов**, которые сейчас намеренно RED/skipped и станут GREEN в слайсах 2 и 3. Это и есть «spec-тесты из спеки».

- [ ] **Step 1: Типы AST грамматики (скелет, по 01 §6.1)**

`grammar.ts`: объявить TS-типы фильтра запроса (теги, исключения, аспект, поле=значения с `|`, отрицания `!`/`&`, date-токены, числовые сравнения/диапазоны, `children_of`/`parents_of`, `excludeBlocked`, `sortBy`, `search`, `limit`, `display`, `title`) как discriminated unions. Без парсера — только типы (парсер в Слайсе 2).

- [ ] **Step 2: Общие фикстуры**

`fixtures.ts`: экспортировать ~10 сущностей-образцов (задачи с разными status/priority/due_date, заметка, финансовая запись) как массив `Entity[]` — единый вход для обоих бэкендов.

- [ ] **Step 3: Скелет теста эквивалентности (skipped)**

`equivalence.test.ts`:
```typescript
import { describe, test } from 'bun:test';
// Контракт 01 §6.2: серверный (Postgres) и клиентский (SQLite) бэкенды
// на одних фикстурах и одном запросе обязаны возвращать идентичный результат.
describe.skip('query-движок: эквивалентность бэкендов (Слайс 2)', () => {
  test('today + сортировка по priority даёт один результат на обоих бэкендах', () => {
    // TODO Слайс 2: прогнать один и тот же запрос через оба бэкенда и сравнить id-список
  });
});
```
(`describe.skip` — намеренный RED-каркас; в Слайсе 2 снимается skip и реализуется.)

- [ ] **Step 4: Скелет теста матрицы конфликтов (skipped)**

`conflict.test.ts`: `describe.skip('sync: матрица конфликтов (Слайс 3)', ...)` с тест-кейсами-заголовками по строкам матрицы 01 §5.2 (title LWW, tags LWW массива, meta key-level, aspects aspect-level, body конфликт-копия, relations tombstone) — тела с комментарием-ссылкой на §5.2, реализация в Слайсе 3.

- [ ] **Step 5: Прогон — каркас виден, skipped**

Run: `bun test --cwd packages/shared`
Expected: тесты эквивалентности и конфликтов числятся как skipped (не fail, не молча отсутствуют); существующие зелёные тесты (entity) проходят. Так контракты PRD зафиксированы исполняемо и ждут своих слайсов.

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

Полный bite-sized план каждого слайса пишется отдельным документом непосредственно перед его исполнением — детали будут точнее после Вехи 0. Здесь — границы и главные задачи.

- **Слайс 1 — «Обед 340» (сквозной путь, локально).** 7 Zod-схем аспектов в `shared` (01 §3) · RLS-политики + сид аспектов и 12 категорий + 3 pinned-сущности (01 §3, 02 §7) · `entity` tRPC-роутер (create/get/update/list) с записью в локальную SQLite и зеркалом в Postgres · клиентский fast-path-парсер (01 §7.5: «обед 340» → expense + резолв категории по aliases) · минимальный список сущностей на дизайн-системе. Контракт: запись расхода ≤ 2 сек, без сети, без LLM.
- **Слайс 2 — Query-движок + Browser.** Парсер грамматики (01 §6.1) → AST · два SQL-бэкенда (Postgres / SQLite) · снять `skip` с теста эквивалентности (T11) — сделать GREEN · pinned-сайдбар со smart lists · Entity Browser: detail-экран, native-рендеринг task/schedule, фильтры. Визуальный query-builder — Фаза 3 (строки запросов правятся вручную).
- **Слайс 3 — Sync (PowerSync).** Коннектор Postgres↔SQLite (логическая репликация) · sync-правила · серверный conflict-резолвер по матрице 01 §5.2 — снять `skip` с теста конфликтов (T11), GREEN · детерминированные ID (01 §5.5) · UX офлайн-очереди (02 §2.6) · конфликт-копии body.
- **Слайс 4 — AI-чат.** Реальный `LLMProvider` поверх Vercel AI SDK (замена EchoProvider) · динамические тулы из реестра (01 §7.6, §9.2) · `ai` tRPC-роутер · треды (глобальный + сущности) · базовые memory-факты и журнал действий/Undo (01 §7.8) · чат-UI с карточками (02 §2.3). MCP — Фаза 2.
- **Слайс 5 — Agenda-lite + онбординг.** Экран Agenda (02 §4: просроченное сверху, дни +7) · материализация recurring-инстансов (01 §5.5) · полный онбординг-сидинг при создании пользователя (02 §7) · бейджи вкладок.

После Вехи 0: детализировать Слайс 1 отдельным планом (`writing-plans`), затем исполнять.
