/**
 * Настройка страниц и шаблонов и предпросмотр шаблона (спека страниц 1а §9; задача 16).
 *
 * Экран записи открывается так, как его откроет человек (`DetailScreen`), поверх обработчика экрана
 * (`structureHandler`) — мир: шаблоны владельца, страницы и подходящие записи. Подходящие записи
 * предпросмотра отдаёт `entity.query {ast}` по аспектам набора — мок сверяет аспекты, как сервер.
 * `this` у блоков данных — только uuid.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import type { QueryAst } from '@orbis/shared/query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { goBack } from '../../app/history';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { openEntity, useNav } from '../../state/navigation';
import {
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
import { BODY_BLOCKED, BODY_SAVING } from '../entity-detail/body-gate';
import { resetDetailMenuModuleForTests } from '../entity-detail/DetailMenuSlot';
import { DetailScreen } from '../entity-detail/DetailScreen';
import {
  STRUCTURE_FIXTURES,
  type StructureFixture,
  structureHandler,
} from '../entity-detail/structure-fixtures';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { previewCandidatesAst } from './TemplatePreview';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  useToastStore.setState({ toasts: [] });
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Простой — сразу: редактор, которому позволено встать, встаёт; тело только для чтения — нет. */
const idleNow = () =>
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 1;
  });
/** Простоя нет вовсе: проверяется первый кадр. */
const idleNever = () => vi.stubGlobal('requestIdleCallback', () => 1);

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TPL = uuid(1601);
const PAGE = uuid(1602);
const PROJECT_B = uuid(1603);

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

/** Проект — запись экрана; последняя изменённая из подходящих. */
const PROJECT_A: StructureFixture = (() => {
  const f = fixture('project');
  return {
    ...f,
    entity: {
      ...f.entity,
      body: 'Смета кухни',
      bodyDoc: parseBody('Смета кухни'),
      updatedAt: '2026-09-24T10:00:00.000Z',
    },
  };
})();

const TEMPLATE_BODY = 'Вид проекта\n\n{{title}}\n\n{{body}}';

/** Шаблон владельца «Проекты» — страница с «Шаблон для: Проект». */
const projectsTemplate = (): WireEntityFixture =>
  wireEntity({
    id: TPL,
    title: 'Проекты',
    body: TEMPLATE_BODY,
    bodyDoc: parseBody(TEMPLATE_BODY),
    aspects: [PAGE_ASPECT],
    createdAt: '2026-09-01T00:00:00.000Z',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/project'] },
  });

const secondProject = (): WireEntityFixture =>
  wireEntity({
    id: PROJECT_B,
    title: 'Дача',
    body: 'Тело дачи',
    bodyDoc: parseBody('Тело дачи'),
    aspects: ['orbis/project'],
    updatedAt: '2026-09-10T10:00:00.000Z',
  });

const PAGE_BODY =
  '{{columns}}\n{{column}}\nлевая часть\n{{/column}}\n{{column}}\nправая часть\n{{/column}}\n{{/columns}}';

/** Страница-дашборд без «Шаблон для» — черновик шаблона. */
const dashboard = (): WireEntityFixture =>
  wireEntity({
    id: PAGE,
    title: 'Дашборд',
    body: PAGE_BODY,
    bodyDoc: parseBody(PAGE_BODY),
    aspects: [PAGE_ASPECT],
  });

const aspectsOfFilter = (ast: QueryAst): string[] => {
  const f = ast.filter as { and?: { aspect: string }[] } | null;
  return f?.and?.map((n) => n.aspect) ?? [];
};

/**
 * Мир экрана: основная запись — обработчиком экрана со своими связями, прочие записи — голыми;
 * список шаблонов — страницы с непустым «Шаблон для»; подходящие записи — по аспектам дерева,
 * последние изменённые первыми, как отсортировал бы сервер.
 */
