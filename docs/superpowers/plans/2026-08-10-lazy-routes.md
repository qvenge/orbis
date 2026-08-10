# Ленивая загрузка экранов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вынести `features/entity-detail/*` и экраны Budget с `ImportFlow` из главного чанка через `React.lazy`, не заплатив за это ни мерцанием экранов, ни новым классом отказа при деплое.

**Architecture:** границы лени ставятся в `app/router.tsx` (точки монтирования), а не в самих модулях — так ни один прямой рендер в тестах не ломается. Вокруг них — одна `Suspense`-граница со скелетоном-заглушкой и одна `ErrorBoundary` на провал загрузки чанка. Сервер перестаёт отдавать `index.html` на промах `/assets/*`. Частые экраны догружаются в фоне на `requestIdleCallback`.

**Tech Stack:** React 19, vite 8.1.3 (rolldown), vite-plugin-pwa (`generateSW`), Vitest 4 + Testing Library, Hono (`serveStatic`), bun.

**Спека:** `docs/superpowers/specs/2026-08-10-lazy-routes-design.md` (решения Р1–Р7).

## Global Constraints

- **Ленивыми становятся точки монтирования в `app/router.tsx`, а не модули.** Модули
  продолжают экспортировать свои компоненты; ни одна сигнатура экспорта не меняется
  (десятки тестов рендерят эти компоненты напрямую через `renderWithProviders`).
- **У ленивого модуля не должно остаться ни одного статического импортёра.** Статический
  импорт рядом с динамическим схлопывает чанк обратно во входной молча — проверяется фактом
  сборки (отдельный файл чанка существует), а не чтением.
- **Текст «Загрузка…» в заглушках запрещён.** `apps/web/src/features/browser/browser.test.tsx:97-100`
  проверяет его отсутствие; загрузка показывается `ui/Skeleton` (он уже несёт
  `role="status" aria-label="Загрузка"`).
- **Размеры бандла мерить только `gzip -c f | wc -c`.** Число `gzip:` из вывода vite врёт
  примерно на 1.2% и в исторический ряд `docs/superpowers/reviews/2026-08-04-bundle-diet.md:188`
  не годится. База для сравнения: **263 909 Б** (`main@1a3ff84`), CSS 7 549 Б.
- **Команда сборки:** `VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build` из корня репозитория.
- **Тесты:** голый `bun test` из корня зависает — только `bun run test`. Web отдельно:
  `cd apps/web && bun run test`.
- Язык интерфейса — русский, строки зашиты в JSX (i18n-словаря нет). Тон: короткие фразы,
  многоточие одним символом «…», без точки в конце коротких строк.
- Коммитить только свои пути: `git commit -- <пути>`.

---

### Task 1: Стабилизировать ожидания в web-сьюте

