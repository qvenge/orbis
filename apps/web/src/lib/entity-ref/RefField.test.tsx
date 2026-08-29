// Пикер ссылочного свойства — ОДИН на все ссылки (§А6-1, ref Р6).
//
// Главное свойство, ради которого он и написан: МНОЖЕСТВО — ПАРАМЕТР, и берётся оно из
// реестра, а не из кода экрана. Прежние пять копий умели ровно одно множество (категории) и
// знали его вшитым литералом запроса; поэтому здесь два теста подряд рисуют ОДИН И ТОТ ЖЕ
// компонент с разными свойствами и ждут разных запросов — на копии, знающей только
// категории, второй из них покраснеет.

import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META, type PropertyDefinition } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { PropertyControl } from '../registry/PropertyControl';
import { REF_OPTIONS_LIMIT, RefField, useRefTitle } from './RefField';

/** Определение свойства из ЖИВОГО встроенного реестра — того же, что едет в бою. */
function def(id: string): PropertyDefinition {
  const found = BUILTIN_PROPERTY_META.find((p) => p.id === id);
  if (found === undefined) throw new Error(`нет свойства ${id} во встроенном реестре`);
  return found;
}

const FINANCE_CATEGORY = def('orbis/finance_category');
const RUN_ROUTINE = def('orbis/run_routine');

const CAT_FOOD = '00000000-0000-4000-8000-0000000000c1';
const CAT_FUN = '00000000-0000-4000-8000-0000000000c2';
const ROUTINE = '00000000-0000-4000-8000-0000000000r1'.replace('r', '9');

/** Проекция, которую пикер добавляет к цели: §А6-1 запрещает её внутри `target`. */
const PROJECTION = { sortBy: [{ field: 'orbis/title', dir: 'asc' }], limit: REF_OPTIONS_LIMIT };

const rows = (...entities: ReturnType<typeof wireEntity>[]) => entities;

test('множество берётся ЦЕЛЬЮ свойства: категория → категории, рутина прогона → рутины', async () => {
  const asked: unknown[] = [];
  const answer = (path: string, input: unknown) => {
    if (path !== 'entity.query') return {};
    asked.push(input);
    return rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }));
  };

  const first = renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value="" onChange={() => {}} />,
    answer,
  );
  await waitFor(() => expect(screen.getByRole('option', { name: 'Еда' })).toBeInTheDocument());
  expect(asked).toEqual([{ ast: { filter: { aspect: 'orbis/category' }, ...PROJECTION } }]);
  first.unmount();

  asked.length = 0;
  renderWithProviders(
    <RefField def={RUN_ROUTINE} value="" onChange={() => {}} />,
    (path, input) => {
      if (path !== 'entity.query') return {};
      asked.push(input);
      return rows(wireEntity({ id: ROUTINE, title: 'Утренний обзор', aspects: ['orbis/routine'] }));
    },
  );
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'Утренний обзор' })).toBeInTheDocument(),
  );
  // ТОТ ЖЕ компонент — ДРУГОЕ множество: цель пришла из объявления свойства, а не из кода.
  expect(asked).toEqual([{ ast: { filter: { aspect: 'orbis/routine' }, ...PROJECTION } }]);
});

test('в списке ТОЛЬКО то, что вернула цель: чужая запись своей опции не получает', async () => {
  renderWithProviders(<RefField def={FINANCE_CATEGORY} value="" onChange={() => {}} />, (path) =>
    path === 'entity.query'
      ? rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }))
      : {},
  );
  await waitFor(() => expect(screen.getByRole('option', { name: 'Еда' })).toBeInTheDocument());
  // Пустой вариант — единственный, кроме самой выдачи: отбор делает СЕРВЕР по цели,
  // и второго, клиентского, у пикера нет (иначе он ослабил бы или ужесточил цель молча).
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Не выбрано', 'Еда']);
});

test('КОНВЕРТ получает пикер автоматически: свойство одно на два аспекта (В1)', async () => {
  // Структурная половина: `orbis/finance_category` объявлен И у операции, и у конверта —
  // В1 слил `financial.category_ref` и `budget.category_ref` в ОДНО свойство.
  const carriers = BUILTIN_ASPECT_DEFS.filter((a) =>
    a.properties.some((r) => r.propertyId === FINANCE_CATEGORY.id),
  ).map((a) => a.id);
  expect(carriers).toContain('orbis/financial');
  expect(carriers).toContain('orbis/budget');

  // Поведенческая: контрол выбирается по ТИПУ свойства (`ref`), а не по аспекту-носителю,
  // поэтому строка конверта получает тот же пикер — без единой строки кода про конверт.
  renderWithProviders(
    <PropertyControl def={FINANCE_CATEGORY} value={CAT_FOOD} onChange={() => {}} />,
    (path) =>
      path === 'entity.query'
        ? rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }))
        : {},
  );
  const select = await screen.findByLabelText('Категория');
  expect(select.tagName).toBe('SELECT');
  await waitFor(() => expect(select).toHaveDisplayValue('Еда'));
});