function open(main: StructureFixture, rows: WireEntityFixture[], over?: MockHandler) {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: main.entity.id }], agenda: [], budget: [] },
  });
  const all = [main.entity, ...rows];
  const base = structureHandler(main);
  const handler: MockHandler = async (path, input, type) => {
    const own = over ? await over(path, input, type) : undefined;
    if (own !== undefined) return own;
    if (path === 'entity.query') {
      const q = input as { query?: string; ast?: QueryAst };
      if (q.query === PAGE_TEMPLATES_QUERY) {
        return all.filter((r) => {
          const tf = r.props[TEMPLATE_FOR_PROPERTY];
          return r.aspects.includes(PAGE_ASPECT) && Array.isArray(tf) && tf.length > 0;
        });
      }
      if (q.ast !== undefined) {
        const need = aspectsOfFilter(q.ast);
        return all
          .filter((r) => need.every((a) => r.aspects.includes(a)))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      }
    }
    if (path === 'entity.get') {
      const id = (input as { id: string }).id;
      const row = rows.find((r) => r.id === id);
      if (row !== undefined) return structureHandler({ name: 'row', entity: row })(path, input);
    }
    return base(path, input);
  };
  const r = renderWithProviders(
    <Screen first={main.entity.id} others={rows.map((row) => row.id)} />,
    handler,
    { queries: queryClient.getDefaultOptions().queries },
  );
  const astCalls = () =>
    r.calls
      .filter((c) => c.path === 'entity.query' && (c.input as { ast?: unknown }).ast !== undefined)
      .map((c) => (c.input as { ast: QueryAst }).ast);
  return { ...r, astCalls };
}

/**
 * Экран записи с переходами на соседние записи: роутер монтирует экран без key, переход меняет
 * только проп — ровно так, как в приложении.
 */
function Screen({ first, others }: { first: string; others: string[] }) {
  const [id, setId] = useState(first);
  return (
    <>
      {[first, ...others].map((to) => (
        <button key={to} type="button" data-testid={`go-${to}`} onClick={() => setId(to)}>
          перейти
        </button>
      ))}
      <DetailScreen entityId={id} />
      <Toaster />
    </>
  );
}

const asScreen = (entity: WireEntityFixture): StructureFixture => ({ name: 'screen', entity });

