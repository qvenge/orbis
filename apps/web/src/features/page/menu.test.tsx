/**
 * Меню ⋮ записи и страницы (спека страниц 1а §8.4, §4.3, Р-19; задача 15).
 *
 * Запись открывается экраном записи (`DetailScreen`) так, как её откроет человек: обработчик экрана
 * (`structureHandler`), поверх — изменяемый мир (запись и шаблоны владельца). Пачка правок меняет
 * мир, как сервер, и перечитанный после инвалидации экран видит новое; Undo возвращает мир к
 * снимку до пачки. Все записи меню — ОДНИМ вызовом `entity.updateBatch` (РП-9): в каждом тесте,
 * где что-то пишется, счёт вызовов сверяется. `this` у блоков данных — только uuid.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { queryClient } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { resetDetailMenuModuleForTests } from '../entity-detail/DetailMenuSlot';
import { DetailScreen } from '../entity-detail/DetailScreen';
import {
  STRUCTURE_FIXTURES,
  type StructureFixture,
  structureHandler,
} from '../entity-detail/structure-fixtures';
import { type DetailStructure, snapshotDetailStructure } from '../entity-detail/structure-snapshot';
import { HIDE_AS_VERSION_HINT } from './ChangeViewDialog';
import { changeViewPlan, TEXT_BEFORE_VIEW_CHANGE } from './change-view';
import { HOST_TEMPLATE_TEXT } from './host-template';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  useToastStore.setState({ toasts: [] });
  // Редактор, вставший сам по таймеру простоя, менял бы дерево посреди проверки.
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TPL_A = uuid(1501);
const TPL_B = uuid(1502);
const TPL_C = uuid(1503);
const TPL_TOP = uuid(1504);
const OTHER = uuid(1510);
const ACTION_ID = uuid(1599);

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

/** Фикстура с другим телом (и документом тела под него, как отдал бы сервер). */
const withBody = (f: StructureFixture, body: string): StructureFixture => ({
  ...f,
  entity: { ...f.entity, body, bodyDoc: parseBody(body) },
});

/** Фикстура-страница: запись с аспектом «страница» и своим телом. */
const asPage = (f: StructureFixture, body: string, props: object = {}): StructureFixture => ({
  ...f,
  entity: {
    ...f.entity,
    aspects: [...f.entity.aspects, PAGE_ASPECT],
    body,
    bodyDoc: parseBody(body),
    props: { ...f.entity.props, ...props },
  },
});

/** Шаблон владельца: страница с «Шаблон для». */
const template = (
  id: string,
  title: string,
  forAspects: string[],
  body: string,
  opts: { winsOver?: string[]; createdAt?: string } = {},
): WireEntityFixture =>
  wireEntity({
    id,
    title,
    body,
    aspects: [PAGE_ASPECT],
    createdAt: opts.createdAt ?? '2026-09-01T00:00:00.000Z',
    props: {
      [TEMPLATE_FOR_PROPERTY]: forAspects,
      ...(opts.winsOver === undefined ? {} : { [TEMPLATE_WINS_OVER_PROPERTY]: opts.winsOver }),
    },
  });

// --- Мир ----------------------------------------------------------------------------------------

type Op =
  | { tool: 'entity_version_pin'; input: { entity_id: string; label: string } }
  | {
      tool: 'entity_update';
      input: {
        id: string;
        expectedUpdatedAt?: string;
        body?: string;
        props?: Record<string, unknown>;
        unset?: string[];
        aspects?: { attach?: string[]; detach?: string[] };
      };
    };

/** Изменяемый мир: записи по id (основная, шаблоны, соседняя), закреплённые версии, снимок для Undo. */
interface World {
  rows: Map<string, WireEntityFixture>;
  pins: { entityId: string; label: string; body: string }[];
  beforeBatch: Map<string, WireEntityFixture> | null;
}

const copy = (e: WireEntityFixture): WireEntityFixture => ({
  ...e,
  props: { ...e.props },
  aspects: [...e.aspects],
});

function makeWorld(rows: WireEntityFixture[]): World {
  return { rows: new Map(rows.map((r) => [r.id, copy(r)])), pins: [], beforeBatch: null };
}

