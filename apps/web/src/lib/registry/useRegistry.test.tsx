// Кеш реестра (§А9-2/§А10-1) — один ключ, инвалидируемый новой версией снимка: чем он
// инвалидируется и чем НЕ инвалидируется.
//
// Проверяется именно ПУТЬ инвалидации, а не две независимые выдачи: версия приезжает в ответе
// `entity.get`, как в бою, и подпись обязана перерисоваться БЕЗ перезагрузки и без
// размонтирования — то есть в том же самом узле DOM.

import { BUILTIN_PROPERTY_META } from '@orbis/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { trpc } from '../../trpc';
import { EntityRef } from '../entity-ref/EntityRef';
import { invalidateGraph } from '../invalidate';
import { fieldLabel } from './labels';
import { resetRegistryVersionForTests, useRegistry } from './useRegistry';

beforeEach(() => {
  // Наблюдённая версия живёт МОДУЛЕМ и переживает размонтирование дерева — как и должна в
  // бою. Между тестами её надо снимать, иначе второй тест стартовал бы с чужой версией.
  resetRegistryVersionForTests();
});

/** Реестр с ПОДМЕНЁННОЙ подписью одного свойства — «владелец переименовал поле». */
function renamed(version: string, label: string) {
  return {
    ...BUILTIN_REGISTRY,
    version,
    properties: BUILTIN_PROPERTY_META.map((p) =>
      p.id === 'orbis/task_status' ? { ...p, label: { ...p.label, ru: label } } : p,
    ),
  };
}

/**
 * Экран-проба: чип ссылки на запись плюс подпись поля из реестра.
 *
 * Чип здесь НЕ декорация и не мог быть заменён своим `useNoteRegistryVersion` в теле пробы:
 * версию сообщает БОЕВОЙ код (`EntityRef`, `useEntityDetail`), и тест, вызвавший хук сам,
 * зеленел бы и при полностью не подключённой проводке — обещая защиту, которой нет.
 */
function Probe() {
  const utils = trpc.useUtils();
  const registry = useRegistry();
  return (
    <div>
      <EntityRef id="e1" />
      <p data-testid="label">{fieldLabel(registry, 'orbis/task_status')}</p>
      {/* Ровно то, что делает боевой код после ЛЮБОЙ правки графа (`lib/invalidate.ts`). */}
      <button type="button" onClick={() => invalidateGraph(utils)}>
        Перечитать
      </button>
    </div>
  );
}

test('смена версии реестра перерисовывает подпись без перезагрузки и без размонтирования', async () => {
  let version = '1.0';
  let label = 'Состояние задачи';
  const { calls } = renderWithProviders(<Probe />, (path) => {
    if (path === 'entity.get')
      return { entity: { id: 'e1', title: 'Запись' }, registryVersion: version };
    if (path === 'registry.effective') return renamed(version, label);
    return {};
  });

  const node = await screen.findByTestId('label');
  await waitFor(() => expect(node).toHaveTextContent('Состояние задачи'));
  // Один запрос, а не два: ключ снимка один, а версия, совпавшая с версией приехавшего снимка,
  // его не инвалидирует.
  const first = calls.filter((c) => c.path === 'registry.effective').length;
  expect(first).toBe(1);

  // Владелец переименовал свойство: сервер поднял версию, и она приезжает ПЕРВЫМ же
  // ответом, который её несёт, — тем самым `entity.get`.
  version = '1.1';
  label = 'Стадия работы';
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать' }));

  await waitFor(() => expect(node).toHaveTextContent('Стадия работы'));
  // Перерисовался ТОТ ЖЕ узел: дерево не пересоздавалось, страница не перезагружалась.
  expect(screen.getByTestId('label')).toBe(node);
  expect(calls.filter((c) => c.path === 'registry.effective').length).toBe(first + 1);
});

test('правка графа сама по себе реестр НЕ перечитывает — только смена его версии', async () => {
  // Обратная сторона той же строки приёмки, и она про ЦЕНУ: инвалидация графа уходит после
  // каждой правки, а реестр меняется от силы раз в месяц. Реализация «на всякий случай
  // перечитать и его» была бы зелёной по первому тесту и тащила бы четыре словаря в сеть на
  // каждое нажатие чекбокса.
  const { calls } = renderWithProviders(<Probe />, (path) => {
    if (path === 'entity.get')
      return { entity: { id: 'e1', title: 'Запись' }, registryVersion: '1.0' };
    if (path === 'registry.effective') return renamed('1.0', 'Состояние задачи');
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('label')).toHaveTextContent('Состояние задачи'));
  const before = calls.filter((c) => c.path === 'registry.effective').length;

  fireEvent.click(screen.getByRole('button', { name: 'Перечитать' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.get').length).toBe(2));
  expect(calls.filter((c) => c.path === 'registry.effective').length).toBe(before);
});

test('холодный старт: версия из entity.get приехала раньше снимка — запрос реестра один (новое-8)', async () => {
  // Порядок ответов холодного старта экрана записи: `entity.get` быстрее четырёх словарей, и его
  // версия приезжает, пока первый запрос реестра ещё в полёте. Ключ с версией переезжал бы в этот
  // момент с «версии ещё нет» на настоящую — и уходил второй запрос за тем же снимком.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { calls } = renderWithProviders(<Probe />, async (path) => {
    if (path === 'entity.get')
      return { entity: { id: 'e1', title: 'Запись' }, registryVersion: '1.0' };
    if (path === 'registry.effective') {
      await gate;
      return renamed('1.0', 'Состояние задачи');
    }
    return {};
  });
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.get')).toBe(true));
  // Кадр на то, чтобы версия дошла до читателей (эффект `useNoteRegistryVersion` чипа).
  await act(() => new Promise((r) => setTimeout(r, 20)));
  release();
  await waitFor(() => expect(screen.getByTestId('label')).toHaveTextContent('Состояние задачи'));
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(calls.filter((c) => c.path === 'registry.effective')).toHaveLength(1);
});

test('вторая версия, названная, пока снимок перечитывается под первую, не оставляет старый снимок', async () => {
  // Перечитывание одно на версию (`refetchedFor`), поэтому версия 1.2, приехавшая, пока летит
  // запрос под 1.1, обязана заменить его новым: слитая с летящим запросом, она осталась бы
  // «уже перечитанной», а снимок — 1.1 до следующей смены версии.
  let version = '1.0';
  let hold: Promise<void> | null = null;
  let release: () => void = () => {};
  const { calls } = renderWithProviders(<Probe />, async (path) => {
    if (path === 'entity.get')
      return { entity: { id: 'e1', title: 'Запись' }, registryVersion: version };
    if (path === 'registry.effective') {
      // Сервер отвечает версией на момент ПРИЁМА запроса — задержка только в доставке.
      const at = version;
      if (hold !== null) await hold;
      return renamed(at, at === '1.2' ? 'Стадия работы' : 'Состояние задачи');
    }
    return {};
  });
  const node = await screen.findByTestId('label');
  await waitFor(() => expect(node).toHaveTextContent('Состояние задачи'));

  hold = new Promise<void>((r) => {
    release = r;
  });
  version = '1.1';
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'registry.effective').length).toBe(2));
  version = '1.2';
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.get').length).toBe(3));
  await act(() => new Promise((r) => setTimeout(r, 20)));
  hold = null;
  release();
  await waitFor(() => expect(node).toHaveTextContent('Стадия работы'));
});
