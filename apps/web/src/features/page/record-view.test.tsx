/**
 * Экран записи через шаблон (спека страниц 1а §4.2, §4.3, §6.5, §8.3; задача 14).
 *
 * Запись открывается экраном записи (`DetailScreen`) — так, как её откроет человек: обработчик
 * экрана (`structureHandler`), поверх — список шаблонов владельца (`entity.query` текстом
 * `PAGE_TEMPLATES_QUERY`), пачка правок и Undo. Мир шаблонов изменяем: пачка выбора правит его,
 * и перечитанный после инвалидации список несёт запомненный выбор, как у сервера.
 * `this` у блоков данных — только uuid.
 */
import {
  PAGE_ASPECT,
  recordDisputeChoice,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
  templatesFromRows,
} from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { GRAMMAR_ERROR_MESSAGES } from '@orbis/shared/doc/page-grammar';
import { SECOND_CARDS_MESSAGE, secondCardMessage } from '@orbis/shared/doc/placement';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  blocksReply,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { queryClient } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { DetailScreen } from '../entity-detail/DetailScreen';
import { BodyScreenProvider } from '../entity-detail/EntityBody';
import {
  STRUCTURE_FIXTURES,
  type StructureFixture,
  structureHandler,
} from '../entity-detail/structure-fixtures';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { RecordView } from './RecordView';
import { DisputePlaque } from './TemplatePlaques';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';

/**
 * Поломка примитива по флагу — «шаблон бросает при рендере». Колонки есть только в шаблонах
 * владельца этого файла (в шаблоне хоста их нет), теги — только в шаблоне хоста (в базовом виде
 * записи их нет): так падает ровно тот шаблон, о котором тест.
 */
const crash = vi.hoisted(() => ({ columns: false, tags: false }));

vi.mock('./Columns', async (importOriginal) => {
  const real = await importOriginal<typeof import('./Columns')>();
  return {
    ...real,
    Columns: (props: Parameters<typeof real.Columns>[0]) => {
      if (crash.columns) throw new Error('колонки упали (мок)');
      return createElement(real.Columns, props);
    },
  };
});

vi.mock('../entity-detail/TagsBlock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../entity-detail/TagsBlock')>();
  return {
    ...real,
    TagsBlock: () => {
      if (crash.tags) throw new Error('теги упали (мок)');
      return createElement(real.TagsBlock);
    },
  };
});

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  crash.columns = false;
  crash.tags = false;
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
const TPL_A = uuid(1401);
const TPL_B = uuid(1402);
const ARCHIVED_TPL = uuid(1403);
const ACTION_ID = uuid(1499);

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

/** Шаблон владельца: страница с «Шаблон для»; дата создания решает ничью (§4.2 шаг 6). */
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

/** Мир шаблонов владельца — то, что отвечает список; пачка выбора правит его на месте. */
interface World {
  templates: WireEntityFixture[];
  listFails?: boolean;
}

const isTemplatesList = (path: string, input: unknown) =>
  path === 'entity.query' && (input as { query?: string }).query === PAGE_TEMPLATES_QUERY;

/** Пачка правок как её исполнил бы сервер: `props` пишет значение, `unset` его снимает. */
function applyBatch(world: World, input: unknown) {
  const { operations } = input as {
    operations: { tool: string; input: { id: string; props?: object; unset?: string[] } }[];
  };
  for (const op of operations) {
    const row = world.templates.find((t) => t.id === op.input.id);
    if (row === undefined) throw trpcError('NOT_FOUND');
    const props: Record<string, unknown> = { ...row.props, ...op.input.props };
    for (const key of op.input.unset ?? []) delete props[key];
    row.props = props;
  }
}

function openRecord(
  f: StructureFixture,
  world: World,
  opts: { blocks?: Parameters<typeof blocksReply>[0]; over?: MockHandler } = {},
) {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: f.entity.id }], agenda: [], budget: [] },
  });
  const screenHandler = structureHandler(f);
  const blocks = blocksReply(opts.blocks ?? {});
  const handler: MockHandler = async (path, input) => {
    const own = opts.over ? await opts.over(path, input) : undefined;
    if (own !== undefined) return own;
    if (isTemplatesList(path, input)) {
      if (world.listFails) throw trpcError('INTERNAL_SERVER_ERROR', 'база недоступна');
      // Копии строк: кеш запроса не должен видеть правки мира до перечитывания.
      return world.templates.map((t) => ({ ...t, props: { ...t.props } }));
    }
    if (path === 'entity.updateBatch') {
      applyBatch(world, input);
      return { actionId: ACTION_ID, results: [] };
    }
    if (path === 'ai.undo') return { ok: true, actionId: ACTION_ID, results: [] };
    return blocks(path, input) ?? screenHandler(path, input);
  };
  return renderWithProviders(
    <>
      <DetailScreen entityId={f.entity.id} />
      <Toaster />
    </>,
    handler,
    { queries: queryClient.getDefaultOptions().queries },
  );
}