/** Пачка как её исполнил бы сервер: тело, аспекты, значения, снятия — и новая версия строки. */
function applyBatch(world: World, operations: Op[]) {
  world.beforeBatch = new Map([...world.rows].map(([id, r]) => [id, copy(r)]));
  for (const op of operations) {
    if (op.tool === 'entity_version_pin') {
      const row = world.rows.get(op.input.entity_id);
      if (row === undefined) throw new Error('нет записи');
      world.pins.push({ entityId: row.id, label: op.input.label, body: row.body });
      continue;
    }
    const row = world.rows.get(op.input.id);
    if (row === undefined) throw new Error('нет записи');
    if (op.input.body !== undefined) {
      row.body = op.input.body;
      row.bodyDoc = parseBody(op.input.body);
    }
    const attach = op.input.aspects?.attach ?? [];
    const detach = op.input.aspects?.detach ?? [];
    row.aspects = [...row.aspects.filter((a) => !detach.includes(a)), ...attach];
    row.props = { ...row.props, ...op.input.props };
    for (const key of op.input.unset ?? []) delete row.props[key];
    row.updatedAt = '2026-09-25T12:00:00.000Z';
  }
}

const isTemplatesList = (path: string, input: unknown) =>
  path === 'entity.query' && (input as { query?: string }).query === PAGE_TEMPLATES_QUERY;

function templatesOf(world: World): WireEntityFixture[] {
  return [...world.rows.values()]
    .filter((r) => {
      const tf = r.props[TEMPLATE_FOR_PROPERTY];
      return r.aspects.includes(PAGE_ASPECT) && Array.isArray(tf) && tf.length > 0;
    })
    .map(copy);
}

function worldHandler(f: StructureFixture, world: World): MockHandler {
  return (path, input) => {
    if (isTemplatesList(path, input)) return templatesOf(world);
    if (path === 'entity.updateBatch') {
      applyBatch(world, (input as { operations: Op[] }).operations);
      return { actionId: ACTION_ID, results: [] };
    }
    if (path === 'ai.undo') {
      if (world.beforeBatch !== null) world.rows = world.beforeBatch;
      world.beforeBatch = null;
      return { ok: true, actionId: ACTION_ID, results: [] };
    }
    if (path === 'entity.get') {
      const row = world.rows.get((input as { id: string }).id);
      if (row !== undefined) {
        // Основная запись — со своими связями фикстуры (`extra`), прочие — голыми.
        const g = row.id === f.entity.id ? f : { name: 'row', entity: row };
        return structureHandler({ ...g, entity: copy(row) })(path, input);
      }
    }
    return structureHandler(f)(path, input);
  };
}

/**
 * Экран записи с переключателем «уйти на соседнюю запись и вернуться»: экран монтируется без key
 * (router.tsx), и переход меняет только проп — ровно так, как в приложении.
 */
function Screen({ first }: { first: string }) {
  const [id, setId] = useState(first);
  return (
    <>
      <button type="button" data-testid="go-other" onClick={() => setId(OTHER)}>
        соседняя
      </button>
      <button type="button" data-testid="go-back" onClick={() => setId(first)}>
        назад
      </button>
      <DetailScreen entityId={id} />
      <Toaster />
    </>
  );
}

function open(f: StructureFixture, extra: WireEntityFixture[] = []) {
  const world = makeWorld([
    f.entity,
    wireEntity({ id: OTHER, title: 'Соседняя запись', body: 'Сосед' }),
    ...extra,
  ]);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: f.entity.id }], agenda: [], budget: [] },
  });
  const r = renderWithProviders(<Screen first={f.entity.id} />, worldHandler(f, world), {
    queries: queryClient.getDefaultOptions().queries,
  });
  const batches = () =>
    r.calls
      .filter((c) => c.path === 'entity.updateBatch')
      .map((c) => (c.input as { operations: Op[] }).operations);
  return { ...r, world, batches };
}

async function openMenu(): Promise<void> {
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
}

const menuLabels = () => screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');