**Files:**
- Modify: `apps/web/tests/setup.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: зелёная база сьюта, от которой следующие задачи меряют регресс.

**Зачем.** Сьют web красный и плавающий: три независимых прогона на одном и том же коммите
`1a3ff84` дали 3 падения, 2 падения и 0 падений — каждый раз по таймауту ожидания и каждый
раз в разных файлах (`deep-link.test.tsx`, `history.test.tsx`, `query-builder.test.tsx`).
Задачи 3 и 4 добавляют каждому входу через `<App/>` лишний асинхронный такт; без зелёной базы
их ревью не сможет отличить регресс от шума.

**Гипотеза, которую надо проверить, а не принять на веру:** `configure()` в проекте не
вызывается ни разу, значит `waitFor`/`findBy` работают на дефолтном таймауте Testing Library —
**1 секунда** — при 57 файлах в параллель.

- [ ] **Шаг 1: Зафиксировать «до»**

Прогнать сьют web три раза подряд и записать в отчёт результат каждого прогона (число
упавших файлов, имена упавших тестов, длительность):

```bash
cd apps/web && for i in 1 2 3; do echo "=== $i ==="; bun run test 2>&1 | grep -E "(Test Files|Tests  |FAIL)"; done
```

- [ ] **Шаг 2: Убедиться, что падения — именно таймаут ожидания**

Открыть каждый упавший тест и проверить: падение приходит из `waitFor`/`findBy` по
истечении времени, а не из ассерта на неверное значение. Если хотя бы одно падение —
настоящий дефект логики, это находка: почини её и напиши об этом в отчёте. Таймаут поднимать
ради маскировки настоящего падения нельзя.

- [ ] **Шаг 3: Поднять порог ожидания**

`apps/web/tests/setup.ts` целиком:

```ts
// `/vitest` entry augments Vitest's `expect` with jest-dom matchers (types + runtime);
// the bare '@testing-library/jest-dom' import only augments Jest, not Vitest 4.
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// waitFor/findBy по умолчанию ждут 1 с. Сьют гоняет 57 файлов в параллель в jsdom, и на
// загруженной машине этого не хватало: три прогона на одном коммите дали 3, 2 и 0 падений
// — каждый раз по таймауту и каждый раз в РАЗНЫХ файлах. Порог поднят до 5 с: тест, который
// не дождётся никогда, всё равно упадёт, просто позже, а ложные падения от планировщика
// исчезают. Это не запас «на всякий случай»: без зелёной базы регресс неотличим от шума.
configure({ asyncUtilTimeout: 5000 });
```

- [ ] **Шаг 4: Зафиксировать «после»**

Тот же цикл из трёх прогонов. Ожидание: 57/57 файлов, 658/658 тестов, три раза подряд.

**Если флак остался** — порог не причина. Не поднимай его ещё раз: сообщи в отчёте, какие
тесты падают, что показывает их код, и назови следующую гипотезу (кандидаты: `fileParallelism`,
таймеры в `deep-link.test.tsx`, `StrictMode` двойной прогон эффектов). Это статус
DONE_WITH_CONCERNS, а не провал задачи.

- [ ] **Шаг 5: Коммит**

```bash
git commit -- apps/web/tests/setup.ts -m "test(web): порог ожидания 5 с — сьют перестаёт плавать под нагрузкой"
```

---

### Task 2: Промах в `/assets/*` отвечает 404, а не страницей

**Files:**
- Modify: `apps/server/src/app.ts` (перед SPA-fallback, строки 107-114)
- Test: `apps/server/src/static.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: гарантия, что провал загрузки чанка выглядит как «файла нет», а не как «сервер
  прислал HTML вместо модуля». На это опирается Task 3 (обработчик `vite:preloadError`).

**Зачем.** Сегодня второй `serveStatic` отдаёт `index.html` со статусом 200 и `text/html`
на ЛЮБОЙ непойманный GET, включая `/assets/index-СТАРЫЙХЕШ.js`. Пока чанк один, этот путь
недостижим на практике; с ленивыми чанками он становится штатным: каждый деплой — новый
контейнер с чистым `dist` (`render.yaml:7-13`, `Dockerfile:38`), старые файлы исчезают, а SW
стоит с `registerType: 'autoUpdate'` (`skipWaiting` + `clientsClaim` + `cleanupOutdatedCaches`)
— то есть новый SW активируется в уже открытой вкладке и вычищает её старый precache.

- [ ] **Шаг 1: Написать падающий тест**

В `apps/server/src/static.test.ts`, рядом с тестом SPA-fallback (после строки 88):

```ts
  // Промах в /assets/* — НЕ клиентский роут: файл с хешем в имени либо есть, либо исчез
  // вместе со старым деплоем. SPA-fallback отдавал на него index.html с 200 и text/html,
  // и браузер ругался на MIME («Failed to fetch dynamically imported module») вместо
  // честного «файла нет». С ленивыми чанками этот путь стал живым.
  test('промах в /assets/* → 404, а не SPA-fallback', async () => {
    const res = await app.request('/assets/index-DEADBEEF.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await res.text()).not.toContain(INDEX_MARKER);
  });
```

- [ ] **Шаг 2: Прогнать — тест обязан упасть**

```bash
cd apps/server && bun test src/static.test.ts
```
Ожидание: FAIL — получено 200 и `text/html`.

- [ ] **Шаг 3: Правка сервера**

В `apps/server/src/app.ts` между строками 111 и 112 (после первого `serveStatic`, ДО
SPA-fallback):

```ts
  // Хешированный ассет либо существует, либо исчез со старым деплоем — клиентским роутом
  // /assets/* не бывает. Без этой строки SPA-fallback ниже отдаёт на промах index.html
  // с 200 и text/html, и провал динамического import() приходит в консоль как ошибка MIME
  // вместо «файла нет».
  app.get('/assets/*', (c) => c.text('Not Found', 404));
```

- [ ] **Шаг 4: Прогнать — тест обязан пройти, соседние тоже**

```bash
cd apps/server && bun test src/static.test.ts
```
Ожидание: PASS, включая существующие «GET /assets/<x>.js → ассет (200, javascript)» и
«хешированный /assets/* → immutable на год».

- [ ] **Шаг 5: Полный серверный сьют**

```bash
cd apps/server && bun run test
```
Ожидание: зелёный.

- [ ] **Шаг 6: Коммит**

```bash
git commit -- apps/server/src/app.ts apps/server/src/static.test.ts -m "fix(static): промах в /assets/* — 404, а не index.html с 200"
```

---

### Task 3: Инфраструктура ленивости + первый разрез (Budget, Import)

**Files:**
- Create: `apps/web/src/app/ScreenFallback.tsx`
- Create: `apps/web/src/app/ChunkErrorBoundary.tsx`
- Create: `apps/web/src/app/chunk-reload.ts`
- Create: `apps/web/src/app/lazy-screens.test.tsx`
- Modify: `apps/web/src/app/router.tsx` (импорты 5-8, 13; `ActiveScreen` 113-127; `renderScreen` 129-160)
- Modify: `apps/web/src/App.tsx` (установка обработчика)
- Modify: `apps/web/src/test/harness.tsx` (Suspense в обёртке)

**Interfaces:**
- Consumes: 404 на промах `/assets/*` из Task 2.
- Produces:
  - `ScreenFallback({ title }: { title: string }): JSX.Element` — заглушка экрана;
  - `ChunkErrorBoundary({ children }: { children: ReactNode })` — граница ошибок;
  - `installChunkReload(reload?: () => void): () => void` — слушатель `vite:preloadError`,
    возвращает функцию снятия;
  - в `router.tsx` появляется `screenTitle(activeTab, top): string` (не экспортируется).
  Task 4 добавит в этот же роутер ленивый `DetailScreen`, ничего из перечисленного не меняя.

- [ ] **Шаг 1: Заглушка экрана**

`apps/web/src/app/ScreenFallback.tsx`:

```tsx
import { Skeleton } from '../ui/Skeleton';
import { ScreenHeader } from './ScreenHeader';

/**
 * Кадр экрана, чей чанк ещё грузится. Шапка рисуется ЗДЕСЬ, потому что ScreenHeader живёт
 * внутри самих экранов (ScreenHeader.tsx:8): без неё кадр без шапки читался бы прыжком
 * раскладки, а кнопка «Назад» на миг исчезала бы.
 *
 * Форма повторяет уже принятый в проекте вид загружающегося экрана — DetailScreen.tsx:76-84
 * (шапка + скелетоны). Текста «Загрузка…» нет намеренно: Skeleton несёт role="status"
 * aria-label="Загрузка" сам, а browser.test.tsx:97-100 прямо запрещает текстовую подпись
 * вместо скелетона.
 */
