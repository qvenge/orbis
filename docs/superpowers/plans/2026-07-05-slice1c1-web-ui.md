# Слайс 1c-1 «Web UI» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающий PWA-фронтенд Orbis против готового tRPC-бэкенда (слайсы 1a+1b): вход, онбординг, чат с карточками и fast-path, Browser-lite, detail сущности, настройки+экспорт.

**Architecture:** Feature-first React 19 + TanStack Query (server-state) + Zustand (навигация/устройство) поверх tRPC-react-query. Мутации оптимистичны с инвалидацией (§5.1); офлайн — только fast-path через retry-буфер (§5.3). Карточки чата — серверный union, клиент рендерит.

**Tech Stack:** React 19, Vite 8, TanStack Query 5, @trpc/react-query 11, radix-ui, Tailwind v4 (токены Вехи-0), @supabase/supabase-js, zustand (ДОБАВИТЬ), vite-plugin-pwa; тесты web — Vitest + @testing-library/react (jsdom); тесты shared — bun:test.

## Global Constraints

- Тесты web — **Vitest** (`test`/`expect` globals, jsdom, `tests/setup.ts`); тесты в `packages/shared` — **bun:test**. Не путать раннеры.
- Все client-generated id (create-сущностей, user-сообщений чата, retry-буфер) — **`newId()` (UUIDv7) из `@orbis/shared`**, НИКОГДА `crypto.randomUUID()` (§2.1/§5.3).
- Каждый tRPC-запрос несёт заголовки `Authorization: Bearer <supabase access_token>` и `CLIENT_VERSION_HEADER` (`x-orbis-client-version`) = `APP_VERSION` (§9.1).
- Клиент ключуется на **коды** ошибок (`TRPCClientError.data.code`), НЕ на текст cause (cause по HTTP не сериализуется). CLIENT_OUTDATED = код `PRECONDITION_FAILED` (412).
- Деньги — **decimal-строки** (знак/цвет: расход красный `−`, доход зелёный `+`); никакого IEEE-754/parseFloat для отображения сумм.
- Таймстампы наружу — UTC-суффикс `Z`; `expectedUpdatedAt` шлётся ровно той строкой, что клиент видел (§5.2).
- Web-клиент всегда `actorKind='owner'` (Supabase JWT) — все ownerOnly-процедуры доступны; PAT-путь клиента нет.
- Server-state живёт в TanStack Query; в Zustand его НЕ дублировать (Zustand — только навигация/буфер/черновики/сессия).
- Никаких новых зависимостей кроме `zustand` без явной задачи. radix-ui, tailwind, supabase-js, vite-plugin-pwa уже установлены.
- DRY, YAGNI, TDD, частые коммиты. Каждая задача — один коммит, трейлер `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Решения контроллера (ревизуемы владельцем)

- **D-a TTL pending:** клиентский visual-expiry через **24ч** от `createdAt` карточки (кнопки approve/reject гаснут, подпись «устарело — переспросите AI»); approve всё равно ревалидирует состояние на сервере. Серверный TTL — 1c-2/backlog.
- **D-b Последовательность задач:** foundation (tRPC+auth+nav+онбординг) → Chat (тред+карточки+fast-path+буфер) → Browser-lite (список+сайдбар+detail+query-блоки) → настройки/экспорт → PWA.
- **D-c Browser-lite объём:** рендер `{{query:...}}`-блоков (native-список + счётчик + красная плашка ошибок с позицией) + базовая панель фильтров → строка грамматики. Визуальный query-builder НЕ делаем (слайс 3); блок правится как текст body. Блокировки/backlinks — слайс 2.
- **D-d Рендер перечислений:** карточка `query_result` с `aggregate` → число + «показать список»; без `aggregate` (есть `entityIds`) → native-список сущностей.
- **D-e Fast-path парсер:** чистая логика в `packages/shared/src/fast-path/` (тестируется bun:test, реюз сервером), вызов-обёртка из web.
- **D-f Optimistic-чат:** user-сообщение показывается сразу (client-UUIDv7); при `replayed:true` из `ai.sendMessage` — рефетч треда (`chat.listMessages`), не локальный аппенд; «лента ожидания ответа» — отдельна от retry-буфера.
- **D-g Quick-capture:** текст→`title` без интерпретации (`entity.create source:'quick_capture'`); fast-path-парсер применяется ТОЛЬКО в Chat.

## Файловая структура

```
apps/web/src/
  main.tsx                      # + провайдеры (QueryClient, trpc.Provider, AuthProvider, OnboardingGate, App)
  trpc.ts                       # РАСШИРИТЬ: makeTrpcClient, queryClient, trpcHeaders, orbisLinks, authErrorLink, makeVanillaClient, RouterInputs/Outputs
  test/
    harness.tsx                 # renderWithProviders / mockLink / trpcError (тест-утилита, создаётся в Task 1)
  app/
    App.tsx                     # оболочка: TabBar + активный стек (перезаписать заглушку Вехи-0)
    router.tsx                  # TabBar + рендер активного экрана (расширяется задачами 9/12/14)
    version.ts                  # APP_VERSION (→ CLIENT_VERSION_HEADER)
  auth/
    supabase.ts                 # createClient(@supabase/supabase-js), useSession()
    events.ts                   # синглтон-слушатели onClientOutdated/onUnauthorized (для линка вне React)
    AuthProvider.tsx            # useAuth(), getCurrentToken(); anon → LoginScreen; 412 → «обновите приложение»
    LoginScreen.tsx
  lib/
    retry-buffer/               # СУЩЕСТВУЕТ — Task 8: enqueue → newId() (UUIDv7)
    query-blocks/               # Task 13: parse/render {{query:...}} (parseQuery + catalog из aspect.list)
    format.ts                   # Task 6: деньги/даты/таймзона
  ui/                           # Button✓ Card✓ + Input, Sheet, Dialog, Tabs, Badge, Chip, Checkbox, Toast, Skeleton
  features/
    chat/
      cards/                    # EntityCard, QueryResultCard, ConfirmationCard, ErrorCard, SystemMessage, types.ts, renderCards.tsx
      useChatThread.ts          # useInfiniteQuery listMessages (before-курсор) + useSendMessage
      useFastPath.ts            # Task 11: parser + буфер + optimistic-карточка
      ChatThread.tsx MessageList.tsx Composer.tsx
    browser/                    # EntityList, Sidebar, QuickCapture, Filters, SmartListSave, useEntities.ts
    entity-detail/              # DetailScreen, AspectCards, Subtasks, NativeRow.tsx
    settings/                   # SettingsScreen, GeneralForm, AspectsList, ViewsList, ExportButton
    onboarding/                 # OnboardingGate.tsx
  state/
    navigation.ts               # Zustand persist: useNav()
    retry.ts                    # Zustand-обёртка над createRetryBuffer: useRetryBuffer(), useOnline()
    retry-send.ts               # Task 8: mapSendError(), makeRetrySend()
  pwa/
    manifest.ts                 # Task 16: pwaManifest (импортируется в vite.config.ts, юнит-тестируется)
  styles/                       # СУЩЕСТВУЕТ (tokens.css, globals.css)

packages/shared/src/
  fast-path/index.ts            # Task 7: parseFastPath (§7.5)
  fast-path/fast-path.test.ts   # Task 7: bun:test
```

---

### Task 1: tRPC-клиент + QueryClient + провайдеры

**Files:**
- Modify `apps/web/src/trpc.ts`
- Create `apps/web/src/app/version.ts`
- Create `apps/web/src/test/harness.tsx`
- Modify `apps/web/src/main.tsx`
- Test `apps/web/src/trpc.test.tsx`

**Interfaces:**
- Consumes: существующий `export const trpc = createTRPCReact<AppRouter>()`; `CLIENT_VERSION_HEADER` из `@orbis/shared`.
- Produces: `makeTrpcClient(getToken: () => string | null, links?)`, `queryClient: QueryClient`, `trpcHeaders(getToken)`, типы `RouterInputs`/`RouterOutputs`; тест-утилита `renderWithProviders`/`mockLink`/`trpcError` (для всех дальнейших задач).

- [ ] **Step 1: Написать падающий тест** `apps/web/src/trpc.test.tsx`

```tsx
import { test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { trpc, trpcHeaders } from './trpc';
import { renderWithProviders } from './test/harness';

function PingProbe() {
  const q = trpc.ping.useQuery();
  return <div data-testid="ping">{q.data ? 'ok' : 'loading'}</div>;
}

test('trpc.ping.useQuery резолвит против мок-линка', async () => {
  renderWithProviders(<PingProbe />, (path) => {
    if (path === 'ping') return { ok: true };
    throw new Error(`unexpected path ${path}`);
  });
  expect(screen.getByTestId('ping')).toHaveTextContent('loading');
  await waitFor(() => expect(screen.getByTestId('ping')).toHaveTextContent('ok'));
});

test('trpcHeaders всегда несёт версию, а Bearer только при наличии токена', () => {
  expect(trpcHeaders(() => null)).toEqual({ 'x-orbis-client-version': '0.1.0' });
  expect(trpcHeaders(() => 'abc')).toEqual({
    authorization: 'Bearer abc',
    'x-orbis-client-version': '0.1.0',
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/trpc.test.tsx` Expected: FAIL «Cannot find module './test/harness'» / «trpcHeaders is not a function».

- [ ] **Step 3: Минимальная реализация**

`apps/web/src/app/version.ts`:
```ts
// APP_VERSION → CLIENT_VERSION_HEADER (§9.1). ДОЛЖЕН быть ≥ MIN_COMPATIBLE_CLIENT_VERSION ('0.1.0').
export const APP_VERSION = '0.1.0';
```

`apps/web/src/trpc.ts` (перезаписать целиком):
```ts
import type { AppRouter } from '@orbis/server/src/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink, type TRPCLink } from '@trpc/client';
import { QueryClient } from '@tanstack/react-query';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { APP_VERSION } from './app/version';

export const trpc = createTRPCReact<AppRouter>();

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: false },
  },
});

export function trpcHeaders(getToken: () => string | null): Record<string, string> {
  const token = getToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    [CLIENT_VERSION_HEADER]: APP_VERSION,
  };
}

// links? — точка инъекции мок-линка в тестах; в проде дефолт (httpBatchLink на /trpc).
export function makeTrpcClient(getToken: () => string | null, links?: TRPCLink<AppRouter>[]) {
  return trpc.createClient({
    links: links ?? [
      httpBatchLink({ url: '/trpc', headers: () => trpcHeaders(getToken) }),
    ],
  });
}
```

`apps/web/src/test/harness.tsx`:
```tsx
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { render, type RenderResult } from '@testing-library/react';
import type { AppRouter } from '@orbis/server/src/router';
import { trpc } from '../trpc';

export type MockHandler = (path: string, input: unknown) => unknown | Promise<unknown>;

// TRPCClientError с data.code — клиент ключуется на КОД (не cause).
export function trpcError(code: string): TRPCClientError<AppRouter> {
  return new TRPCClientError(code, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: { error: { message: code, code: -32600, data: { code, httpStatus: 400 } } } as any,
  });
}

export function mockLink(handler: MockHandler): TRPCLink<AppRouter> {
  return () => ({ op }) =>
    observable((observer) => {
      Promise.resolve(handler(op.path, op.input))
        .then((data) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        })
        .catch((err) => observer.error(err instanceof TRPCClientError ? err : TRPCClientError.from(err)));
      return () => {};
    });
}

export function renderWithProviders(
  ui: ReactNode,
  handler: MockHandler = () => ({}),
): RenderResult & { calls: { path: string; input: unknown }[] } {
  const calls: { path: string; input: unknown }[] = [];
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [mockLink((path, input) => {
      calls.push({ path, input });
      return handler(path, input);
    })],
  });
  const result = render(
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
  return Object.assign(result, { calls });
}
```

`apps/web/src/main.tsx` (перезаписать):
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { trpc, makeTrpcClient, queryClient } from './trpc';
import { App } from './App';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

const trpcClient = makeTrpcClient(() => null);

createRoot(rootElement).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
```

- [ ] **Step 4: Запустить — убедиться, что проходит** Run: `cd apps/web && bunx vitest run src/trpc.test.tsx` Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/trpc.ts apps/web/src/app/version.ts apps/web/src/test/harness.tsx apps/web/src/main.tsx apps/web/src/trpc.test.tsx
git commit -m "feat(web): tRPC client, QueryClient, providers + test harness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Supabase-auth + AuthProvider + LoginScreen + линк-обработка 401/412

**Files:**
- Create `apps/web/src/auth/supabase.ts`, `apps/web/src/auth/events.ts`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/auth/LoginScreen.tsx`
- Modify `apps/web/src/trpc.ts` (добавить `authErrorLink`, `orbisLinks`; `makeTrpcClient` использует `orbisLinks`)
- Modify `apps/web/src/main.tsx` (обернуть в `AuthProvider`, токен через `getCurrentToken`)
- Test `apps/web/src/auth/AuthProvider.test.tsx`, `apps/web/src/trpc.errorlink.test.ts`

**Interfaces:**
- Consumes: `makeTrpcClient`, `trpc`, `trpcHeaders` (Task 1); `MIN_COMPATIBLE_CLIENT_VERSION` из `@orbis/shared` (не обязателен, версия хардкод в version.ts).
- Produces: `supabase`, `useSession(): { token, userId, status }`, `AuthProvider`, `useAuth()`, `getCurrentToken()`, `emitClientOutdated`/`emitUnauthorized`/`onClientOutdated`/`onUnauthorized` (events.ts), `authErrorLink(handlers)`, `orbisLinks(getToken)`.

- [ ] **Step 1: Написать падающий тест (маппинг кодов в линке)** `apps/web/src/trpc.errorlink.test.ts`

```ts
import { test, expect, vi } from 'vitest';
import { observable } from '@trpc/server/observable';
import { authErrorLink } from './trpc';
import { trpcError } from './test/harness';

function runLinkWithError(link: ReturnType<typeof authErrorLink>, err: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime = {} as any;
  const chain = link(runtime)({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    op: { id: 1, type: 'query', path: 'x', input: undefined, context: {}, signal: null } as any,
    next: () => observable((o) => { o.error(err as never); return () => {}; }),
  });
  return new Promise<void>((resolve) => {
    chain.subscribe({ next: () => {}, error: () => resolve(), complete: () => resolve() });
  });
}

test('PRECONDITION_FAILED → onOutdated, не onUnauthorized', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(authErrorLink({ onOutdated, onUnauthorized }), trpcError('PRECONDITION_FAILED'));
  expect(onOutdated).toHaveBeenCalledTimes(1);
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test('UNAUTHORIZED → onUnauthorized, не onOutdated', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(authErrorLink({ onOutdated, onUnauthorized }), trpcError('UNAUTHORIZED'));
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(onOutdated).not.toHaveBeenCalled();
});

test('прочий код (CONFLICT) не триггерит ни один хендлер', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(authErrorLink({ onOutdated, onUnauthorized }), trpcError('CONFLICT'));
  expect(onOutdated).not.toHaveBeenCalled();
  expect(onUnauthorized).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/trpc.errorlink.test.ts` Expected: FAIL «authErrorLink is not exported».

- [ ] **Step 3: Реализация линка** — добавить в `apps/web/src/trpc.ts` (в конец файла + переключить `makeTrpcClient` на `orbisLinks`):

```ts
import { observable } from '@trpc/server/observable';
import { emitClientOutdated, emitUnauthorized } from './auth/events';

export function authErrorLink(handlers: {
  onOutdated: () => void;
  onUnauthorized: () => void;
}): TRPCLink<AppRouter> {
  return () => ({ op, next }) =>
    observable((observer) =>
      next(op).subscribe({
        next: (v) => observer.next(v),
        complete: () => observer.complete(),
        error: (err) => {
          const code = err instanceof TRPCClientError ? err.data?.code : undefined;
          if (code === 'PRECONDITION_FAILED') handlers.onOutdated();
          else if (code === 'UNAUTHORIZED') handlers.onUnauthorized();
          observer.error(err);
        },
      }),
    );
}

export function orbisLinks(getToken: () => string | null): TRPCLink<AppRouter>[] {
  return [
    authErrorLink({ onOutdated: emitClientOutdated, onUnauthorized: emitUnauthorized }),
    httpBatchLink({ url: '/trpc', headers: () => trpcHeaders(getToken) }),
  ];
}
```

И заменить тело `makeTrpcClient` дефолтом на `orbisLinks(getToken)`:
```ts
export function makeTrpcClient(getToken: () => string | null, links?: TRPCLink<AppRouter>[]) {
  return trpc.createClient({ links: links ?? orbisLinks(getToken) });
}
```

`apps/web/src/auth/events.ts`:
```ts
type Listener = () => void;
let outdated: Listener | null = null;
let unauthorized: Listener | null = null;

export function onClientOutdated(fn: Listener) { outdated = fn; }
export function onUnauthorized(fn: Listener) { unauthorized = fn; }
export function emitClientOutdated() { outdated?.(); }
export function emitUnauthorized() { unauthorized?.(); }
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/trpc.errorlink.test.ts` Expected: PASS (3 tests).

- [ ] **Step 5: Написать падающий тест (AuthProvider)** `apps/web/src/auth/AuthProvider.test.tsx`

```tsx
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('./supabase', () => ({
  supabase: { auth: { signOut: vi.fn(), signInWithPassword: vi.fn() } },
  useSession: vi.fn(),
}));

import { useSession } from './supabase';
import { AuthProvider, useAuth } from './AuthProvider';
import { emitClientOutdated } from './events';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSession = (v: any) => (useSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

function Child() {
  const { userId } = useAuth();
  return <div data-testid="child">user:{userId}</div>;
}

beforeEach(() => vi.clearAllMocks());

test('anon → LoginScreen', () => {
  mockSession({ token: null, userId: null, status: 'anon' });
  render(<AuthProvider><Child /></AuthProvider>);
  expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  expect(screen.queryByTestId('child')).not.toBeInTheDocument();
});

test('authed → children с userId в контексте', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(<AuthProvider><Child /></AuthProvider>);
  expect(screen.getByTestId('child')).toHaveTextContent('user:u1');
});

test('emitClientOutdated → экран «обновите приложение»', () => {
  mockSession({ token: 'jwt', userId: 'u1', status: 'authed' });
  render(<AuthProvider><Child /></AuthProvider>);
  act(() => emitClientOutdated());
  expect(screen.getByTestId('update-required')).toBeInTheDocument();
  expect(screen.queryByTestId('child')).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/auth/AuthProvider.test.tsx` Expected: FAIL «Cannot find module './AuthProvider'».

- [ ] **Step 7: Реализация auth-провайдера**

`apps/web/src/auth/supabase.ts`:
```ts
import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export type SessionState = {
  token: string | null;
  userId: string | null;
  status: 'loading' | 'authed' | 'anon';
};

function fromSession(session: Session | null): SessionState {
  if (!session) return { token: null, userId: null, status: 'anon' };
  return { token: session.access_token, userId: session.user.id, status: 'authed' };
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ token: null, userId: null, status: 'loading' });
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState(fromSession(data.session));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setState(fromSession(session)));
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  return state;
}
```

`apps/web/src/auth/AuthProvider.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase, useSession } from './supabase';
import { onClientOutdated, onUnauthorized } from './events';
import { LoginScreen } from './LoginScreen';

