# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun run dev           # Web dev server (Vite on :5173)
bun run dev:server    # Server with hot reload (Bun on :3001)
bun run dev:all       # Both concurrently

# Build & check
bun run build         # Build web (tsc + vite build)
bun run typecheck     # Typecheck all three packages (shared → server → web)

# Database (Drizzle + PostgreSQL via Supabase)
bun run db:generate   # Generate migration from schema changes
bun run db:migrate    # Apply migrations
bun run db:seed       # Seed default aspects and smart views

# Web only
cd apps/web && bun run lint      # ESLint
cd apps/web && bun run preview   # Preview production build
```

## Architecture

Bun monorepo with three workspace packages:

```
packages/shared  →  Zod schemas, TypeScript types, constants (imported by both server and web)
apps/server      →  Hono HTTP + tRPC v11 + Drizzle ORM + Anthropic SDK
apps/web         →  Vite 8 + React 19 + Tailwind CSS v4 + Zustand + tRPC client
```

### Request flow

Web → tRPC httpBatchLink (`/trpc`) → Vite dev proxy → Hono server → tRPC router → Drizzle → PostgreSQL

Auth: Supabase JWT. Web gets token via `supabase.auth.getSession()`, sends as `Authorization: Bearer {token}`. Server validates with `supabase.auth.getUser(token)` in tRPC context (`apps/server/src/trpc.ts`). All data-mutating procedures use `protectedProcedure` which gates on `ctx.userId`.

### tRPC routers (`apps/server/src/routers/`)

`entity` (CRUD + financial/fitness/nutrition/habits submodules), `relation`, `aspect`, `user`, `sync`, `ai` (rate-limited: 20 req/min), `metrics`, `share`. Router composition in `apps/server/src/router.ts`. `AppRouter` type is imported by web for end-to-end type safety.

### Data model

Single `entities` table with JSONB `aspects` column — entities are typed by their aspects (task, financial, fitness, nutrition, habit, note, goal). The `relations` table links entities (parent, blocks, related_to, derived_from). Aspect definitions stored in `aspect_definitions` table. User preferences in `user_settings`.

Schema: `apps/server/src/db/schema.ts`. Migrations: `apps/server/src/db/migrations/` (configured via `apps/server/drizzle.config.ts`). Validation schemas: `packages/shared/src/schemas.ts`. Constants/enums: `packages/shared/src/constants.ts`.

### Frontend state

- **Zustand stores** (`apps/web/src/stores/`): `auth` (Supabase session), `navigation` (active view, filters, calendar week), `chat` (message history), `settings` (user prefs)
- **tRPC + React Query**: server data via `trpc.entity.list.useQuery()` etc. Two clients exist — React hooks (`trpc`) and vanilla client (`trpcClient`) for use in Zustand stores
- **Dexie** (IndexedDB): offline entity cache with sync via `sync.push`/`sync.pull` tRPC procedures
- **Navigation**: single `navigate(view, params?)` method in navigation store, views rendered by `HomePage.renderMainContent()`

### Frontend component patterns

- `components/ui/AspectCard.tsx` — shared wrapper for all aspect cards (title + border + padding)
- `components/ui/IconButton.tsx` — accessible icon button (requires `label` prop for aria-label)
- Aspect cards (`TaskAspectCard`, `FitnessAspectCard`, etc.) receive `data` + `onChange` props
- List items (`EntityRow`, `ChatMessage`, `PinnedEntityRow`) are wrapped in `React.memo`
- `react-markdown` is lazy-loaded in `BodyEditor.tsx` (only loads in preview mode)
- Heavy views lazy-loaded via `React.lazy` in `HomePage.tsx`

## Environment

Env is split per app — each reads its own file from its own cwd. The root `.env.example` documents the union of variables; copy the relevant subset into each app.

`apps/server/.env`:

```
SUPABASE_URL          # Supabase project URL
SUPABASE_ANON_KEY     # Supabase anonymous key
DATABASE_URL          # PostgreSQL connection string
ANTHROPIC_API_KEY     # Claude API key (for AI chat)
PORT                  # Server port (default: 3001)
```

`apps/web/.env`:

```
VITE_SUPABASE_URL         # same as SUPABASE_URL
VITE_SUPABASE_ANON_KEY    # same as SUPABASE_ANON_KEY
```