export function ScreenFallback() {
  return (
    <>
      {/* Титул — «…», как у DetailScreen на время загрузки данных (DetailScreen.tsx:79).
          Подставлять сюда угаданное название нельзя: заголовки экранов динамические
          («Бюджет · сентябрь», «Транзакции · сентябрь», имя категории), и любой статический
          текст сменился бы на глазах, как только приедет настоящий экран. */}
      <ScreenHeader title="…" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 p-3">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9 w-1/2" />
      </div>
    </>
  );
}
```

- [ ] **Шаг 2: Один автоматический перезаход**

`apps/web/src/app/chunk-reload.ts`:

```ts
/**
 * Провал загрузки ленивого чанка почти всегда означает одно: вкладка открыта на старом
 * index.html, а деплой уже сменил имена чанков (каждый деплой — новый контейнер с чистым
 * dist, старые файлы исчезают). Лечится перезагрузкой: свежий index.html знает новые имена.
 *
 * Vite шлёт на window событие 'vite:preloadError', когда динамический import() не удался.
 *
 * Перезаход РОВНО ОДИН на сессию вкладки. Второй провал уже не про устаревший index.html —
 * это сеть или сервер, и повторная перезагрузка превратилась бы в цикл. Флаг живёт в
 * sessionStorage (переживает reload, умирает с вкладкой) и намеренно НЕ снимается: второй
 * деплой за одну сессию вкладки — редкость, и там честнее показать экран с кнопкой
 * (ChunkErrorBoundary), чем перезагружать пользователя молча ещё раз.
 */
const RELOADED_FLAG = 'orbis:chunk-reloaded';