async function choose(label: string): Promise<void> {
  await openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

/** Экран встал: снимок и число запросов не меняются несколько проходов подряд (приём `captureDetail`). */
async function settle(container: HTMLElement, calls: unknown[]): Promise<DetailStructure> {
  let last = '';
  let quiet = 0;
  for (let tick = 0; quiet < 3; tick++) {
    if (tick > 200) throw new Error('экран не стабилизировался');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const now = JSON.stringify([calls.length, snapshotDetailStructure(container)]);
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  return snapshotDetailStructure(container);
}

const renderedTexts = () => screen.queryAllByTestId('page-text').map((n) => n.textContent ?? '');

/**
 * С1а-8: чем снимок записи-страницы после «Изменить вид только этой записи» отличается от снимка
 * той же записи через шаблон до него. Отличие одно — тело: случай 2 — на месте редактора тела
 * текст страницы (`page-text`); случай 1 — ничего (пустое тело рисовалось заглушкой, а копия
 * шаблона строки `{{body}}` не несёт, РП-29). Вместе с редактором уходит и узел его плашек над
 * вкладками (`body-notices`): это плашки ТЕЛА (сохранение, расхождение версий), а тела-редактора
 * у страницы нет. Остальное совпадает: карточка «Страница» в `{{cards}}` своего тела не рисуется
 * (РП-25).
 */
function bodyBecameText(before: DetailStructure, planCase: 1 | 2): DetailStructure {
  const swap = (parts: string[]) =>
    parts.flatMap((p) => (p === 'body' ? (planCase === 2 ? ['page-text'] : []) : [p]));
  return {
    aboveTabs: before.aboveTabs.filter((p) => p !== 'body-notices'),
    tabs: before.tabs.map((t) => ({ ...t, parts: swap(t.parts) })),
  };
}

const becomePageOp = (id: string, updatedAt: string, body: string): Op => ({
  tool: 'entity_update',
  input: { id, expectedUpdatedAt: updatedAt, body, aspects: { attach: [PAGE_ASPECT] } },
});

// --- Запись -------------------------------------------------------------------------------------

describe('«Сделать страницей»', () => {
  test('одна пачка с аспектом «страница»; тост «Отменить» → ai.undo; у страницы пункта нет', async () => {
    const f = fixture('note-plain');
    const { batches, calls } = open(f);
    await screen.findByTestId('page-tabs');
    await choose('Сделать страницей');

    await screen.findByTestId('page-view');
    expect(batches()).toEqual([
      [{ tool: 'entity_update', input: { id: f.entity.id, aspects: { attach: [PAGE_ASPECT] } } }],
    ]);
    expect(calls.some((c) => c.path === 'entity.update')).toBe(false);

    await openMenu();
    expect(menuLabels()).not.toContain('Сделать страницей');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'ai.undo').map((c) => c.input)).toEqual([
        { actionId: ACTION_ID },
      ]),
    );
    // Undo перечитал граф (`invalidateGraph`): запись снова показана через шаблон.
    await waitFor(() => expect(screen.queryByTestId('page-view')).toBeNull());
    expect(await screen.findByTestId('record-view')).toBeInTheDocument();
  });
});

