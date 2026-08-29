import type { AppRouter } from '@orbis/server/src/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, StrictMode, Suspense } from 'react';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { trpc } from '../trpc';

/**
 * Ловушка для КРАХОВ В ОБРАБОТЧИКАХ. Зовётся на верхнем уровне файла тестов.
 *
 * Ошибка, брошенная в обработчике DOM-события (горячая клавиша ProseMirror, onClick кнопки,
 * колбэк NodeView), до ассертов НЕ доезжает: jsdom её гасит и докладывает отдельно. Прогон
 * краснеет КОДОМ ВОЗВРАТА, а сам тест остаётся зелёным — документ после краха, разумеется, не
 * изменился, и ассерт «ничего не сломалось» истинен. Разница видна на мутации: снятая проверка
 * края в move-block.ts держала четырнадцать тестов из четырнадцати зелёными при коде 1, то есть
 * падало «что-то», без единого слова о том, что именно.
 *
 * Глобально (tests/setup.ts) ставить НЕЛЬЗЯ: в apps/web есть тесты, которые бросают намеренно
 * (граница ошибок чанков, плашки отказов конструктора запросов), и общая ловушка покрасила бы
 * их все.
 *
 * Два свойства, ради которых слушатель живёт ФАЙЛОМ, а не тестом:
 * - он ставится один раз на файл и снимается в самом конце, поэтому ошибка, прилетевшая уже
 *   после `afterEach` (отложенный колбэк только что закончившегося теста), не теряется —
 *   она доедет до следующей сверки, пусть и под чужим именем;
 * - список НЕ чистится перед тестом, а СНИМАЕТСЯ при сверке: чистка «на входе» выбрасывала бы
 *   ровно те ошибки, что прилетели между хуками, а снятие гарантирует и то, что одна ошибка не
 *   покрасит все последующие тесты подряд.
 *
 * В сообщение уходит СТЕК, а не `String(error)`: без него в выводе остаётся «TypeError: …»
 * без единой строки о том, где это случилось.
 */
export function installCrashTrap(): void {
  const crashes: string[] = [];
  const onError = (event: ErrorEvent) => {
    const error = event.error as Error | undefined;
    crashes.push(error?.stack ?? error?.message ?? event.message);
  };
  const check = (where: string) => {
    const seen = crashes.splice(0);
    expect(seen, `необработанная ошибка в обработчике события (${where})`).toEqual([]);
  };
  beforeAll(() => window.addEventListener('error', onError));
  afterEach(() => check('после теста'));
  afterAll(() => {
    // Сверка ПЕРЕД снятием слушателя, а не только в afterEach: без неё поздняя ошибка
    // ПОСЛЕДНЕГО теста файла (отложенный колбэк, доехавший уже после его afterEach) не
    // сверялась бы ни разу — следующего теста, который бы её унёс, в файле просто нет.
    try {
      check('после последнего теста файла');
    } finally {
      window.removeEventListener('error', onError);
    }
  });
}

export type MockHandler = (path: string, input: unknown) => unknown | Promise<unknown>;

// TRPCClientError с data.code — клиент ключуется на КОД (не cause). Второй аргумент —
// текст сообщения: cause по HTTP не сериализуется, поэтому детали инвариантов (путь цикла
// blocks, K17) доезжают до UI только в message, и тесты должны уметь его подделать.
export function trpcError(code: string, message = code): TRPCClientError<AppRouter> {
  return new TRPCClientError(message, {
    // biome-ignore lint/suspicious/noExplicitAny: конструирование сырого tRPC-error shape для тестов
    result: { error: { message, code: -32600, data: { code, httpStatus: 400 } } } as any,
  });
}

export function mockLink(handler: MockHandler): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        Promise.resolve(handler(op.path, op.input))
          .then((data) => {
            observer.next({ result: { type: 'data', data } });
            observer.complete();
          })
          .catch((err) =>
            observer.error(err instanceof TRPCClientError ? err : TRPCClientError.from(err)),
          );
        return () => {};
      });
}

// Заглушка Suspense в обёртке — НЕ null и намеренно отличима. Сегодня через эту границу
// не подвисает ни одно дерево сьюта; пустой fallback превратил бы будущее подвисание в тихую
// пустоту, и падение пришло бы как «Unable to find an element» — без слова о том, что дерево
// подвисло, и без подсказки, где искать. Ровно та болезнь, против которой написан
// tests/setup.ts:11-18: улика в выводе важнее краткости разметки.
const SUSPENDED = <div data-testid="harness-suspended">дерево подвисло под Suspense обёртки</div>;

