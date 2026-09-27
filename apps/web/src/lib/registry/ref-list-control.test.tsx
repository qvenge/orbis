/**
 * «Упорядоченный список ссылок» (срез 1б §9.3; С1б-8): контрол «Навигации» приложения — перестановка
 * кнопками и перетаскиванием, добавление поиском, удаление, архивная ссылка — плашкой (§4.4, Фокус
 * ревью п. 2). Проба — по настоящему объявлению свойства во встроенном реестре.
 */
import {
  APP_ASPECT,
  APP_DISABLED,
  APP_NAV,
  BUILTIN_PROPERTY_META,
  type PropertyDefinition,
} from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { AspectSection } from '../../features/entity-detail/AspectSection';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { controlKindOf } from './controls';
import { PropertyControl } from './PropertyControl';
import { RefListControl } from './RefListControl';

function def(id: string): PropertyDefinition {
  const found = BUILTIN_PROPERTY_META.find((p) => p.id === id);
  if (found === undefined) throw new Error(`нет свойства ${id} во встроенном реестре`);
  return found;
}

const id = (n: number) => `00000000-0000-4000-8000-0000000021${String(n).padStart(2, '0')}`;
const DAILY = id(1);
const UPCOMING = id(2);
const YEAR = id(3);
const REPAIR = id(4);

const REFS = [
  { id: DAILY, title: 'Daily Planning', emoji: '☀️', completable: null, archived: false },
  { id: UPCOMING, title: 'Upcoming', emoji: '📅', completable: null, archived: false },
  { id: YEAR, title: 'Год', emoji: '🗓️', completable: null, archived: true },
  { id: REPAIR, title: 'Ремонт', emoji: null, completable: null, archived: false },
];

/** Ответ `resolveRefs` по набору с этим id ждёт `release` (медленная сеть, гейт 21 M-4). */
const slow = { id: null as string | null, gate: Promise.resolve() };

const handler = async (path: string, input: unknown) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.resolveRefs') {
    const { ids } = input as { ids: string[] };
    if (slow.id !== null && ids.includes(slow.id)) await slow.gate;
    return REFS.filter((r) => ids.includes(r.id));
  }
  // Сервер нашёл всё живое (архивные `entity.suggest` не отдаёт); отсев уже стоящих — дело контрола.
  if (path === 'entity.suggest') return REFS.filter((r) => !r.archived);
  return {};
};