describe('«Изменить вид только этой записи» (С1а-8, Р-19)', () => {
  test('случай 2: текст на место {{body}}, одна пачка; после — страница, вид прежний', async () => {
    const f = fixture('note-plain');
    const { container, calls, batches } = open(f);
    await screen.findByTestId('editor-preview');
    const before = await settle(container, calls);
    expect(before.tabs[0]?.parts).toContain('body');

    const plan = changeViewPlan(HOST_TEMPLATE_TEXT, f.entity.body);
    expect(plan.case).toBe(2);
    await choose('Изменить вид только этой записи');

    await screen.findByTestId('page-view');
    expect(batches()).toEqual([
      [becomePageOp(f.entity.id, f.entity.updatedAt, plan.case === 2 ? plan.body : '')],
    ]);
    await waitFor(() => expect(renderedTexts()).toContain(f.entity.body));
    const after = await settle(container, calls);
    expect(after).toEqual(bodyBecameText(before, 2));
    // РП-25: карточки «Страница» на показе своим телом нет.
    expect(screen.queryByTestId(`aspect-${PAGE_ASPECT}`)).toBeNull();
  });

  test('случай 1: тела нет — копия шаблона без {{body}}; ориентир тела исчезает, прочее то же', async () => {
    const f = withBody(fixture('note-plain'), '');
    const { container, calls, batches } = open(f);
    await screen.findByTestId('editor-preview');
    const before = await settle(container, calls);

    await choose('Изменить вид только этой записи');
    await screen.findByTestId('page-view');
    expect(batches()).toEqual([
      [becomePageOp(f.entity.id, f.entity.updatedAt, HOST_TEMPLATE_TEXT.replace('{{body}}\n', ''))],
    ]);
    const after = await settle(container, calls);
    expect(after).toEqual(bodyBecameText(before, 1));
    // Плашки «{{body}} работает только в шаблонах» на странице нет — строки нет вовсе (РП-29).
    expect(screen.queryByTestId('block-plaque')).toBeNull();
  });

  describe('случай 3: шаблон тела не показывает — вопрос владельцу', () => {
    const NO_BODY = '{{title}}\n{{cards}}\n';
    const f = fixture('project');
    const tpl = () => template(TPL_A, 'Шаблон проекта', ['orbis/project'], NO_BODY);
    const plan = changeViewPlan(NO_BODY, f.entity.body);

    async function ask() {
      const r = open(f, [tpl()]);
      await screen.findByTestId('page-render');
      await waitFor(() => expect(screen.queryByTestId('page-tabs')).toBeNull());
      await choose('Изменить вид только этой записи');
      const dialog = await screen.findByRole('dialog');
      return { ...r, dialog };
    }

    test('диалог Р-19: текст вопроса, три кнопки, подсказка про версию; до ответа — ни одной записи', async () => {
      const { dialog, batches } = await ask();
      expect(dialog).toHaveTextContent(
        'В этом шаблоне текст записи не показывается, а у записи он есть. Что с ним сделать?',
      );
      const save = within(dialog).getByRole('button', { name: 'Сохранить версией и убрать' });
      expect(save).toHaveAccessibleDescription(HIDE_AS_VERSION_HINT);
      expect(HIDE_AS_VERSION_HINT).toMatch(
        /пока текст лежит в версии, его не видят поиск и агент/i,
      );
      within(dialog).getByRole('button', { name: 'Показать внизу страницы' });
      within(dialog).getByRole('button', { name: 'Отмена' });
      expect(batches()).toEqual([]);
    });

    test('«Отмена» — вызовов нет, запись как была', async () => {
      const { dialog, batches, world } = await ask();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(batches()).toEqual([]);
      expect(world.rows.get(f.entity.id)?.aspects).not.toContain(PAGE_ASPECT);
    });

    test('«Сохранить версией и убрать» — одна пачка: закрепление текста, затем тело-шаблон', async () => {
      if (plan.case !== 3) throw new Error('ожидался случай 3');
      const { dialog, batches, world } = await ask();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить версией и убрать' }));
      await screen.findByTestId('page-view');
      expect(batches()).toEqual([
        [
          {
            tool: 'entity_version_pin',
            input: { entity_id: f.entity.id, label: TEXT_BEFORE_VIEW_CHANGE },
          },
          becomePageOp(f.entity.id, f.entity.updatedAt, plan.hideAsVersion),
        ],
      ]);
      // Версия сняла ПРЕЖНИЙ текст: закрепление стоит в пачке первым.
      expect(world.pins).toEqual([
        { entityId: f.entity.id, label: TEXT_BEFORE_VIEW_CHANGE, body: f.entity.body },
      ]);
      expect(await screen.findByRole('button', { name: 'Отменить' })).toBeInTheDocument();
    });

    test('«Показать внизу страницы» — одна пачка, текст под шаблоном', async () => {
      if (plan.case !== 3) throw new Error('ожидался случай 3');
      const { dialog, batches } = await ask();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Показать внизу страницы' }));
      await screen.findByTestId('page-view');
      expect(batches()).toEqual([[becomePageOp(f.entity.id, f.entity.updatedAt, plan.showBelow)]]);
      await waitFor(() => expect(renderedTexts()).toContain(f.entity.body));
    });
  });
});