/**
 * `strict: true` — прогнать дерево под StrictMode, то есть с ДВОЙНЫМ прогоном эффектов
 * монтирования (так приложение и живёт в разработке, см. main.tsx).
 *
 * Флаг существует потому, что «просто передать `<StrictMode>` внутри `ui`» НЕ РАБОТАЕТ, и это
 * замерено: двойной прогон эффектов включается, только когда StrictMode — САМЫЙ ВЕРХНИЙ
 * элемент, переданный в `render`. Достаточно любого элемента над ним, чтобы прогон стал
 * одинарным: `<StrictMode><X/></StrictMode>` → 2 прогона, `<div><StrictMode><X/></StrictMode>
 * </div>` → 1, `<QueryClientProvider><StrictMode><X/></StrictMode></QueryClientProvider>` → 1
 * (три пробы, React 19.2). А `renderWithProviders` ставит над `ui` три обёртки — то есть тест,
 * написавший StrictMode внутри, проверяет ровно то же, что и без него, и зелен при любой
 * реализации. Поэтому StrictMode здесь оборачивает ВСЁ дерево, включая провайдеры.
 */
export function renderWithProviders(
  ui: ReactNode,
  handler: MockHandler = () => ({}),
  opts: { strict?: boolean } = {},
): RenderResult & { calls: { path: string; input: unknown }[] } {
  const calls: { path: string; input: unknown }[] = [];
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      mockLink((path, input) => {
        calls.push({ path, input });
        return handler(path, input);
      }),
    ],
  });
  const tree = (
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>
        {/* Suspense — страховка для тестов, которые рендерят ленивое поддерево напрямую.
            Для синхронного дерева обёртка не меняет ничего. */}
        <Suspense fallback={SUSPENDED}>{ui}</Suspense>
      </QueryClientProvider>
    </trpc.Provider>
  );
  const result = render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree);
  return Object.assign(result, { calls });
}

/**
 * Сущность в wire-форме — ровно теми ключами, которыми её пишет ПРОИЗВОДИТЕЛЬ
 * (`apps/server/src/wire.ts`, `toWireEntity`).
 *
 * Зачем фабрика вообще. Каждый сьют держал свою рукописную «сущность», и ключи в ней были
 * те, которые понадобились автору теста, — а не те, которые пишет сервер. Пока web читал
 * одну карту, это сходило с рук; с переездом значений в `props` (§А1-1) ровно эта привычка
 * дала 138 красных тестов на пустом месте: у фикстур не было ни `props`, ни `aspects`, и
 * первый же читатель падал на `undefined.includes`. Форма ответа обязана быть ОДНА, и
 * задаваться она должна там же, где производитель, — а не двадцатью семью копиями.
 *
 * `bodyDoc` фабрика НЕ кладёт: производитель кладёт его только по явному `include`
 * (`toWireEntity(row, includeBodyDoc)`), то есть в ответе `entity.get` детали — и нигде
 * больше. Сьют, которому документ нужен, дописывает его сам.
 *
 * Мешка `meta` и старой карты `aspectsMap` здесь БОЛЬШЕ НЕТ: Задача 13c сняла обе из
 * wire-формы вместе с последними читателями (§А1-3, §А1-1). Фикстура, которая их пишет,
 * теперь описывает форму, которой производитель не отдаёт, — и ловит это страж
 * `test/fixtures.test.ts` по исходнику, а не тип: лишний ключ в объектном литерале tsc
 * отвергает, но `...over` и `as` его проносят молча.
 */
export interface WireEntityFixture {
  id: string;
  ownerId: string;
  title: string;
  emoji: string | null;
  body: string;
  /**
   * Документ тела. Объявлен ОПЦИОНАЛЬНЫМ и умолчания не имеет: производитель кладёт его
   * только по явному `include` (ответ `entity.get` детали), и фикстура списка с документом
   * обещала бы форму, которой `entity.query` не отдаёт никогда.
   */
  bodyDoc?: { v: number; doc: Record<string, unknown> } | null;
  bodyRefs: string[];
  tags: string[];
  /** Новая правда §А1-1: значения плоско по id свойства. */
  props: Record<string, unknown>;
  /** Новая правда §А1-1: аспекты — список навешенного, без полей. */
  aspects: string[];
  queryRefs: string[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/**
 * Фикстура сущности: обязательны `id` и `title` (без них строка не бывает), остальное —
 * умолчания производителя.
 *
 * `props` и `aspects` разложены ПОСЛЕ `...over` намеренно: они обязаны быть в объекте
 * всегда, даже когда вызывающий их не назвал, — читатель падал бы на `undefined.includes`.
 */
export function wireEntity(
  over: Partial<WireEntityFixture> & { id: string; title: string },
): WireEntityFixture {
  const props = over.props ?? {};
  const aspects = over.aspects ?? [];
  return {
    ownerId: 'u',
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: [],
    queryRefs: [],
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T10:00:00.000Z',
    archived: false,
    ...over,
    props,
    aspects,
  };
}