export function installChunkReload(reload: () => void = () => location.reload()): () => void {
  const onPreloadError = (e: Event) => {
    if (sessionStorage.getItem(RELOADED_FLAG) !== null) return;
    sessionStorage.setItem(RELOADED_FLAG, '1');
    // Vite по умолчанию перебрасывает ошибку дальше; мы её уже обрабатываем перезагрузкой.
    e.preventDefault();
    reload();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
}
```

- [ ] **Шаг 3: Граница ошибок**

`apps/web/src/app/ChunkErrorBoundary.tsx`:

```tsx
import { Component, type ReactNode } from 'react';
import { Button } from '../ui/Button';

/**
 * Единственная граница ошибок в приложении. Заведена под конкретный класс отказа, который
 * ввела ленивая загрузка: чанк экрана не загрузился (устаревшая вкладка после деплоя,
 * пропавшая сеть). Первый такой провал chunk-reload.ts лечит перезагрузкой; сюда доезжает
 * второй — и любая ошибка рендера ленивого поддерева.
 *
 * Кнопка, а не автоматический reload: цикл перезагрузок при настоящей потере сети хуже
 * одного честного экрана.
 */
export class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-3 p-6 text-sm">
        <p className="text-text-secondary">Не удалось загрузить экран</p>
        <Button data-testid="chunk-reload" onClick={() => location.reload()}>
          Обновить
        </Button>
      </div>
    );
  }
}
```

Сверь форму `role="alert"` с соседями (`features/chat/cards/ErrorCard.tsx:14`,
`features/onboarding/OnboardingGate.tsx:41`) и подгони классы под их стиль, если расходится.

- [ ] **Шаг 4: Ленивые экраны в роутере**

В `apps/web/src/app/router.tsx` убрать статические импорты строк 5-8 и 13
(`BudgetScreen`, `CategoryScreen`, `RolloverScreen`, `TransactionsScreen`, `ImportFlow`) и
завести вместо них:

```tsx
// Ленивые экраны: вкладка Budget и разовый мастер импорта не нужны первому кадру.
// Граница лени стоит ЗДЕСЬ, а не в самих модулях: десятки тестов рендерят эти компоненты
// напрямую через renderWithProviders, и ленивость модуля уронила бы их все.
// ВАЖНО: у этих модулей не должно остаться ни одного статического импортёра — статический
// импорт рядом с динамическим молча схлопывает чанк обратно во входной.
const BudgetScreen = lazy(() =>
  import('../features/budget/BudgetScreen').then((m) => ({ default: m.BudgetScreen })),
);
const CategoryScreen = lazy(() =>
  import('../features/budget/CategoryScreen').then((m) => ({ default: m.CategoryScreen })),
);
const RolloverScreen = lazy(() =>
  import('../features/budget/RolloverScreen').then((m) => ({ default: m.RolloverScreen })),
);
const TransactionsScreen = lazy(() =>
  import('../features/budget/TransactionsScreen').then((m) => ({ default: m.TransactionsScreen })),
);
const ImportFlow = lazy(() =>
  import('../features/import/ImportFlow').then((m) => ({ default: m.ImportFlow })),
);
```

`useBudgetAlertCount` / `useBudgetTabVisible` (строка 9) остаются статическими — их зовёт
`TabBar` на каждом рендере.

- [ ] **Шаг 5: Suspense-граница и заголовок заглушки**

В том же файле — `ActiveScreen` (строки 113-127) и новая функция титула:

```tsx
export function ActiveScreen() {
  const activeTab = useNav((s) => s.activeTab);
  const stack = useNav((s) => s.stacks[activeTab]);
  const top = stack[stack.length - 1];
  return (
    <main
      data-testid="tab-content"
      data-tab={activeTab}
      data-depth={stack.length}
      className="flex-1 overflow-y-auto"
    >
      <ChunkErrorBoundary>
        <Suspense fallback={<ScreenFallback />}>{renderScreen(activeTab, top)}</Suspense>
      </ChunkErrorBoundary>
    </main>
  );
}
```

Заглушка титул не выбирает: заголовки всех этих экранов **динамические** — проверено,
`BudgetScreen.tsx:113` даёт `Бюджет · <месяц>`, `TransactionsScreen.tsx:159` —
`Транзакции · <месяц>`, `RolloverScreen.tsx:89` — `Новый месяц: <месяц>`,
`CategoryScreen.tsx:149` — имя категории (и `'…'`, пока данные не пришли),
`ImportFlow.tsx:358` — вычисляемый `title`. Любой угаданный статический текст сменился бы
на глазах через долю секунды.

Импорты в шапке файла дополнить: `import { lazy, Suspense } from 'react';`,
`ChunkErrorBoundary`, `ScreenFallback`.

- [ ] **Шаг 6: Установка обработчика в App**

В `apps/web/src/App.tsx` добавить эффект рядом с существующим (он живёт ниже
`OnboardingGate`, то есть ставится после входа — этого достаточно: ленивые чанки грузятся
только внутри приложения):

```tsx
  // Провал загрузки ленивого чанка → один автоматический перезаход (см. chunk-reload.ts).
  useEffect(() => installChunkReload(), []);