describe('«Открыть через …» — разово (§8.4)', () => {
  test('«Открыть через шаблон хоста» — только при шаблоне владельца; после ухода и возврата — снова свой', async () => {
    const f = fixture('project');
    open(f, [template(TPL_A, 'Шаблон A', ['orbis/project'], 'Вид A\n\n{{body}}\n')]);
    await waitFor(() => expect(renderedTexts()).toContain('Вид A'));

    await openMenu();
    expect(menuLabels()).toContain('Открыть через шаблон хоста');
    // Показанный шаблон «открыть через» себя не предлагается.
    expect(menuLabels()).not.toContain('Открыть через „Шаблон A“');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Открыть через шаблон хоста' }));

    expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
    expect(renderedTexts()).not.toContain('Вид A');
    await openMenu();
    expect(menuLabels()).not.toContain('Открыть через шаблон хоста');
    expect(menuLabels()).toContain('Открыть через „Шаблон A“');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId('go-other'));
    await screen.findByText('Соседняя запись');
    fireEvent.click(screen.getByTestId('go-back'));
    await waitFor(() => expect(renderedTexts()).toContain('Вид A'));
    expect(screen.queryByTestId('page-tabs')).toBeNull();
  });

  test('шаблон хоста у записи без своих шаблонов — пункта «через шаблон хоста» нет', async () => {
    open(fixture('project'));
    await screen.findByTestId('page-tabs');
    await openMenu();
    expect(menuLabels().filter((l) => l.startsWith('Открыть через'))).toEqual([]);
  });

  test('«Открыть через „X“» — по пункту на прочие исправные подходящие шаблоны', async () => {
    const f = fixture('project-task');
    open(f, [
      template(TPL_A, 'Шаблон A', ['orbis/project'], 'Вид A\n'),
      template(TPL_B, 'Шаблон B', ['orbis/project', 'orbis/task'], 'Вид B\n'),
      template(TPL_C, 'Шаблон целей', ['orbis/goal'], 'Вид C\n'),
      template(TPL_TOP, 'Сломанный', ['orbis/task'], '{{columns}}\n'),
    ]);
    await waitFor(() => expect(renderedTexts()).toContain('Вид B'));
    await openMenu();
    expect(menuLabels().filter((l) => l.startsWith('Открыть через'))).toEqual([
      'Открыть через шаблон хоста',
      'Открыть через „Шаблон A“',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Открыть через „Шаблон A“' }));
    await waitFor(() => expect(renderedTexts()).toContain('Вид A'));
    expect(renderedTexts()).not.toContain('Вид B');
  });
});

describe('«Сменить выбор шаблона для таких записей» (§4.3)', () => {
  test('только при споре; показывает плашку и при запомненном выборе', async () => {
    const f = fixture('project');
    const { batches } = open(f, [
      template(TPL_A, 'Шаблон A', ['orbis/project'], 'Вид A\n', { winsOver: [TPL_B] }),
      template(TPL_B, 'Шаблон B', ['orbis/project'], 'Вид B\n'),
    ]);
    await waitFor(() => expect(renderedTexts()).toContain('Вид A'));
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();

    await choose('Сменить выбор шаблона для таких записей');
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон B' }));
    await waitFor(() => expect(renderedTexts()).toContain('Вид B'));
    expect(batches()).toHaveLength(1);

    // Повторная просьба после выбора — плашка снова на экране.
    await choose('Сменить выбор шаблона для таких записей');
    expect(await screen.findByTestId('dispute-plaque')).toBeInTheDocument();
  });

  test('одного подходящего шаблона — пункта нет', async () => {
    open(fixture('project'), [template(TPL_A, 'Шаблон A', ['orbis/project'], 'Вид A\n')]);
    await waitFor(() => expect(renderedTexts()).toContain('Вид A'));
    await openMenu();
    expect(menuLabels()).not.toContain('Сменить выбор шаблона для таких записей');
  });

  test('сломанный шаблон на вершине: спор A/C под ним — пункт есть, как и плашка (brokenIds)', async () => {
    open(fixture('project-task'), [
      template(TPL_TOP, 'Сломанный', ['orbis/project', 'orbis/task'], '{{columns}}\n'),
      template(TPL_A, 'Шаблон A', ['orbis/project'], 'Вид A\n'),
      template(TPL_C, 'Шаблон C', ['orbis/project'], 'Вид C\n', {
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
    ]);
    expect(await screen.findByTestId('dispute-plaque')).toBeInTheDocument();
    await openMenu();
    expect(menuLabels()).toContain('Сменить выбор шаблона для таких записей');
  });
});

// --- Страница -----------------------------------------------------------------------------------

describe('меню страницы (§8.4)', () => {
  const PAGE_BODY = 'Моя страница\n\n{{cards}}\n';

  test('пункты страницы; пунктов записи и «Править как markdown» нет', async () => {
    open(asPage(fixture('note-plain'), PAGE_BODY));
    await screen.findByTestId('page-view');
    await openMenu();
    const labels = menuLabels();
    expect(labels).toEqual(
      expect.arrayContaining([
        'Открыть как запись',
        'Сделать шаблоном для…',
        'Перестать быть страницей',
      ]),
    );
    for (const absent of [
      'Сделать страницей',
      'Изменить вид только этой записи',
      'Открыть через шаблон хоста',
      'Сменить выбор шаблона для таких записей',
      'Править как markdown',
    ])
      expect(labels).not.toContain(absent);
  });

  test('«Открыть как запись» — шаблон хоста: версии, тред, обратные ссылки, тело в редакторе экрана', async () => {
    open(asPage(fixture('with-relations'), PAGE_BODY));
    await waitFor(() => expect(renderedTexts()).toContain('Моя страница'));
    // РП-25: своим телом карточки «Страница» нет.
    expect(screen.queryByTestId(`aspect-${PAGE_ASPECT}`)).toBeNull();

    await choose('Открыть как запись');
    const tabs = await screen.findByTestId('page-tabs');
    expect(screen.queryByTestId('page-view')).toBeNull();
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Запись', 'Детали', 'Тред']);
    expect(await screen.findByTestId('versions-card')).toBeInTheDocument();
    expect(screen.getAllByTestId('backlink').length).toBeGreaterThan(0);
    // Через шаблон хоста карточка «Страница» видна, как все (РП-25).
    expect(screen.getByTestId(`aspect-${PAGE_ASPECT}`)).toBeInTheDocument();
    // Тело — настоящим редактором, и его плашки уехали в узел ЭКРАНА над вкладками: провайдер
    // экрана дошёл, инертный провайдер `PageView` (узла плашек нет) его не перекрыл.
    expect(await screen.findByTestId('editor-preview')).toBeInTheDocument();
    const notices = screen.getByTestId('body-notices');
    expect(screen.getByTestId('record-area').contains(notices)).toBe(false);

    await openMenu();
    expect(menuLabels()).not.toContain('Открыть как запись');
    expect(menuLabels()).toContain('Перестать быть страницей');
  });

  test('«Открыть как запись» — разово: после ухода и возврата страница снова своим телом', async () => {
    open(asPage(fixture('note-plain'), PAGE_BODY));
    await screen.findByTestId('page-view');
    await choose('Открыть как запись');
    await screen.findByTestId('page-tabs');
    fireEvent.click(screen.getByTestId('go-other'));
    await screen.findByText('Соседняя запись');
    fireEvent.click(screen.getByTestId('go-back'));
    expect(await screen.findByTestId('page-view')).toBeInTheDocument();
  });

  test('«Сделать шаблоном для…» — служебных и «Страницы» в выборе нет; пачка props «Шаблон для»', async () => {
    const f = asPage(fixture('note-plain'), PAGE_BODY);
    const { batches } = open(f);
    await screen.findByTestId('page-view');
    await choose('Сделать шаблоном для…');
    const dialog = await screen.findByRole('dialog');
    const chips = within(dialog)
      .getAllByRole('checkbox')
      .map((c) => c.closest('label')?.textContent ?? '');
    expect(chips).toContain('Проект');
    expect(chips).not.toContain('Страница');
    expect(chips).not.toContain('Прогон агента');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Проект' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(batches()).toHaveLength(1));
    expect(batches()).toEqual([
      [
        {
          tool: 'entity_update',
          input: { id: f.entity.id, props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/project'] } },
        },
      ],
    ]);
  });

  test('снятие всех аспектов — одна правка: unset «Шаблон для» и «Главнее, чем» (§3.2)', async () => {
    const f = asPage(fixture('note-plain'), PAGE_BODY, {
      [TEMPLATE_FOR_PROPERTY]: ['orbis/project'],
      [TEMPLATE_WINS_OVER_PROPERTY]: [TPL_B],
    });
    const { batches } = open(f, [template(TPL_B, 'Шаблон B', ['orbis/project'], 'Вид B\n')]);
    await screen.findByTestId('page-view');
    await choose('Сделать шаблоном для…');
    const dialog = await screen.findByRole('dialog');
    const chip = within(dialog).getByRole('checkbox', { name: 'Проект' });
    expect(chip).toBeChecked();
    // Порог чипов (`minItems`) в диалоге снят: пустоту диалог пишет снятием.
    expect(chip).not.toBeDisabled();
    fireEvent.click(chip);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(batches()).toHaveLength(1));
    expect(batches()).toEqual([
      [
        {
          tool: 'entity_update',
          input: {
            id: f.entity.id,
            unset: [TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY],
          },
        },
      ],
    ]);
  });

  test('«Перестать быть страницей» — снимается только аспект (РП-22); одна пачка, Undo', async () => {
    const f = asPage(fixture('note-plain'), PAGE_BODY, {
      [TEMPLATE_FOR_PROPERTY]: ['orbis/project'],
    });
    const { batches, world, calls } = open(f);
    await screen.findByTestId('page-view');
    await choose('Перестать быть страницей');
    await waitFor(() => expect(screen.queryByTestId('page-view')).toBeNull());
    expect(batches()).toEqual([
      [{ tool: 'entity_update', input: { id: f.entity.id, aspects: { detach: [PAGE_ASPECT] } } }],
    ]);
    expect(world.rows.get(f.entity.id)?.props[TEMPLATE_FOR_PROPERTY]).toEqual(['orbis/project']);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    expect(await screen.findByTestId('page-view')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  });
});
