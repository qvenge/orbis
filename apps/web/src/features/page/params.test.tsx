/**
 * Параметр страницы в web (спека 1в §5.1, С1в-4, С1в-11, РП-15): значения из объявлений тела и из
 * истории экрана, все блоки с `$` — одной пачкой со значениями (подстановка — на сервере), значение
 * — в записи стопки экрана (не в теле и не в адресе), плашки места, неизвестного имени, второго и
 * ошибки блока параметра; первый кадр и редактор просят блок с умолчанием.
 *
 * Страница открывается экраном записи (`DetailScreen`) — так, как её откроет человек.
 */
import { PAGE_ASPECT } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { MISPLACED_HINT } from '@orbis/shared/doc/placement';
import {
  type Address,
  currentEntry,
  HOST_APP,
  PARAM_VIEW_PREFIX as NAV_PARAM_VIEW_PREFIX,
} from '@orbis/shared/nav';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BodyKindProvider } from '../../lib/query-blocks/body-kind';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  blocksReply,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { topAddress } from '../../test/nav';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { queryClient } from '../../trpc';
import { DetailScreen } from '../entity-detail/DetailScreen';
import { structureHandler } from '../entity-detail/structure-fixtures';
import { BodyEditor } from '../entity-editor/BodyEditor';
import { EditorShell } from '../entity-editor/EditorShell';
import { paramMarkers } from '../entity-editor/nodes/QueryWidget';
import { PARAM_VIEW_PREFIX } from './params';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  // Редактор, вставший сам по таймеру простоя, менял бы дерево посреди проверки.
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useNav.setState({ mode: 'site' });
});

const PAGE_ID = '00000000-0000-4000-8000-000000000601';
const APP_X = '00000000-0000-4000-8000-0000000006a1';
const RECORDS = '00000000-0000-4000-8000-0000000006a2';

const PARAM =
  '{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title="Горизонт"}}';
const Q1 = 'aspect=orbis/task, orbis/due_date=$period';
const Q2 = 'aspect=orbis/task, orbis/due_date=$period, limit=5';
const BODY = `${PARAM}\n\n{{query: ${Q1}}}\n\n{{query: ${Q2}}}\n`;

const page = (body: string, over: Partial<WireEntityFixture> = {}): WireEntityFixture =>
  wireEntity({ id: PAGE_ID, title: 'Повестка', body, aspects: [PAGE_ASPECT], ...over });