test('выбор шлёт id записи; пустой вариант СНИМАЕТ значение (unset), а не пишет пусто', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value={CAT_FOOD} onChange={onChange} />,
    (path) =>
      path === 'entity.query'
        ? rows(
            wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }),
            wireEntity({ id: CAT_FUN, title: 'Развлечения', aspects: ['orbis/category'] }),
          )
        : {},
  );
  const select = await screen.findByLabelText('Категория');
  await screen.findByRole('option', { name: 'Развлечения' });

  fireEvent.change(select, { target: { value: CAT_FUN } });
  expect(onChange).toHaveBeenLastCalledWith(CAT_FUN);

  fireEvent.change(select, { target: { value: '' } });
  // `undefined`, а не пустая строка: снятие свойства — это `unset` (§А1-1), и пустая
  // строка записалась бы значением, то есть ссылкой в никуда.
  expect(onChange).toHaveBeenLastCalledWith(undefined);
});

test('значение вне выдачи не теряется: три причины «нет в списке» читаются по-разному', async () => {
  // 1) список цел, ссылка ведёт мимо него.
  const orphan = renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value="gone" onChange={() => {}} />,
    (path) =>
      path === 'entity.query'
        ? rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }))
        : {},
  );
  const select = await screen.findByLabelText('Категория');
  await screen.findByRole('option', { name: 'Еда' });
  expect(select).toHaveDisplayValue('Не найдено');
  orphan.unmount();

  // 2) списка нет вовсе — отказ запроса.
  const failed = renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value="gone" onChange={() => {}} />,
    (path) => {
      if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    },
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Категория')).toHaveDisplayValue('Не удалось загрузить список'),
  );
  failed.unmount();

  // 3) список ещё в полёте.
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value="gone" onChange={() => {}} />,
    (path) => (path === 'entity.query' ? pending : {}),
  );
  expect(await screen.findByLabelText('Категория')).toHaveDisplayValue('Загрузка…');
  release([]);
});

test('поиск появляется на упёршейся в потолок выдаче и уезжает узлом {search} в ту же цель', async () => {
  const asked: unknown[] = [];
  const full = Array.from({ length: REF_OPTIONS_LIMIT }, (_, i) =>
    wireEntity({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `Категория ${i}`,
      aspects: ['orbis/category'],
    }),
  );
  renderWithProviders(
    <RefField def={FINANCE_CATEGORY} value="" onChange={() => {}} />,
    (path, input) => {
      if (path !== 'entity.query') return {};
      asked.push(input);
      return full;
    },
  );
  // Поле поиска появляется ТОЛЬКО когда выдача упёрлась в потолок: до этого список полон.
  const search = await screen.findByLabelText('Поиск: Категория');
  fireEvent.change(search, { target: { value: 'еда' } });

  await waitFor(() => expect(asked).toHaveLength(2));
  // Фрагмент уезжает УЗЛОМ канона внутрь той же цели, а не отдельным параметром: цель
  // остаётся условием (§А6-1), поиск — вторым условием рядом с ней.
  expect(asked[1]).toEqual({
    ast: {
      filter: { and: [{ aspect: 'orbis/category' }, { search: 'еда' }] },
      ...PROJECTION,
    },
  });
});

test('короткая выдача поля поиска не показывает: контрол без работы', async () => {
  renderWithProviders(<RefField def={FINANCE_CATEGORY} value="" onChange={() => {}} />, (path) =>
    path === 'entity.query'
      ? rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }))
      : {},
  );
  await screen.findByRole('option', { name: 'Еда' });
  expect(screen.queryByLabelText('Поиск: Категория')).toBeNull();
});

/** Потребитель `useRefTitle` — подпись ссылки там, где иначе печатался бы сырой uuid. */
function Title({ refId }: { refId: string }) {
  const { title, isPending } = useRefTitle(FINANCE_CATEGORY, refId);
  return <span data-testid="title">{isPending ? '…' : title}</span>;
}

test('useRefTitle: название из ТОЙ ЖЕ выдачи, что у пикера; промах — сам ref', async () => {
  const asked: unknown[] = [];
  renderWithProviders(
    <>
      <RefField def={FINANCE_CATEGORY} value={CAT_FOOD} onChange={() => {}} />
      <Title refId={CAT_FOOD} />
      <Title refId="gone" />
    </>,
    (path, input) => {
      if (path !== 'entity.query') return {};
      asked.push(input);
      return rows(wireEntity({ id: CAT_FOOD, title: 'Еда', aspects: ['orbis/category'] }));
    },
  );
  await waitFor(() => expect(screen.getAllByTestId('title')[0]).toHaveTextContent('Еда'));
  // Промах по ИЗВЕСТНОМУ списку — сам ref: uuid хуже названия, но лучше пустого места.
  expect(screen.getAllByTestId('title')[1]).toHaveTextContent('gone');
  // ОДИН запрос на всех троих: ключ кеша — цель свойства, и второго источника названий нет.
  expect(asked).toHaveLength(1);
});