type AuthContextValue = { token: string | null; userId: string | null };
const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

// Токен для tRPC-линка, который живёт вне React. Обновляется на каждом рендере провайдера.
let currentToken: string | null = null;
export function getCurrentToken(): string | null { return currentToken; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [outdated, setOutdated] = useState(false);
  currentToken = session.token;

  useEffect(() => {
    onClientOutdated(() => setOutdated(true));
    onUnauthorized(() => { void supabase.auth.signOut(); });
  }, []);

  if (outdated) return <UpdateRequiredScreen />;
  if (session.status === 'loading') return <div role="status" aria-live="polite">Загрузка…</div>;
  if (session.status === 'anon' || !session.token) return <LoginScreen />;

  return (
    <AuthContext.Provider value={{ token: session.token, userId: session.userId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function UpdateRequiredScreen() {
  return (
    <div role="alert" data-testid="update-required" className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">Обновите приложение</h1>
      <p className="text-sm text-text-secondary">Установлена устаревшая версия Orbis. Обновите страницу, чтобы продолжить.</p>
      <button type="button" className="rounded-control bg-accent px-4 py-2 text-accent-foreground" onClick={() => location.reload()}>Обновить</button>
    </div>
  );
}
```

`apps/web/src/auth/LoginScreen.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { supabase } from './supabase';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <form onSubmit={submit} aria-label="Вход" data-testid="login-screen"
      className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Orbis</h1>
      <label className="flex flex-col gap-1 text-sm">Email
        <input aria-label="Email" type="email" required value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1 text-sm">Пароль
        <input aria-label="Пароль" type="password" required value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-control border border-line bg-surface px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={busy}
        className="rounded-control bg-accent px-4 py-2 text-accent-foreground disabled:opacity-50">Войти</button>
    </form>
  );
}
```

И обновить `apps/web/src/main.tsx` — обернуть `App` в `AuthProvider`, токен через `getCurrentToken`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { trpc, makeTrpcClient, queryClient } from './trpc';
import { AuthProvider, getCurrentToken } from './auth/AuthProvider';
import { App } from './App';
import './styles/globals.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

const trpcClient = makeTrpcClient(getCurrentToken);

createRoot(rootElement).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
```

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/auth/AuthProvider.test.tsx src/trpc.errorlink.test.ts` Expected: PASS (6 tests).

- [ ] **Step 9: Commit**
```
git add apps/web/src/auth apps/web/src/trpc.ts apps/web/src/main.tsx
git commit -m "feat(web): Supabase auth, AuthProvider, 401/412 error link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Оболочка — табы + push-стеки (Zustand persist) + state/retry.ts

**Files:**
- Modify `apps/web/package.json` (добавить `zustand`)
- Create `apps/web/src/state/navigation.ts`, `apps/web/src/state/retry.ts`, `apps/web/src/app/router.tsx`
- Modify `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`
- Test `apps/web/src/state/navigation.test.ts`

**Interfaces:**
- Consumes: `createRetryBuffer`, `localStorageQueue`, `QueuedCreate`, `FlushOutcome` из `apps/web/src/lib/retry-buffer`; `EntityCreateInput` из `@orbis/shared`.
- Produces: `useNav()` → `{ activeTab, stacks, push, pop, switchTab, resetTabToRoot }`, `type Tab`, `type ScreenRef`; `useRetryBuffer()` → `{ size, pending, enqueueCreate, flushNow, cancel }`, `useOnline()`, `registerRetrySend(fn)` (реализация send — в Task 8); `TabBar`, `AppShell`-роутер.

> **Примечание контроллера:** `state/retry.ts` создаётся здесь (а не в Task 8), потому что бейдж Chat (§1.5) читает `useRetryBuffer().size`. Task 8 добавляет сетевой `send` (`registerRetrySend` + `mapSendError`) и newId-фикс в lib.

- [ ] **Step 1: Добавить зависимость zustand** Run: `cd apps/web && bun add zustand@^5` Expected: `zustand` в `dependencies`.

- [ ] **Step 2: Написать падающий тест навигации** `apps/web/src/state/navigation.test.ts`

```ts
import { test, expect, beforeEach } from 'vitest';
import { useNav } from './navigation';

const reset = () =>
  useNav.setState({ activeTab: 'chat', stacks: { chat: [], browser: [], agenda: [], budget: [] } });

beforeEach(() => { localStorage.clear(); reset(); });

test('push кладёт экран в стек активного таба, pop снимает верхний', () => {
  useNav.getState().push('browser', { kind: 'entity', id: 'e1' });
  useNav.getState().push('browser', { kind: 'entity', id: 'e2' });
  expect(useNav.getState().stacks.browser).toHaveLength(2);
  useNav.getState().pop('browser');
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: 'e1' }]);
});

test('switchTab меняет активный таб, но не сбрасывает чужие стеки', () => {
  useNav.getState().push('chat', { kind: 'thread', threadId: 't1' });
  useNav.getState().switchTab('browser');
  expect(useNav.getState().activeTab).toBe('browser');
  expect(useNav.getState().stacks.chat).toEqual([{ kind: 'thread', threadId: 't1' }]);
});

test('повторный switchTab по активному табу сворачивает его стек до корня', () => {
  useNav.getState().push('chat', { kind: 'thread', threadId: 't1' });
  useNav.getState().switchTab('chat');
  expect(useNav.getState().stacks.chat).toEqual([]);
});

test('persist пишет активный таб и стеки в localStorage', () => {
  useNav.getState().push('browser', { kind: 'entity', id: 'e9' });
  const raw = JSON.parse(localStorage.getItem('orbis:nav:v1')!);
  expect(raw.state.stacks.browser).toEqual([{ kind: 'entity', id: 'e9' }]);
});
```

- [ ] **Step 3: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/state/navigation.test.ts` Expected: FAIL «Cannot find module './navigation'».

- [ ] **Step 4: Реализация навигации**

`apps/web/src/state/navigation.ts`:
```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tab = 'chat' | 'browser' | 'agenda' | 'budget';
export type ScreenRef =
  | { kind: 'entity'; id: string }
  | { kind: 'thread'; threadId: string };

type NavState = {
  activeTab: Tab;
  stacks: Record<Tab, ScreenRef[]>;
  push: (tab: Tab, screen: ScreenRef) => void;
  pop: (tab: Tab) => void;
  switchTab: (tab: Tab) => void;
  resetTabToRoot: (tab: Tab) => void;
};

const emptyStacks = (): Record<Tab, ScreenRef[]> => ({ chat: [], browser: [], agenda: [], budget: [] });

export const useNav = create<NavState>()(
  persist(
    (set) => ({
      activeTab: 'chat',
      stacks: emptyStacks(),
      push: (tab, screen) =>
        set((s) => ({ stacks: { ...s.stacks, [tab]: [...s.stacks[tab], screen] } })),
      pop: (tab) =>
        set((s) => ({ stacks: { ...s.stacks, [tab]: s.stacks[tab].slice(0, -1) } })),
      // §1.1: повторный тап по активному табу — свернуть до корня; иначе просто переключить.
      switchTab: (tab) =>
        set((s) => (s.activeTab === tab ? { stacks: { ...s.stacks, [tab]: [] } } : { activeTab: tab })),
      resetTabToRoot: (tab) => set((s) => ({ stacks: { ...s.stacks, [tab]: [] } })),
    }),
    { name: 'orbis:nav:v1', partialize: (s) => ({ activeTab: s.activeTab, stacks: s.stacks }) },
  ),
);
```

- [ ] **Step 5: Запустить** Run: `cd apps/web && bunx vitest run src/state/navigation.test.ts` Expected: PASS (4 tests).

- [ ] **Step 6: Реализация retry-обёртки (без сетевого send — он в Task 8)**

`apps/web/src/state/retry.ts`:
```ts
import { create } from 'zustand';
import { useSyncExternalStore } from 'react';
import {
  createRetryBuffer,
  localStorageQueue,
  type QueuedCreate,
  type FlushOutcome,
} from '../lib/retry-buffer';
import type { EntityCreateInput } from '@orbis/shared';

const storage = localStorageQueue;
const buffer = createRetryBuffer(storage);

export type RetrySend = (op: QueuedCreate) => Promise<FlushOutcome>;
let sendImpl: RetrySend | null = null;
// Task 8 регистрирует реальный send (entity.create + mapSendError).
export function registerRetrySend(fn: RetrySend) { sendImpl = fn; }

type RetryState = {
  size: number;
  pending: QueuedCreate[];
  enqueueCreate: (input: EntityCreateInput, source: 'fast_path') => QueuedCreate;
  flushNow: () => Promise<void>;
  cancel: (clientId: string) => void;
};

// storage.load() — авторитетный источник оставшихся операций (buffer.flush их удаляет/оставляет).
function snapshot(): { size: number; pending: QueuedCreate[] } {
  const items = storage.load();
  return { size: items.length, pending: items };
}

export const useRetryBuffer = create<RetryState>((set) => ({
  ...snapshot(),
  enqueueCreate: (input, source) => {
    const op = buffer.enqueue({ tool: 'entity.create', payload: { input, source } });
    set(snapshot());
    return op;
  },
  flushNow: async () => {
    if (!sendImpl) return;
    await buffer.flush(sendImpl);
    set(snapshot());
  },
  cancel: (clientId) => {
    buffer.cancel(clientId);
    set(snapshot());
  },
}));

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
```

- [ ] **Step 7: Реализация оболочки (router + App)**

`apps/web/src/app/router.tsx`:
```tsx
import { useNav, type Tab } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';

const TABS: { id: Tab; label: string; icon: string; enabled: boolean }[] = [
  { id: 'chat', label: 'Chat', icon: '💬', enabled: true },
  { id: 'browser', label: 'Browser', icon: '🗂', enabled: true },
  { id: 'agenda', label: 'Agenda', icon: '📅', enabled: false },
  { id: 'budget', label: 'Budget', icon: '💸', enabled: false },
];

export function TabBar() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5

  return (
    <nav role="tablist" aria-label="Разделы" className="flex border-t border-line bg-surface">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={activeTab === t.id}
          aria-label={t.label}
          disabled={!t.enabled}
          data-testid={`tab-${t.id}`}
          onClick={() => t.enabled && switchTab(t.id)}
          className="relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs disabled:opacity-40 aria-selected:text-accent"
        >
          <span aria-hidden>{t.icon}</span>
          {t.label}
          {t.id === 'chat' && chatBadge > 0 && (
            <span data-testid="chat-badge"
              className="absolute right-4 top-1 rounded-full bg-danger px-1.5 text-[10px] text-danger-foreground">
              {chatBadge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

// Расширяется задачами 9/12/14: рендер реальных экранов по верхушке стека.
export function ActiveScreen() {
  const activeTab = useNav((s) => s.activeTab);
  const stack = useNav((s) => s.stacks[activeTab]);
  const top = stack[stack.length - 1];
  return (
    <main data-testid="tab-content" data-tab={activeTab} data-depth={stack.length} className="flex-1 overflow-y-auto">
      <div className="p-4 text-sm text-text-secondary">
        {top ? `${top.kind}` : `Экран: ${activeTab}`}
      </div>
    </main>
  );
}
```

`apps/web/src/App.tsx` (перезаписать заглушку Вехи-0):
```tsx
import { TabBar, ActiveScreen } from './app/router';

export function App() {
  return (
    <div className="flex h-full flex-col">
      <ActiveScreen />
      <TabBar />
    </div>
  );
}
```

`apps/web/src/App.test.tsx` (перезаписать под новую оболочку):
```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

test('рендерит 4 таба, Agenda/Budget задизейблены', () => {
  render(<App />);
  expect(screen.getByTestId('tab-chat')).toBeEnabled();
  expect(screen.getByTestId('tab-browser')).toBeEnabled();
  expect(screen.getByTestId('tab-agenda')).toBeDisabled();
  expect(screen.getByTestId('tab-budget')).toBeDisabled();
});
```

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/App.test.tsx src/state/navigation.test.ts` Expected: PASS.

- [ ] **Step 9: Commit**
```
git add apps/web/package.json apps/web/src/state/navigation.ts apps/web/src/state/retry.ts apps/web/src/app/router.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/state/navigation.test.ts
git commit -m "feat(web): tab shell, nav push-stacks (zustand persist), retry store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Онбординг-триггер

**Files:**
- Create `apps/web/src/features/onboarding/OnboardingGate.tsx`
- Modify `apps/web/src/main.tsx` (обернуть `App` в `OnboardingGate`)
- Test `apps/web/src/features/onboarding/OnboardingGate.test.tsx`

**Interfaces:**
- Consumes: `trpc` (Task 1) — `trpc.user.getSettings.useQuery`, `trpc.user.seedOnboarding.useMutation`; `renderWithProviders`/`trpcError` (Task 1).
- Produces: `OnboardingGate` (гейт: первый вход → `seedOnboarding`, идемпотентно).

- [ ] **Step 1: Написать падающий тест** `apps/web/src/features/onboarding/OnboardingGate.test.tsx`

```tsx
import { test, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, trpcError } from '../../test/harness';
import { OnboardingGate } from './OnboardingGate';

const settings = {
  ownerId: 'u1', plan: 'dev', timezone: 'Europe/Moscow', defaultCurrency: 'RUB',
  weekStartDay: 'monday', tagColors: {}, installedViews: [], pinnedEntities: [],
  viewPreferences: {}, updatedAt: '2026-07-05T00:00:00.000Z',
};

test('первый вход: getSettings NOT_FOUND → seedOnboarding → рендер детей', async () => {
  let seeded = false;
  const { calls } = renderWithProviders(
    <OnboardingGate><div data-testid="app">app</div></OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') {
        if (!seeded) throw trpcError('NOT_FOUND');
        return settings;
      }
      if (path === 'user.seedOnboarding') { seeded = true; return { seeded: true }; }
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(true);
});

test('повторный вход: settings есть сразу → seedOnboarding НЕ вызывается', async () => {
  const { calls } = renderWithProviders(
    <OnboardingGate><div data-testid="app">app</div></OnboardingGate>,
    (path) => {
      if (path === 'user.getSettings') return settings;
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'user.seedOnboarding')).toBe(false);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/onboarding/OnboardingGate.test.tsx` Expected: FAIL «Cannot find module './OnboardingGate'».

- [ ] **Step 3: Реализация**

`apps/web/src/features/onboarding/OnboardingGate.tsx`:
```tsx
import { useEffect, type ReactNode } from 'react';
import { trpc } from '../../trpc';

export function OnboardingGate({ children }: { children: ReactNode }) {
  const settings = trpc.user.getSettings.useQuery(undefined, { retry: false });
  const seed = trpc.user.seedOnboarding.useMutation({
    onSuccess: () => { void settings.refetch(); },
  });

  const needsSeed = settings.isError && settings.error.data?.code === 'NOT_FOUND';

  useEffect(() => {
    if (needsSeed && seed.isIdle) seed.mutate();
  }, [needsSeed, seed.isIdle, seed]);

  if (settings.isLoading || seed.isPending || needsSeed) {
    return <div role="status" data-testid="onboarding-splash" className="flex h-full items-center justify-center text-sm text-text-secondary">Готовим Orbis…</div>;
  }
  if (settings.isError) {
    return <div role="alert" className="flex h-full items-center justify-center text-sm text-danger">Не удалось загрузить настройки. Повторите позже.</div>;
  }
  return <>{children}</>;
}
```

И `apps/web/src/main.tsx` — обернуть `App`:
```tsx
import { OnboardingGate } from './features/onboarding/OnboardingGate';
// ...
        <AuthProvider>
          <OnboardingGate>
            <App />
          </OnboardingGate>
        </AuthProvider>
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/onboarding/OnboardingGate.test.tsx` Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/features/onboarding apps/web/src/main.tsx
git commit -m "feat(web): onboarding gate (getSettings NOT_FOUND -> seedOnboarding)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: UI-примитивы на radix

**Files:**
- Create `apps/web/src/ui/{Input,Sheet,Dialog,Tabs,Badge,Chip,Checkbox,Toast,Skeleton}.tsx`
- Test `apps/web/src/ui/primitives.test.tsx`

**Interfaces:**
- Consumes: `radix-ui` (unified package 1.6.1) — namespaces `Dialog`, `Tabs`, `Checkbox`, `Toast`; токены Tailwind Вехи-0.
- Produces: примитивы `Input`, `Sheet`, `Dialog`, `Tabs`, `Badge`, `Chip`, `Checkbox`, `Toast`, `Skeleton` (используются задачами 9–15). Button/Card уже есть.

- [ ] **Step 1: Написать падающий тест** `apps/web/src/ui/primitives.test.tsx`

```tsx
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from './Input';
import { Badge } from './Badge';
import { Chip } from './Chip';
import { Checkbox } from './Checkbox';
import { Skeleton } from './Skeleton';
import { Tabs } from './Tabs';

test('Input прокидывает value/aria и type=text по умолчанию', () => {
  render(<Input aria-label="поле" value="x" onChange={() => {}} />);
  const el = screen.getByLabelText('поле') as HTMLInputElement;
  expect(el.value).toBe('x');
  expect(el.type).toBe('text');
});

test('Badge рендерит контент и tone', () => {
  render(<Badge tone="danger">99+</Badge>);
  const b = screen.getByText('99+');
  expect(b).toBeInTheDocument();
  expect(b.className).toContain('bg-danger');
});

test('Chip удаляется по кнопке', () => {
  const onRemove = vi.fn();
  render(<Chip onRemove={onRemove}>tag</Chip>);
  fireEvent.click(screen.getByRole('button', { name: /удалить/i }));
  expect(onRemove).toHaveBeenCalled();
});

test('Checkbox переключается и вызывает onCheckedChange', () => {
  const onCheckedChange = vi.fn();
  render(<Checkbox aria-label="готово" checked={false} onCheckedChange={onCheckedChange} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'готово' }));
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});

test('Skeleton имеет role=status', () => {
  render(<Skeleton />);
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('Tabs переключает панель по клику', () => {
  render(
    <Tabs
      defaultValue="a"
      tabs={[
        { value: 'a', label: 'A', content: <div>panel-a</div> },
        { value: 'b', label: 'B', content: <div>panel-b</div> },
      ]}
    />,
  );
  expect(screen.getByText('panel-a')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'B' }));
  expect(screen.getByText('panel-b')).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/ui/primitives.test.tsx` Expected: FAIL «Cannot find module './Input'».

- [ ] **Step 3: Реализация примитивов**

`apps/web/src/ui/Input.tsx`:
```tsx
import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ type = 'text', className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={`rounded-control border border-line bg-surface px-3 py-2 text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
        {...rest}
      />
    );
  },
);
```

`apps/web/src/ui/Badge.tsx`:
```tsx
import type { HTMLAttributes } from 'react';

type Tone = 'default' | 'danger' | 'accent';
const TONE: Record<Tone, string> = {
  default: 'bg-surface-2 text-text-secondary',
  danger: 'bg-danger text-danger-foreground',
  accent: 'bg-accent text-accent-foreground',
};

export function Badge({ tone = 'default', className = '', ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${TONE[tone]} ${className}`} {...rest} />;
}
```

`apps/web/src/ui/Chip.tsx`:
```tsx
import type { HTMLAttributes, ReactNode } from 'react';

export function Chip({ children, onRemove, ...rest }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-surface-2 px-2 py-0.5 text-xs text-text-secondary" {...rest}>
      {children}
      {onRemove && (
        <button type="button" aria-label="Удалить" onClick={onRemove} className="text-text-muted hover:text-danger">×</button>
      )}
    </span>
  );
}
```

`apps/web/src/ui/Checkbox.tsx`:
```tsx
import { Checkbox as RC } from 'radix-ui';

export function Checkbox({
  checked, onCheckedChange, 'aria-label': ariaLabel, className = '',
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <RC.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      aria-label={ariaLabel}
      className={`flex h-5 w-5 items-center justify-center rounded-sm border border-line bg-surface data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
    >
      <RC.Indicator>✓</RC.Indicator>
    </RC.Root>
  );
}
```

`apps/web/src/ui/Skeleton.tsx`:
```tsx
export function Skeleton({ className = '' }: { className?: string }) {
  return <div role="status" aria-label="Загрузка" className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
}
```

`apps/web/src/ui/Tabs.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Tabs as RT } from 'radix-ui';

export function Tabs({
  defaultValue, tabs,
}: {
  defaultValue: string;
  tabs: { value: string; label: string; content: ReactNode }[];
}) {
  return (
    <RT.Root defaultValue={defaultValue} className="flex flex-col">
      <RT.List className="flex gap-1 border-b border-line" aria-label="Вкладки">
        {tabs.map((t) => (
          <RT.Trigger key={t.value} value={t.value}
            className="px-3 py-2 text-sm text-text-secondary data-[state=active]:border-b-2 data-[state=active]:border-accent data-[state=active]:text-text">
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
      {tabs.map((t) => (
        <RT.Content key={t.value} value={t.value} className="pt-3">{t.content}</RT.Content>
      ))}
    </RT.Root>
  );
}
```

`apps/web/src/ui/Dialog.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Dialog as RD } from 'radix-ui';

export function Dialog({
  open, onOpenChange, title, children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 bg-black/50" />
        <RD.Content className="fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-surface p-4 shadow-pop">
          <RD.Title className="text-lg font-semibold">{title}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
```

`apps/web/src/ui/Sheet.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Dialog as RD } from 'radix-ui';

export function Sheet({
  open, onOpenChange, side = 'left', title, children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  side?: 'left' | 'right';
  title: string;
  children: ReactNode;
}) {
  const pos = side === 'left' ? 'left-0' : 'right-0';
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 bg-black/50" />
        <RD.Content aria-label={title}
          className={`fixed top-0 ${pos} h-full w-[min(85vw,20rem)] border-line bg-surface p-4 shadow-pop`}>
          <RD.Title className="sr-only">{title}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
```

`apps/web/src/ui/Toast.tsx`:
```tsx
import { Toast as RTo } from 'radix-ui';

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <RTo.Provider swipeDirection="right">
      {children}
      <RTo.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" />
    </RTo.Provider>
  );
}

export function Toast({
  open, onOpenChange, title, tone = 'default',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <RTo.Root open={open} onOpenChange={onOpenChange}
      className={`rounded-control border border-line p-3 text-sm shadow-pop ${tone === 'danger' ? 'bg-danger text-danger-foreground' : 'bg-surface-2 text-text'}`}>
      <RTo.Title>{title}</RTo.Title>
    </RTo.Root>
  );
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/ui/primitives.test.tsx` Expected: PASS (6 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/ui
git commit -m "feat(web): radix-based UI primitives (Input/Sheet/Dialog/Tabs/Badge/Chip/Checkbox/Toast/Skeleton)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: format.ts — деньги/даты/таймзона

**Files:**
- Create `apps/web/src/lib/format.ts`
- Test `apps/web/src/lib/format.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `formatMoney(amount: string, direction: 'expense'|'income'): { text: string; tone: 'danger'|'positive' }`; `formatDate(iso: string, tz: string): string` (используются NativeRow/EntityCard/детейл).

- [ ] **Step 1: Написать падающий тест** `apps/web/src/lib/format.test.ts`

```ts
import { test, expect } from 'vitest';
import { formatMoney, formatDate } from './format';

test('расход: знак минус (U+2212), тон danger, decimal-строка без float', () => {
  const r = formatMoney('340.00', 'expense');
  expect(r.tone).toBe('danger');
  expect(r.text.startsWith('−')).toBe(true);
  expect(r.text).toContain('340');
});

test('доход: знак плюс, тон positive', () => {
  const r = formatMoney('150000.00', 'income');
  expect(r.tone).toBe('positive');
  expect(r.text.startsWith('+')).toBe(true);
});

test('группировка тысяч сохраняет дробную часть как есть', () => {
  expect(formatMoney('1234567.89', 'income').text).toContain('.89');
});

test('ноль: направление всё равно определяет знак/тон', () => {
  expect(formatMoney('0.00', 'expense')).toMatchObject({ tone: 'danger' });
});

test('formatDate учитывает таймзону (Moscow = UTC+3)', () => {
  const iso = '2026-07-05T12:00:00.000Z';
  const msk = formatDate(iso, 'Europe/Moscow');
  const utc = formatDate(iso, 'UTC');
  expect(msk).toContain('15:00');
  expect(utc).toContain('12:00');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/lib/format.test.ts` Expected: FAIL «Cannot find module './format'».

- [ ] **Step 3: Реализация**

`apps/web/src/lib/format.ts`:
```ts
export type MoneyTone = 'danger' | 'positive';

// Деньги — decimal-строки. Никакого parseFloat/Number для отображения (Global Constraints).
export function formatMoney(amount: string, direction: 'expense' | 'income'): { text: string; tone: MoneyTone } {
  const negative = direction === 'expense';
  const sign = negative ? '−' : '+'; // U+2212 minus для расхода, '+' для дохода
  const tone: MoneyTone = negative ? 'danger' : 'positive';
  const abs = amount.replace(/^[-−+]/, '');
  const [intRaw, fracRaw = ''] = abs.split('.');
  const grouped = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // narrow no-break space
  const frac = fracRaw ? `.${fracRaw}` : '';
  return { text: `${sign}${grouped}${frac}`, tone };
}

export function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/lib/format.test.ts` Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/lib/format.ts apps/web/src/lib/format.test.ts
git commit -m "feat(web): money/date/timezone formatters (decimal-string, signed tone)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Fast-path парсер в `packages/shared` (§7.5)

**Files:**
- Create `packages/shared/src/fast-path/index.ts`, `packages/shared/src/fast-path/fast-path.test.ts`
- Modify `packages/shared/src/index.ts` (реэкспорт `export * from './fast-path'`)
- Remove `packages/shared/src/contracts/fast-path.test.ts` (describe.skip-заглушка — покрыто новыми тестами)

**Interfaces:**
- Consumes: `newId` из `../ids`; `EntityCreateInput` из `../contracts/tools`.
- Produces: `parseFastPath(text, ctx): FastPathResult`; `type FastPathResult`, `type FastPathCtx`, `type FastPathCategory` (импортируется из `@orbis/shared` фронтендом в Task 11).

- [ ] **Step 1: Написать падающие тесты** `packages/shared/src/fast-path/fast-path.test.ts`

```ts
import { describe, test, expect } from 'bun:test';
import { parseFastPath } from './index';

const cats = [
  { id: 'cat-food', aliases: ['обед', 'еда', 'кофе'], spendClass: 'variable' },
  { id: 'cat-salary', aliases: ['зарплата'], spendClass: 'income' },
];
const ctx = { categories: cats, defaultCurrency: 'RUB', today: '2026-07-05' };

describe('fast-path parseFastPath (§7.5)', () => {
  test('"обед 340" → financial expense, amount 340.00, категория по alias', () => {
    const r = parseFastPath('обед 340', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.title).toBe('обед');
    expect(r.create.aspects?.['orbis/financial']).toMatchObject({
      amount: '340.00', direction: 'expense', currency: 'RUB',
      occurred_on: '2026-07-05', category_ref: 'cat-food',
    });
    expect(r.create.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i); // UUIDv7
  });

  test('"+150000 зарплата" → income', () => {
    const r = parseFastPath('+150000 зарплата', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.aspects?.['orbis/financial']).toMatchObject({ amount: '150000.00', direction: 'income', category_ref: 'cat-salary' });
  });

  test('"кофе 127.50" → 127.50', () => {
    const r = parseFastPath('кофе 127.50', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial'].amount).toBe('127.50');
  });

  test('"кофе 99,90" → 99.90 (запятая как разделитель)', () => {
    const r = parseFastPath('кофе 99,90', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial'].amount).toBe('99.90');
  });

  test('"кофе 4 usd" → currency USD', () => {
    const r = parseFastPath('кофе 4 usd', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial'].currency).toBe('USD');
  });

  test('"обед 340 $" → currency USD (символ)', () => {
    const r = parseFastPath('обед 340 $', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial'].currency).toBe('USD');
  });

  test('неизвестная категория → уступает LLM', () => {
    expect(parseFastPath('квакозябра 500', ctx)).toEqual({ ok: false, reason: 'unknown_category' });
  });

  test('несколько сумм → ambiguous', () => {
    expect(parseFastPath('перевод 100 и 200', ctx)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  test('вопросительная форма → question', () => {
    expect(parseFastPath('сколько я потратил на еду?', ctx)).toEqual({ ok: false, reason: 'question' });
  });

  test('нет числа → no_match', () => {
    expect(parseFastPath('просто заметка', ctx)).toEqual({ ok: false, reason: 'no_match' });
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd packages/shared && bun test src/fast-path/fast-path.test.ts` Expected: FAIL «Cannot find module './index'».

- [ ] **Step 3: Реализация**

`packages/shared/src/fast-path/index.ts`:
```ts
import { newId } from '../ids';
import type { EntityCreateInput } from '../contracts/tools';

export type FastPathCategory = { id: string; aliases: string[]; spendClass?: string };
export type FastPathCtx = { categories: FastPathCategory[]; defaultCurrency: string; today?: string };
export type FastPathResult =
  | { ok: true; create: EntityCreateInput }
  | { ok: false; reason: 'ambiguous' | 'unknown_category' | 'question' | 'no_match' };

const CURRENCY_TOKENS: Record<string, string> = {
  '₽': 'RUB', 'руб': 'RUB', 'р': 'RUB', 'rub': 'RUB',
  '$': 'USD', 'usd': 'USD',
  '€': 'EUR', 'eur': 'EUR',
};
const QUESTION_WORDS = ['сколько', 'что', 'когда', 'где', 'какой', 'какая', 'why', 'how', 'what', 'when'];

function toDecimal2(raw: string): string {
  const norm = raw.replace(',', '.');
  const [i, f = ''] = norm.split('.');
  const frac = (f + '00').slice(0, 2);
  return `${i}.${frac}`;
}

function findCategory(words: string[], cats: FastPathCategory[]): FastPathCategory | null {
  const lw = words.map((w) => w.toLowerCase().replace(/[.,!?]/g, ''));
  for (const c of cats) {
    const aliases = c.aliases.map((a) => a.toLowerCase());
    if (lw.some((w) => aliases.includes(w))) return c;
  }
  return null;
}

export function parseFastPath(text: string, ctx: FastPathCtx): FastPathResult {
  const input = text.trim();
  if (!input) return { ok: false, reason: 'no_match' };

  const lower = input.toLowerCase();
  if (input.includes('?') || QUESTION_WORDS.some((w) => new RegExp(`(^|\\s)${w}(\\s|$)`, 'i').test(lower))) {
    return { ok: false, reason: 'question' };
  }

  // Отделяем прилипшие символы валют: "340₽" → "340 ₽".
  const spaced = input.replace(/([₽$€])/g, ' $1 ').replace(/\s+/g, ' ').trim();

  const numberRe = /(^|\s)(\+)?(\d+(?:[.,]\d+)?)(?=\s|$)/g;
  const matches = [...spaced.matchAll(numberRe)];
  if (matches.length === 0) return { ok: false, reason: 'no_match' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };

  const m = matches[0];
  const income = m[2] === '+';
  const amount = toDecimal2(m[3]);

  let currency = ctx.defaultCurrency;
  const textWords: string[] = [];
  for (const word of spaced.split(' ')) {
    const bare = word.replace(/^\+/, '');
    if (/^\d+(?:[.,]\d+)?$/.test(bare)) continue; // числовой токен
    const cur = CURRENCY_TOKENS[word.toLowerCase()];
    if (cur) { currency = cur; continue; }
    textWords.push(word);
  }

  const title = textWords.join(' ').trim();
  if (!title) return { ok: false, reason: 'no_match' };

  const category = findCategory(textWords, ctx.categories);
  if (!category) return { ok: false, reason: 'unknown_category' };

  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const create: EntityCreateInput = {
    id: newId(),
    title,
    tags: [],
    aspects: {
      'orbis/financial': {
        amount,
        direction: income ? 'income' : 'expense',
        currency,
        occurred_on: today,
        category_ref: category.id,
      },
    },
  };
  return { ok: true, create };
}
```

И в `packages/shared/src/index.ts` добавить строку:
```ts
export * from './fast-path';
```

Удалить устаревшую заглушку:
```
git rm packages/shared/src/contracts/fast-path.test.ts
```

- [ ] **Step 4: Запустить** Run: `cd packages/shared && bun test src/fast-path/fast-path.test.ts` Expected: PASS (10 tests).

- [ ] **Step 5: Commit**
```
git add packages/shared/src/fast-path packages/shared/src/index.ts
git rm packages/shared/src/contracts/fast-path.test.ts
git commit -m "feat(shared): fast-path deterministic parser (financial patterns, §7.5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Retry-буфер — newId()-фикс + сетевой send + маппинг кодов

**Files:**
- Modify `apps/web/src/lib/retry-buffer/index.ts` (enqueue → `newId()`)
- Modify `apps/web/src/lib/retry-buffer/retry-buffer.test.ts` (добавить проверку UUIDv7)
- Create `apps/web/src/state/retry-send.ts`
- Modify `apps/web/src/trpc.ts` (добавить `makeVanillaClient`)
- Test `apps/web/src/state/retry-send.test.ts`, `apps/web/src/state/retry.test.ts`

**Interfaces:**
- Consumes: `useRetryBuffer`/`registerRetrySend`/`RetrySend` (Task 3); `orbisLinks` (Task 2); `createTRPCClient` из `@trpc/client`; `newId` из `@orbis/shared`; `trpcError` (Task 1 harness); типы `QueuedCreate`/`FlushOutcome`.
- Produces: `mapSendError(err): FlushOutcome`, `makeRetrySend(client): RetrySend`; `makeVanillaClient(getToken)` в trpc.ts.

- [ ] **Step 1: Написать падающий тест (newId в буфере)** — добавить в `apps/web/src/lib/retry-buffer/retry-buffer.test.ts`:

```ts
import { test, expect } from 'vitest';
import { createRetryBuffer } from './index';
import type { QueueStorage } from './storage';

function memStorage(): QueueStorage {
  let items: ReturnType<QueueStorage['load']> = [];
  return { load: () => items, save: (v) => { items = v; } };
}

test('enqueue генерирует UUIDv7 clientId (версия-нибл = 7)', () => {
  const buf = createRetryBuffer(memStorage());
  const op = buf.enqueue({ tool: 'entity.create', payload: {} });
  // UUIDv7: 15-й символ (индекс 14) = '7'
  expect(op.clientId[14]).toBe('7');
  expect(op.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/lib/retry-buffer/retry-buffer.test.ts` Expected: FAIL (clientId[14] === '4' у UUIDv4).

- [ ] **Step 3: Фикс enqueue** — в `apps/web/src/lib/retry-buffer/index.ts` заменить генератор:

Импорт вверху файла:
```ts
import { newId } from '@orbis/shared';
```
Внутри `enqueue` заменить строку `clientId: crypto.randomUUID(),` на `clientId: newId(),` и убрать placeholder-комментарий про UUIDv4.

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/lib/retry-buffer/retry-buffer.test.ts` Expected: PASS (существующие + новый).

- [ ] **Step 5: Написать падающий тест (маппинг + send)** `apps/web/src/state/retry-send.test.ts`

```ts
import { test, expect, vi } from 'vitest';
import { mapSendError, makeRetrySend } from './retry-send';
import { trpcError } from '../test/harness';
import type { QueuedCreate } from '../lib/retry-buffer';

test('mapSendError: CONFLICT (id_conflict) → confirmed (идемпотентно)', () => {
  expect(mapSendError(trpcError('CONFLICT'))).toBe('confirmed');
});

test('mapSendError: бизнес-коды → business_rejection', () => {
  expect(mapSendError(trpcError('BAD_REQUEST'))).toBe('business_rejection');
  expect(mapSendError(trpcError('UNPROCESSABLE_CONTENT'))).toBe('business_rejection');
  expect(mapSendError(trpcError('TOO_MANY_REQUESTS'))).toBe('business_rejection');
  expect(mapSendError(trpcError('FORBIDDEN'))).toBe('business_rejection');
  expect(mapSendError(trpcError('NOT_FOUND'))).toBe('business_rejection');
});

test('mapSendError: сеть/неизвестное → transport_failure', () => {
  expect(mapSendError(new Error('network down'))).toBe('transport_failure');
  expect(mapSendError(trpcError('INTERNAL_SERVER_ERROR'))).toBe('transport_failure');
});

test('makeRetrySend: успешный create → confirmed; шлёт id=clientId и source', async () => {
  const mutate = vi.fn().mockResolvedValue({ id: 'x' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = { clientId: 'cid7', tool: 'entity.create', payload: { input: { title: 'обед', tags: [] }, source: 'fast_path' }, createdAt: 'now' };
  expect(await send(op)).toBe('confirmed');
  expect(mutate).toHaveBeenCalledWith({ input: { title: 'обед', tags: [], id: 'cid7' }, source: 'fast_path' });
});

test('makeRetrySend: ошибка мапится через mapSendError', async () => {
  const mutate = vi.fn().mockRejectedValue(trpcError('BAD_REQUEST'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { entity: { create: { mutate } } } as any;
  const send = makeRetrySend(client);
  const op: QueuedCreate = { clientId: 'c1', tool: 'entity.create', payload: { input: { title: 't', tags: [] }, source: 'fast_path' }, createdAt: 'now' };
  expect(await send(op)).toBe('business_rejection');
});
```

- [ ] **Step 6: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/state/retry-send.test.ts` Expected: FAIL «Cannot find module './retry-send'».

- [ ] **Step 7: Реализация**

Добавить `makeVanillaClient` в `apps/web/src/trpc.ts`:
```ts
import { createTRPCClient } from '@trpc/client';

export function makeVanillaClient(getToken: () => string | null) {
  return createTRPCClient<AppRouter>({ links: orbisLinks(getToken) });
}
export type OrbisVanillaClient = ReturnType<typeof makeVanillaClient>;
```

`apps/web/src/state/retry-send.ts`:
```ts
import { TRPCClientError } from '@trpc/client';
import type { EntityCreateInput } from '@orbis/shared';
import type { QueuedCreate, FlushOutcome } from '../lib/retry-buffer';
import type { OrbisVanillaClient } from '../trpc';

const BUSINESS_CODES = new Set([
  'BAD_REQUEST',           // VALIDATION
  'UNPROCESSABLE_CONTENT', // INVARIANT
  'TOO_MANY_REQUESTS',     // LIMIT
  'FORBIDDEN',             // FORBIDDEN_LEVEL
  'NOT_FOUND',             // NOT_FOUND
]);

// §5.3: CONFLICT/id_conflict онлайн — идемпотентный успех (confirmed);
// бизнес-коды — окончательный отказ (business_rejection); сеть/прочее — retry.
export function mapSendError(err: unknown): FlushOutcome {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code as string | undefined;
    if (code === 'CONFLICT') return 'confirmed';
    if (code && BUSINESS_CODES.has(code)) return 'business_rejection';
  }
  return 'transport_failure';
}

export function makeRetrySend(client: OrbisVanillaClient): (op: QueuedCreate) => Promise<FlushOutcome> {
  return async (op) => {
    const { input, source } = op.payload as { input: EntityCreateInput; source: 'fast_path' };
    try {
      // id = clientId (UUIDv7) — идемпотентность по client-UUID (§5.3).
      await client.entity.create.mutate({ input: { ...input, id: op.clientId }, source });
      return 'confirmed';
    } catch (err) {
      return mapSendError(err);
    }
  };
}
```

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/state/retry-send.test.ts` Expected: PASS (5 tests).

- [ ] **Step 9: Написать падающий тест (интеграция store + бейдж)** `apps/web/src/state/retry.test.ts`

```ts
import { test, expect, beforeEach } from 'vitest';
import { useRetryBuffer, registerRetrySend } from './retry';

beforeEach(() => {
  localStorage.clear();
  // сброс подписанного send между тестами
  registerRetrySend(async () => 'transport_failure');
});

test('enqueueCreate увеличивает size и pending (бейдж-счётчик)', () => {
  useRetryBuffer.getState().enqueueCreate({ title: 'обед', tags: [] }, 'fast_path');
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(useRetryBuffer.getState().pending).toHaveLength(1);
});

test('cancel убирает операцию из буфера', () => {
  const op = useRetryBuffer.getState().enqueueCreate({ title: 'x', tags: [] }, 'fast_path');
  useRetryBuffer.getState().cancel(op.clientId);
  expect(useRetryBuffer.getState().size).toBe(0);
});

test('flushNow: confirmed удаляет; transport_failure оставляет', async () => {
  registerRetrySend(async () => 'confirmed');
  useRetryBuffer.getState().enqueueCreate({ title: 'a', tags: [] }, 'fast_path');
  await useRetryBuffer.getState().flushNow();
  expect(useRetryBuffer.getState().size).toBe(0);

  registerRetrySend(async () => 'transport_failure');
  useRetryBuffer.getState().enqueueCreate({ title: 'b', tags: [] }, 'fast_path');
  await useRetryBuffer.getState().flushNow();
  expect(useRetryBuffer.getState().size).toBe(1);
});
```

- [ ] **Step 10: Запустить** Run: `cd apps/web && bunx vitest run src/state/retry.test.ts` Expected: PASS (3 tests).

> Регистрация реального send в проде: в `apps/web/src/main.tsx` после создания клиента добавить `registerRetrySend(makeRetrySend(makeVanillaClient(getCurrentToken)))` (импорты из `./state/retry`, `./state/retry-send`, `./trpc`). Это боевая проводка, тестами не покрывается (юнит-тесты используют `registerRetrySend` напрямую).

- [ ] **Step 11: Commit**
```
git add apps/web/src/lib/retry-buffer/index.ts apps/web/src/lib/retry-buffer/retry-buffer.test.ts apps/web/src/state/retry-send.ts apps/web/src/state/retry-send.test.ts apps/web/src/state/retry.test.ts apps/web/src/trpc.ts apps/web/src/main.tsx
git commit -m "feat(web): retry-buffer newId() fix + network send + error->FlushOutcome mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Chat-ядро — useChatThread + Composer + optimistic send + MessageList

**Files:**
- Create `apps/web/src/features/chat/useChatThread.ts`, `apps/web/src/features/chat/MessageList.tsx`, `apps/web/src/features/chat/Composer.tsx`, `apps/web/src/features/chat/ChatThread.tsx`
- Test `apps/web/src/features/chat/useChatThread.test.tsx`

**Interfaces:**
- Consumes: `trpc`, `RouterOutputs` (Task 1); `renderWithProviders` (Task 1 harness); `newId` из `@orbis/shared`.
- Produces: `useChatThread(threadId)` → `{ messages, fetchOlder, hasMore, isLoading }`; `useSendMessage(threadId)` → `{ sendMessage, isSending }`; `chatThreadKey(threadId)`, `upsertNewest`; `ChatThread`, `MessageList`, `Composer`.

> `chat.listMessages` отдаёт **createdAt DESC** (свежие первыми), дефолт limit 50, `before` — курсор по createdAt самого старого загруженного (пагинация вверх), cap ≤ 200. `ai.sendMessage.replayed:true` → рефетч треда (D-f).

- [ ] **Step 1: Написать падающий тест** `apps/web/src/features/chat/useChatThread.test.tsx`

```tsx
import { test, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { useChatThread, useSendMessage } from './useChatThread';
import type { RouterOutputs } from '../../trpc';

type Msg = RouterOutputs['chat']['listMessages'][number];
const mkMsg = (id: string, createdAt: string, role: Msg['role'] = 'user'): Msg =>
  ({ id, threadId: 't1', role, content: id, metadata: {}, createdAt } as Msg);

function Thread() {
  const { messages, fetchOlder, hasMore, isLoading } = useChatThread('t1');
  return (
    <div>
      <span data-testid="count">{messages.length}</span>
      <span data-testid="more">{String(hasMore)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <button onClick={() => fetchOlder()}>older</button>
    </div>
  );
}

test('пагинация вверх по before-курсору (самый старый createdAt)', async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => mkMsg(`a${i}`, `2026-07-05T10:${String(i).padStart(2, '0')}:00.000Z`));
  const page2 = [mkMsg('old1', '2026-07-05T09:00:00.000Z')];
  const seen: unknown[] = [];
  renderWithProviders(<Thread />, (path, input) => {
    if (path === 'chat.listMessages') {
      seen.push(input);
      const before = (input as { before?: string }).before;
      return before ? page2 : page1;
    }
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('50'));
  expect(screen.getByTestId('more')).toHaveTextContent('true'); // ровно 50 → есть ещё
  fireEvent.click(screen.getByText('older'));
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('51'));
  // второй запрос ушёл с before = createdAt самого старого из page1
  expect((seen[1] as { before?: string }).before).toBe(page1[page1.length - 1].createdAt);
  expect(screen.getByTestId('more')).toHaveTextContent('false'); // 1 < 50 → конец
});

function Sender() {
  const { messages } = useChatThread('t1');
  const { sendMessage, isSending } = useSendMessage('t1');
  return (
    <div>
      <span data-testid="count">{messages.length}</span>
      <span data-testid="sending">{String(isSending)}</span>
      <button onClick={() => sendMessage('привет')}>send</button>
    </div>
  );
}

test('optimistic: user-сообщение появляется сразу; не-replayed добавляет ответ ассистента', async () => {
  const assistant = mkMsg('resp', '2026-07-05T11:00:00.000Z', 'assistant');
  renderWithProviders(<Sender />, (path) => {
    if (path === 'chat.listMessages') return [];
    if (path === 'ai.sendMessage') return { assistantMessage: assistant, actions: [], pending: [], replayed: false };
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  fireEvent.click(screen.getByText('send'));
  // optimistic user-сообщение сразу
  await waitFor(() => expect(Number(screen.getByTestId('count').textContent)).toBeGreaterThanOrEqual(1));
  // затем прилетает ответ ассистента
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
});

test('replayed:true → рефетч треда, без локального аппенда ответа', async () => {
  let listCalls = 0;
  const replayedList = [mkMsg('u', '2026-07-05T11:00:00.000Z', 'user'), mkMsg('r', '2026-07-05T11:00:01.000Z', 'assistant')];
  const { calls } = renderWithProviders(<Sender />, (path) => {
    if (path === 'chat.listMessages') { listCalls += 1; return listCalls === 1 ? [] : replayedList; }
    if (path === 'ai.sendMessage') return { assistantMessage: mkMsg('ignored', 'x', 'assistant'), actions: [], pending: [], replayed: true };
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  fireEvent.click(screen.getByText('send'));
  await waitFor(() => expect(calls.filter((c) => c.path === 'chat.listMessages').length).toBeGreaterThanOrEqual(2));
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/chat/useChatThread.test.tsx` Expected: FAIL «Cannot find module './useChatThread'».

- [ ] **Step 3: Реализация хуков**

`apps/web/src/features/chat/useChatThread.ts`:
```ts
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { newId } from '@orbis/shared';
import { trpc, type RouterOutputs } from '../../trpc';

export type ChatMessage = RouterOutputs['chat']['listMessages'][number];
const PAGE = 50;

export function chatThreadKey(threadId: string) {
  return ['chatThread', threadId] as const;
}

type InfiniteData = { pages: ChatMessage[][]; pageParams: (string | undefined)[] };

// Новейшая страница — pages[0] (DESC). Свежее/оптимистичное сообщение — в начало pages[0], дедуп по id.
export function upsertNewest(old: InfiniteData | undefined, msg: ChatMessage): InfiniteData {
  if (!old) return { pages: [[msg]], pageParams: [undefined] };
  const [first = [], ...rest] = old.pages;
  const without = first.filter((m) => m.id !== msg.id);
  return { ...old, pages: [[msg, ...without], ...rest] };
}

export function useChatThread(threadId: string) {
  const utils = trpc.useUtils();
  const q = useInfiniteQuery({
    queryKey: chatThreadKey(threadId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => utils.chat.listMessages.fetch({ threadId, before: pageParam, limit: PAGE }),
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE ? undefined : lastPage[lastPage.length - 1]?.createdAt,
  });
  const messages = (q.data?.pages ?? []).flat();
  return {
    messages,
    fetchOlder: () => q.fetchNextPage(),
    hasMore: q.hasNextPage,
    isLoading: q.isLoading,
  };
}

export function useSendMessage(threadId: string) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const key = chatThreadKey(threadId);

  const send = trpc.ai.sendMessage.useMutation({
    onMutate: async ({ id, content }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const optimistic: ChatMessage = {
        id, threadId, role: 'user', content, metadata: {}, createdAt: new Date().toISOString(),
      } as ChatMessage;
      queryClient.setQueryData<InfiniteData>(key, (old) => upsertNewest(old, optimistic));
    },
    onSuccess: (res) => {
      if (res.replayed) {
        // D-f: не аппендим локально — рефетчим тред
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      queryClient.setQueryData<InfiniteData>(key, (old) => upsertNewest(old, res.assistantMessage as ChatMessage));
      void utils.entity.query.invalidate();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return {
    sendMessage: (content: string) => send.mutate({ id: newId(), threadId, content }),
    isSending: send.isPending,
  };
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/chat/useChatThread.test.tsx` Expected: PASS (3 tests).

- [ ] **Step 5: Реализация UI-компонентов**

`apps/web/src/features/chat/MessageList.tsx`:
```tsx
import type { ChatMessage } from './useChatThread';
import { renderCards } from './cards/renderCards';

export function MessageList({ messages, isTyping }: { messages: ChatMessage[]; isTyping: boolean }) {
  // messages в DESC; для показа сверху-вниз (старые вверху) — reverse на рендере.
  const ordered = [...messages].reverse();
  return (
    <div data-testid="message-list" className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
      {ordered.map((m) => (
        <article key={m.id} data-role={m.role}
          className={`max-w-[85%] rounded-card px-3 py-2 text-sm ${m.role === 'user' ? 'self-end bg-accent text-accent-foreground' : 'self-start bg-surface-2 text-text'}`}>
          {m.content && <p>{m.content}</p>}
          {renderCards(m)}
        </article>
      ))}
      {isTyping && (
        <div data-testid="typing" role="status" className="self-start rounded-card bg-surface-2 px-3 py-2 text-sm text-text-muted">…</div>
      )}
    </div>
  );
}
```

`apps/web/src/features/chat/Composer.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';

export function Composer({ onSubmit, disabled, placeholder }: { onSubmit: (text: string) => void; disabled?: boolean; placeholder?: string }) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText('');
  }
  return (
    <form onSubmit={submit} className="flex gap-2 border-t border-line p-2">
      <Input aria-label="Сообщение" value={text} onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? 'Напишите сообщение…'} className="flex-1" />
      <Button type="submit" variant="primary" disabled={disabled}>Отправить</Button>
    </form>
  );
}
```

`apps/web/src/features/chat/ChatThread.tsx`:
```tsx
import { useChatThread, useSendMessage } from './useChatThread';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { Button } from '../../ui/Button';

// Общий чат-компонент (§2.2): используется глобальным тредом и тредом сущности (разный threadId).
export function ChatThread({ threadId }: { threadId: string }) {
  const { messages, fetchOlder, hasMore, isLoading } = useChatThread(threadId);
  const { sendMessage, isSending } = useSendMessage(threadId);
  return (
    <div className="flex h-full flex-col">
      {hasMore && (
        <Button variant="ghost" onClick={() => fetchOlder()} className="m-2 self-center">Загрузить ещё</Button>
      )}
      {isLoading ? (
        <div role="status" className="flex-1 p-3 text-sm text-text-muted">Загрузка…</div>
      ) : (
        <MessageList messages={messages} isTyping={isSending} />
      )}
      <Composer onSubmit={sendMessage} disabled={isSending} />
    </div>
  );
}
```

> **Замечание:** `ChatThread`/`MessageList` импортируют `renderCards` из Task 10. При исполнении по порядку Task 10 идёт следом; если Task 10 ещё не готов, временно закомментировать импорт нельзя — исполняйте Task 9 и Task 10 подряд (обе части общего чат-UI). Тесты Task 9 не рендерят `MessageList`/`ChatThread` (только хуки), поэтому проходят независимо.

- [ ] **Step 6: Commit**
```
git add apps/web/src/features/chat/useChatThread.ts apps/web/src/features/chat/MessageList.tsx apps/web/src/features/chat/Composer.tsx apps/web/src/features/chat/ChatThread.tsx apps/web/src/features/chat/useChatThread.test.tsx
git commit -m "feat(web): chat core — useChatThread (infinite before-cursor) + optimistic send

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Карточки чата + renderCards

**Files:**
- Create `apps/web/src/features/chat/cards/types.ts`, `renderCards.tsx`, `EntityCard.tsx`, `QueryResultCard.tsx`, `ConfirmationCard.tsx`, `ErrorCard.tsx`, `SystemMessage.tsx`
- Create `apps/web/src/features/chat/format-audit.ts`
- Test `apps/web/src/features/chat/cards/cards.test.tsx`

**Interfaces:**
- Consumes: `trpc` (Task 1); `useNav` (Task 3); `formatMoney` (Task 6); `renderWithProviders` (Task 1); `ChatMessage` (Task 9).
- Produces: `renderCards(msg): ReactNode`; карточки `EntityCard/QueryResultCard/ConfirmationCard/ErrorCard/SystemMessage`; `smoothAuditText(text)`; тип `Card` (локальный union).

> Серверный `Card`-union живёт в `assistantMessage.metadata.cards[]`. Клиент рендерит. Действия зовут `entity.update`/`ai.undo`/`ai.approve`/`ai.reject`. Visual-expiry 24ч (D-a). `query_result` — D-d.

- [ ] **Step 1: Написать падающий тест** `apps/web/src/features/chat/cards/cards.test.tsx`

```tsx
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/harness';
import { renderCards } from './renderCards';
import { smoothAuditText } from '../format-audit';
import type { ChatMessage } from '../useChatThread';

const msg = (cards: unknown[], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'm1', threadId: 't1', role: 'assistant', content: '', metadata: { cards }, createdAt: '2026-07-05T12:00:00.000Z', ...extra } as ChatMessage);

test('entity_card: Undo зовёт ai.undo(undoActionId) и гасит карточку', async () => {
  const { calls } = renderWithProviders(
    <div>{renderCards(msg([{ kind: 'entity_card', entityId: 'e1', title: 'Обед', aspects: ['orbis/financial'], keyFields: { amount: '340.00', direction: 'expense' }, undoActionId: 'act1' }]))}</div>,
    (path) => (path === 'ai.undo' ? { ok: true, actionId: 'act1', results: [], idempotentReplay: false } : {}),
  );
  fireEvent.click(screen.getByRole('button', { name: /отменить|undo/i }));
  await waitFor(() => expect(calls.find((c) => c.path === 'ai.undo')?.input).toEqual({ actionId: 'act1' }));
  await waitFor(() => expect(screen.getByTestId('entity-card')).toHaveAttribute('data-undone', 'true'));
});

test('query_result с aggregate → число + «показать список»', () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'query_result', title: 'Расходы', count: 3, entityIds: ['a', 'b', 'c'], aggregate: { op: 'sum', value: '1200.00' } }]))}</div>);
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('1200.00');
  expect(screen.getByRole('button', { name: /показать список/i })).toBeInTheDocument();
});

test('query_result без aggregate → native-список из entityIds (D-d)', () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'query_result', count: 2, entityIds: ['a', 'b'] }]))}</div>);
  expect(screen.getAllByTestId('qr-item')).toHaveLength(2);
});

test('confirmation explicit: Подтвердить → ai.approve(pendingId)', async () => {
  const { calls } = renderWithProviders(
    <div>{renderCards(msg([{ kind: 'confirmation_card', mode: 'explicit', pendingId: 'p1', summary: 'Удалить 3 задачи', diff: {} }]))}</div>,
    (path) => (path === 'ai.approve' ? { ok: true, actionId: 'a', results: [], idempotentReplay: false } : {}),
  );
  fireEvent.click(screen.getByRole('button', { name: /подтвердить/i }));
  await waitFor(() => expect(calls.find((c) => c.path === 'ai.approve')?.input).toEqual({ pendingId: 'p1' }));
});

test('confirmation explicit: Отменить → ai.reject(pendingId)', async () => {
  const { calls } = renderWithProviders(
    <div>{renderCards(msg([{ kind: 'confirmation_card', mode: 'explicit', pendingId: 'p2', summary: 's' }]))}</div>,
    (path) => (path === 'ai.reject' ? { pendingId: 'p2', alreadyRejected: false } : {}),
  );
  fireEvent.click(screen.getByRole('button', { name: /отменить/i }));
  await waitFor(() => expect(calls.find((c) => c.path === 'ai.reject')?.input).toEqual({ pendingId: 'p2' }));
});

describe('visual-expiry (D-a)', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-07-07T13:00:00.000Z')));
  afterEach(() => vi.useRealTimers());
  test('старше 24ч → кнопки задизейблены, подпись «устарело»', () => {
    renderWithProviders(<div>{renderCards(msg([{ kind: 'confirmation_card', mode: 'explicit', pendingId: 'p3', summary: 's' }], { createdAt: '2026-07-05T12:00:00.000Z' }))}</div>);
    expect(screen.getByRole('button', { name: /подтвердить/i })).toBeDisabled();
    expect(screen.getByText(/устарело/i)).toBeInTheDocument();
  });
});

test('error_card: код + сообщение', () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'error_card', code: 'LLM_UNAVAILABLE', message: 'Модель недоступна' }]))}</div>);
  expect(screen.getByRole('alert')).toHaveTextContent('Модель недоступна');
});

test('SystemMessage: author_kind=agent → префикс 🤖 агент', () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} }], { metadata: { author_kind: 'agent', cards: [{ kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} }] } }))}</div>);
  expect(screen.getByText(/агент/i)).toBeInTheDocument();
});