/** Запись другой фикстуры с другим id — «другая запись с тем же набором аспектов». */
const cloneAs = (f: StructureFixture, id: string, title: string): StructureFixture => ({
  ...f,
  name: `${f.name}-copy`,
  entity: { ...f.entity, id, title },
});

const renderedTexts = () => screen.queryAllByTestId('page-text').map((n) => n.textContent ?? '');

describe('выбор шаблона (§4.2)', () => {
  test('нет своих шаблонов → шаблон хоста; список шаблонов уходит, не дожидаясь entity.get', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const f = fixture('note-plain');
    const { calls } = openRecord(
      f,
      { templates: [] },
      {
        over: async (path) => {
          if (path === 'entity.get') await gate;
          return undefined;
        },
      },
    );
    // Ответ записи ещё держится, а список уже спрошен: запросы не ждут друг друга. Склейку в
    // один HTTP даёт `httpBatchLink` прода — обвязкой `mockLink` она не доказуема.
    await waitFor(() => expect(calls.some((c) => isTemplatesList(c.path, c.input))).toBe(true));
    expect(screen.queryByTestId('native-row')).toBeNull();
    release();

    const tabs = await screen.findByTestId('page-tabs');
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Запись', 'Детали', 'Тред']);
    expect(await screen.findByTestId('native-row')).toBeInTheDocument();
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();
    expect(screen.queryByTestId('broken-template')).toBeNull();
  });

  test('шаблон владельца {project} на записи-проекте — рисуется он (живая приёмка 2)', async () => {
    openRecord(fixture('project'), {
      templates: [
        template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n\n{{body}}\n'),
      ],
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    expect(screen.queryByTestId('page-tabs')).toBeNull();
    expect(await screen.findByTestId('editor-preview')).toBeInTheDocument();
  });

  test('сломанный шаблон B{project,task} → рисуется A и плашка «не разобран» ведёт в настройку B', async () => {
    const broken = '{{columns}}\n{{column}}\nлевая\n{{/column}}\n';
    const { calls } = openRecord(fixture('project-task'), {
      templates: [
        template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n'),
        template(TPL_B, 'Большой шаблон', ['orbis/project', 'orbis/task'], broken),
      ],
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    const plaque = screen.getByTestId('broken-template');
    expect(plaque).toHaveTextContent(
      `Шаблон „Большой шаблон“ не разобран: ${GRAMMAR_ERROR_MESSAGES.CONTAINER_UNCLOSED}`,
    );
    // Плашка ведёт в НАСТРОЙКУ шаблона (спека §9.1, задача 16): чинить шаблон — правкой его тела.
    fireEvent.click(
      within(plaque).getByRole('button', { name: 'Настроить шаблон „Большой шаблон“' }),
    );
    expect(await screen.findByTestId('configure-view')).toBeInTheDocument();
    expect(calls).toContainEqual({ path: 'entity.get', input: detailGetInput(TPL_B) });
    // Экран не уходил со своей записи: настройка — режим экрана, а не переход.
    expect(useNav.getState().stacks.browser.at(-1)).toEqual({
      kind: 'entity',
      id: fixture('project-task').entity.id,
    });
  });

  test('повтор одинаковым текстом в единственном шаблоне → шаблон хоста и «не разобран» с причиной «второй» (R-4)', async () => {
    const first = openRecord(fixture('goal'), {
      templates: [
        template(
          TPL_A,
          'Вид цели',
          ['orbis/goal'],
          'Свой вид цели\n\n{{card: orbis/goal}}\n\n{{card: orbis/goal}}\n',
        ),
      ],
    });
    expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
    expect(renderedTexts()).not.toContain('Свой вид цели');
    expect(await screen.findByTestId('broken-template')).toHaveTextContent(
      `Шаблон „Вид цели“ не разобран: ${secondCardMessage('{{card: orbis/goal}}')}`,
    );
    first.unmount();

    openRecord(fixture('goal'), {
      templates: [
        template(TPL_A, 'Вид цели', ['orbis/goal'], 'Свой вид цели\n\n{{cards}}\n\n{{cards}}\n'),
      ],
    });
    expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
    expect(await screen.findByTestId('broken-template')).toHaveTextContent(
      `Шаблон „Вид цели“ не разобран: ${SECOND_CARDS_MESSAGE}`,
    );
  });

  test('шаблон владельца бросает при рендере → «ошибка отрисовки», выбор повторяется', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    crash.columns = true;
    const columns =
      'Вид с колонками\n\n{{columns}}\n{{column}}\nлевая\n{{/column}}\n{{column}}\nправая\n{{/column}}\n{{/columns}}\n';
    openRecord(fixture('project-task'), {
      templates: [
        template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n'),
        template(TPL_B, 'Колоночный', ['orbis/project', 'orbis/task'], columns),
      ],
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    expect(renderedTexts()).not.toContain('Вид с колонками');
    expect(screen.getByTestId('broken-template')).toHaveTextContent(
      'Шаблон „Колоночный“ не разобран: ошибка отрисовки',
    );
  });

  test('упал единственный подходящий шаблон → шаблон хоста с плашкой', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    crash.columns = true;
    openRecord(fixture('project'), {
      templates: [
        template(
          TPL_A,
          'Колоночный',
          ['orbis/project'],
          '{{columns}}\n{{column}}\nа\n{{/column}}\n{{column}}\nб\n{{/column}}\n{{/columns}}\n',
        ),
      ],
    });
    expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
    expect(await screen.findByTestId('broken-template')).toHaveTextContent('ошибка отрисовки');
  });

  test('ошибка списка шаблонов → шаблон хоста и плашка, экран работает (РП-14)', async () => {
    openRecord(fixture('task'), { templates: [], listFails: true });
    expect(await screen.findByTestId('templates-error')).toBeInTheDocument();
    expect(screen.getByTestId('page-tabs')).toBeInTheDocument();
    expect(await screen.findByTestId('native-row')).toBeInTheDocument();
    expect(await screen.findByTestId('editor-preview')).toBeInTheDocument();
  });
});

describe('род тела внутри {{body}} — по самой записи (I-4)', () => {
  const DUE = 'aspect=orbis/task, orbis/due_date<=2026-01-01';
  const body = `{{query: ${DUE}}}\n`;
  const dueRow = wireEntity({
    id: uuid(1450),
    title: 'Просроченный отчёт',
    aspects: ['orbis/task'],
  });

  test('заметка под шаблоном хоста: абсолютная дата — данные, а не плашка', async () => {
    const note = fixture('note-plain');
    openRecord(
      { ...note, entity: { ...note.entity, body, bodyDoc: parseBody(body) } },
      { templates: [] },
      { blocks: { [DUE]: [dueRow] } },
    );
    await screen.findByTestId('page-tabs');
    expect(await screen.findByText('Просроченный отчёт')).toBeInTheDocument();
    expect(screen.queryByTestId('qb-error')).toBeNull();
  });

  test('тот же блок на странице — плашка абсолютной даты', async () => {
    const note = fixture('note-plain');
    openRecord(
      {
        ...note,
        entity: { ...note.entity, aspects: [PAGE_ASPECT], body, bodyDoc: parseBody(body) },
      },
      { templates: [] },
      { blocks: { [DUE]: [dueRow] } },
    );
    expect(await screen.findByTestId('qb-error')).toHaveTextContent('2026-01-01');
    expect(screen.queryByText('Просроченный отчёт')).toBeNull();
  });
});

describe('спор и память (§4.3)', () => {
  const disputeWorld = (winsOverB?: string[]): World => ({
    templates: [
      template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n', {
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      template(TPL_B, 'Шаблон задачи', ['orbis/task'], 'Вид задачи B\n', {
        createdAt: '2026-09-02T00:00:00.000Z',
        ...(winsOverB === undefined ? {} : { winsOver: winsOverB }),
      }),
    ],
  });

  test('спор A{project}/B{task}: раньше созданный и плашка; выбор B — одна пачка, экран на B, Undo', async () => {
    const world = disputeWorld();
    const before = templatesFromRows(world.templates);
    const f = fixture('project-task');
    const { calls, unmount } = openRecord(f, world);

    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    const plaque = screen.getByTestId('dispute-plaque');
    expect(plaque).toHaveTextContent('Для записей „проект + задача“ подходят два шаблона:');
    expect(plaque).toHaveTextContent('Какой использовать?');
    expect(
      within(plaque)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Шаблон проекта', 'Шаблон задачи']);

    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();

    const batches = calls.filter((c) => c.path === 'entity.updateBatch');
    expect(batches).toHaveLength(1);
    const expected = [...recordDisputeChoice(TPL_B, [TPL_A, TPL_B], before)].map(([id, next]) => ({
      tool: 'entity_update',
      input: { id, props: { [TEMPLATE_WINS_OVER_PROPERTY]: next } },
    }));
    expect(expected).toEqual([
      {
        tool: 'entity_update',
        input: { id: TPL_B, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [TPL_A] } },
      },
    ]);
    // Подпись жеста — заголовок записи журнала и «отмени последнее» (B-M2).
    expect(batches[0]?.input).toEqual({ label: 'Выбор шаблона', operations: expected });

    // Тост «Отменить» — Undo всей пачки одним actionId.
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === 'ai.undo').map((c) => c.input)).toEqual([
        { actionId: ACTION_ID },
      ]),
    );
    unmount();

    // Другая запись с тем же спором: выбор запомнен для спора, а не для записи — плашки нет.
    openRecord(cloneAs(f, uuid(1460), 'Другая плитка'), world);
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();
  });

  test('выбор в споре: экран сразу на выбранном шаблоне, не дожидаясь перечитывания списка (Л-2)', async () => {
    const world = disputeWorld();
    let releaseBatch: () => void = () => {};
    const batchHeld = new Promise<void>((r) => {
      releaseBatch = r;
    });
    let listCalls = 0;
    let batchAnswered = false;
    const { calls } = openRecord(fixture('project-task'), world, {
      over: async (path, input) => {
        // Ответ пачки держится воротами: экран обязан переключиться ДО него (патч до записи).
        if (path === 'entity.updateBatch') {
          await batchHeld;
          batchAnswered = true;
          return undefined;
        }
        // Перечитывание списка после записи висит: экран обязан переключиться и без него.
        if (!isTemplatesList(path, input)) return undefined;
        listCalls += 1;
        return listCalls >= 2 ? new Promise(() => {}) : undefined;
      },
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    const plaque = screen.getByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
    expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
    expect(batchAnswered).toBe(false);
    releaseBatch();
    await waitFor(() => expect(batchAnswered).toBe(true));
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();
    expect(renderedTexts()).toContain('Вид задачи B');
  });

  test('отказ пачки выбора: патч откатывается — экран на A, плашка снова с кнопками (Л-2)', async () => {
    const world = disputeWorld();
    let listCalls = 0;
    openRecord(fixture('project-task'), world, {
      over: (path, input) => {
        if (path === 'entity.updateBatch') throw trpcError('INTERNAL_SERVER_ERROR');
        // Перечитывание после отказа висит: экран возвращает ОТКАТ, а не приехавший список.
        if (!isTemplatesList(path, input)) return undefined;
        listCalls += 1;
        return listCalls >= 2 ? new Promise(() => {}) : undefined;
      },
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    fireEvent.click(
      within(screen.getByTestId('dispute-plaque')).getByRole('button', { name: 'Шаблон задачи' }),
    );
    expect(await screen.findByText('Не удалось запомнить выбор шаблона')).toBeInTheDocument();
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    const plaque = screen.getByTestId('dispute-plaque');
    const buttons = within(plaque).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Шаблон проекта', 'Шаблон задачи']);
    for (const b of buttons) expect(b).not.toBeDisabled();
  });

  test('в «Главнее, чем» B — архивный шаблон: запись выбора его вычищает (РП-21)', async () => {
    const world = disputeWorld([ARCHIVED_TPL]);
    const { calls } = openRecord(fixture('project-task'), world);
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'entity.updateBatch')).toBe(true));
    expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toEqual({
      label: 'Выбор шаблона',
      operations: [
        {
          tool: 'entity_update',
          input: { id: TPL_B, props: { [TEMPLATE_WINS_OVER_PROPERTY]: [TPL_A] } },
        },
      ],
    });
  });

  test('повторный выбор текущего победителя — пачки нет, плашка закрывается', async () => {
    const rows = [
      template(TPL_A, 'Шаблон проекта', ['orbis/project'], ''),
      template(TPL_B, 'Шаблон задачи', ['orbis/task'], '', { winsOver: [TPL_A] }),
    ];
    const { calls } = renderWithProviders(
      <DisputePlaque contenders={[TPL_A, TPL_B]} rows={rows} />,
      (path) => (path === 'registry.effective' ? BUILTIN_REGISTRY : {}),
    );
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(screen.queryByTestId('dispute-plaque')).toBeNull());
    expect(calls.some((c) => c.path === 'entity.updateBatch')).toBe(false);
  });
});

