import type { AppRouter } from '@orbis/server/src/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, Suspense } from 'react';
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

export function renderWithProviders(
  ui: ReactNode,
  handler: MockHandler = () => ({}),
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
  const result = render(
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>
        {/* Suspense — страховка для тестов, которые рендерят ленивое поддерево напрямую.
            Для синхронного дерева обёртка не меняет ничего. */}
        <Suspense fallback={SUSPENDED}>{ui}</Suspense>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return Object.assign(result, { calls });
}