```

- [ ] **Шаг 7: Suspense в тестовой обёртке**

В `apps/web/src/test/harness.tsx` обернуть `{ui}` в `<Suspense>`:

```tsx
  const result = render(
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>
        {/* Suspense — страховка для тестов, которые рендерят ленивое поддерево напрямую.
            Для синхронного дерева обёртка не меняет ничего. */}
        <Suspense fallback={null}>{ui}</Suspense>
      </QueryClientProvider>
    </trpc.Provider>,
  );
```

- [ ] **Шаг 8: Тесты новой инфраструктуры**

`apps/web/src/app/lazy-screens.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { installChunkReload } from './chunk-reload';
import { ScreenFallback } from './ScreenFallback';

test('заглушка экрана показывает скелетон, а не текст «Загрузка…»', () => {
  render(<ScreenFallback />);
  expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(/Загрузка…/)).not.toBeInTheDocument();
});

test('граница ошибок ловит провал рендера и даёт кнопку обновления', () => {
  function Boom(): never {
    throw new Error('Failed to fetch dynamically imported module');
  }
  // React печатает пойманную ошибку в консоль — это ожидаемо, глушим шум.
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ChunkErrorBoundary>
      <Boom />
    </ChunkErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('chunk-reload')).toBeInTheDocument();
  err.mockRestore();
});