describe('гарантии хоста (§8.3)', () => {
  test('шаблон хоста падает при рендере → базовый вид записи: заголовок, тело, карточки', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    crash.tags = true;
    openRecord(fixture('task'), { templates: [] });
    const base = await screen.findByTestId('base-record-view');
    expect(await within(base).findByTestId('native-row')).toBeInTheDocument();
    expect(await within(base).findByTestId('editor-preview')).toBeInTheDocument();
    expect(await within(base).findByTestId('aspect-orbis/task')).toBeInTheDocument();
    expect(screen.queryByTestId('page-tabs')).toBeNull();
  });

  test('шаблон владельца без card: и без cards на записи-цели → карточка цели дописана в конец', async () => {
    const goal = fixture('goal');
    openRecord(goal, {
      templates: [template(TPL_A, 'Шаблон цели', ['orbis/goal'], 'Вид цели\n\n{{body}}\n')],
    });
    await waitFor(() => expect(renderedTexts()).toContain('Вид цели'));
    const section = await screen.findByTestId('aspect-orbis/goal');
    const progress = await screen.findByTestId('goal-progress');
    const body = await screen.findByTestId('editor-preview');
    // «В конец» — после тела, последнего узла шаблона.
    expect(body.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('разовый выбор и ожидание реестра', () => {
  /**
   * `RecordView` напрямую — так его вызовут меню «Открыть через X» (задача 15) и предпросмотр
   * (задача 16): экран тела даёт вызывающий, ответ записи — готовый.
   */
  function renderRecordView(f: StructureFixture, world: World, override: { templateId: string }) {
    const screenHandler = structureHandler(f);
    const handler: MockHandler = (path, input) =>
      isTemplatesList(path, input) ? world.templates : screenHandler(path, input);
    const reply = {
      entity: f.entity,
      relations: [],
      backlinks: [],
      thread: null,
      registryVersion: BUILTIN_REGISTRY.version,
    } as unknown as Parameters<typeof RecordView>[0]['reply'];
    return renderWithProviders(
      <BodyScreenProvider
        value={{
          asMarkdown: false,
          onCloseMarkdown: () => {},
          screenConflict: false,
          noticeHost: null,
          onRefresh: () => {},
          bodyGate: { current: null },
        }}
      >
        <RecordView reply={reply} override={override} />
      </BodyScreenProvider>,
      handler,
    );
  }

  const twoTemplates = (): World => ({
    templates: [
      template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n', {
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      template(TPL_B, 'Шаблон задачи', ['orbis/task'], 'Вид задачи B\n', {
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
    ],
  });

  test('«открыть через шаблон хоста» — хост, хотя подходит свой шаблон', async () => {
    renderRecordView(fixture('project-task'), twoTemplates(), { templateId: 'host' });
    expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
    expect(renderedTexts()).not.toContain('Вид проекта A');
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();
  });

  test('«открыть через „B“» — B без плашки спора; неподходящий шаблон разово не навязывается', async () => {
    const view = renderRecordView(fixture('project-task'), twoTemplates(), { templateId: TPL_B });
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
    expect(screen.queryByTestId('dispute-plaque')).toBeNull();
    view.unmount();

    // Проект без задачи: шаблон задачи ему не подходит — обычный выбор (A).
    renderRecordView(fixture('project'), twoTemplates(), { templateId: TPL_B });
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    expect(renderedTexts()).not.toContain('Вид задачи B');
  });

  test('свой шаблон подходит, а реестра ещё нет — ожидание, а не мигание шаблоном хоста', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    openRecord(
      fixture('project'),
      {
        templates: [template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n')],
      },
      {
        over: async (path) => {
          if (path === 'registry.effective') await gate;
          return undefined;
        },
      },
    );
    expect(await screen.findByTestId('record-view-wait')).toBeInTheDocument();
    expect(screen.queryByTestId('page-tabs')).toBeNull();
    release();
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    expect(screen.queryByTestId('record-view-wait')).toBeNull();
    expect(screen.queryByTestId('page-tabs')).toBeNull();
  });
});

describe('фикс-раунд 1: реестр, пачка спора', () => {
  /** Ворота: пока закрыты, ответ ждёт. */
  const gateOf = () => {
    let open: () => void = () => {};
    const promise = new Promise<void>((r) => {
      open = r;
    });
    return { promise, open };
  };

  test('F1: реестр ещё едет — своя карточка цели уже на экране (С1а-6)', async () => {
    const gate = gateOf();
    openRecord(
      fixture('goal'),
      { templates: [] },
      {
        over: async (path) => {
          if (path === 'registry.effective') await gate.promise;
          return undefined;
        },
      },
    );
    // Карточка `{{card: orbis/goal}}` узнаётся по ключу без реестра: прогресс — с ответом записи.
    expect(await screen.findByTestId('goal-progress')).toBeInTheDocument();
    gate.open();
    // Реестр доехал — карточка та же, дополнилась секцией полей цели.
    expect(await screen.findByTestId('aspect-orbis/goal')).toBeInTheDocument();
    expect(screen.getAllByTestId('goal-progress')).toHaveLength(1);
  });

  test('F2: реестр отказал на записи со своим шаблоном — шаблон хоста и плашка, а не вечный скелет', async () => {
    openRecord(
      fixture('project'),
      {
        templates: [template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n')],
      },
      {
        over: (path) => {
          if (path === 'registry.effective') throw trpcError('INTERNAL_SERVER_ERROR');
          return undefined;
        },
      },
    );
    expect(await screen.findByTestId('registry-error')).toHaveTextContent(
      'Реестр не загрузился — запись показана шаблоном хоста.',
    );
    expect(screen.getByTestId('page-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('record-view-wait')).toBeNull();
    expect(renderedTexts()).not.toContain('Вид проекта A');
  });

  test('F2: смена версии реестра — прежний снимок держится, кадра ожидания нет', async () => {
    let hold: Promise<void> | null = null;
    const gate = gateOf();
    openRecord(
      fixture('project'),
      {
        templates: [
          template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n\n{{body}}\n'),
        ],
      },
      {
        over: async (path) => {
          if (path === 'registry.effective' && hold !== null) await hold;
          return undefined;
        },
      },
    );
    await waitFor(() => expect(renderedTexts()).toContain('Вид проекта A'));
    const body = screen.getByTestId('editor-preview');
    hold = gate.promise;
    act(() => noteRegistryVersion('2.0-следующая'));
    // Новая версия инвалидировала снимок, перечитанный держится воротами — а экран прежний, тело то же.
    expect(screen.queryByTestId('record-view-wait')).toBeNull();
    expect(renderedTexts()).toContain('Вид проекта A');
    expect(screen.getByTestId('editor-preview')).toBe(body);
    gate.open();
  });

  const contradictionWorld = (): World => ({
    templates: [
      template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n', {
        createdAt: '2026-09-01T00:00:00.000Z',
        winsOver: [TPL_B],
      }),
      template(TPL_B, 'Шаблон задачи', ['orbis/task'], 'Вид задачи B\n', {
        createdAt: '2026-09-02T00:00:00.000Z',
        winsOver: [TPL_A],
      }),
    ],
  });

  test('F8: противоречие A>B и B>A, выбор B — у A «Главнее, чем» снимается (unset), а не пишется пустым', async () => {
    const { calls } = openRecord(fixture('project-task'), contradictionWorld());
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'entity.updateBatch')).toBe(true));
    expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toEqual({
      label: 'Выбор шаблона',
      operations: [
        { tool: 'entity_update', input: { id: TPL_A, unset: [TEMPLATE_WINS_OVER_PROPERTY] } },
      ],
    });
  });

  test('F5: после записанного выбора плашка закрыта ещё до перечитывания списка — второй пачки нет', async () => {
    const world = disputeWorldFor();
    const listGate = gateOf();
    let written = false;
    const { calls } = openRecord(fixture('project-task'), world, {
      over: async (path, input) => {
        if (path === 'entity.updateBatch') written = true;
        // Перечитывание списка после записи держится: окно, в котором кнопки были бы живы.
        if (written && isTemplatesList(path, input)) await listGate.promise;
        return undefined;
      },
    });
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(screen.queryByTestId('dispute-plaque')).toBeNull());
    expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
    listGate.open();
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
  });

  test('F6: отказ пачки перечитывает список шаблонов', async () => {
    const { calls } = openRecord(fixture('project-task'), disputeWorldFor(), {
      over: (path) => {
        if (path === 'entity.updateBatch') throw trpcError('BAD_REQUEST', 'цель архивна');
        return undefined;
      },
    });
    const plaque = await screen.findByTestId('dispute-plaque');
    const lists = () => calls.filter((c) => isTemplatesList(c.path, c.input)).length;
    const before = lists();
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    // Плашка осталась: выбор не записан, спросить снова честно.
    expect(screen.getByTestId('dispute-plaque')).toBeInTheDocument();
  });

  test('C1-I4: двойное нажатие, пока пачка в полёте, — одна пачка', async () => {
    const batchGate = gateOf();
    const { calls } = openRecord(fixture('project-task'), disputeWorldFor(), {
      over: async (path) => {
        if (path === 'entity.updateBatch') await batchGate.promise;
        return undefined;
      },
    });
    const plaque = await screen.findByTestId('dispute-plaque');
    const choice = within(plaque).getByRole('button', { name: 'Шаблон задачи' });
    fireEvent.click(choice);
    await waitFor(() => expect(choice).toBeDisabled());
    fireEvent.click(choice);
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон проекта' }));
    batchGate.open();
    await waitFor(() => expect(screen.queryByTestId('dispute-plaque')).toBeNull());
    expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
  });

  test('C1-I4: отказ пачки — тост плашки, плашка остаётся, кнопки снова нажимаемы', async () => {
    openRecord(fixture('project-task'), disputeWorldFor(), {
      over: (path) => {
        if (path === 'entity.updateBatch') throw trpcError('BAD_REQUEST', 'цель архивна');
        return undefined;
      },
    });
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    expect(await screen.findByText('Не удалось запомнить выбор шаблона')).toBeInTheDocument();
    const again = await screen.findByTestId('dispute-plaque');
    await waitFor(() =>
      expect(within(again).getByRole('button', { name: 'Шаблон задачи' })).toBeEnabled(),
    );
  });

  test('MUT-M5: две правки выбора (у проигравшего вычищается архивный) — одной пачкой, один Undo', async () => {
    // У A в «Главнее, чем» — архивный шаблон: он A не делает главнее B, спор стоит; выбор B
    // пишет B → [A] и снимает у A вычищенный список — две правки.
    const world: World = {
      templates: [
        template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n', {
          createdAt: '2026-09-01T00:00:00.000Z',
          winsOver: [ARCHIVED_TPL],
        }),
        template(TPL_B, 'Шаблон задачи', ['orbis/task'], 'Вид задачи B\n', {
          createdAt: '2026-09-02T00:00:00.000Z',
        }),
      ],
    };
    const { calls } = openRecord(fixture('project-task'), world);
    const plaque = await screen.findByTestId('dispute-plaque');
    fireEvent.click(within(plaque).getByRole('button', { name: 'Шаблон задачи' }));
    await waitFor(() => expect(renderedTexts()).toContain('Вид задачи B'));
    const batches = calls.filter((c) => c.path === 'entity.updateBatch');
    expect(batches).toHaveLength(1);
    const ops = (batches[0]?.input as { operations: unknown[] }).operations;
    expect(ops).toHaveLength(2);
  });
});

/** Спор A{project} / B{task} без запомненного выбора — для тестов фикс-раунда. */
function disputeWorldFor(): World {
  return {
    templates: [
      template(TPL_A, 'Шаблон проекта', ['orbis/project'], 'Вид проекта A\n', {
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      template(TPL_B, 'Шаблон задачи', ['orbis/task'], 'Вид задачи B\n', {
        createdAt: '2026-09-02T00:00:00.000Z',
      }),
    ],
  };
}