test('smoothAuditText сглаживает «batch: операций — 1»', () => {
  expect(smoothAuditText('batch: операций — 1')).toBe('Операция выполнена');
  expect(smoothAuditText('batch: операций — 3')).toBe('batch: операций — 3');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/chat/cards/cards.test.tsx` Expected: FAIL «Cannot find module './renderCards'».

- [ ] **Step 3: Реализация типов и утилит**

`apps/web/src/features/chat/cards/types.ts`:
```ts
export type EntityCardData = { kind: 'entity_card'; entityId: string; title: string; aspects: string[]; keyFields: Record<string, unknown>; undoActionId?: string };
export type QueryResultData = { kind: 'query_result'; title?: string; count: number; entityIds: string[]; aggregate?: { op: 'sum' | 'count'; value: string } };
export type ConfirmationData = { kind: 'confirmation_card'; mode: 'preview' | 'explicit'; pendingId?: string; summary: string; diff?: Record<string, { before: unknown; after: unknown }> };
export type ErrorCardData = { kind: 'error_card'; code: string; message: string };
export type Card = EntityCardData | QueryResultData | ConfirmationData | ErrorCardData;
```

`apps/web/src/features/chat/format-audit.ts`:
```ts
// Леджер 1c: approve одиночного payload звучит «batch: операций — 1» → сгладить.
export function smoothAuditText(text: string): string {
  if (/^batch:\s*операций\s*[—-]\s*1$/i.test(text.trim())) return 'Операция выполнена';
  return text;
}
```

`apps/web/src/features/chat/cards/renderCards.tsx`:
```tsx
import type { ReactNode } from 'react';
import type { ChatMessage } from '../useChatThread';
import type { Card } from './types';
import { EntityCard } from './EntityCard';
import { QueryResultCard } from './QueryResultCard';
import { ConfirmationCard } from './ConfirmationCard';
import { ErrorCard } from './ErrorCard';
import { SystemMessage } from './SystemMessage';

export function renderCards(msg: ChatMessage): ReactNode {
  const meta = (msg.metadata ?? {}) as { cards?: Card[]; author_kind?: string };
  const cards = meta.cards ?? [];
  const body = cards.map((card, i) => {
    switch (card.kind) {
      case 'entity_card': return <EntityCard key={i} card={card} />;
      case 'query_result': return <QueryResultCard key={i} card={card} />;
      case 'confirmation_card': return <ConfirmationCard key={i} card={card} createdAt={msg.createdAt} />;
      case 'error_card': return <ErrorCard key={i} card={card} />;
      default: return null;
    }
  });
  if (meta.author_kind === 'agent') return <SystemMessage>{body}</SystemMessage>;
  return <>{body}</>;
}
```

- [ ] **Step 4: Реализация карточек**

`apps/web/src/features/chat/cards/EntityCard.tsx`:
```tsx
import { useState } from 'react';
import { trpc } from '../../../trpc';
import { Card } from '../../../ui/Card';
import { Button } from '../../../ui/Button';
import { useNav } from '../../../state/navigation';
import type { EntityCardData } from './types';

export function EntityCard({ card }: { card: EntityCardData }) {
  const [undone, setUndone] = useState(false);
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const utils = trpc.useUtils();
  const undo = trpc.ai.undo.useMutation({
    onSuccess: () => { setUndone(true); void utils.entity.get.invalidate({ id: card.entityId }); },
  });

  return (
    <Card data-testid="entity-card" data-undone={String(undone)}
      className={`flex flex-col gap-2 ${undone ? 'opacity-50' : ''}`}>
      <button type="button" className="text-left font-medium" disabled={undone}
        onClick={() => push(activeTab, { kind: 'entity', id: card.entityId })}>
        {card.title}
      </button>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {Object.entries(card.keyFields).map(([k, v]) => (
          <div key={k} className="flex gap-1"><dt>{k}:</dt><dd>{String(v)}</dd></div>
        ))}
      </dl>
      {card.undoActionId && !undone && (
        <Button variant="ghost" onClick={() => undo.mutate({ actionId: card.undoActionId! })}>Отменить</Button>
      )}
      {undone && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
```

`apps/web/src/features/chat/cards/QueryResultCard.tsx`:
```tsx
import { useState } from 'react';
import { Card } from '../../../ui/Card';
import { Button } from '../../../ui/Button';
import type { QueryResultData } from './types';

export function QueryResultCard({ card }: { card: QueryResultData }) {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid="query-result-card" className="flex flex-col gap-2">
      {card.title && <p className="font-medium">{card.title}</p>}
      {card.aggregate ? (
        <div className="flex items-center gap-3">
          <span data-testid="qr-aggregate" className="text-2xl font-semibold">{card.aggregate.value}</span>
          <span className="text-xs text-text-secondary">{card.aggregate.op}</span>
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>Показать список</Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="qr-list">
          {card.entityIds.map((id) => (
            <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">{id}</li>
          ))}
        </ul>
      )}
      {card.aggregate && open && (
        <ul className="flex flex-col gap-1">
          {card.entityIds.map((id) => <li key={id} data-testid="qr-item">{id}</li>)}
        </ul>
      )}
    </Card>
  );
}
```

`apps/web/src/features/chat/cards/ConfirmationCard.tsx`:
```tsx
import { useState } from 'react';
import { trpc } from '../../../trpc';
import { Card } from '../../../ui/Card';
import { Button } from '../../../ui/Button';
import type { ConfirmationData } from './types';

const EXPIRY_MS = 24 * 60 * 60 * 1000; // D-a: 24ч visual-expiry

export function ConfirmationCard({ card, createdAt }: { card: ConfirmationData; createdAt: string }) {
  const [resolved, setResolved] = useState<null | 'approved' | 'rejected'>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const expired = Date.now() - new Date(createdAt).getTime() > EXPIRY_MS;

  const approve = trpc.ai.approve.useMutation({
    onSuccess: () => setResolved('approved'),
    onError: (e) => setPostError(e.message), // approve может вернуть структурную ошибку постфактум
  });
  const reject = trpc.ai.reject.useMutation({ onSuccess: () => setResolved('rejected') });

  const explicit = card.mode === 'explicit' && card.pendingId && !resolved;
  const disabled = expired || approve.isPending || reject.isPending;

  return (
    <Card data-testid="confirmation-card" className="flex flex-col gap-2">
      <p className="font-medium">{card.summary}</p>
      {card.diff && Object.keys(card.diff).length > 0 && (
        <dl className="flex flex-col gap-1 text-xs">
          {Object.entries(card.diff).map(([field, { before, after }]) => (
            <div key={field} className="flex gap-2">
              <dt>{field}:</dt>
              <dd className="text-danger line-through">{String(before)}</dd>
              <dd className="text-accent">{String(after)}</dd>
            </div>
          ))}
        </dl>
      )}
      {postError && <p role="alert" className="text-xs text-danger">{postError}</p>}
      {explicit && (
        <div className="flex gap-2">
          <Button variant="primary" disabled={disabled} onClick={() => approve.mutate({ pendingId: card.pendingId! })}>Подтвердить</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => reject.mutate({ pendingId: card.pendingId! })}>Отменить</Button>
        </div>
      )}
      {expired && !resolved && <p className="text-xs text-text-muted">Устарело — переспросите AI</p>}
      {resolved === 'approved' && <p className="text-xs text-accent">Подтверждено</p>}
      {resolved === 'rejected' && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
```

`apps/web/src/features/chat/cards/ErrorCard.tsx`:
```tsx
import { Card } from '../../../ui/Card';
import type { ErrorCardData } from './types';

export function ErrorCard({ card }: { card: ErrorCardData }) {
  return (
    <Card role="alert" data-testid="error-card" className="flex flex-col gap-1 border-danger">
      <p className="text-sm text-danger">{card.message}</p>
      <p className="text-xs text-text-muted">{card.code}</p>
    </Card>
  );
}
```

`apps/web/src/features/chat/cards/SystemMessage.tsx`:
```tsx
import type { ReactNode } from 'react';

export function SystemMessage({ children }: { children: ReactNode }) {
  return (
    <div data-testid="system-message" className="flex flex-col gap-1">
      <p className="text-xs text-text-muted">🤖 агент</p>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Запустить** Run: `cd apps/web && bunx vitest run src/features/chat/cards/cards.test.tsx` Expected: PASS (10 tests).

- [ ] **Step 6: Commit**
```
git add apps/web/src/features/chat/cards apps/web/src/features/chat/format-audit.ts apps/web/src/features/chat/cards/cards.test.tsx
git commit -m "feat(web): chat cards (entity/query_result/confirmation/error/system) + renderCards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Fast-path в Chat — мгновенная карточка «⚡ без AI» + «разобрать с AI» + офлайн «⏳ ждёт отправки»

**Files:**
- Create `apps/web/src/features/chat/useFastPath.ts`
- Create `apps/web/src/features/chat/ChatScreen.tsx` (глобальный тред: Composer через fast-path)
- Modify `apps/web/src/app/router.tsx` (таб chat → `ChatScreen`)
- Test `apps/web/src/features/chat/useFastPath.test.tsx`

**Interfaces:**
- Consumes: `parseFastPath` из `@orbis/shared` (Task 7); `useRetryBuffer`/`useOnline` (Task 3); `trpc` (Task 1); `useSendMessage`/`chatThreadKey`/`upsertNewest`/`ChatMessage` (Task 9); `useQueryClient`.
- Produces: `useFastPath(threadId)` → `{ submit(text) }` (оркестрация parser → entity.create/буфер/LLM); `ChatScreen`.

> §2.5/§2.6: уверенный паттерн онлайн → мгновенная entity_card «⚡ без AI» + `entity.create(source:'fast_path')`; «разобрать с AI» = архивировать fast-сущность + отправить строку LLM-путём (одна строка ≠ две сущности). Неуверенный → LLM. Офлайн → буфер-карточка «⏳ ждёт отправки», inline-edit и «разобрать с AI» недоступны до подтверждения.

- [ ] **Step 1: Написать падающий тест** `apps/web/src/features/chat/useFastPath.test.tsx`

```tsx
import { test, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc } from '../../trpc';
import { mockLink } from '../../test/harness';
import { useFastPath } from './useFastPath';
import { useRetryBuffer } from '../../state/retry';

function wrapper(handler: (path: string, input: unknown) => unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const calls: { path: string; input: unknown }[] = [];
  const client = trpc.createClient({ links: [mockLink((p, i) => { calls.push({ path: p, input: i }); return handler(p, i); })] });
  const Wrap = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={client} queryClient={qc}><QueryClientProvider client={qc}>{children}</QueryClientProvider></trpc.Provider>
  );
  return { Wrap, calls };
}

const settings = { defaultCurrency: 'RUB' };
const categories = [{ id: 'cat-food', title: 'Еда', aspects: { 'orbis/category': { aliases: ['обед', 'еда'], spend_class: 'variable' } } }];

function handlerBase(path: string) {
  if (path === 'user.getSettings') return settings;
  if (path === 'entity.query') return categories; // aspect=orbis/category
  if (path === 'chat.listMessages') return [];
  return {};
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });

test('уверенный паттерн онлайн → entity.create(source:fast_path)', async () => {
  const { Wrap, calls } = wrapper((path, input) => {
    if (path === 'entity.create') return { id: 'e1', title: 'обед' };
    return handlerBase(path);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => { await result.current.submit('обед 340'); });
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.create');
    expect(c?.input).toMatchObject({ source: 'fast_path' });
  });
});

test('неуверенный паттерн → LLM-путь (ai.sendMessage), без entity.create', async () => {
  const { Wrap, calls } = wrapper((path) => {
    if (path === 'ai.sendMessage') return { assistantMessage: { id: 'r', threadId: 't1', role: 'assistant', content: 'ok', metadata: {}, createdAt: 'x' }, actions: [], pending: [], replayed: false };
    return handlerBase(path);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => { await result.current.submit('квакозябра 500'); });
  await waitFor(() => expect(calls.some((c) => c.path === 'ai.sendMessage')).toBe(true));
  expect(calls.some((c) => c.path === 'entity.create')).toBe(false);
});

test('офлайн + уверенный → в retry-буфер, без entity.create', async () => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  const { Wrap, calls } = wrapper(handlerBase);
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => { await result.current.submit('обед 340'); });
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(calls.some((c) => c.path === 'entity.create')).toBe(false);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/chat/useFastPath.test.tsx` Expected: FAIL «Cannot find module './useFastPath'».

- [ ] **Step 3: Реализация**

`apps/web/src/features/chat/useFastPath.ts`:
```ts
import { useQueryClient } from '@tanstack/react-query';
import { parseFastPath, newId, type FastPathCategory } from '@orbis/shared';
import { trpc } from '../../trpc';
import { useRetryBuffer, useOnline } from '../../state/retry';
import { useSendMessage, chatThreadKey, upsertNewest, type ChatMessage } from './useChatThread';

// Собрать контекст парсера из aspect=orbis/category (entity.query) + defaultCurrency (settings).
function useFastPathCtx() {
  const cats = trpc.entity.query.useQuery({ query: 'aspect=orbis/category' });
  const settings = trpc.user.getSettings.useQuery();
  const categories: FastPathCategory[] = (cats.data ?? []).map((e) => {
    const meta = (e.aspects?.['orbis/category'] ?? {}) as { aliases?: string[]; spend_class?: string };
    return { id: e.id, aliases: meta.aliases ?? [], spendClass: meta.spend_class };
  });
  return { categories, defaultCurrency: settings.data?.defaultCurrency ?? 'RUB' };
}

export function useFastPath(threadId: string) {
  const queryClient = useQueryClient();
  const ctx = useFastPathCtx();
  const online = useOnline();
  const enqueueCreate = useRetryBuffer((s) => s.enqueueCreate);
  const flushNow = useRetryBuffer((s) => s.flushNow);
  const { sendMessage } = useSendMessage(threadId);

  const create = trpc.entity.create.useMutation();
  const key = chatThreadKey(threadId);

  function insertCard(entityId: string | undefined, card: Record<string, unknown>, note: string) {
    const synthetic: ChatMessage = {
      id: newId(), threadId, role: 'assistant', content: note,
      metadata: { cards: [{ kind: 'entity_card', entityId: entityId ?? '', title: String(card.title ?? ''), aspects: ['orbis/financial'], keyFields: card }] },
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    queryClient.setQueryData(key, (old) => upsertNewest(old as never, synthetic));
  }

  async function submit(text: string): Promise<void> {
    const parsed = parseFastPath(text, ctx);
    if (!parsed.ok) {
      // Неуверенно → LLM-путь
      sendMessage(text);
      return;
    }
    const fin = (parsed.create.aspects?.['orbis/financial'] ?? {}) as Record<string, unknown>;
    if (!online) {
      // Офлайн → retry-буфер, карточка «⏳ ждёт отправки»
      enqueueCreate(parsed.create, 'fast_path');
      insertCard(undefined, { ...fin, title: parsed.create.title }, '⏳ ждёт отправки');
      return;
    }
    // Онлайн → мгновенная карточка «⚡ без AI» + entity.create
    insertCard(parsed.create.id, { ...fin, title: parsed.create.title }, '⚡ без AI');
    try {
      await create.mutateAsync({ input: parsed.create, source: 'fast_path' });
    } catch {
      // при потере сети во время отправки — доложить в буфер и дренировать позже
      enqueueCreate(parsed.create, 'fast_path');
      void flushNow();
    }
  }

  return { submit };
}
```

`apps/web/src/features/chat/ChatScreen.tsx`:
```tsx
import { trpc } from '../../trpc';
import { useChatThread } from './useChatThread';
import { useFastPath } from './useFastPath';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { useRetryBuffer, useOnline } from '../../state/retry';

// Глобальный тред (§2.1): fast-path применяется здесь (D-g — только в Chat).
export function ChatScreen() {
  const ensure = trpc.chat.ensureThread.useQuery
    ? undefined
    : undefined;
  const thread = trpc.chat.ensureThread.useMutation();
  // ensureThread один раз при монтировании
  // (в реальном коде — useEffect + сохранение threadId; здесь показан контракт)
  return <GlobalThread ensure={thread} />;
}

function GlobalThread({ ensure }: { ensure: ReturnType<typeof trpc.chat.ensureThread.useMutation> }) {
  const threadId = ensure.data?.threadId;
  if (!threadId) {
    if (ensure.isIdle) ensure.mutate({});
    return <div role="status" className="p-4 text-sm text-text-muted">Открываем тред…</div>;
  }
  return <ThreadView threadId={threadId} />;
}

function ThreadView({ threadId }: { threadId: string }) {
  const { messages, isLoading } = useChatThread(threadId);
  const { submit } = useFastPath(threadId);
  const online = useOnline();
  const pending = useRetryBuffer((s) => s.size);
  return (
    <div className="flex h-full flex-col">
      {pending > 0 && <div data-testid="pending-indicator" className="px-3 py-1 text-xs text-text-secondary">Ждут отправки: {pending}</div>}
      {isLoading ? <div role="status" className="flex-1 p-3 text-sm text-text-muted">Загрузка…</div> : <MessageList messages={messages} isTyping={false} />}
      <Composer onSubmit={submit} placeholder={online ? 'Сообщение или быстрый ввод…' : 'Нет сети — доступен только быстрый ввод'} />
    </div>
  );
}
```

> **Замечание:** упрощённая проводка `ensureThread` показана для контракта; при исполнении вынести `ensure.mutate({})` в `useEffect` (StrictMode-safe) и хранить `threadId` в стейте. Тесты Task 11 покрывают `useFastPath` напрямую (без `ChatScreen`).

И в `apps/web/src/app/router.tsx` — заменить рендер таба `chat` на `<ChatScreen />` в `ActiveScreen` (когда стек пуст):
```tsx
import { ChatScreen } from '../features/chat/ChatScreen';
// ...в ActiveScreen: if (activeTab === 'chat' && !top) return <ChatScreen />;
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/chat/useFastPath.test.tsx` Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/features/chat/useFastPath.ts apps/web/src/features/chat/ChatScreen.tsx apps/web/src/app/router.tsx apps/web/src/features/chat/useFastPath.test.tsx
git commit -m "feat(web): fast-path in chat (instant card, offline buffer, LLM fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Browser-lite — EntityList + Sidebar + QuickCapture + Filters

**Files:**
- Create `apps/web/src/features/browser/useEntities.ts`, `EntityList.tsx`, `Sidebar.tsx`, `QuickCapture.tsx`, `Filters.tsx`, `SmartListSave.tsx`, `BrowserScreen.tsx`, `query.ts`
- Modify `apps/web/src/app/router.tsx` (таб browser → `BrowserScreen`)
- Test `apps/web/src/features/browser/browser.test.tsx`, `apps/web/src/features/browser/query.test.ts`

**Interfaces:**
- Consumes: `trpc` (Task 1); `useNav` (Task 3); `newId` из `@orbis/shared`; `renderWithProviders`/`mockLink` (Task 1); `firstQueryBlock` (см. ниже — общий с Task 13; определяется здесь, реэкспортируется в query-blocks).
- Produces: `browserQuery({ limit, filters })`, `buildFilterQuery(state)`, `firstQueryBlock(body)`; `EntityList`, `Sidebar`, `QuickCapture`, `Filters`, `SmartListSave`, `BrowserScreen`.

> **Грамматика surface (подтверждена контроллером по `packages/shared/src/query/{grammar.ts,parse.test.ts}`):** клаузы разделяются **запятой**: `aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled, sortBy=priority:desc|due_date:asc, limit=30`. Внутри значения: `|` = OR (`tags=работа|дом`, `status=a|b`), `&!` = исключение (`status=!done&!cancelled`). Сравнения — строгие `>`/`<` (`amount>1000`, `created_at>2026-07-01`) и диапазон `..` (`amount=500..2000`); `>=`/`<=` грамматикой НЕ поддерживаются. `sortBy=field:dir` (несколько через `|`). `limit=N`. Смешивать `|` и `&` в одном значении — ошибка парсинга (§6.4). Пагинация MVP — оконная по `limit` (курсорный `updated_at<…, sortBy=updated_at:desc` — уточнение 1c-2).

- [ ] **Step 1: Написать падающий тест (query.ts helpers)** `apps/web/src/features/browser/query.test.ts`

```ts
import { test, expect } from 'vitest';
import { browserQuery, buildFilterQuery, firstQueryBlock } from './query';

test('browserQuery включает limit и сортировку по updated_at desc', () => {
  const q = browserQuery({ limit: 50, filters: '' });
  expect(q).toContain('limit=50');
  expect(q).toContain('sortBy=updated_at:desc');
});

test('browserQuery дописывает фильтры перед limit', () => {
  const q = browserQuery({ limit: 100, filters: 'aspect=orbis/task' });
  expect(q).toContain('aspect=orbis/task');
  expect(q).toContain('limit=100');
});

test('buildFilterQuery собирает строку из выбранных фильтров', () => {
  const s = buildFilterQuery({ tags: ['работа', 'дом'], aspects: ['orbis/task'], status: 'inbox', priority: null, createdFrom: null, createdTo: null });
  expect(s).toContain('tags=работа|дом');
  expect(s).toContain('aspect=orbis/task');
  expect(s).toContain('status=inbox');
});

test('firstQueryBlock извлекает первый {{query:...}} из body', () => {
  expect(firstQueryBlock('текст\n{{query:aspect=orbis/task}}\nещё {{query:tags=x}}')).toBe('aspect=orbis/task');
  expect(firstQueryBlock('без блоков')).toBeNull();
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/browser/query.test.ts` Expected: FAIL «Cannot find module './query'».

- [ ] **Step 3: Реализация query-хелперов**

`apps/web/src/features/browser/query.ts`:
```ts
export type FilterState = {
  tags: string[];
  aspects: string[];
  status: string | null;
  priority: string | null;
  createdFrom: string | null; // ISO date
  createdTo: string | null;
};

export function buildFilterQuery(f: FilterState): string {
  // Грамматика §6.1: клаузы через запятую; OR внутри значения — '|'; сравнения строгие '>'/'<'.
  const clauses: string[] = [];
  if (f.tags.length) clauses.push(`tags=${f.tags.join('|')}`);
  for (const a of f.aspects) clauses.push(`aspect=${a}`);
  if (f.status) clauses.push(`status=${f.status}`);
  if (f.priority) clauses.push(`priority=${f.priority}`);
  if (f.createdFrom) clauses.push(`created_at>${f.createdFrom}`);
  if (f.createdTo) clauses.push(`created_at<${f.createdTo}`);
  return clauses.join(', ');
}

export function browserQuery({ limit, filters }: { limit: number; filters: string }): string {
  const base = filters ? `${filters}, ` : '';
  return `${base}sortBy=updated_at:desc, limit=${limit}`;
}

export function firstQueryBlock(body: string): string | null {
  const m = body.match(/\{\{query:([\s\S]*?)\}\}/);
  return m ? m[1].trim() : null;
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/browser/query.test.ts` Expected: PASS (4 tests).

- [ ] **Step 5: Написать падающий тест (компоненты)** `apps/web/src/features/browser/browser.test.tsx`

```tsx
import { test, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { EntityList } from './EntityList';
import { Sidebar } from './Sidebar';
import { QuickCapture } from './QuickCapture';
import { useNav } from '../../state/navigation';

const ent = (id: string, title: string) => ({ id, ownerId: 'u', title, emoji: null, body: '', bodyRefs: [], tags: [], meta: {}, aspects: {}, createdAt: 'x', updatedAt: 'y', archived: false });

beforeEach(() => { localStorage.clear(); useNav.setState({ activeTab: 'browser', stacks: { chat: [], browser: [], agenda: [], budget: [] } }); });

test('EntityList: первая страница 50 через entity.query; «ещё» шлёт limit=100', async () => {
  const page = Array.from({ length: 50 }, (_, i) => ent(`e${i}`, `T${i}`));
  const { calls } = renderWithProviders(<EntityList />, (path, input) => {
    if (path === 'entity.query') {
      const q = (input as { query: string }).query;
      return q.includes('limit=100') ? [...page, ent('e50', 'T50')] : page;
    }
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(50));
  fireEvent.click(screen.getByRole('button', { name: /ещё/i }));
  await waitFor(() => expect(calls.some((c) => (c.input as { query: string }).query.includes('limit=100'))).toBe(true));
});

test('Sidebar: бейдж pinned через entity.count; >99 → «99+»', async () => {
  const settings = { pinnedEntities: [{ id: 'p1', order: 0 }] };
  renderWithProviders(<Sidebar settings={settings as never} />, (path, input) => {
    if (path === 'entity.get') return { entity: ent('p1', 'Задачи'), relations: [] };
    if (path === 'entity.count') return { count: 250 };
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('pin-badge-p1')).toHaveTextContent('99+'));
});

test('QuickCapture: title-only через entity.create(source:quick_capture) без интерпретации', async () => {
  const { calls } = renderWithProviders(<QuickCapture context={{ kind: 'root' }} />, (path) => (path === 'entity.create' ? ent('new', 'купить молоко 200') : {}));
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), { target: { value: 'купить молоко 200' } });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.create');
    expect(c?.input).toMatchObject({ source: 'quick_capture', input: { title: 'купить молоко 200', tags: [] } });
    // никакой интерпретации: нет aspects orbis/financial
    expect((c?.input as { input: { aspects?: unknown } }).input.aspects).toBeUndefined();
  });
});
```

- [ ] **Step 6: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/browser/browser.test.tsx` Expected: FAIL «Cannot find module './EntityList'».

- [ ] **Step 7: Реализация компонентов**

`apps/web/src/features/browser/useEntities.ts`:
```ts
import { useState } from 'react';
import { trpc } from '../../trpc';
import { browserQuery } from './query';

const PAGE = 50;

export function useEntities(filters: string) {
  const [limit, setLimit] = useState(PAGE);
  const query = browserQuery({ limit, filters });
  const q = trpc.entity.query.useQuery({ query });
  const entities = q.data ?? [];
  const hasMore = entities.length >= limit;
  return { entities, hasMore, loadMore: () => setLimit((l) => l + PAGE), isLoading: q.isLoading };
}
```

`apps/web/src/features/browser/EntityList.tsx`:
```tsx
import { useEntities } from './useEntities';
import { Button } from '../../ui/Button';
import { useNav } from '../../state/navigation';

export function EntityList({ filters = '' }: { filters?: string }) {
  const { entities, hasMore, loadMore, isLoading } = useEntities(filters);
  const push = useNav((s) => s.push);
  if (isLoading) return <div role="status" className="p-4 text-sm text-text-muted">Загрузка…</div>;
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-line">
        {entities.map((e) => (
          <li key={e.id}>
            <button type="button" data-testid="entity-row"
              onClick={() => push('browser', { kind: 'entity', id: e.id })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
              {e.emoji && <span aria-hidden>{e.emoji}</span>}
              <span className="flex-1 truncate">{e.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && <Button variant="ghost" onClick={loadMore} className="m-2 self-center">Показать ещё</Button>}
    </div>
  );
}
```

`apps/web/src/features/browser/Sidebar.tsx`:
```tsx
import { trpc, type RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { firstQueryBlock } from './query';
import { useNav } from '../../state/navigation';

type Settings = RouterOutputs['user']['getSettings'];

function PinnedRow({ id }: { id: string }) {
  const push = useNav((s) => s.push);
  const ent = trpc.entity.get.useQuery({ id, include: ['body'] });
  const body = ent.data?.entity.body ?? '';
  const block = firstQueryBlock(body);
  const count = trpc.entity.count.useQuery({ query: block ?? '' }, { enabled: !!block });
  const badge = count.data ? (count.data.count > 99 ? '99+' : String(count.data.count)) : null;
  return (
    <button type="button" onClick={() => push('browser', { kind: 'entity', id })}
      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
      <span className="truncate">{ent.data?.entity.title ?? id}</span>
      {badge && <Badge data-testid={`pin-badge-${id}`}>{badge}</Badge>}
    </button>
  );
}

export function Sidebar({ settings }: { settings: Settings }) {
  const pinned = [...(settings.pinnedEntities ?? [])].sort((a, b) => a.order - b.order);
  return (
    <aside className="flex flex-col border-r border-line">
      <p className="px-3 py-2 text-xs uppercase text-text-muted">Закреплённые</p>
      {pinned.map((p) => <PinnedRow key={p.id} id={p.id} />)}
    </aside>
  );
}
```

`apps/web/src/features/browser/QuickCapture.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { newId } from '@orbis/shared';
import { trpc } from '../../trpc';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';

// §3.7 / D-g: текст → title БЕЗ интерпретации. Контекст задаёт теги/связь.
export type CaptureContext =
  | { kind: 'root' }
  | { kind: 'smart-list' }
  | { kind: 'entity'; parentId: string };

export function QuickCapture({ context }: { context: CaptureContext }) {
  const [text, setText] = useState('');
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({ onSuccess: () => void utils.entity.query.invalidate() });
  const relation = trpc.relation.create.useMutation();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const title = text.trim();
    if (!title) return;
    const id = newId();
    const aspects = context.kind === 'root' ? undefined : { 'orbis/task': { status: 'inbox' } };
    const tags = context.kind === 'smart-list' ? [] : [];
    const ent = await create.mutateAsync({ input: { id, title, tags, ...(aspects ? { aspects } : {}) }, source: 'quick_capture' });
    if (context.kind === 'entity') {
      await relation.mutateAsync({ source_id: context.parentId, target_id: ent.id, relation_type: 'parent' });
    }
    setText('');
  }

  return (
    <form data-testid="quick-capture-form" onSubmit={submit} className="flex gap-2 border-t border-line p-2">
      <Input aria-label="Быстрая запись" value={text} onChange={(e) => setText(e.target.value)} placeholder="Быстрая запись…" className="flex-1" />
      <Button type="submit" variant="primary">Добавить</Button>
    </form>
  );
}
```

`apps/web/src/features/browser/Filters.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { buildFilterQuery, type FilterState } from './query';

const EMPTY: FilterState = { tags: [], aspects: [], status: null, priority: null, createdFrom: null, createdTo: null };

export function Filters({ onApply }: { onApply: (query: string) => void }) {
  const [state, setState] = useState<FilterState>(EMPTY);
  const [tagDraft, setTagDraft] = useState('');
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap gap-1">
        {state.tags.map((t) => (
          <Chip key={t} onRemove={() => setState((s) => ({ ...s, tags: s.tags.filter((x) => x !== t) }))}>{t}</Chip>
        ))}
        <input aria-label="Добавить тег" value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && tagDraft.trim()) { setState((s) => ({ ...s, tags: [...s.tags, tagDraft.trim()] })); setTagDraft(''); } }}
          className="rounded-control border border-line bg-surface px-2 py-1 text-xs" />
      </div>
      <Button variant="primary" onClick={() => onApply(buildFilterQuery(state))}>Применить</Button>
    </div>
  );
}
```

`apps/web/src/features/browser/SmartListSave.tsx`:
```tsx
import { newId } from '@orbis/shared';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

// §3.8: «Сохранить как smart list» → сущность (body=query-блок, тег smart-list) + автозакреп.
export function SmartListSave({ query, title }: { query: string; title: string }) {
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation();
  const settings = trpc.user.getSettings.useQuery();
  const update = trpc.user.updateSettings.useMutation({ onSuccess: () => void utils.user.getSettings.invalidate() });

  async function save() {
    const id = newId();
    await create.mutateAsync({ input: { id, title, tags: ['smart-list'], body: `{{query:${query}}}` }, source: 'quick_capture' });
    const pinned = settings.data?.pinnedEntities ?? [];
    await update.mutateAsync({ pinnedEntities: [...pinned, { id, order: pinned.length }] });
  }
  return <Button variant="ghost" onClick={save}>Сохранить как smart list</Button>;
}
```

`apps/web/src/features/browser/BrowserScreen.tsx`:
```tsx
import { useState } from 'react';
import { trpc } from '../../trpc';
import { EntityList } from './EntityList';
import { Sidebar } from './Sidebar';
import { QuickCapture } from './QuickCapture';
import { Filters } from './Filters';

export function BrowserScreen() {
  const settings = trpc.user.getSettings.useQuery();
  const [filters, setFilters] = useState('');
  return (
    <div className="grid h-full grid-cols-[minmax(0,14rem)_1fr]">
      {settings.data && <Sidebar settings={settings.data} />}
      <div className="flex h-full flex-col">
        <Filters onApply={setFilters} />
        <div className="flex-1 overflow-y-auto"><EntityList filters={filters} /></div>
        <QuickCapture context={{ kind: 'root' }} />
      </div>
    </div>
  );
}
```

И в `apps/web/src/app/router.tsx` — `if (activeTab === 'browser' && !top) return <BrowserScreen />;`.

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/features/browser/browser.test.tsx` Expected: PASS (3 tests).

- [ ] **Step 9: Commit**
```
git add apps/web/src/features/browser apps/web/src/app/router.tsx
git commit -m "feat(web): Browser-lite (list, sidebar badges, quick-capture, filters)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: query-blocks lib — парс/рендер `{{query:...}}` + красная плашка с позицией

**Files:**
- Create `apps/web/src/lib/query-blocks/parse.ts`, `catalog.ts`, `QueryBlock.tsx`
- Test `apps/web/src/lib/query-blocks/parse.test.ts`, `apps/web/src/lib/query-blocks/QueryBlock.test.tsx`

**Interfaces:**
- Consumes: `parseQuery`, `buildFieldCatalog`, `CORE_FIELDS`, типы `FieldCatalog`/`ParseResult`/`QueryAst` из `@orbis/shared`; `WireAspectDefinition` через `RouterOutputs['aspect']['list'][number]`; `trpc` (Task 1); `firstQueryBlock` из `../../features/browser/query` (Task 12).
- Produces: `buildCatalogFromAspects(defs)`, `parseBlock(blockText, catalog)`; `QueryBlock` (рендер: список+счётчик / красная плашка `{message,position}`; §6.4 — никогда не пустой список при ошибке).

> **Ассумпция (флаг контроллеру):** для валидного парса тест использует `tags=work` (reserved key `tags`, не требует aspect-каталога) и `{{query:}}` (пустой inner) как заведомо-ошибочный. Если реальный `parseQuery` иначе трактует эти входы — правится только фикстура теста, не контракт `QueryBlock`.

- [ ] **Step 1: Написать падающий тест (parse/catalog)** `apps/web/src/lib/query-blocks/parse.test.ts`

```ts
import { test, expect } from 'vitest';
import { buildCatalogFromAspects, parseBlock } from './parse';

const aspects = [
  { id: 'orbis/task', schema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'string' } } } },
];

test('buildCatalogFromAspects строит каталог из schema + CORE_FIELDS', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  expect(cat).toBeTruthy();
});

test('parseBlock снимает обёртку и валидный блок → ok:true с ast', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  const r = parseBlock('{{query:tags=work}}', cat);
  expect(r.ok).toBe(true);
});

test('parseBlock: пустой inner → ok:false с position', () => {
  const cat = buildCatalogFromAspects(aspects as never);
  const r = parseBlock('{{query:}}', cat);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(typeof r.error.position).toBe('number');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/lib/query-blocks/parse.test.ts` Expected: FAIL «Cannot find module './parse'».

- [ ] **Step 3: Реализация parse/catalog**

`apps/web/src/lib/query-blocks/catalog.ts`:
```ts
import { buildFieldCatalog, type FieldCatalog } from '@orbis/shared';
import type { RouterOutputs } from '../../trpc';

type AspectDef = RouterOutputs['aspect']['list'][number];

export function buildCatalogFromAspects(defs: AspectDef[]): FieldCatalog {
  return buildFieldCatalog(defs.map((d) => ({ id: d.id, schema: d.schema as Record<string, unknown> })));
}
```

`apps/web/src/lib/query-blocks/parse.ts`:
```ts
import { parseQuery, type FieldCatalog, type ParseResult } from '@orbis/shared';
export { buildCatalogFromAspects } from './catalog';

// Снимаем обёртку {{query:...}}; на вход parseQuery идёт содержимое (карта §2: обёртку парсер НЕ снимает).
export function parseBlock(blockText: string, catalog: FieldCatalog): ParseResult {
  const m = blockText.match(/\{\{query:([\s\S]*?)\}\}/);
  const inner = (m ? m[1] : blockText).trim();
  return parseQuery(inner, catalog);
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/lib/query-blocks/parse.test.ts` Expected: PASS (3 tests). (Если фикстура `tags=work`/`{{query:}}` даёт иной результат — скорректировать входы под реальный `parseQuery`, сохранив проверяемое поведение веток.)

- [ ] **Step 5: Написать падающий тест (QueryBlock)** `apps/web/src/lib/query-blocks/QueryBlock.test.tsx`

```tsx
import { test, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { QueryBlock } from './QueryBlock';

const aspectsResp = [{ id: 'orbis/task', ownerId: null, name: 'Task', namespace: 'orbis', description: null, icon: '✅', schema: { type: 'object', properties: {} }, aiInstructions: null, tagMappings: [], aggregations: null, viewConfig: null, createdAt: 'x' }];
const ent = (id: string) => ({ id, ownerId: 'u', title: id, emoji: null, body: '', bodyRefs: [], tags: [], meta: {}, aspects: {}, createdAt: 'x', updatedAt: 'y', archived: false });

test('валидный блок → список сущностей + счётчик', async () => {
  renderWithProviders(<QueryBlock body="{{query:tags=work}}" title="Работа" />, (path) => {
    if (path === 'aspect.list') return aspectsResp;
    if (path === 'entity.query') return [ent('a'), ent('b')];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('qb-count')).toHaveTextContent('2'));
  expect(screen.getAllByTestId('qb-item')).toHaveLength(2);
});

test('невалидный блок → красная плашка с позицией, без списка (§6.4)', async () => {
  renderWithProviders(<QueryBlock body="{{query:}}" title="Битый" />, (path) => {
    if (path === 'aspect.list') return aspectsResp;
    throw new Error(`unexpected ${path}`); // entity.query не должен вызываться
  });
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(screen.getByTestId('qb-error')).toHaveTextContent(/позиция/i);
  expect(screen.queryByTestId('qb-item')).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/lib/query-blocks/QueryBlock.test.tsx` Expected: FAIL «Cannot find module './QueryBlock'».

- [ ] **Step 7: Реализация QueryBlock**

`apps/web/src/lib/query-blocks/QueryBlock.tsx`:
```tsx
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';
import { buildCatalogFromAspects, parseBlock } from './parse';

export function QueryBlock({ body, title }: { body: string; title?: string }) {
  const aspects = trpc.aspect.list.useQuery();
  const catalog = useMemo(
    () => (aspects.data ? buildCatalogFromAspects(aspects.data) : null),
    [aspects.data],
  );

  const parsed = useMemo(() => (catalog ? parseBlock(body, catalog) : null), [catalog, body]);
  const inner = body.match(/\{\{query:([\s\S]*?)\}\}/)?.[1].trim() ?? '';
  const ok = parsed?.ok === true;

  // entity.query только при валидном блоке; §6.4 — при ошибке НИКОГДА не пустой список, а плашка.
  const list = trpc.entity.query.useQuery({ query: inner }, { enabled: ok });

  if (!parsed) return <Card><span role="status">Загрузка…</span></Card>;

  if (!parsed.ok) {
    return (
      <Card role="alert" data-testid="qb-error" className="border-danger">
        <p className="text-sm text-danger">Ошибка запроса: {parsed.error.message}</p>
        <p className="text-xs text-text-muted">позиция {parsed.error.position}</p>
      </Card>
    );
  }

  const entities = list.data ?? [];
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {title && <p className="font-medium">{title}</p>}
        <span data-testid="qb-count" className="text-xs text-text-secondary">{entities.length}</span>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {entities.map((e) => (
          <li key={e.id} data-testid="qb-item" className="py-1 text-sm">{e.title}</li>
        ))}
      </ul>
    </Card>
  );
}
```

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/lib/query-blocks/QueryBlock.test.tsx` Expected: PASS (2 tests).

- [ ] **Step 9: Commit**
```
git add apps/web/src/lib/query-blocks
git commit -m "feat(web): query-blocks (parse {{query}}, catalog, red error plaque with position)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: Detail сущности — DetailScreen + AspectCards + Subtasks + NativeRow

**Files:**
- Create `apps/web/src/features/entity-detail/NativeRow.tsx`, `AspectCards.tsx`, `Subtasks.tsx`, `DetailScreen.tsx`, `useEntityDetail.ts`
- Modify `apps/web/src/app/router.tsx` (ScreenRef `entity` → `DetailScreen`)
- Test `apps/web/src/features/entity-detail/NativeRow.test.tsx`, `apps/web/src/features/entity-detail/detail.test.tsx`

**Interfaces:**
- Consumes: `trpc` (Task 1); `formatMoney`/`formatDate` (Task 6); `Checkbox` (Task 5); `Tabs` (Task 5); `ChatThread` (Task 9); `QueryBlock` (Task 13); `Badge` (Task 5); `BUILTIN_ASPECT_META` из `@orbis/shared`; `useNav` (Task 3).
- Produces: `NativeRow` (§3.6: task/schedule/financial/generic); `AspectCards`; `Subtasks`; `DetailScreen`.

> Чекбокс task → `entity.update aspects:{'orbis/task':{status:'done', completed_at}}` (+ откат). Inline body-правка — optimistic + `expectedUpdatedAt` = точная строка `updatedAt`, которую видел клиент (§5.2). Снять аспект — `aspects:{id:null}`.

- [ ] **Step 1: Написать падающий тест (NativeRow)** `apps/web/src/features/entity-detail/NativeRow.test.tsx`

```tsx
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NativeRow } from './NativeRow';

const base = { id: 'e1', ownerId: 'u', title: 'Обед', emoji: null, body: '', bodyRefs: [], tags: [], meta: {}, createdAt: 'x', updatedAt: 'y', archived: false };

test('financial: сумма с минусом и тоном danger', () => {
  render(<NativeRow entity={{ ...base, aspects: { 'orbis/financial': { amount: '340.00', direction: 'expense', category_ref: 'cat-food' } } } as never} onToggleTask={() => {}} />);
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('−')).toBe(true);
  expect(amount.className).toContain('text-danger');
});

test('task: рендерит чекбокс', () => {
  render(<NativeRow entity={{ ...base, aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } } } as never} onToggleTask={() => {}} />);
  expect(screen.getByRole('checkbox')).toBeInTheDocument();
});

test('generic: 2-3 keyFields из реестра', () => {
  render(<NativeRow entity={{ ...base, aspects: { 'orbis/note': { content_type: 'text', pinned: true } } } as never} onToggleTask={() => {}} />);
  expect(screen.getByTestId('native-generic')).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/entity-detail/NativeRow.test.tsx` Expected: FAIL «Cannot find module './NativeRow'».

- [ ] **Step 3: Реализация NativeRow**

`apps/web/src/features/entity-detail/NativeRow.tsx`:
```tsx
import { BUILTIN_ASPECT_META } from '@orbis/shared';
import type { RouterOutputs } from '../../trpc';
import { formatMoney } from '../../lib/format';
import { Checkbox } from '../../ui/Checkbox';
import { Badge } from '../../ui/Badge';

type Entity = RouterOutputs['entity']['query'][number];

function keyFieldsFor(aspectId: string): string[] {
  return BUILTIN_ASPECT_META.find((m) => m.id === aspectId)?.viewConfig.keyFields ?? [];
}

export function NativeRow({ entity, onToggleTask }: { entity: Entity; onToggleTask: (done: boolean) => void }) {
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

  if (aspects['orbis/task']) {
    const t = aspects['orbis/task'];
    const done = t.status === 'done';
    return (
      <div className="flex items-center gap-2" data-testid="native-task">
        <Checkbox aria-label="Готово" checked={done} onCheckedChange={onToggleTask} />
        <span className={done ? 'line-through text-text-muted' : ''}>{entity.title}</span>
        {typeof t.status === 'string' && t.status !== 'done' && <Badge>{t.status}</Badge>}
      </div>
    );
  }

  if (aspects['orbis/financial']) {
    const f = aspects['orbis/financial'];
    const money = formatMoney(String(f.amount ?? '0'), (f.direction as 'expense' | 'income') ?? 'expense');
    return (
      <div className="flex items-center gap-2" data-testid="native-financial">
        <span className="flex-1">{entity.title}</span>
        <span data-testid="native-amount" className={money.tone === 'danger' ? 'text-danger' : 'text-accent'}>{money.text}</span>
        {typeof f.category_ref === 'string' && <Badge>{f.category_ref}</Badge>}
      </div>
    );
  }

  if (aspects['orbis/schedule']) {
    const s = aspects['orbis/schedule'];
    return (
      <div className="flex items-center gap-2" data-testid="native-schedule">
        <span className="flex-1">{entity.title}</span>
        {s.all_day ? <Badge>весь день</Badge> : <span className="text-xs text-text-secondary">{String(s.start_at ?? '')}</span>}
      </div>
    );
  }

  // generic: первые 2-3 keyFields установленного аспекта
  const firstAspect = Object.keys(aspects)[0];
  const fields = firstAspect ? keyFieldsFor(firstAspect).slice(0, 3) : [];
  return (
    <div className="flex items-center gap-2" data-testid="native-generic">
      <span className="flex-1">{entity.title}</span>
      <dl className="flex gap-2 text-xs text-text-secondary">
        {fields.map((k) => (
          <div key={k} className="flex gap-1"><dt>{k}:</dt><dd>{String(aspects[firstAspect!]?.[k] ?? '—')}</dd></div>
        ))}
      </dl>
    </div>
  );
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/entity-detail/NativeRow.test.tsx` Expected: PASS (3 tests).

- [ ] **Step 5: Написать падающий тест (detail взаимодействия)** `apps/web/src/features/entity-detail/detail.test.tsx`

```tsx
import { test, expect, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { DetailScreen } from './DetailScreen';
import { useNav } from '../../state/navigation';

const entity = {
  id: 'e1', ownerId: 'u', title: 'Задача', emoji: null, body: 'тело', bodyRefs: [], tags: ['work'], meta: {},
  aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } },
  createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-07-05T10:00:00.000Z', archived: false,
};

beforeEach(() => { localStorage.clear(); useNav.setState({ activeTab: 'browser', stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] } }); });

test('чекбокс task → entity.update status=done + completed_at', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, aspects: { 'orbis/task': { status: 'done', completed_at: 'now' } } };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByText('Задача')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    const input = c?.input as { id: string; aspects: Record<string, { status: string; completed_at?: unknown }> };
    expect(input.id).toBe('e1');
    expect(input.aspects['orbis/task'].status).toBe('done');
    expect(input.aspects['orbis/task'].completed_at).toBeTruthy();
  });
});

test('inline body-правка шлёт expectedUpdatedAt = точная строка updatedAt', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, body: 'новое' };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'новое' } });
  fireEvent.blur(screen.getByTestId('body-edit'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update' && (x.input as { body?: string }).body === 'новое');
    expect((c?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe('2026-07-05T10:00:00.000Z');
  });
});
```

- [ ] **Step 6: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/entity-detail/detail.test.tsx` Expected: FAIL «Cannot find module './DetailScreen'».

- [ ] **Step 7: Реализация detail**

`apps/web/src/features/entity-detail/useEntityDetail.ts`:
```ts
import { trpc } from '../../trpc';

export function useEntityDetail(entityId: string) {
  const utils = trpc.useUtils();
  const get = trpc.entity.get.useQuery({ id: entityId, include: ['body', 'relations', 'thread'] });
  const update = trpc.entity.update.useMutation({
    onSuccess: () => void utils.entity.get.invalidate({ id: entityId }),
  });
  return { get, update, invalidate: () => utils.entity.get.invalidate({ id: entityId }) };
}
```

`apps/web/src/features/entity-detail/AspectCards.tsx`:
```tsx
import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { RouterOutputs } from '../../trpc';

type Entity = RouterOutputs['entity']['get']['entity'];

export function AspectCards({ entity }: { entity: Entity }) {
  const utils = trpc.useUtils();
  const update = trpc.entity.update.useMutation({ onSuccess: () => void utils.entity.get.invalidate({ id: entity.id }) });
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

  return (
    <div className="flex flex-col gap-2">
      {Object.entries(aspects).map(([aspectId, fields]) => (
        <Card key={aspectId} data-testid={`aspect-${aspectId}`} className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="font-medium">{aspectId}</p>
            <Button variant="ghost" aria-label={`Снять ${aspectId}`}
              onClick={() => update.mutate({ id: entity.id, aspects: { [aspectId]: null } })}>Снять аспект</Button>
          </div>
          <dl className="flex flex-col gap-1 text-sm">
            {Object.entries(fields).map(([k, v]) => (
              <div key={k} className="flex gap-2"><dt className="text-text-secondary">{k}:</dt><dd>{String(v)}</dd></div>
            ))}
          </dl>
        </Card>
      ))}
    </div>
  );
}
```

`apps/web/src/features/entity-detail/Subtasks.tsx`:
```tsx
import { newId } from '@orbis/shared';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { useState } from 'react';
import { Input } from '../../ui/Input';

export function Subtasks({ parentId }: { parentId: string }) {
  const utils = trpc.useUtils();
  const relations = trpc.relation.listFor.useQuery({ entityId: parentId });
  const childIds = (relations.data ?? []).filter((r) => r.relationType === 'parent' && r.sourceId === parentId).map((r) => r.targetId);
  const [draft, setDraft] = useState('');
  const create = trpc.entity.create.useMutation();
  const relate = trpc.relation.create.useMutation({ onSuccess: () => void utils.relation.listFor.invalidate({ entityId: parentId }) });

  async function add() {
    const title = draft.trim();
    if (!title) return;
    const id = newId();
    await create.mutateAsync({ input: { id, title, tags: [], aspects: { 'orbis/task': { status: 'inbox' } } }, source: 'quick_capture' });
    await relate.mutateAsync({ source_id: parentId, target_id: id, relation_type: 'parent' });
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Подзадачи ({childIds.length})</p>
      <ul className="flex flex-col gap-1">{childIds.map((id) => <li key={id} data-testid="subtask" className="text-sm">{id}</li>)}</ul>
      <div className="flex gap-2">
        <Input aria-label="Новая подзадача" value={draft} onChange={(e) => setDraft(e.target.value)} className="flex-1" />
        <Button variant="ghost" onClick={add}>+ подзадача</Button>
      </div>
    </div>
  );
}
```

`apps/web/src/features/entity-detail/DetailScreen.tsx`:
```tsx
import { useState } from 'react';
import { trpc } from '../../trpc';
import { Tabs } from '../../ui/Tabs';
import { Button } from '../../ui/Button';
import { NativeRow } from './NativeRow';
import { AspectCards } from './AspectCards';
import { Subtasks } from './Subtasks';
import { ChatThread } from '../chat/ChatThread';
import { QueryBlock } from '../../lib/query-blocks/QueryBlock';
import { firstQueryBlock } from '../browser/query';

export function DetailScreen({ entityId }: { entityId: string }) {
  const get = trpc.entity.get.useQuery({ id: entityId, include: ['body', 'relations', 'thread'] });
  const utils = trpc.useUtils();
  const update = trpc.entity.update.useMutation({ onSuccess: () => void utils.entity.get.invalidate({ id: entityId }) });
  const settings = trpc.user.getSettings.useQuery();
  const updateSettings = trpc.user.updateSettings.useMutation({ onSuccess: () => void utils.user.getSettings.invalidate() });

  if (get.isLoading || !get.data) return <div role="status" className="p-4 text-sm text-text-muted">Загрузка…</div>;
  const { entity, thread } = get.data;

  function toggleTask(done: boolean) {
    update.mutate({
      id: entity.id,
      aspects: { 'orbis/task': { status: done ? 'done' : 'inbox', completed_at: done ? new Date().toISOString() : null } },
    });
  }

  const block = firstQueryBlock(entity.body ?? '');

  const entityTab = (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{entity.emoji ? `${entity.emoji} ` : ''}{entity.title}</h1>
        <DetailMenu
          onPin={() => {
            const pinned = settings.data?.pinnedEntities ?? [];
            updateSettings.mutate({ pinnedEntities: [...pinned, { id: entity.id, order: pinned.length }] });
          }}
          onArchive={() => update.mutate({ id: entity.id, archived: !entity.archived })}
          archived={entity.archived}
        />
      </div>
      <NativeRow entity={entity as never} onToggleTask={toggleTask} />
      <BodyEditor
        initial={entity.body ?? ''}
        onSave={(body) => update.mutate({ id: entity.id, body, expectedUpdatedAt: entity.updatedAt })}
      />
      {block && <QueryBlock body={entity.body ?? ''} />}
      <AspectCards entity={entity} />
      <Subtasks parentId={entity.id} />
    </div>
  );

  return (
    <Tabs
      defaultValue="entity"
      tabs={[
        { value: 'entity', label: 'Сущность', content: entityTab },
        { value: 'thread', label: 'Тред', content: thread ? <ChatThread threadId={thread.threadId} /> : <p className="p-3 text-sm text-text-muted">Нет треда</p> },
      ]}
    />
  );
}

function BodyEditor({ initial, onSave }: { initial: string; onSave: (body: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <textarea data-testid="body-edit" value={value} onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== initial && onSave(value)}
      className="min-h-24 rounded-control border border-line bg-surface p-2 text-sm" />
  );
}

function DetailMenu({ onPin, onArchive, archived }: { onPin: () => void; onArchive: () => void; archived: boolean }) {
  return (
    <div className="flex gap-1">
      <Button variant="ghost" onClick={onPin}>Закрепить</Button>
      <Button variant="ghost" onClick={onArchive}>{archived ? 'Разархивировать' : 'Архивировать'}</Button>
    </div>
  );
}
```

И в `apps/web/src/app/router.tsx` — если верхушка стека `entity` → `<DetailScreen entityId={top.id} />`.

- [ ] **Step 8: Запустить** Run: `cd apps/web && bunx vitest run src/features/entity-detail/detail.test.tsx src/features/entity-detail/NativeRow.test.tsx` Expected: PASS.

- [ ] **Step 9: Commit**
```
git add apps/web/src/features/entity-detail apps/web/src/app/router.tsx
git commit -m "feat(web): entity detail (tabs, native rows, aspect cards, subtasks, optimistic edit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 15: Настройки + экспорт

**Files:**
- Create `apps/web/src/features/settings/SettingsScreen.tsx`, `GeneralForm.tsx`, `AspectsList.tsx`, `ViewsList.tsx`, `ExportButton.tsx`
- Test `apps/web/src/features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: `trpc` (Task 1); `Input`/`Button` (Task 5); `renderWithProviders` (Task 1).
- Produces: `SettingsScreen`, `GeneralForm`, `AspectsList`, `ViewsList`, `ExportButton`.

- [ ] **Step 1: Написать падающий тест** `apps/web/src/features/settings/settings.test.tsx`

```tsx
import { test, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/harness';
import { GeneralForm } from './GeneralForm';
import { ExportButton } from './ExportButton';

const settings = { ownerId: 'u', plan: 'dev', timezone: 'Europe/Moscow', defaultCurrency: 'RUB', weekStartDay: 'monday', tagColors: {}, installedViews: [], pinnedEntities: [], viewPreferences: {}, updatedAt: 'x' };

test('GeneralForm сабмитит частичный апдейт (только изменённый timezone)', async () => {
  const { calls } = renderWithProviders(<GeneralForm settings={settings as never} />, (path) => (path === 'user.updateSettings' ? settings : {}));
  fireEvent.change(screen.getByLabelText(/таймзона/i), { target: { value: 'UTC' } });
  fireEvent.submit(screen.getByTestId('general-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'user.updateSettings');
    expect(c?.input).toMatchObject({ timezone: 'UTC' });
  });
});

beforeEach(() => {
  // jsdom не имеет createObjectURL
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

test('ExportButton формирует Blob с format:orbis-export', async () => {
  let captured: Blob | null = null;
  (URL.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation((b: Blob) => { captured = b; return 'blob:x'; });
  renderWithProviders(<ExportButton />, (path) => (path === 'user.exportData' ? { format: 'orbis-export', version: 1, exportedAt: 'x', entities: [], relations: [], chatThreads: [], chatMessages: [], userSettings: settings, aspectDefinitions: [] } : {}));
  fireEvent.click(screen.getByRole('button', { name: /экспорт/i }));
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  const text = await captured!.text();
  expect(JSON.parse(text).format).toBe('orbis-export');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/features/settings/settings.test.tsx` Expected: FAIL «Cannot find module './GeneralForm'».

- [ ] **Step 3: Реализация**

`apps/web/src/features/settings/GeneralForm.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { trpc, type RouterOutputs } from '../../trpc';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';

type Settings = RouterOutputs['user']['getSettings'];

export function GeneralForm({ settings }: { settings: Settings }) {
  const utils = trpc.useUtils();
  const update = trpc.user.updateSettings.useMutation({ onSuccess: () => void utils.user.getSettings.invalidate() });
  const [timezone, setTimezone] = useState(settings.timezone);
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency);
  const [weekStartDay, setWeekStartDay] = useState(settings.weekStartDay);

  function submit(e: FormEvent) {
    e.preventDefault();
    // LWW, только изменённые поля (все optional в updateSettings).
    const patch: Record<string, unknown> = {};
    if (timezone !== settings.timezone) patch.timezone = timezone;
    if (defaultCurrency !== settings.defaultCurrency) patch.defaultCurrency = defaultCurrency;
    if (weekStartDay !== settings.weekStartDay) patch.weekStartDay = weekStartDay;
    update.mutate(patch);
  }

  return (
    <form data-testid="general-form" onSubmit={submit} className="flex flex-col gap-3 p-3">
      <label className="flex flex-col gap-1 text-sm">Таймзона
        <Input aria-label="Таймзона" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Валюта по умолчанию
        <Input aria-label="Валюта" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value)} maxLength={3} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Начало недели
        <select aria-label="Начало недели" value={weekStartDay} onChange={(e) => setWeekStartDay(e.target.value as typeof weekStartDay)}
          className="rounded-control border border-line bg-surface px-3 py-2">
          <option value="monday">Понедельник</option>
          <option value="sunday">Воскресенье</option>
        </select>
      </label>
      <Button type="submit" variant="primary">Сохранить</Button>
    </form>
  );
}
```

`apps/web/src/features/settings/ExportButton.tsx`:
```tsx
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

export function ExportButton() {
  const utils = trpc.useUtils();
  async function exportNow() {
    const data = await utils.user.exportData.fetch();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbis-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return <Button variant="primary" onClick={exportNow}>Экспорт данных</Button>;
}
```

`apps/web/src/features/settings/AspectsList.tsx`:
```tsx
import { trpc } from '../../trpc';
import { Card } from '../../ui/Card';

export function AspectsList() {
  const aspects = trpc.aspect.list.useQuery();
  return (
    <div className="flex flex-col gap-2 p-3">
      {(aspects.data ?? []).map((a) => (
        <Card key={a.id} className="flex items-center gap-2">
          {a.icon && <span aria-hidden>{a.icon}</span>}
          <span className="flex-1">{a.name}</span>
          <span className="text-xs text-text-muted">{a.id}</span>
        </Card>
      ))}
    </div>
  );
}
```

`apps/web/src/features/settings/ViewsList.tsx`:
```tsx
import { trpc } from '../../trpc';

export function ViewsList() {
  const settings = trpc.user.getSettings.useQuery();
  const views = settings.data?.installedViews ?? [];
  return (
    <ul className="flex flex-col gap-1 p-3 text-sm">
      {views.length === 0 && <li className="text-text-muted">Нет установленных views</li>}
      {views.map((v) => <li key={v}>{v}</li>)}
    </ul>
  );
}
```

`apps/web/src/features/settings/SettingsScreen.tsx`:
```tsx
import { trpc } from '../../trpc';
import { Tabs } from '../../ui/Tabs';
import { GeneralForm } from './GeneralForm';
import { AspectsList } from './AspectsList';
import { ViewsList } from './ViewsList';
import { ExportButton } from './ExportButton';

export function SettingsScreen() {
  const settings = trpc.user.getSettings.useQuery();
  if (!settings.data) return <div role="status" className="p-4 text-sm text-text-muted">Загрузка…</div>;
  return (
    <Tabs
      defaultValue="general"
      tabs={[
        { value: 'general', label: 'Общие', content: <GeneralForm settings={settings.data} /> },
        { value: 'aspects', label: 'Аспекты', content: <AspectsList /> },
        { value: 'views', label: 'Views', content: <ViewsList /> },
        { value: 'export', label: 'Экспорт', content: <div className="p-3"><ExportButton /></div> },
      ]}
    />
  );
}
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/features/settings/settings.test.tsx` Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```
git add apps/web/src/features/settings
git commit -m "feat(web): settings screen (general form, aspects, views, JSON export)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 16: PWA — манифест + app-shell + офлайн-fallback + APP_VERSION↔autoUpdate

**Files:**
- Create `apps/web/src/pwa/manifest.ts`
- Create `apps/web/public/icon.svg` (из существующего `public/favicon.svg`)
- Modify `apps/web/vite.config.ts` (использовать `pwaManifest`, workbox `navigateFallback`)
- Test `apps/web/src/pwa/manifest.test.ts`

**Interfaces:**
- Consumes: `APP_VERSION` (Task 1) для версии/описания.
- Produces: `pwaManifest` (импортируется в `vite.config.ts`).

> Manifest вынесен в модуль ради юнит-тестируемости полей (theme_color `#0c0d12` из токенов, start_url/scope, иконки). Иконка — SVG (`purpose:'any maskable'`), чтобы не генерировать бинарные PNG. Сборка SW и офлайн-оболочка проверяются в Verification (`vite build`).

- [ ] **Step 1: Написать падающий тест** `apps/web/src/pwa/manifest.test.ts`

```ts
import { test, expect } from 'vitest';
import { pwaManifest } from './manifest';

test('манифест несёт имя, standalone, theme_color токена и scope', () => {
  expect(pwaManifest.name).toBe('Orbis');
  expect(pwaManifest.display).toBe('standalone');
  expect(pwaManifest.theme_color).toBe('#0c0d12');
  expect(pwaManifest.background_color).toBe('#0c0d12');
  expect(pwaManifest.start_url).toBe('/');
  expect(pwaManifest.scope).toBe('/');
});

test('есть иконка с purpose maskable', () => {
  expect(pwaManifest.icons.length).toBeGreaterThan(0);
  expect(pwaManifest.icons.some((i) => i.purpose?.includes('maskable'))).toBe(true);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает** Run: `cd apps/web && bunx vitest run src/pwa/manifest.test.ts` Expected: FAIL «Cannot find module './manifest'».

- [ ] **Step 3: Реализация**

`apps/web/src/pwa/manifest.ts`:
```ts
// theme/background — токен bg «ночной обсерватории» (#0c0d12, §4.9).
export const pwaManifest = {
  name: 'Orbis',
  short_name: 'Orbis',
  description: 'Личная операционная система',
  display: 'standalone' as const,
  start_url: '/',
  scope: '/',
  theme_color: '#0c0d12',
  background_color: '#0c0d12',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
  ],
};
```

`apps/web/public/icon.svg` — скопировать содержимое `apps/web/public/favicon.svg` (иконка приложения; при желании увеличить viewBox/паддинг под maskable safe-zone):
```
cp apps/web/public/favicon.svg apps/web/public/icon.svg
```

`apps/web/vite.config.ts` — подключить `pwaManifest` и офлайн-fallback. Заменить блок `VitePWA({...})`:
```ts
import { pwaManifest } from './src/pwa/manifest';
// ...
    VitePWA({
      registerType: 'autoUpdate',
      manifest: pwaManifest,
      workbox: {
        navigateFallback: '/index.html', // app-shell для офлайна
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
    }),
```

- [ ] **Step 4: Запустить** Run: `cd apps/web && bunx vitest run src/pwa/manifest.test.ts` Expected: PASS (2 tests).

- [ ] **Step 5: Проверка сборки (SW генерируется)** Run: `cd apps/web && bunx vite build` Expected: сборка успешна; в `dist/` присутствуют `sw.js` и `manifest.webmanifest`.

- [ ] **Step 6: Commit**
```
git add apps/web/src/pwa apps/web/public/icon.svg apps/web/vite.config.ts
git commit -m "feat(web): PWA manifest (icons/theme #0c0d12/scope) + offline app-shell fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification

По завершении всех 16 задач прогнать на корне репозитория:

- [ ] **Lint:** `bun run lint` → 0 ошибок.
- [ ] **Typecheck:** `bun run typecheck` (или `cd apps/web && bun run typecheck` + `cd packages/shared && bunx tsc --noEmit`) → 0 ошибок.
- [ ] **Тесты web (Vitest):** `cd apps/web && bun run test` → все зелёные.
- [ ] **Тесты shared (bun:test):** `cd packages/shared && bun test` → все зелёные (включая `fast-path/fast-path.test.ts`).
- [ ] **Сборка:** `cd apps/web && bunx vite build` → успешно; `dist/sw.js` и `dist/manifest.webmanifest` присутствуют.
- [ ] **Ручной прогон против локального бэкенда** (`apps/server` на :3001, прокси `/trpc`): login → онбординг (seed) → fast-path «обед 340» в чате даёт мгновенную «⚡ без AI» карточку → Browser показывает список и pinned-бейджи → тап по строке открывает detail → чекбокс task → настройки: смена timezone → «Экспорт данных» скачивает JSON `orbis-export`.

**Перенос триажа (§5 карты):** каждый клиентский пункт закрыт задачей —
`cap limit ≤ 200` и `before`-курсор (Task 9); `include=thread` без пагинации (Task 14); CLIENT_OUTDATED = код `PRECONDITION_FAILED` (Task 2); «batch: операций — 1» сглаживание (Task 10); `replayed:true` → рефетч (Task 9). Серверные/прод-пункты (llm-smoke, стриминг экспорта, составной курсор thread, retry/idempotency-проход, `defaultAiDeps` throw, body-limit `/mcp`, двойной CI, приёмка §8) — переносятся в план **1c-2**.

## После 1c-1

План **1c-2 «Прод + приёмка слайса 1»**: re-point `render.yaml` на `main`, деплой API + статики web, секреты `ORBIS_PAT_*` / `ANTHROPIC_API_KEY` на Render, бэкап-runbook, гейт `llm-smoke` реальным ключом, приёмка §8 из `00-product`. Владельческие инфра-гейты (Render-аккаунт/секреты) — вне UI-кода.