const row = (n: number, title: string) =>
  wireEntity({ id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`, title });

type Item = { text: string; params?: Record<string, string>; thisEntityId?: string };
const items = (calls: { path: string; input: unknown }[]): Item[][] =>
  calls
    .filter((c) => c.path === 'entity.blocks')
    .map((c) => (c.input as { blocks: Item[] }).blocks.filter((b) => 'text' in b));

/** Строки блока по значению периода: так видно, какое значение посчитал «сервер». */
const byPeriod = (b: { params?: Record<string, string> }) => [
  row(b.params?.period === 'next_14d' ? 2 : 1, `строка ${b.params?.period ?? 'без значения'}`),
];

/**
 * Строки видны у `n` блоков. Не `findAllByText`: ответы блоков одной пачки доходят до экрана
 * разными коммитами, и поиск вернулся бы на первом же блоке.
 */
const shown = (text: string, n: number) =>
  waitFor(() => expect(screen.getAllByText(text)).toHaveLength(n));

/** Экран — верх стопки навигации: запись — `DetailScreen`, прочее (экран хоста) — пусто. */
function Top() {
  const a = useNav((s) => currentEntry(s.model).address);
  return a.kind === 'record' ? <DetailScreen entityId={a.id} /> : <div data-testid="not-page" />;
}

/** Поставить навигацию: стопка `stack` раздела `section` приложения `app`, активная. */
function navStack(app: string, section: string, stack: Address[]) {
  useNav.setState({
    model: {
      activeApp: app,
      apps: {
        [app]: {
          activeSection: section,
          stacks: { [section]: stack.map((address) => ({ address })) },
        },
      },
    },
    overlay: null,
    mode: 'app',
  });
}

const hostPage: Address = { kind: 'record', app: { kind: 'host' }, id: PAGE_ID };

function openPage(
  entity: WireEntityFixture,
  opts: {
    gate?: Promise<void>;
    stack?: { app: string; section: string; addresses: Address[] };
    /** Ответы блоков сверх Q1/Q2 — по тексту блока. */
    replies?: Parameters<typeof blocksReply>[0];
  } = {},
) {
  const s = opts.stack ?? {
    app: HOST_APP,
    section: 'home',
    addresses: [{ kind: 'home', app: { kind: 'host' } } as Address, hostPage],
  };
  navStack(s.app, s.section, s.addresses);
  const screenHandler = structureHandler({ name: 'page', entity, extra: {} });
  const blocks = blocksReply({ [Q1]: byPeriod, [Q2]: byPeriod, ...opts.replies });
  const handler: MockHandler = async (path, input) => {
    if (path === 'entity.blocks' && opts.gate) {
      const asked = (input as { blocks: Item[] }).blocks;
      if (asked.some((b) => b.params?.period === 'next_14d')) await opts.gate;
    }
    return blocks(path, input) ?? screenHandler(path, input);
  };
  return renderWithProviders(<Top />, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

test('ключ истории значения — тот же, что переносит через перезапуск модель навигации', () => {
  expect(PARAM_VIEW_PREFIX).toBe(NAV_PARAM_VIEW_PREFIX);
});

describe('значения и пачка (§5.1, С1в-4)', () => {
  test('два блока с $period — один вызов entity.blocks, у обоих params = умолчание; текст — с $', async () => {
    const { calls } = openPage(page(BODY));
    await shown('строка next_7d', 2);
    const sent = items(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((b) => [b.text, b.params])).toEqual([
      [Q1, { period: 'next_7d' }],
      [Q2, { period: 'next_7d' }],
    ]);
  });

  test('переключение на «14 дней»: второй вызов с next_14d, прежние строки видны до ответа; значение — в записи стопки, тело и адрес не тронуты', async () => {
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const { calls } = openPage(page(BODY), { gate });
    await shown('строка next_7d', 2);
    const before = topAddress();

    const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
    fireEvent.click(within(group).getByRole('radio', { name: '14 дней' }));

    await waitFor(() => expect(items(calls)).toHaveLength(2));
    expect(items(calls)[1]?.map((b) => [b.text, b.params])).toEqual([
      [Q1, { period: 'next_14d' }],
      [Q2, { period: 'next_14d' }],
    ]);
    // Ответ ещё не пришёл — на месте прежние строки, без «Загрузка…».
    expect(screen.getAllByText('строка next_7d')).toHaveLength(2);
    expect(screen.queryByText('Загрузка…')).toBeNull();
    await act(async () => open());
    await shown('строка next_14d', 2);
    expect(within(group).getByRole('radio', { name: '14 дней' })).toBeChecked();

    expect(currentEntry(useNav.getState().model).view).toEqual({ 'param:period': 'next_14d' });
    // Параметр не пишется в тело (С1в-11) и в адрес не входит.
    expect(calls.some((c) => c.path.startsWith('entity.update'))).toBe(false);
    expect(topAddress()).toEqual(before);
  });

  test('«назад» с экрана поверх и возврат на страницу — значение на месте', async () => {
    const { calls } = openPage(page(BODY));
    const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
    fireEvent.click(within(group).getByRole('radio', { name: '14 дней' }));
    await shown('строка next_14d', 2);

    act(() => useNav.getState().openHostScreen('settings'));
    expect(await screen.findByTestId('not-page')).toBeInTheDocument();
    act(() => useNav.getState().back());

    const again = await screen.findByRole('radiogroup', { name: 'Горизонт' });
    expect(within(again).getByRole('radio', { name: '14 дней' })).toBeChecked();
    await shown('строка next_14d', 2);
    // Все просьбы после возврата — с выбранным значением, не с умолчанием.
    const last = items(calls).at(-1) ?? [];
    expect(last.every((b) => b.params?.period === 'next_14d')).toBe(true);
  });

  test.each([
    [
      'ярлык в чужом приложении',
      {
        app: APP_X,
        section: 'home',
        addresses: [
          { kind: 'home', app: { kind: 'app', ref: APP_X } } as Address,
          { kind: 'record', app: { kind: 'app', ref: APP_X }, id: PAGE_ID } as Address,
        ],
      },
    ],
    [
      'из «Записей»',
      {
        app: HOST_APP,
        section: RECORDS,
        addresses: [{ kind: 'record', app: { kind: 'host' }, id: RECORDS } as Address, hostPage],
      },
    ],
  ])('страница, открытая (%s), — значение живёт в ЕЁ записи стопки', async (_, stack) => {
    openPage(page(BODY), { stack });
    const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
    fireEvent.click(within(group).getByRole('radio', { name: '14 дней' }));
    await waitFor(() =>
      expect(currentEntry(useNav.getState().model).view).toEqual({ 'param:period': 'next_14d' }),
    );
    // Состояние — ровно у одной записи стопок, и это запись самой страницы на экране.
    const model = useNav.getState().model;
    const withView = Object.values(model.apps).flatMap((nav) =>
      Object.values(nav.stacks).flatMap((entries) => entries.filter((e) => e.view !== undefined)),
    );
    expect(withView).toEqual([currentEntry(model)]);
    expect(currentEntry(model).address).toMatchObject({ kind: 'record', id: PAGE_ID });
  });

  test('значение view вне вариантов объявления игнорируется — умолчание', async () => {
    const { calls } = openPage(page(BODY));
    await screen.findAllByText('строка next_7d');
    act(() => useNav.getState().setView({ 'param:period': 'this_month' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(
      items(calls)
        .flat()
        .every((b) => b.params?.period === 'next_7d'),
    ).toBe(true);
  });
});

// Фикс-круг 1 (I-1): значения блока — только имён самого блока. Иначе ключ кеша зависел бы от чужих
// параметров, и переключатель одного параметра перезапрашивал бы все блоки страницы.
test('два параметра, три блока: смена horizon перезапрашивает ТОЛЬКО блок с $horizon; у блока без $ нет params', async () => {
  const HORIZON = '{{param: horizon, type=period, default=today, options=today|this_week}}';
  const QH = 'aspect=orbis/task, orbis/due_date=$horizon, limit=7';
  const QN = 'aspect=orbis/task, limit=3';
  const body = `${PARAM}\n\n${HORIZON}\n\n{{query: ${Q1}}}\n\n{{query: ${QH}}}\n\n{{query: ${QN}}}\n`;
  const { calls } = openPage(page(body));
  await waitFor(() => expect(items(calls)).toHaveLength(1));
  expect(items(calls)[0]?.map((b) => [b.text, b.params])).toEqual([
    [Q1, { period: 'next_7d' }],
    [QH, { horizon: 'today' }],
    [QN, undefined],
  ]);
  expect(items(calls)[0]?.[2]).not.toHaveProperty('params');
  await screen.findByText('строка next_7d');

  const group = await screen.findByRole('radiogroup', { name: 'horizon' });
  fireEvent.click(within(group).getByRole('radio', { name: 'эта неделя' }));
  await waitFor(() => expect(items(calls)).toHaveLength(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(items(calls).map((batch) => batch.map((b) => [b.text, b.params]))).toEqual([
    items(calls)[0]?.map((b) => [b.text, b.params]),
    [[QH, { horizon: 'this_week' }]],
  ]);
});

// М-1 ревью C: раскрытое «ещё N» — просьба ПРИ ЭТИХ значениях параметров. Другой горизонт — другой
// запрос: блок уходит без поднятого `limit`, а прежние строки видны до ответа (блок не пересоздан).
test('«ещё N», раскрытое на 7 днях, не переживает смену горизонта: блок на 14 днях — без поднятого limit', async () => {
  const QM = 'aspect=orbis/task, orbis/due_date=$period, limit=1';
  const body = `${PARAM}\n\n{{query: ${QM}}}\n`;
  const reply = (b: { params?: Record<string, string>; limit?: number }) => ({
    ok: true as const,
    kind: 'rows' as const,
    rows: [row(3, `строка ${b.params?.period} limit ${b.limit ?? '—'}`)],
    more: b.limit === undefined ? 4 : 0,
    closedIds: [],
  });
  const { calls } = openPage(page(body), { replies: { [QM]: reply } });
  await screen.findByText('строка next_7d limit —');
  fireEvent.click(screen.getByRole('button', { name: 'ещё 4' }));
  await screen.findByText('строка next_7d limit 5');
  const asks = () =>
    items(calls)
      .flat()
      .filter((b) => b.text === QM)
      .map((b) => [b.params?.period, (b as { limit?: number }).limit]);
  expect(asks()).toEqual([
    ['next_7d', undefined],
    ['next_7d', 5],
  ]);

  const group = await screen.findByRole('radiogroup', { name: 'Горизонт' });
  fireEvent.click(within(group).getByRole('radio', { name: '14 дней' }));
  await screen.findByText('строка next_14d limit —');
  expect(asks()).toEqual([
    ['next_7d', undefined],
    ['next_7d', 5],
    ['next_14d', undefined],
  ]);
  expect(screen.getByRole('button', { name: 'ещё 4' })).toBeTruthy();
});

describe('плашки (§5.1)', () => {
  test('блок с $x без объявления — плашка «параметр «x» не объявлен на странице», запроса нет', async () => {
    const q = 'aspect=orbis/task, orbis/due_date=$x';
    const { calls } = openPage(page(`${PARAM}\n\n{{query: ${q}}}\n\n{{query: ${Q1}}}\n`));
    expect(await screen.findByText('строка next_7d')).toBeInTheDocument();
    const plaque = await screen.findByText(/параметр «x» не объявлен на странице/);
    expect(plaque.closest('[data-testid="qb-error"]')).not.toBeNull();
    expect(
      items(calls)
        .flat()
        .map((b) => b.text),
    ).toEqual([Q1]);
  });

  test('второй {{param: period…}} — плашка «второй»; ошибка блока параметра — плашка с текстом ошибки', async () => {
    const bad = '{{param: horizon, type=period, default=today, options=next_7d|next_14d}}';
    openPage(page(`${PARAM}\n\n${PARAM}\n\n${bad}\n\n{{query: ${Q1}}}\n`));
    expect(await screen.findByText('строка next_7d')).toBeInTheDocument();
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(screen.getByTestId('block-misplaced')).toHaveTextContent('Второй параметр «period»');
    expect(screen.getByTestId('qb-error')).toHaveTextContent(
      "Блок {{param}}: умолчание — один из вариантов, не 'today'.",
    );
  });
});

// Фикс-круг 1 (m-2): селектор маркеров зовётся в каждом блоке данных на каждой транзакции — обход
// документа один на его версию, в заметке обхода нет вовсе.
test('маркеры параметров редактора: один обход на версию документа; в заметке — без обхода', () => {
  type Visit = (n: { type: { name: string }; attrs: Record<string, unknown> }) => void;
  const walk = (f: Visit) => {
    f({ type: { name: 'paragraph' }, attrs: {} });
    f({ type: { name: 'paramBlock' }, attrs: { text: PARAM } });
  };
  const descendants = vi.fn(walk);
  const doc = { descendants };
  expect(paramMarkers(doc, 'page')).toBe(PARAM);
  expect(paramMarkers(doc, 'template')).toBe(PARAM);
  expect(descendants).toHaveBeenCalledTimes(1);
  const next = { descendants: vi.fn(walk) };
  expect(paramMarkers(next, 'page')).toBe(PARAM);
  expect(next.descendants).toHaveBeenCalledTimes(1);
  const note = { descendants: vi.fn(walk) };
  expect(paramMarkers(note, 'note')).toBe('');
  expect(note.descendants).not.toHaveBeenCalled();
});

describe('заметка, первый кадр и редактор', () => {
  const noteHandler: MockHandler = (path, input) =>
    registryReply(path) ?? blocksReply({ [Q1]: byPeriod })(path, input) ?? {};

  test('заметка с {{param}} и блоком с $period — плашки места, запроса нет; объявление заметки блокам не отдаётся', async () => {
    const { calls } = renderWithProviders(
      <BodyKindProvider kind="note">
        <EditorShell doc={null} markdown={BODY} onChange={() => {}} readOnly />
      </BodyKindProvider>,
      noteHandler,
    );
    const misplaced = await screen.findByTestId('block-misplaced');
    expect(misplaced).toHaveTextContent('Блок {{param: period}} не показывается в заметке.');
    expect(misplaced).toHaveTextContent(MISPLACED_HINT);
    await waitFor(() =>
      expect(screen.getAllByTestId('qb-error')[0]).toHaveTextContent(
        'только в блоках страниц и шаблонов',
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.path === 'entity.blocks')).toBe(false);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  test('первый кадр страницы: заглушка параметра, блок с $period — с умолчанием, а не отказом', async () => {
    const { calls } = renderWithProviders(
      <BodyKindProvider kind="page">
        <EditorShell doc={null} markdown={BODY} onChange={() => {}} readOnly />
      </BodyKindProvider>,
      noteHandler,
    );
    expect(await screen.findAllByText('строка next_7d')).toHaveLength(1);
    expect(screen.getByText('[Параметр «Горизонт»: 7 дней | 14 дней]')).toBeInTheDocument();
    expect(
      items(calls)
        .flat()
        .map((b) => b.params),
    ).toEqual([{ period: 'next_7d' }, { period: 'next_7d' }]);
  });

  test('редактор страницы (QueryWidget): блок с $period — с умолчанием из документа; узел параметра — заглушкой', async () => {
    const md = `${PARAM}\n\n{{query: ${Q1}}}\n`;
    const { calls } = renderWithProviders(
      <BodyKindProvider kind="page">
        <BodyEditor doc={parseBody(md)} onChange={() => {}} />
      </BodyKindProvider>,
      noteHandler,
    );
    expect(await screen.findByText('строка next_7d')).toBeInTheDocument();
    expect(screen.getByText('[Параметр «Горизонт»: 7 дней | 14 дней]')).toBeInTheDocument();
    expect(
      items(calls)
        .flat()
        .map((b) => [b.text, b.params]),
    ).toEqual([[Q1, { period: 'next_7d' }]]);
  });
});