async function choose(label: string): Promise<void> {
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

const menuLabels = async () => {
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
  const labels = screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return labels;
};

const frameLabels = () =>
  screen.getAllByTestId('layout-frame-label').map((n) => n.textContent ?? '');

/** Сервер правки тела: `hold` держит ответ, `reject` — отказывает правке по существу. */
function bodyServer(opts: { hold?: Promise<void>; reject?: boolean }): MockHandler {
  return async (path, input) => {
    if (path !== 'entity.update') return undefined;
    if (opts.hold !== undefined) await opts.hold;
    if (opts.reject === true) throw trpcError('BAD_REQUEST', 'тело не принято');
    const inp = input as { bodyDoc?: { v: number; doc: object } };
    const base = dashboard();
    return {
      ...base,
      updatedAt: '2026-09-25T13:00:00.000Z',
      ...(inp.bodyDoc === undefined
        ? {}
        : { bodyDoc: inp.bodyDoc, body: serializeBody(inp.bodyDoc as never) }),
    };
  };
}

// --- «Настроить» -------------------------------------------------------------------------------

test('«Настроить» у страницы → тело страницы в редакторе (род «страница»), «Готово» → показ', async () => {
  idleNever();
  open(asScreen(dashboard()), [], bodyServer({}));
  // Показ — раскладкой колонок.
  await screen.findByTestId('page-columns');
  await choose('Настроить');

  const view = await screen.findByTestId('configure-view');
  // Контейнеры — подписанными рамками одна под другой (§9.1), а не раскладкой показа.
  await waitFor(() => expect(frameLabels()).toEqual(['Колонка 1', 'Колонка 2']));
  expect(screen.queryByTestId('page-columns')).toBeNull();
  expect(within(view).queryByTestId('template-banner')).toBeNull();

  // Касание текста поднимает ТОТ ЖЕ редактор, что у тела записи, и он — под родом страницы:
  // меню «/» предлагает контейнеры (у заметки их нет).
  await userEvent.click(within(view).getByText('левая часть'));
  // Коробка редактора встаёт раньше его contenteditable (ProseMirror монтируется эффектом) — ждём
  // именно область правки.
  await waitFor(() =>
    expect(
      within(view).getByTestId('body-editor').querySelector('[contenteditable]'),
    ).not.toBeNull(),
  );
  await userEvent.keyboard(' /колон');
  const menu = await screen.findByTestId('slash-menu');
  expect(
    within(menu)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Колонкираскладка страницы']);
  await userEvent.keyboard('{Escape}');

  // Набранное « /колон» ещё не сохранено: «Готово» досылает его и ждёт (остаток 1а №86), а после
  // ответа сервера закрывает настройку.
  await waitFor(() => {
    fireEvent.click(within(view).getByRole('button', { name: 'Готово' }));
    expect(screen.queryByTestId('configure-view')).toBeNull();
  });
  await screen.findByTestId('page-columns');
});

test('«Настроить шаблон „Проекты“» с записи, открытой шаблоном владельца → редактор шаблона с баннером', async () => {
  idleNever();
  const { calls } = open(PROJECT_A, [projectsTemplate()]);
  await waitFor(() =>
    expect(screen.queryAllByTestId('page-text').map((n) => n.textContent)).toContain('Вид проекта'),
  );
  await choose('Настроить шаблон „Проекты“');

  const view = await screen.findByTestId('configure-view');
  expect(await within(view).findByTestId('template-banner')).toHaveTextContent(
    'Вы правите шаблон — изменится вид всех записей с аспектом „Проект“',
  );
  // Тело ШАБЛОНА (не записи): заглушки обвязки, `{{body}}` законен — род «шаблон».
  await waitFor(() =>
    expect(
      within(view)
        .getAllByTestId('record-stub')
        .map((n) => n.textContent),
    ).toEqual(['[Заголовок записи]', '[Тело записи]']),
  );
  expect(within(view).queryByText('Смета кухни')).toBeNull();
  expect(calls).toContainEqual({ path: 'entity.get', input: detailGetInput(TPL) });
  // Экран остался на своей записи: настройка — режим экрана, не переход.
  expect(useNav.getState().stacks.browser.at(-1)).toEqual({
    kind: 'entity',
    id: PROJECT_A.entity.id,
  });
});

test('плашка «шаблон не разобран» открывает настройку этого шаблона', async () => {
  idleNever();
  const broken = wireEntity({
    ...projectsTemplate(),
    body: '{{columns}}\n{{column}}\nлевая\n{{/column}}\n',
    bodyDoc: parseBody('левая'),
  });
  const { calls } = open(PROJECT_A, [broken]);
  const plaque = await screen.findByTestId('broken-template');
  fireEvent.click(within(plaque).getByRole('button', { name: 'Настроить шаблон „Проекты“' }));
  expect(await screen.findByTestId('template-banner')).toHaveTextContent('„Проект“');
  expect(calls).toContainEqual({ path: 'entity.get', input: detailGetInput(TPL) });
});

// --- Предпросмотр -------------------------------------------------------------------------------

test('открытый шаблон — плашкой «Шаблон для: Проект · предпросмотр на: [запись ▾]», по умолчанию последняя изменённая', async () => {
  idleNow();
  const tpl = projectsTemplate();
  const { calls, astCalls } = open(asScreen(tpl), [secondProject(), PROJECT_A.entity]);
  const plaque = await screen.findByTestId('template-preview-plaque');
  // Подпись аспекта — по реестру (едет своим запросом).
  await waitFor(() => expect(plaque).toHaveTextContent('Шаблон для: Проект · предпросмотр на:'));
  // Подходящие — деревом: все аспекты набора, последние изменённые, двадцать.
  expect(astCalls()).toEqual([previewCandidatesAst(['orbis/project'])]);
  expect(previewCandidatesAst(['orbis/project'])).toEqual({
    filter: { and: [{ aspect: 'orbis/project' }] },
    sortBy: [{ field: 'orbis/updated_at', dir: 'desc' }],
    limit: 20,
  });
  const select = within(plaque).getByRole('combobox', { name: 'предпросмотр на:' });
  await waitFor(() => expect(select).toHaveValue(PROJECT_A.entity.id));

  // Шаблон — на записи: её заголовок и её тело на месте `{{body}}`, данные — своим entity.get.
  await waitFor(() => expect(screen.getByText('Смета кухни')).toBeInTheDocument());
  expect(screen.getAllByText('Вид проекта').length).toBeGreaterThan(0);
  expect(calls).toContainEqual({ path: 'entity.get', input: detailGetInput(PROJECT_A.entity.id) });

  // Тело записи — только чтение: редактор не встаёт ни по простою, ни по касанию.
  fireEvent.click(screen.getByText('Смета кухни'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('body-editor')).toBeNull();
  expect(document.querySelector('[contenteditable="true"]')).toBeNull();

  // Другая запись — выбором.
  fireEvent.change(select, { target: { value: PROJECT_B } });
  await waitFor(() => expect(screen.getByText('Тело дачи')).toBeInTheDocument());
  expect(screen.queryByText('Смета кухни')).toBeNull();
});

test('подходящих записей нет — шаблон показан сам на себе (this — страница)', async () => {
  idleNever();
  open(asScreen(projectsTemplate()), []);
  const plaque = await screen.findByTestId('template-preview-plaque');
  const view = await screen.findByTestId('page-view');
  expect(within(plaque).getByRole('combobox')).toHaveValue(TPL);
  // Сам на себе `{{body}}` — заглушка (тела записи у шаблона нет, §6.4).
  expect(await within(view).findByTestId('body-stub')).toHaveTextContent('[Тело записи]');
});

test('«Предпросмотр на записи…» у страницы без «Шаблон для» → выбор записи и тот же показ', async () => {
  idleNow();
  const draftBody = 'Черновик вида\n\n{{body}}';
  const draft = wireEntity({ ...dashboard(), body: draftBody, bodyDoc: parseBody(draftBody) });
  const { astCalls } = open(asScreen(draft), [secondProject()]);
  await screen.findByTestId('page-view');
  expect(screen.queryByTestId('template-preview-plaque')).toBeNull();
  await choose('Предпросмотр на записи…');

  const plaque = await screen.findByTestId('template-preview-plaque');
  expect(plaque).toHaveTextContent('Шаблон для: — · предпросмотр на:');
  // Черновику подходит любая запись.
  expect(astCalls()).toEqual([previewCandidatesAst([])]);
  const select = within(plaque).getByRole('combobox');
  await waitFor(() => expect(select).toHaveValue(PROJECT_B));
  await waitFor(() => expect(screen.getByText('Тело дачи')).toBeInTheDocument());
  expect(screen.getAllByText('Черновик вида').length).toBeGreaterThan(0);
  expect(document.querySelector('[contenteditable="true"]')).toBeNull();

  fireEvent.click(within(plaque).getByRole('button', { name: 'Закрыть предпросмотр' }));
  await waitFor(() => expect(screen.queryByTestId('template-preview-plaque')).toBeNull());
  expect(screen.getByTestId('page-view')).toBeInTheDocument();
});

test('пункты меню: у шаблона нет «Предпросмотра на записи…», у записи через хост — нет «Настроить шаблон»', async () => {
  idleNever();
  const first = open(asScreen(projectsTemplate()), []);
  await screen.findByTestId('template-preview-plaque');
  const tplLabels = await menuLabels();
  expect(tplLabels).toContain('Настроить');
  expect(tplLabels).not.toContain('Предпросмотр на записи…');
  first.unmount();

  open(PROJECT_A, []);
  await screen.findByTestId('page-tabs');
  const hostLabels = await menuLabels();
  expect(hostLabels.some((l) => l.startsWith('Настроить'))).toBe(false);
});

// --- Переходы и снимки ------------------------------------------------------------------------

const PAGE_B = uuid(1604);
const TPL_2 = uuid(1605);

test('переход на другую запись закрывает настройку и предпросмотр', async () => {
  idleNever();
  const other = wireEntity({
    ...dashboard(),
    id: PAGE_B,
    title: 'Второй дашборд',
    body: 'Текст второго',
    bodyDoc: parseBody('Текст второго'),
  });
  open(asScreen(dashboard()), [other, secondProject()]);
  await screen.findByTestId('page-columns');
  await choose('Настроить');
  await screen.findByTestId('configure-view');

  // Настройка — про ТУ страницу, из чьего меню её открыли: переехав, она правила бы чужое тело.
  fireEvent.click(screen.getByTestId(`go-${PAGE_B}`));
  await waitFor(() => expect(screen.getByText('Текст второго')).toBeInTheDocument());
  expect(screen.queryByTestId('configure-view')).toBeNull();

  await choose('Предпросмотр на записи…');
  await screen.findByTestId('template-preview-plaque');
  fireEvent.click(screen.getByTestId(`go-${PAGE}`));
  await screen.findByTestId('page-columns');
  expect(screen.queryByTestId('template-preview-plaque')).toBeNull();
});

test('выбор записи предпросмотра не переезжает на другой шаблон', async () => {
  idleNever();
  const tpl2 = wireEntity({ ...projectsTemplate(), id: TPL_2, title: 'Проекты 2' });
  open(asScreen(tpl2), [projectsTemplate(), secondProject(), PROJECT_A.entity]);
  const select = () => within(screen.getByTestId('template-preview-plaque')).getByRole('combobox');
  await waitFor(() => expect(select()).toHaveValue(PROJECT_A.entity.id));

  // На первом шаблоне выбрана не последняя изменённая запись…
  fireEvent.click(screen.getByTestId(`go-${TPL}`));
  await waitFor(() => expect(select()).toHaveValue(PROJECT_A.entity.id));
  fireEvent.change(select(), { target: { value: PROJECT_B } });
  await waitFor(() => expect(screen.getByText('Тело дачи')).toBeInTheDocument());

  // …а вернувшись на второй (он в кеше — экран не размонтируется), видим его умолчание.
  fireEvent.click(screen.getByTestId(`go-${TPL_2}`));
  await waitFor(() => expect(select()).toHaveValue(PROJECT_A.entity.id));
  await waitFor(() => expect(screen.getByText('Смета кухни')).toBeInTheDocument());
});

test('страницы и сама страница не предлагаются записью предпросмотра', async () => {
  idleNever();
  const otherPage = wireEntity({
    id: PAGE_B,
    title: 'Чужая страница',
    body: 'x',
    aspects: [PAGE_ASPECT, 'orbis/project'],
  });
  // Черновику подходит любая запись — в выдаче и сама страница, и чужая страница.
  open(asScreen(dashboard()), [otherPage, secondProject()]);
  await screen.findByTestId('page-columns');
  await choose('Предпросмотр на записи…');
  const plaque = await screen.findByTestId('template-preview-plaque');
  await waitFor(() => expect(within(plaque).getByRole('combobox')).toHaveValue(PROJECT_B));
  expect(
    within(plaque)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['Дача', 'сама страница']);
});

// --- Несохранённая правка настройки (остаток 1а №86) -------------------------------------------

describe('несохранённая правка настройки не молчит', () => {
  /**
   * Правка тела в редакторе настройки, НЕ дождавшаяся паузы автосохранения: командой живого
   * редактора (Tiptap кладёт себя в `dom.editor`) — тем же путём `onUpdate`, что и набор.
   */
  async function editUnsent(view: HTMLElement, tail: string): Promise<void> {
    await userEvent.click(within(view).getByText('левая часть'));
    const field = await waitFor(() => {
      const node = within(view).getByTestId('body-editor').querySelector('[contenteditable]');
      if (node === null) throw new Error('редактор не встал');
      return node as HTMLElement & { editor: Editor };
    });
    let at = -1;
    field.editor.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text === 'левая часть') at = pos + node.text.length;
    });
    act(() => {
      field.editor.commands.insertContentAt(at, tail);
    });
  }

  const done = (view: HTMLElement) => within(view).getByRole('button', { name: 'Готово' });
  const updates = (calls: { path: string }[]) => calls.filter((c) => c.path === 'entity.update');

  async function configure(over: MockHandler) {
    idleNever();
    const r = open(asScreen(dashboard()), [secondProject()], over);
    await screen.findByTestId('page-columns');
    await choose('Настроить');
    const view = await screen.findByTestId('configure-view');
    await waitFor(() => expect(within(view).getByText('левая часть')).toBeInTheDocument());
    return { ...r, view };
  }

  test('«Готово» до паузы автосохранения — правка уходит, тост, настройка на месте; после ответа «Готово» закрывает', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, view } = await configure(bodyServer({ hold }));
    await editUnsent(view, ' ХВОСТ');
    expect(updates(calls)).toEqual([]);

    fireEvent.click(done(view));
    expect(await screen.findByText(BODY_SAVING)).toBeInTheDocument();
    expect(screen.getByTestId('configure-view')).toBe(view);
    await waitFor(() => expect(updates(calls)).toHaveLength(1));
    expect(JSON.stringify(updates(calls)[0])).toContain('ХВОСТ');

    release();
    await waitFor(() => {
      fireEvent.click(done(view));
      expect(screen.queryByTestId('configure-view')).toBeNull();
    });
    await screen.findByTestId('page-columns');
  });

  test('сервер отверг правку — «Готово» говорит «не сохранена», настройка и плашка тела на месте', async () => {
    const { calls, view } = await configure(bodyServer({ reject: true }));
    await editUnsent(view, ' ХВОСТ');
    fireEvent.click(done(view));
    await waitFor(() => expect(updates(calls)).toHaveLength(1));
    // Отказ по существу: тело говорит о нём своей плашкой.
    expect(await within(view).findByTestId('save-indicator')).toHaveTextContent('Правка отклонена');
    useToastStore.setState({ toasts: [] });
    fireEvent.click(done(view));
    expect(await screen.findByText(BODY_BLOCKED)).toBeInTheDocument();
    expect(screen.queryByText(BODY_SAVING)).toBeNull();
    expect(screen.getByTestId('configure-view')).toBe(view);
    expect(within(view).getByTestId('save-indicator')).toBeInTheDocument();
    // Досылать обречённое не станем.
    expect(updates(calls)).toHaveLength(1);
  });

  test('«назад» и переход на другую запись при неотправленной правке — настройка на месте, стек прежний, тост', async () => {
    const { view } = await configure(bodyServer({ hold: new Promise(() => {}) }));
    await editUnsent(view, ' ХВОСТ');
    const back = vi.spyOn(window.history, 'back');
    const stacks = useNav.getState().stacks;

    const toasts = () => useToastStore.getState().toasts.map((t) => t.title);

    goBack();
    expect(toasts()).toContain(BODY_SAVING);
    expect(back).not.toHaveBeenCalled();

    useToastStore.setState({ toasts: [] });
    openEntity(PROJECT_B);
    expect(toasts()).toContain(BODY_SAVING);
    expect(useNav.getState().stacks).toEqual(stacks);
    expect(screen.getByTestId('configure-view')).toBe(view);
  });

  test('без неотправленного «Готово», «назад» и переход работают сразу', async () => {
    const { view } = await configure(bodyServer({}));
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});

    goBack();
    expect(back).toHaveBeenCalledTimes(1);
    openEntity(PROJECT_B);
    expect(useNav.getState().stacks.browser.at(-1)).toEqual({ kind: 'entity', id: PROJECT_B });

    fireEvent.click(done(view));
    await screen.findByTestId('page-columns');
    expect(screen.queryByTestId('configure-view')).toBeNull();
    expect(screen.queryByText(BODY_SAVING)).toBeNull();
  });
});