test('vite:preloadError перезагружает страницу ровно один раз за сессию вкладки', () => {
  sessionStorage.clear();
  const reload = vi.fn();
  const uninstall = installChunkReload(reload);

  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).toHaveBeenCalledTimes(1);

  // Второй провал в той же сессии вкладки перезагрузку уже не запускает.
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).toHaveBeenCalledTimes(1);

  uninstall();
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).toHaveBeenCalledTimes(1);
  sessionStorage.clear();
});
```

- [ ] **Шаг 9: Прогнать сьют web целиком**

```bash
cd apps/web && bun run test
```
Ожидание: зелёный, 57+1 файл. Особое внимание — тестам, которые входят через `<App/>` на
вкладку Budget (`BudgetScreen.test.tsx:258…`, `CategoryScreen.test.tsx:419`,
`TransactionsScreen.test.tsx:496`) и `AgendaScreen.test.tsx:490,509` (рендерит `ActiveScreen`).
Если какой-то из них ждёт синхронно — добавь ожидание в тест (`await waitFor`/`findBy`),
это законная правка: экран теперь приезжает на такт позже. НЕ правь тест, если он падает
по существу — это находка.

- [ ] **Шаг 10: Сборка — чанки обязаны появиться отдельными файлами**

```bash
cd /Users/birzhan/projects/orbis && VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build
for f in apps/web/dist/assets/*.js; do printf "%-40s %8s %8s\n" "$(basename $f)" "$(wc -c < $f)" "$(gzip -c $f | wc -c)"; done | sort -k3 -nr
```
Ожидание: файлов JS стало больше одного; среди них есть чанки Budget-экранов и импорта.
**Если отдельного файла у какого-то экрана нет — чанк схлопнулся** (где-то остался
статический импорт того же модуля): найди импортёра и убери.

Записать в отчёт: имена и размеры всех JS-чанков, какой из них входной (тот, что подключён
в `dist/index.html` как `<script type="module">`), и какие чанки входной импортирует
статически — их сумма и есть начальная загрузка.

- [ ] **Шаг 11: Коммит**

```bash
git commit -- apps/web/src/app/ScreenFallback.tsx apps/web/src/app/ChunkErrorBoundary.tsx \
  apps/web/src/app/chunk-reload.ts apps/web/src/app/lazy-screens.test.tsx \
  apps/web/src/app/router.tsx apps/web/src/App.tsx apps/web/src/test/harness.tsx \
  -m "feat(web): ленивые экраны Budget и импорта + граница загрузки и ошибок"
```

---

### Task 4: Второй разрез — `entity-detail` и фоновый префетч

**Files:**
- Modify: `apps/web/src/app/router.tsx` (импорт строки 12 → `lazy`)
- Create: `apps/web/src/app/prefetch.ts`
- Modify: `apps/web/src/App.tsx` (вызов префетча)
- Modify: `apps/web/src/app/lazy-screens.test.tsx` (тест префетча)

**Interfaces:**
- Consumes: `Suspense`-граница, `ScreenFallback`, `ChunkErrorBoundary` из Task 3 — они уже
  стоят вокруг `renderScreen`, второй разрез ничего в них не меняет.
- Produces: `prefetchScreens(schedule?): void` в `apps/web/src/app/prefetch.ts`.

**Зачем именно этот экран.** `features/entity-detail/*` — **32.4 кБ gzip**, больше всех
экранов Budget и импорта вместе. Из них **14.1 кБ — вендоры**: `ui/DropdownMenu` тянет
`@radix-ui/react-menu`, `react-dropdown-menu`, `react-popper`, `react-arrow` и весь
`floating-ui` (43.7 кБ сырых), и его единственный потребитель — этот экран. Весь
`features/query-builder/*` лежит внутри его поддерева и уезжает бесплатно — отдельной границы
внутри `DetailScreen` не заводить (она сломает синхронный `editorField(dialog)` в
`query-builder.test.tsx:68-70` и ничего не добавит).

**Почему нужен префетч.** Экран сущности открывается тапом из обзора, повестки и чата —
это частый жест. Вкладка Budget тоже частая. Экспериментом проверено: повторный `import()`
из `requestIdleCallback` чанк обратно **не схлопывает**.

- [ ] **Шаг 1: Ленивый DetailScreen**

В `apps/web/src/app/router.tsx` убрать статический импорт строки 12 и добавить рядом с
ленивыми Task 3:

```tsx
// Самый крупный отдельный чанк: экран сущности уносит с собой и весь query-builder,
// и дерево ui/DropdownMenu (radix-menu + floating-ui), у которого он единственный потребитель.
const DetailScreen = lazy(() =>
  import('../features/entity-detail/DetailScreen').then((m) => ({ default: m.DetailScreen })),
);
```

Ничего больше в роутере не меняется: `Suspense`-граница и заглушка из Task 3 уже стоят
вокруг `renderScreen`, а титул заглушки одинаков для всех экранов (`…`).

- [ ] **Шаг 2: Тест — вход через `<App/>` на экран сущности всё ещё работает**

Проверить существующие тесты, которые открывают сущность через приложение
(`app/deep-link.test.tsx`, `features/entity-detail/detail.test.tsx` — те, что рендерят
`<App/>` или `ActiveScreen`). Прогнать и, если какой-то ждёт синхронно, добавить ожидание.

```bash
cd apps/web && bun run test src/app src/features/entity-detail
```

- [ ] **Шаг 3: Фоновый префетч**

`apps/web/src/app/prefetch.ts`:

```ts
/**
 * Ленивость не должна оплачиваться ожиданием в момент, когда пользователь уже нажал.
 * Экран сущности открывается тапом из обзора, повестки и чата, вкладку Budget открывают
 * часто — поэтому их чанки догружаются в фоне, как только браузер освободился.
 *
 * requestIdleCallback есть не везде (Safari до 17), поэтому фолбэк на setTimeout.
 * Импорты те же самые, что в router.tsx: повторный динамический import() чанк не схлопывает
 * (проверено сборкой), а браузер отдаст уже загруженный модуль из своего кеша модулей.
 *
 * ImportFlow намеренно НЕ префетчится: разовый сценарий, его незачем тянуть всем.
 */
type Schedule = (cb: () => void) => void;

const idle: Schedule = (cb) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(cb, { timeout: 3000 });
  else setTimeout(cb, 1500);
};

export function prefetchScreens(schedule: Schedule = idle): void {
  schedule(() => {
    void import('../features/entity-detail/DetailScreen');
    void import('../features/budget/BudgetScreen');
  });
}
```

- [ ] **Шаг 4: Вызов из App**

В `apps/web/src/App.tsx`, в тот же эффект, что ставит `installChunkReload`:

```tsx
  useEffect(() => {
    prefetchScreens();
    return installChunkReload();
  }, []);