/** Хозяин значения: контрол управляемый, как в черновике редактора навигации. */
function Harness({ initial, onChange }: { initial: string[]; onChange: (v: unknown) => void }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <RefListControl
      def={def(APP_NAV)}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const titles = () => screen.getAllByTestId('ref-title').map((t) => t.textContent);

test('вид «ref-list» — только у «Навигации» приложения; прочие списки ссылок — только показ', () => {
  expect(controlKindOf(def(APP_NAV))).toBe('ref-list');
  expect(controlKindOf(def('orbis/template_wins_over'))).toBe('readonly');
  expect(controlKindOf(def('orbis/app_opens_over'))).toBe('readonly');
  expect(controlKindOf(def('orbis/app_home'))).toBe('ref');
});

test('разделы — строками по порядку значения; архивный — плашкой «в архиве», не пустотой', async () => {
  renderWithProviders(
    <PropertyControl def={def(APP_NAV)} value={[DAILY, YEAR, UPCOMING]} onChange={() => {}} />,
    handler,
  );
  const control = await screen.findByTestId(`prop-${APP_NAV}`);
  expect(control).toHaveAttribute('data-kind', 'ref-list');
  await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Год', 'Upcoming']));
  const year = screen.getAllByTestId('ref-row')[1] as HTMLElement;
  expect(year).toHaveAttribute('data-archived', 'true');
  expect(within(year).getByText('в архиве')).toBeInTheDocument();
});

test('↑ и ↓ переставляют; × убирает; значение — всегда список (пустой — тоже)', async () => {
  const onChange = vi.fn();
  renderWithProviders(<Harness initial={[DAILY, UPCOMING]} onChange={onChange} />, handler);
  await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Upcoming']));
  fireEvent.click(screen.getByRole('button', { name: 'Выше: Upcoming' }));
  expect(onChange).toHaveBeenLastCalledWith([UPCOMING, DAILY]);
  fireEvent.click(screen.getByRole('button', { name: 'Ниже: Upcoming' }));
  expect(onChange).toHaveBeenLastCalledWith([DAILY, UPCOMING]);
  fireEvent.click(screen.getByRole('button', { name: 'Убрать: Daily Planning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Убрать: Upcoming' }));
  // «Навигация» без значения читалась бы испорченной оболочкой — пустота пишется списком.
  expect(onChange).toHaveBeenLastCalledWith([]);
});

test('перетаскивание переставляет строку на место той, куда её бросили', async () => {
  const onChange = vi.fn();
  renderWithProviders(<Harness initial={[DAILY, UPCOMING, REPAIR]} onChange={onChange} />, handler);
  await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Upcoming', 'Ремонт']));
  const rows = screen.getAllByTestId('ref-row');
  fireEvent.dragStart(rows[2] as HTMLElement);
  fireEvent.dragOver(rows[0] as HTMLElement);
  fireEvent.drop(rows[0] as HTMLElement);
  expect(onChange).toHaveBeenLastCalledWith([REPAIR, DAILY, UPCOMING]);
});

test('добавление поиском — в конец; уже стоящий поиском не предлагается', async () => {
  const onChange = vi.fn();
  renderWithProviders(<Harness initial={[DAILY]} onChange={onChange} />, handler);
  const search = await screen.findByRole('searchbox', { name: 'Добавить: Навигация' });
  fireEvent.change(search, { target: { value: 'р' } });
  const found = await screen.findByRole('list', { name: 'Найдено: Добавить: Навигация' });
  await within(found).findByRole('button', { name: 'Ремонт' });
  // «Daily Planning» уже стоит — второй экземпляр раздела поиск не предложит.
  expect(within(found).queryByRole('button', { name: /Daily Planning/ })).toBeNull();
  expect(within(found).getByRole('button', { name: /Upcoming/ })).toBeInTheDocument();
  fireEvent.click(within(found).getByRole('button', { name: 'Ремонт' }));
  expect(onChange).toHaveBeenLastCalledWith([DAILY, REPAIR]);
});

test('M-4: только что добавленный до ответа по новому набору — заголовок из поиска, не uuid «не найдено»', async () => {
  let release!: () => void;
  slow.id = REPAIR;
  slow.gate = new Promise<void>((r) => {
    release = r;
  });
  try {
    renderWithProviders(<Harness initial={[DAILY]} onChange={() => {}} />, handler);
    await waitFor(() => expect(titles()).toEqual(['Daily Planning']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Добавить: Навигация' }), {
      target: { value: 'р' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ремонт' }));
    expect(titles()).toEqual(['Daily Planning', 'Ремонт']);
    expect(screen.queryByText('не найдено')).toBeNull();
    release();
    await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Ремонт']));
    expect(screen.queryByText('не найдено')).toBeNull();
  } finally {
    slow.id = null;
    slow.gate = Promise.resolve();
  }
});

test('RefListControl: `exclude` — поиск не предлагает и то, что назвал хозяин (сама запись-приложение)', async () => {
  renderWithProviders(
    <RefListControl def={def(APP_NAV)} value={[]} onChange={() => {}} exclude={[REPAIR]} />,
    handler,
  );
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Добавить: Навигация' }), {
    target: { value: 'р' },
  });
  const found = await screen.findByRole('list', { name: 'Найдено: Добавить: Навигация' });
  await within(found).findByRole('button', { name: /Upcoming/ });
  expect(within(found).queryByRole('button', { name: 'Ремонт' })).toBeNull();
});

// ─── Карточка записи-приложения (гейт 21, I-1) ─────────────────────────────────────────────────

test('I-1: строка карточки копит правку до «Сохранить» и пишет её ОДНОЙ правкой без архивного id', async () => {
  const onChange = vi.fn();
  renderWithProviders(
    <PropertyControl def={def(APP_NAV)} value={[DAILY, YEAR, UPCOMING]} onChange={onChange} />,
    handler,
  );
  await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Год', 'Upcoming']));
  fireEvent.click(screen.getByRole('button', { name: 'Выше: Upcoming' }));
  fireEvent.click(screen.getByRole('button', { name: 'Выше: Upcoming' }));
  // Ни одна перестановка не ушла — ни записи журнала, ни Undo на каждое ↑.
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith([UPCOMING, DAILY]);
});

test('I-1: карточка выключенного приложения с архивным разделом — ↑ → запись без архивного id, отказа нет', async () => {
  const APP = id(9);
  const app = wireEntity({
    id: APP,
    title: 'Работа',
    aspects: [APP_ASPECT],
    props: { [APP_NAV]: [DAILY, YEAR, UPCOMING], [APP_DISABLED]: true },
  });
  const { calls } = renderWithProviders(
    <AspectSection entity={app as never} aspectId={APP_ASPECT} />,
    async (path, input) => {
      if (path === 'entity.update') {
        // Проверка ссылок исполнителя: архивная цель — отказ всей правки.
        const nav = (input as { props?: Record<string, unknown> }).props?.[APP_NAV];
        if (Array.isArray(nav) && nav.includes(YEAR))
          throw trpcError('BAD_REQUEST', 'цель архивна');
        return { entity: app };
      }
      return handler(path, input);
    },
  );
  await waitFor(() => expect(titles()).toEqual(['Daily Planning', 'Год', 'Upcoming']));
  fireEvent.click(screen.getByRole('button', { name: 'Выше: Upcoming' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1));
  const [update] = calls.filter((c) => c.path === 'entity.update');
  expect((update?.input as { props: Record<string, unknown> }).props).toEqual({
    [APP_NAV]: [DAILY, UPCOMING],
  });
});
