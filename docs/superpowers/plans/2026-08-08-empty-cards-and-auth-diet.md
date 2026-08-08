# Пустые карточки поиска и диета auth — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНАЯ СУБ-СКИЛЛ: `superpowers:subagent-driven-development`.
> Шаги размечены чекбоксами (`- [ ]`).

**Цель:** карточка `query_result` перестаёт быть немой при нулевом результате и начинает
показывать своё единственное число; `apps/web` уходит с `@supabase/supabase-js` на
`@supabase/auth-js` без разлогина живых сессий.

**Архитектура:** две независимые правки целиком в `apps/web`, общего кода нет — Задачи 1
и 2–3 исполняются параллельно. Спека: `docs/superpowers/specs/2026-08-08-empty-cards-and-auth-diet-design.md`
(решения Р1–Р10 с причинами и отклонёнными вариантами).

**Стек:** React 19, Vitest + Testing Library, Tailwind v4 (токены в `styles/tokens.css`),
bun-воркспейсы.

## Глобальные ограничения

- Прогон тестов ТОЛЬКО через `bun run test` (голый `bun test` из корня зависает). Код
  возврата lint снимать отдельным вызовом.
- Сервер и web мокают друг друга; живой Supabase поднят (`http://127.0.0.1:54321`), но
  **не запускать серверный сьют одновременно с живым смоуком** — сьют делает `truncateAll`.
- Тексты интерфейса — по-русски, в регистре существующих строк.
- Смена пакета обязана прийти вместе с `package.json` и `bun.lock` в ОДНОМ коммите:
  Dockerfile и CI ставят зависимости `--frozen-lockfile`.
- Факты в этом плане проверены разведкой по коду на `2067e64`, но **могут быть неверны** —
  проверяй и опровергай прямым пробоем, опровержение ценнее исполнения.

---

### Task 1: Пустое состояние и счётчик в `QueryResultCard`

> **Исполнено с поправкой (коммиты `690aa7e`, `7e8496f`).** Пункт 3 ниже — «кнопка только
> при непустом `entityIds`» — ревью задачи признало мёртвой веткой: производитель агрегата
> ставит `entityIds: []` всегда, значит под условием кнопка не появится никогда. Решением
> Р11 механизм разворота снят целиком (состояние, кнопка, нижний `<ul>`), а старый тест
> переписан на утверждение об отсутствии кнопки. Код ниже приведён в исходном виде — фактом
> является спека (Р11) и git.

**Files:**
- Modify: `apps/web/src/features/chat/cards/QueryResultCard.tsx` (весь компонент, 10-55)
- Test: `apps/web/src/features/chat/cards/cards.test.tsx` (рядом с двумя существующими
  тестами карточки, строки 72-102)

**Interfaces:**
- Consumes: `QueryResultData` из `./types` — `{ kind, title?, count, entityIds, aggregate? }`,
  менять тип НЕ надо; `aggregateLabel` из `../../../lib/field-labels`; `Card`, `Button`,
  `EntityRef` — как сейчас.
- Produces: новые `data-testid`: `qr-empty` (строка «Ничего не найдено»), `qr-count`
  (счётчик в обеих ветках). Существующие `qr-aggregate`, `qr-item`, `qr-list`,
  `query-result-card` сохраняются.

Три изменения поведения (спека Р2–Р4):
1. `entityIds` пуст и агрегата нет → вместо пустого `<ul>` строка «Ничего не найдено»;
2. счётчик `card.count`: «Совпадений: N» над списком, «Записей: N» под числом агрегата,
   и НЕ печатается у `op === 'count'` (там значение агрегата и есть это число);
3. кнопка «Показать список» — только когда `entityIds` непуст (у агрегата сервер всегда
   шлёт пустой список, `dispatch.ts:426`).

- [ ] **Шаг 1: Написать падающие тесты**

В `cards.test.tsx` после теста «query_result без aggregate → native-список» добавить:

```tsx
test('query_result без результатов → «Ничего не найдено», пустого списка нет', () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 0, entityIds: [] }]))}</div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-empty')).toHaveTextContent('Ничего не найдено');
  expect(screen.queryByTestId('qr-list')).not.toBeInTheDocument();
  expect(screen.queryByTestId('qr-count')).not.toBeInTheDocument();
});

test('query_result со списком → счётчик «Совпадений: N»', () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 2, entityIds: ['a', 'b'] }]))}</div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-count')).toHaveTextContent('Совпадений: 2');
});

test('агрегат sum → «Записей: N»; пустой entityIds → без кнопки «Показать список»', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'query_result',
            count: 37,
            entityIds: [],
            aggregate: { op: 'sum', value: '12400.00' },
          },
        ]),
      )}
    </div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('12400.00');
  expect(screen.getByTestId('qr-count')).toHaveTextContent('Записей: 37');
  expect(screen.queryByRole('button', { name: /показать список/i })).not.toBeInTheDocument();
  // Агрегат — не «пусто»: число есть, значит пустого состояния быть не должно.
  expect(screen.queryByTestId('qr-empty')).not.toBeInTheDocument();
});

test('агрегат count → счётчик не дублирует само число', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'query_result',
            count: 5,
            entityIds: [],
            aggregate: { op: 'count', value: '5' },
          },
        ]),
      )}
    </div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('5');
  expect(screen.queryByTestId('qr-count')).not.toBeInTheDocument();
});
```

- [ ] **Шаг 2: Прогнать тесты, убедиться что падают**

Запуск: `bun run --filter @orbis/web test -- cards.test.tsx`
Ожидание: FAIL — `qr-empty` и `qr-count` не находятся; тест агрегата падает на кнопке,
которая сегодня рисуется всегда.

- [ ] **Шаг 3: Переписать компонент**

`apps/web/src/features/chat/cards/QueryResultCard.tsx` целиком:

```tsx
import { useState } from 'react';
import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { aggregateLabel } from '../../../lib/field-labels';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { QueryResultData } from './types';

// D-d: без aggregate — native-список из entityIds; с aggregate — число + разворачиваемый список.
// Строки — EntityRef (title вместо сырого UUID, этап 4).
export function QueryResultCard({ card }: { card: QueryResultData }) {
  const [open, setOpen] = useState(false);
  // Сервер шлёт entityIds:[] в двух РАЗНЫХ случаях: поиск ничего не нашёл (тогда карточка
  // обязана сказать это словами) и агрегат (id он не выбирает по замыслу — dispatch.ts:426,
  // и разворачивать там нечего, поэтому кнопки быть не должно).
  const hasList = card.entityIds.length > 0;
  return (
    <Card data-testid="query-result-card" className="flex flex-col gap-2">
      {card.title && <p className="text-sm font-medium">{card.title}</p>}
      {card.aggregate ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-text-muted">
            {aggregateLabel(card.aggregate.op)}
          </span>
          <span
            data-testid="qr-aggregate"
            className="text-2xl font-semibold tabular-nums tracking-tight"
          >
            {card.aggregate.value}
          </span>
          {/* count у агрегата — это count(*) по ВСЕЙ выборке (compile.ts:71-91), то есть
              число, которого на экране больше нет нигде. У op='count' оно совпадает со
              значением агрегата — дубль не печатаем. */}
          {card.aggregate.op !== 'count' && (
            <span data-testid="qr-count" className="text-xs text-text-secondary">
              Записей: {card.count}
            </span>
          )}
          {hasList && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setOpen((v) => !v)}
            >
              Показать список
            </Button>
          )}
        </div>
      ) : hasList ? (
        <>
          {/* Формулировка и регистр — как у счётчика виджета запроса (QueryBlock.tsx:88-90),
              чтобы список в чате и список на экране читались одинаково. */}
          <span data-testid="qr-count" className="text-xs text-text-secondary">
            Совпадений: {card.count}
          </span>
          <ul className="flex flex-col gap-1" data-testid="qr-list">
            {card.entityIds.map((id) => (
              <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">
                <EntityRef id={id} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        // Тихий регистр пустоты репозитория («Нет транзакций», «день свободен»), а не
        // EmptyState: py-10 с иконкой 32px внутри карточки ленты выше самой карточки.
        <p data-testid="qr-empty" className="text-sm text-text-muted">
          Ничего не найдено
        </p>
      )}
      {card.aggregate && open && (
        <ul className="flex flex-col gap-1">
          {card.entityIds.map((id) => (
            <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">
              <EntityRef id={id} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Шаг 4: Прогнать тесты**

Запуск: `bun run --filter @orbis/web test -- cards.test.tsx`
Ожидание: PASS, включая два СТАРЫХ теста карточки (у теста с агрегатом `entityIds`
непустой, поэтому кнопка там остаётся).

- [ ] **Шаг 5: Прогнать весь сьют web и линт**

Запуск: `bun run --filter @orbis/web test`, затем `bun run lint` (код возврата снимать
отдельным вызовом) и `bun run --filter @orbis/web typecheck`.
Ожидание: зелено. При случайном падении навигационного теста — перепрогнать файл
изолированно, это известный флак параллельного прогона.

- [ ] **Шаг 6: Коммит**

```bash
git add apps/web/src/features/chat/cards/QueryResultCard.tsx apps/web/src/features/chat/cards/cards.test.tsx
git commit -m "fix(web): пустой поиск говорит словами, count перестал быть немым"
```

---

### Task 2: Формулы `authUrl` и `storageKeyFor` (чистый модуль + тест)

**Files:**
- Create: `apps/web/src/auth/config.ts`
- Test: `apps/web/src/auth/config.test.ts`

**Interfaces:**
- Produces: `authUrl(base: string): string` и `storageKeyFor(base: string): string` —
  Task 3 импортирует обе из `./config`.

Почему отдельным модулем: `auth/supabase.ts` создаёт клиент на импорте (побочный эффект,
таймеры, BroadcastChannel), а формулы надо проверять чистым тестом.

- [ ] **Шаг 1: Написать падающий тест**

`apps/web/src/auth/config.test.ts`:

```ts
import { expect, test } from 'vitest';
import { authUrl, storageKeyFor } from './config';