```

- [ ] **Шаг 5: Тест префетча**

Дописать в `apps/web/src/app/lazy-screens.test.tsx`:

```tsx
test('префетч планируется через idle и не бросает', async () => {
  const calls: (() => void)[] = [];
  prefetchScreens((cb) => calls.push(cb));
  expect(calls).toHaveLength(1);
  // Сам импорт обязан отработать без ошибок: модули существуют и грузятся.
  await expect(Promise.resolve(calls[0]?.())).resolves.toBeUndefined();
});
```

- [ ] **Шаг 6: Полный прогон и сборка**

```bash
cd apps/web && bun run test
cd /Users/birzhan/projects/orbis && VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build
for f in apps/web/dist/assets/*.js; do printf "%-40s %8s %8s\n" "$(basename $f)" "$(wc -c < $f)" "$(gzip -c $f | wc -c)"; done | sort -k3 -nr
```
Ожидание: появился отдельный крупный чанк экрана сущности; входной чанк заметно меньше, чем
после Task 3. Записать все цифры в отчёт.

- [ ] **Шаг 7: Коммит**

```bash
git commit -- apps/web/src/app/router.tsx apps/web/src/app/prefetch.ts apps/web/src/App.tsx \
  apps/web/src/app/lazy-screens.test.tsx \
  -m "feat(web): экран сущности — отдельный чанк, частые экраны догружаются в фоне"
```

---

### Task 5: Замер, документы, решение в журнал

**Files:**
- Modify: `docs/superpowers/reviews/2026-08-04-bundle-diet.md` (раздел «Работа 2», ряд замеров в конце)
- Modify: `docs/prd/04-decision-log.md` (новое решение)
- Modify: `docs/superpowers/specs/2026-08-10-lazy-routes-design.md` (Р5, Р6 и текст кадра ошибки)
- Modify: `apps/web/src/app/chunk-reload.ts` (две ссылки в докблоке — см. ниже)
- Create: `docs/superpowers/reviews/2026-08-10-lazy-split-backlog.md`

**Две правки в `chunk-reload.ts`, которые может сделать только эта задача:**
- строка ~15 ссылается на «разбор в бэклоге» — файла бэклога до этой задачи не существует;
  после его создания поставить точный путь с номером строки, как принято в проекте;
- строки ~21-22 советуют вернуться к `<link rel="modulepreload">`, не сказав, что путь
  сейчас закрыт: имена чанков берутся только из `build.manifest`, он выключен, `dist/.vite/`
  нет, а `__vite__mapDeps` в собранном чанке не экспортируется. Добавить оговорку, иначе
  следующий читатель сожжёт раунд.

**Р6 спеки получает вторую роль.** После отмены Р5 полный precache — единственное, что греет
ленивые чанки. Кто-то, вернувшийся к `globIgnores` ради трафика первой установки (это стоит
первым риском в отчётах задач 3 и 4), снесёт заодно и грелку, не увидев этого в решении.
Одной фразы достаточно.

**Что разошлось со спекой по ходу исполнения — привести к факту:**
- **Р5 (фоновый префетч) отменён.** Он был реализован и снят: `vite:preloadError` шлётся на
  любой провал `import()`, не отличая фоновый от пользовательского, поэтому догрузка
  забирала себе единственный на сессию автоперезаход и глушила настоящий провал на входном
  пути; а транзиентный отказ фоновой загрузки навсегда оседает в module map и превращал
  моргнувшую сеть в гарантированный отказ при первом тапе. Пользы при этом не было:
  service worker регистрируется по `load` первого визита и сам качает все ленивые чанки
  (18 precache-записей, `revision:null`) — догрузка дублировала работу воркера.
- **Текст кадра ошибки** — «Не удалось открыть экран», а не «загрузить»: граница ловит
  рендер любого экрана, а не только ленивого, и причину не знает.
- **Заглушка не принимает титул** — всегда «…» (заголовки экранов динамические).

**Interfaces:**
- Consumes: цифры сборки из Task 4.
- Produces: документы, приведённые к факту.

- [ ] **Шаг 1: Снять итоговый замер**

```bash
cd /Users/birzhan/projects/orbis && VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build
for f in apps/web/dist/assets/*; do printf "%-40s %8s %8s\n" "$(basename $f)" "$(wc -c < $f)" "$(gzip -c $f | wc -c)"; done | sort -k3 -nr
grep -o 'assets/[A-Za-z0-9_.-]*\.js' apps/web/dist/index.html | sort -u
grep -c 'url' apps/web/dist/sw.js
```

Нужны три числа: **входной чанк**, **сумма входного и всех статически связанных с ним
чанков** (это и есть начальная загрузка — именно её сравнивают с базой 263 909 Б), число
precache-записей. Как определить статически связанные: они перечислены в `dist/index.html`
как `<script type="module">` / `<link rel="modulepreload">`.

- [ ] **Шаг 2: Обновить разбор бандла**

В `docs/superpowers/reviews/2026-08-04-bundle-diet.md`, раздел «Работа 2», заменить блок
«Статус на 2026-08-08: НЕ делалась» на итог по образцу «Итог: исполнено» из «Работы 1»:
что сделано, таблица «до/после» настоящим `gzip -c`, чего НЕ вышло и почему (общий чанк,
precache тянет всё, Budget целиком неотделим), и продлить исторический ряд в конце файла.

Обязательно записать честно: **выигрыш меньше, чем обещал раздел «Работа 2»** — и назвать
причину (общий чанк, который вход грузит статически).

- [ ] **Шаг 3: Решение в журнал PRD**

В `docs/prd/04-decision-log.md` добавить решение следующего свободного номера (сейчас
последнее — D32) о том, что приложение разбито на чанки: что это меняет для PWA (precache
из нескольких записей, все всё равно прекешируются), какой новый класс отказа появился
(провал загрузки чанка) и как он закрыт (404 на промах `/assets/*`, один автоперезаход,
граница ошибок). Формат — как у соседних решений в файле.

- [ ] **Шаг 4: Бэклог ветки**

`docs/superpowers/reviews/2026-08-10-lazy-split-backlog.md` — что осознанно не чинилось.
Обязательные пункты (дополни находками ревью и смоука):
- **фоновая догрузка чанков: реализована и снята** — готовая формулировка лежит в
  `.superpowers/sdd/2026-08-10-lazy-routes/task-4-report.md`, раздел «Формулировка для
  бэклога», вместе с двумя условиями возврата (честный способ узнать URL чанка под
  `modulepreload`; отказ от полного precache);
- **преемник снятой догрузки, предложенный ревью:** греть чанк не в фоне, а **внутри жеста**
  — `onPointerDown`/`onMouseEnter` на строках, которые пушат экран сущности, тем же
  `import()`. Такой прогрев по построению пользовательский, поэтому его провал — настоящий
  пользовательский провал, `chunk-reload` обрабатывает его корректно и гейт не нужен;
  отравление module map остаётся, но наступает в ответ на жест, сделанный ~100 мс назад.
  Записать вместе с ценой, которую сняли вместе с Р5: заглушка теперь мелькает на первом
  тапе по сущности в каждой сессии (воркер греет байты в Cache Storage, но не модули —
  парсинг и исполнение всё равно на тапе), а у пользователей без service worker (приватные
  окна Safari и Firefox) ленивые чанки холодные вовсе;
- ленивый markdown-стек (47.1 кБ) — крупнейший оставшийся рычаг, отложен из-за мерцания
  в ленте чата;
- `React.lazy` не повторяет попытку после отказа: экран, чей чанк не приехал, не
  восстановится сам даже при вернувшейся сети — лечит только перезагрузка;
- промах по `/workbox-<хеш>.js` (корень `dist`) по-прежнему отдаёт HTML: отсечка 404
  намеренно узкая, только `/assets/*`;
- 76% бандла — вендоры, ленивость экранов их не трогает;
- Budget целиком неотделим (568 строк держатся из main) — что нужно, чтобы отделить;
- precache тянет все чанки: экономии трафика у установленного PWA нет;
- предупреждение сборщика про чанк > 500 кБ (осталось ли).

- [ ] **Шаг 5: Коммит**

```bash
git commit -- docs -m "docs(bundle): итог второй половины диеты — замер, решение, бэклог"
```

---

## Приёмка ветки

1. `bun run test` из корня — зелёный **три прогона подряд**. Lint зелёный
   (`bun run lint`, код возврата снимать отдельным вызовом).
2. Замер начальной загрузки снят и записан; дельта против 263 909 Б названа числом.
3. Каждый ленивый модуль существует отдельным файлом чанка (доказательство, что ни один
   не схлопнулся статическим импортом).
4. Тест сервера на 404 при промахе `/assets/*` — зелёный.
5. **Живой смоук** на прод-сборке (стенд: `bunx supabase start`, сервер из `apps/server`
   с `PORT=3000 WEB_DIST_DIR=../web/dist`; порт именно 3000 — иначе magic link уводит в
   никуда; service worker снимать дважды, он перерегистрируется):
   - открыть сущность, вкладку Budget, экран импорта — экраны приезжают, видна заглушка со
     скелетоном, консоль чистая;
   - F5 на экране сущности (глубокая ссылка) — экран восстанавливается;
   - старт приложения с персистированным стеком `budget-import` в `orbis:nav:v1`.
6. **Смоук отказа:** удалить файл одного ленивого чанка из `dist` при живом сервере →
   `curl` отдаёт 404, приложение делает один автоперезаход, повторный провал показывает
   экран с кнопкой «Обновить».