// Ключ хранилища ОБЯЗАН совпасть с тем, что supabase-js уже записал в localStorage живым
// пользователям (SupabaseClient.ts:319: `sb-${hostname.split('.')[0]}-auth-token`), иначе
// релиз читает пустой ключ и разлогинивает всех.
test('storageKeyFor воспроизводит формулу supabase-js', () => {
  expect(storageKeyFor('https://ceovqtdibalxnqkgedrl.supabase.co')).toBe(
    'sb-ceovqtdibalxnqkgedrl-auth-token',
  );
  expect(storageKeyFor('http://localhost:54321')).toBe('sb-localhost-auth-token');
  // 127.0.0.1 даёт 'sb-127-auth-token' — выглядит странно, но это ровно то, что писал
  // supabase-js на локальном стенде, и совпасть мы обязаны именно с ним.
  expect(storageKeyFor('http://127.0.0.1:54321')).toBe('sb-127-auth-token');
});

test('storageKeyFor не зависит от хвостового слэша', () => {
  expect(storageKeyFor('https://ceovqtdibalxnqkgedrl.supabase.co/')).toBe(
    'sb-ceovqtdibalxnqkgedrl-auth-token',
  );
});

test('authUrl склеивает без двойного слэша', () => {
  expect(authUrl('https://ceovqtdibalxnqkgedrl.supabase.co')).toBe(
    'https://ceovqtdibalxnqkgedrl.supabase.co/auth/v1',
  );
  expect(authUrl('https://ceovqtdibalxnqkgedrl.supabase.co/')).toBe(
    'https://ceovqtdibalxnqkgedrl.supabase.co/auth/v1',
  );
  expect(authUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/auth/v1');
});
```

- [ ] **Шаг 2: Прогнать, убедиться что падает**

Запуск: `bun run --filter @orbis/web test -- config.test.ts`
Ожидание: FAIL — модуля `./config` нет.

- [ ] **Шаг 3: Написать модуль**

`apps/web/src/auth/config.ts`:

```ts
// Три вещи supabase-js выводил из VITE_SUPABASE_URL сам; голый @supabase/auth-js не выводит
// ничего, а все его опции необязательны — забытая подставится МОЛЧА (url → localhost:9999,
// storageKey → 'supabase.auth.token'). Здесь воспроизведены две формулы супабейсовского
// клиента (SupabaseClient.ts:319 и :324) — третья, заголовки, задаётся в supabase.ts.

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** `https://ref.supabase.co` → `https://ref.supabase.co/auth/v1`, без двойного слэша. */
export function authUrl(base: string): string {
  return new URL('auth/v1', ensureTrailingSlash(base)).href;
}

/** Ключ localStorage живой сессии: `https://ref.supabase.co` → `sb-ref-auth-token`. */
export function storageKeyFor(base: string): string {
  return `sb-${new URL(base).hostname.split('.')[0]}-auth-token`;
}
```

- [ ] **Шаг 4: Прогнать тест**

Запуск: `bun run --filter @orbis/web test -- config.test.ts`
Ожидание: PASS (4 теста).

- [ ] **Шаг 5: Коммит**

```bash
git add apps/web/src/auth/config.ts apps/web/src/auth/config.test.ts
git commit -m "feat(web): формулы authUrl и storageKey супабейсового клиента, пиннятся тестом"
```

---

### Task 3: Перевод клиента на `@supabase/auth-js`

**Files:**
- Modify: `apps/web/src/auth/supabase.ts` (весь файл)
- Modify: `apps/web/src/auth/LoginScreen.tsx:6,20`
- Modify: `apps/web/src/auth/AuthProvider.tsx:5,34`
- Modify: `apps/web/src/auth/AuthProvider.test.tsx:4-7`
- Modify: `apps/web/package.json:14`
- Modify: `bun.lock` (через `bun install`, руками не править)

**Interfaces:**
- Consumes: `authUrl`, `storageKeyFor` из `./config` (Task 2).
- Produces: модуль `auth/supabase.ts` экспортирует `auth` (клиент `AuthClient`),
  `useSession()`, тип `SessionState` — вместо прежнего `supabase`. Потребители зовут
  `auth.signInWithPassword(...)` и `auth.signOut()` без `.auth` посередине.

- [ ] **Шаг 1: Поменять зависимость**

В `apps/web/package.json` убрать строку `"@supabase/supabase-js": "^2.110.0",` и добавить
в том же алфавитном месте `"@supabase/auth-js": "^2.110.0",`. Затем из корня репозитория:

```bash
bun install
```

Проверить, что `bun.lock` изменился и `node_modules/@supabase/auth-js` на месте:

```bash
git diff --stat bun.lock && cat node_modules/@supabase/auth-js/package.json | head -5
```

Ожидание: `auth-js` объявлен прямо (сейчас он лежит только транзитивно, а supabase-js
пиннит его точной версией — снять supabase-js, не объявив auth-js, значит развалить сборку).

- [ ] **Шаг 2: Переписать `auth/supabase.ts`**

```ts
import { AuthClient, type Session } from '@supabase/auth-js';
import { useEffect, useState } from 'react';
import { authUrl, storageKeyFor } from './config';

const url = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'anon';

// Диета бандла: из supabase-js (51.6 кБ gzip) использовались только четыре вызова .auth,
// остальное — postgrest/realtime/storage/functions, к которым web не обращается вовсе
// (все данные идут через tRPC). Взамен — голый auth-клиент.
//
// ВАЖНО: три вещи supabase-js подставлял сам, и все три опции здесь необязательные —
// забытая уходит в молчаливый дефолт, без ошибки типов и рантайма:
//   url        → 'http://localhost:9999' (клиент ходит не туда);
//   storageKey → 'supabase.auth.token'   (чужой ключ: живые сессии не читаются, разлогин);
//   headers    → без apikey              (шлюз Supabase отвергает запрос).
export const auth = new AuthClient({
  url: authUrl(url),
  storageKey: storageKeyFor(url),
  headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  persistSession: true,
  autoRefreshToken: true,
  // На нём держится вход по magic link в приёмочном смоуке — ссылка приносит сессию
  // hash-фрагментом. Дефолт auth-js такой же, но опция, от которой зависит приёмка,
  // должна быть видна в коде, а не унаследована.
  detectSessionInUrl: true,
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
  const [state, setState] = useState<SessionState>({
    token: null,
    userId: null,
    status: 'loading',
  });
  useEffect(() => {
    let active = true;
    auth.getSession().then(({ data }) => {
      if (active) setState(fromSession(data.session));
    });
    const { data: sub } = auth.onAuthStateChange((_e, session) => setState(fromSession(session)));
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}
```

- [ ] **Шаг 3: Поправить двух потребителей и мок**

`apps/web/src/auth/LoginScreen.tsx`: импорт `import { supabase } from './supabase';` →
`import { auth } from './supabase';`; строка 20 `await supabase.auth.signInWithPassword(...)`
→ `await auth.signInWithPassword({ email, password })`.

`apps/web/src/auth/AuthProvider.tsx`: импорт `import { supabase, useSession } from './supabase';`
→ `import { auth, useSession } from './supabase';`; строка 34 `void supabase.auth.signOut();`
→ `void auth.signOut();`.

`apps/web/src/auth/AuthProvider.test.tsx:4-7`:

```tsx
vi.mock('./supabase', () => ({
  auth: { signOut: vi.fn(), signInWithPassword: vi.fn() },
  useSession: vi.fn(),
}));
```

- [ ] **Шаг 4: Проверить, что пакета больше нет нигде**

```bash
rg -n "@supabase/supabase-js" apps packages --glob '!node_modules'
```

Ожидание: ни одного попадания в `apps/` и `packages/` (в `spikes/` — отдельный корень,
не входит в воркспейсы, его не трогаем).

- [ ] **Шаг 5: Прогнать сьют, типы, линт**

Запуск: `bun run --filter @orbis/web test`, затем `bun run --filter @orbis/web typecheck`
и `bun run lint`.
Ожидание: зелено. Тестов, зависящих от имени пакета, нет — единственный мок завязан на
относительный путь `./supabase`.

- [ ] **Шаг 6: Проверить, что прод-сборка собирается**

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build
```

Ожидание: сборка проходит (`tsc --noEmit` внутри), в `apps/web/dist/assets` один js-чанк.

- [ ] **Шаг 7: Коммит**

```bash
git add apps/web/package.json bun.lock apps/web/src/auth/supabase.ts apps/web/src/auth/LoginScreen.tsx apps/web/src/auth/AuthProvider.tsx apps/web/src/auth/AuthProvider.test.tsx
git commit -m "perf(web): auth без supabase-js — голый auth-js с явными url, storageKey и заголовками"
```

---

### Task 4: Замер бандла до и после

**Files:** ничего не меняется в исходниках; результат идёт в
`docs/superpowers/reviews/2026-08-04-bundle-diet.md` (раздел с исторической базой).

- [ ] **Шаг 1: Снять размер ДО**

```bash
git stash list >/dev/null; git worktree list >/dev/null  # ориентировка
git checkout main -- . 2>/dev/null || true
```

Проще и без риска для рабочего дерева — собрать из чистой копии `main` во временном
каталоге:

```bash
TMP=$(mktemp -d) && git worktree add "$TMP/base" main >/dev/null 2>&1 && cd "$TMP/base" && bun install >/dev/null 2>&1 && VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build >/dev/null 2>&1 && for f in apps/web/dist/assets/*.js; do printf "%-34s %7s\n" "$(basename $f)" "$(gzip -c $f | wc -c)"; done
```

- [ ] **Шаг 2: Снять размер ПОСЛЕ**

Из рабочего дерева ветки:

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build && for f in apps/web/dist/assets/*.js; do printf "%-34s %7s\n" "$(basename $f)" "$(gzip -c $f | wc -c)"; done
```

- [ ] **Шаг 3: Убрать временный worktree**

```bash
git worktree remove "$TMP/base" --force && git worktree prune
```

- [ ] **Шаг 4: Записать факт**

Дописать в `docs/superpowers/reviews/2026-08-04-bundle-diet.md` строку исторической базы:
`292.1 кБ (query-builder, фаза D) → <новое значение> кБ (auth-js, 2026-08-08)` и
зафиксировать реальную экономию. Ожидание из спеки — около 31 кБ; **если цифра заметно
меньше, это факт, а не повод его сгладить** (у `auth-js` нет `sideEffects: false`, rollup
может вытрясти хуже esbuild'а).

- [ ] **Шаг 5: Коммит**

```bash
git add docs/superpowers/reviews/2026-08-04-bundle-diet.md
git commit -m "docs(bundle): замер после перехода на auth-js"
```

---

### Task 5: Бэклог находок разведки

**Files:**
- Create: `docs/superpowers/reviews/2026-08-08-cards-auth-backlog.md`

- [ ] **Шаг 1: Записать четыре пункта с доказательствами**

1. **Корень серии пустых карточек** (Р6): `packages/shared/src/aspect-registry.ts:48`
   обещает резолв категории по `aliases` через `entity_query`, которого грамматика не умеет
   (`apps/server/src/query/compile.ts:218-221`, `packages/shared/src/query/catalog.ts:87`);
   сидированные категории держат синонимы только в `aliases`
   (`apps/server/src/seed/categories.ts:26-33`). Инструкция доезжает до модели дважды
   (`apps/server/src/tools/registry.ts:428-432`, `apps/server/src/llm/context.ts:259-264`).
   Два варианта починки: текст инструкции (велеть тянуть все категории одним
   `aspect=orbis/category, limit=50`) против настоящего резолва по алиасам в грамматике
   (общий код у web и импорта уже есть — `packages/shared/src/fast-path`). Требует пересева
   реестра на проде.
2. **`count` карточки при упоре в лимит занижен**: у `entity_query` это размер уже усечённой
   SQL-выдачи (`apps/server/src/query/compile.ts:55-68`), полного числа сервер не считает.
   После Task 1 число стало видимым — значит стало и видимым враньём при 500 строках.
3. **N+1 у длинной карточки**: каждая строка `EntityRef` делает свой `entity.get`
   (`apps/web/src/lib/entity-ref/EntityRef.tsx:11-19`), поэтому карточка на N результатов
   стоит N запросов; при цели это ещё +4 запроса на цель (D23).
4. **Нет серверного теста на нулевую карточку**: единственный тест с пустой выдачей
   (`apps/server/src/tools/dispatch.test.ts:435-440`) проверяет длину результата и карточку
   не смотрит; при этом два теста `send-message` зелены именно потому, что карточка при нуле
   выпускается (`:251-279`, `:292-313`) — это стоит закрепить явным тестом формы.

- [ ] **Шаг 2: Коммит**

```bash
git add docs/superpowers/reviews/2026-08-08-cards-auth-backlog.md
git commit -m "docs(backlog): находки разведки — корень серии поисков, лимит count, N+1 EntityRef"
```

---

### Task 6: Живой смоук (исполняет контроллер, не сабагент)

Стенд поднят: Supabase на `http://127.0.0.1:54321`. Сервер запускать **из `apps/server`**:

```bash
cd apps/server && PORT=3010 WEB_DIST_DIR=../web/dist SUPABASE_URL=http://127.0.0.1:54321 bun run src/index.ts
```

Перед проверкой снять service worker в консоли браузера, иначе смоук проверит прошлое:

```js
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
```

- [ ] **Сценарий 1 (карточка):** запрос к модели, заведомо ничего не находящий → в ленте
  строка «Ничего не найдено», не голая рамка; при непустом поиске виден счётчик.
- [ ] **Сценарий 2 (главный риск auth):** войти на СТАРОМ бандле (сборка с `main`), затем
  подменить `dist` на новый и обновить страницу — пользователь остался внутри. Это прямая
  проверка совпадения `storageKey`; ключ в `localStorage` посмотреть глазами.
- [ ] **Сценарий 3:** F5 с живой сессией — сессия жива.
- [ ] **Сценарий 4:** вход по magic link (админский API Supabase,
  `/auth/v1/admin/generate_link`) — проверка `detectSessionInUrl`.
- [ ] **Сценарий 5:** выход (`signOut`) — экран логина, токен из хранилища исчез.
- [ ] **Сценарий 6:** две вкладки — выход в одной виден во второй (BroadcastChannel).

---

## Самопроверка плана

- **Покрытие спеки:** Р1–Р4 → Task 1; Р7–Р9 → Tasks 2–3; Р10 → Task 4; Р5–Р6 → Task 5
  (записаны как отложенные с причиной); приёмка обеих частей → Task 6.
- **Плейсхолдеров нет:** весь код приведён целиком, включая полный текст компонента и
  модуля; тесты — с готовыми ожиданиями.
- **Согласованность имён:** `authUrl`/`storageKeyFor` объявлены в Task 2 и импортируются
  под теми же именами в Task 3; `auth` — единственное новое имя экспорта, используется
  в Task 3 во всех трёх файлах-потребителях; `qr-empty`/`qr-count` заведены в Task 1
  и больше нигде не переопределяются.
