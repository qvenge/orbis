/**
 * Шаблон хоста — запись поставки (спека 1б §9.2) и свои карточки `{{cards: own}}` (§8.5; С1б-9).
 *
 * Экран записи открывается так, как его откроет человек (`DetailScreen`), поверх обработчика экрана
 * (`structureHandler`: записи поставки — по варианту фикстуры), поверх — список шаблонов владельца и
 * записи поставки этого теста.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY, templatesFromRows } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
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
import { resetDetailMenuModuleForTests } from '../entity-detail/DetailMenuSlot';
import { DetailScreen } from '../entity-detail/DetailScreen';
import {
  HOST_TEMPLATE_RECORD_BODY,
  HOST_TEMPLATE_RECORD_ID,
  type HostTemplateVariant,
  hostTemplateRecord,
  STRUCTURE_FIXTURES,
  type StructureFixture,
  structureHandler,
} from '../entity-detail/structure-fixtures';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';
import { SUPPLY_RECORDS_QUERY } from './useSupplyRecords';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  // Редактор, вставший сам по таймеру простоя, менял бы дерево посреди проверки.
  vi.stubGlobal('requestIdleCallback', () => 1);
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fixture = (name: string): StructureFixture => {
  const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) throw new Error(`нет фикстуры ${name}`);
  return f;
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Экран записи: обработчик экрана по варианту шаблона хоста; `templates` — ответ списка шаблонов
 * владельца, `supply` — ответ записей поставки вместо варианта; `supplyGate` держит этот ответ до
 * своего разрешения, `supplyFails` — отказ одного этого запроса.
 */
function open(
  f: StructureFixture,
  opts: {
    hostTemplate?: HostTemplateVariant;
    templates?: WireEntityFixture[];
    supply?: WireEntityFixture[];
    supplyGate?: Promise<void>;
    supplyFails?: boolean;
  } = {},
) {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: f.entity.id }], agenda: [], budget: [] },
  });
  const base = structureHandler(
    f,
    opts.hostTemplate === undefined ? {} : { hostTemplate: opts.hostTemplate },
  );
  const handler: MockHandler = async (path, input, type) => {
    const q = (input as { query?: unknown } | undefined)?.query;
    if (path === 'entity.query' && q === PAGE_TEMPLATES_QUERY) return opts.templates ?? [];
    if (path === 'entity.query' && q === SUPPLY_RECORDS_QUERY) {
      if (opts.supplyGate !== undefined) await opts.supplyGate;
      if (opts.supplyFails === true)
        throw trpcError('INTERNAL_SERVER_ERROR', 'поставка недоступна');
      if (opts.supply !== undefined) return opts.supply;
    }
    return base(path, input, type);
  };
  return renderWithProviders(<DetailScreen entityId={f.entity.id} />, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

async function menuLabels(): Promise<string[]> {
  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
  const labels = screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return labels;
}

const pageTexts = () => screen.queryAllByTestId('page-text').map((n) => n.textContent ?? '');

// --- (г) запись шаблона хоста ------------------------------------------------------------------

test('запись шаблона хоста рисуется своим телом рода «шаблон»: {{body}} — заглушка, без BLOCK_MISPLACED (§9.2)', async () => {
  const record = hostTemplateRecord();
  open({ name: 'host-template', entity: record });
  const plaque = await screen.findByTestId('template-preview-plaque');
  // Подходящих записей в мире нет — шаблон сам на себе, как шаблон владельца (1а §9.3).
  const view = await screen.findByTestId('page-view');
  expect(await within(view).findByTestId('body-stub')).toHaveTextContent('[Тело записи]');
  expect(within(view).queryByTestId('block-misplaced')).toBeNull();
  // Шаблон хоста — не «Шаблон для: —»: его «набор» — все записи без своего шаблона.
  expect(plaque).toHaveTextContent('Шаблон хоста');
});

test('запись шаблона хоста — не кандидат выбора, даже с «Шаблон для» (templatesFromRows, §9.2)', async () => {
  const record = hostTemplateRecord(`Своя строка кандидата\n\n${HOST_TEMPLATE_RECORD_BODY}`, {
    props: {
      ...hostTemplateRecord().props,
      [TEMPLATE_FOR_PROPERTY]: ['orbis/task'],
    },
  });
  expect(templatesFromRows([record])).toEqual([]);
  // На экране: список шаблонов её несёт, а записей поставки нет — стань она кандидатом, задача
  // показалась бы ею; не кандидат — эталоном кода.
  open(fixture('task'), { templates: [record], hostTemplate: 'none' });
  await screen.findByTestId('page-tabs');
  await new Promise((r) => setTimeout(r, 50));
  expect(pageTexts()).not.toContain('Своя строка кандидата');
});

test('правка записи шаблона хоста меняет вид записи (§9.2: шаблон хоста — тело записи поставки)', async () => {
  const edited = hostTemplateRecord(`Своя строка шаблона хоста\n\n${HOST_TEMPLATE_RECORD_BODY}`);
  open(fixture('task'), { supply: [edited] });
  await waitFor(() => expect(pageTexts()).toContain('Своя строка шаблона хоста'));
  expect(screen.queryByTestId('host-template-broken')).toBeNull();
});

test('запись шаблона хоста сломана — эталон кода и плашка с причиной и выходом в настройку', async () => {
  open(fixture('task'), { hostTemplate: 'broken' });
  const plaque = await screen.findByTestId('host-template-broken');
  expect(plaque).toHaveTextContent('Шаблон хоста повреждён — показан эталон поставки');
  expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
  fireEvent.click(within(plaque).getByRole('button', { name: 'Настроить шаблон хоста' }));
  expect(await screen.findByTestId('template-banner')).toHaveTextContent('шаблон хоста');
});

test('«⋯» записи через шаблон хоста — «Настроить шаблон хоста»; настройка — с баннером шаблона хоста', async () => {
  const { calls } = open(fixture('task'));
  await screen.findByTestId('page-tabs');
  await waitFor(async () => expect(await menuLabels()).toContain('Настроить шаблон хоста'));

  fireEvent.keyDown(await screen.findByTestId('detail-menu'), { key: 'Enter' });
  await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Настроить шаблон хоста' }));
  const view = await screen.findByTestId('configure-view');
  expect(await within(view).findByTestId('template-banner')).toHaveTextContent(
    'Вы правите шаблон хоста — изменится вид всех записей, для которых нет своего шаблона',
  );
  // Тело ЗАПИСИ ПОСТАВКИ в редакторе рода «шаблон»: `{{body}}` — заглушка, а не плашка места.
  await waitFor(() =>
    expect(
      within(view)
        .getAllByTestId('record-stub')
        .map((n) => n.textContent),
    ).toContain('[Тело записи]'),
  );
  expect(calls).toContainEqual({
    path: 'entity.get',
    input: detailGetInput(HOST_TEMPLATE_RECORD_ID),
  });
});

test('записи шаблона хоста нет — пункта «Настроить шаблон хоста» нет (настраивать нечего)', async () => {
  open(fixture('task'), { hostTemplate: 'none' });
  await screen.findByTestId('page-tabs');
  await new Promise((r) => setTimeout(r, 50));
  expect(await menuLabels()).not.toContain('Настроить шаблон хоста');
});

test('запрос записей поставки отказал — эталон кода без плашки «повреждён» и без «Настроить шаблон хоста» (R-29 (а))', async () => {
  open(fixture('task'), { supplyFails: true });
  expect(await screen.findByTestId('page-tabs')).toBeInTheDocument();
  expect(await screen.findByTestId('tags-block')).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('host-template-broken')).toBeNull();
  expect(await menuLabels()).not.toContain('Настроить шаблон хоста');
});

test('у самой записи «Шаблон хоста» нет «Сделать шаблоном для…» и «Перестать быть страницей» (R-29 (б))', async () => {
  open({ name: 'host-template', entity: hostTemplateRecord() });
  await screen.findByTestId('template-preview-plaque');
  const labels = await menuLabels();
  expect(labels).toContain('Настроить');
  expect(labels).not.toContain('Сделать шаблоном для…');
  expect(labels).not.toContain('Перестать быть страницей');
});

test('запись показана своим шаблоном — сломанная запись шаблона хоста плашки не даёт (эталон не показан)', async () => {
  const OWN = 'Вид задачи\n\n{{title}}\n\n{{body}}\n';
  const own = wireEntity({
    id: uuid(1702),
    title: 'Задачи',
    body: OWN,
    bodyDoc: parseBody(OWN),
    aspects: [PAGE_ASPECT],
    createdAt: '2026-09-01T00:00:00.000Z',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] },
  });
  open(fixture('task'), { hostTemplate: 'broken', templates: [own] });
  await waitFor(() => expect(pageTexts()).toContain('Вид задачи'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByTestId('host-template-broken')).toBeNull();
});

test('смена «эталон → запись шаблона хоста» не сбрасывает открытую вкладку (гейт 17, M-2)', async () => {
  let release: () => void = () => {};
  const supplyGate = new Promise<void>((r) => {
    release = r;
  });
  const edited = hostTemplateRecord(`Своя строка шаблона хоста\n\n${HOST_TEMPLATE_RECORD_BODY}`);
  open(fixture('task'), { supply: [edited], supplyGate });
  // Записи поставки ещё едут — показан эталон кода; владелец уходит на «Детали».
  const details = await screen.findByRole('tab', { name: 'Детали' });
  fireEvent.mouseDown(details);
  fireEvent.click(details);
  await waitFor(() => expect(details).toHaveAttribute('aria-selected', 'true'));
  expect(pageTexts()).not.toContain('Своя строка шаблона хоста');

  release();
  await waitFor(() => expect(pageTexts()).toContain('Своя строка шаблона хоста'));
  expect(screen.getByRole('tab', { name: 'Детали' })).toHaveAttribute('aria-selected', 'true');
});

// --- (д) {{cards: own}} рядом с явной карточкой и «остальными» ----------------------------------

const TPL = uuid(1701);
const OWN_TEMPLATE_BODY =
  'Вид цели\n\n{{title}}\n\n{{card: orbis/goal}}\n\n{{cards: own}}\n\n{{cards}}\n\n{{body}}\n';

test('{{card: orbis/goal}} + {{cards: own}} + {{cards}}: цель один раз (явная), прочие свои по рангу, «остальные» их не повторяют', async () => {
  const base = fixture('goal-schedule');
  const f: StructureFixture = {
    ...base,
    entity: {
      ...base.entity,
      aspects: [...base.entity.aspects, 'orbis/task', 'orbis/financial'],
      props: { ...base.entity.props, 'orbis/task_status': 'planned' },
    },
  };
  const template = wireEntity({
    id: TPL,
    title: 'Цели',
    body: OWN_TEMPLATE_BODY,
    bodyDoc: parseBody(OWN_TEMPLATE_BODY),
    aspects: [PAGE_ASPECT],
    createdAt: '2026-09-01T00:00:00.000Z',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/goal'] },
  });
  const { container } = open(f, { templates: [template] });
  await waitFor(() => expect(pageTexts()).toContain('Вид цели'));
  await screen.findByTestId('assignment-card');
  // Секции полей встают с реестром — порядок снимается, когда встали все шесть частей.
  await waitFor(() => {
    for (const id of ['aspect-orbis/goal', 'aspect-orbis/financial', 'aspect-orbis/schedule'])
      expect(container.querySelectorAll(`[data-testid="${id}"]`), id).toHaveLength(1);
  });

  const parts = new Set([
    'aspect-orbis/goal',
    'goal-progress',
    'assignment-card',
    'aspect-orbis/financial',
    'aspect-orbis/schedule',
    'aspect-orbis/task',
  ]);
  // Все ориентиры одним селектором и фильтр — не список селекторов через запятую: jsdom отдаёт такой
  // список сгруппированным по селекторам, а не в порядке документа (замерено), и сверка порядка
  // была бы сверкой порядка селекторов.
  const order = [...container.querySelectorAll('[data-testid]')]
    .map((n) => n.getAttribute('data-testid') ?? '')
    .filter((id) => parts.has(id));
  // Явная цель — на своём месте и один раз; свои: исполнитель (20) раньше финансов (50), хотя аспект
  // финансов в реестре раньше назначения; «остальные» — только общие секции прочих аспектов.
  expect(order).toEqual([
    'aspect-orbis/goal',
    'goal-progress',
    'assignment-card',
    'aspect-orbis/financial',
    'aspect-orbis/schedule',
    'aspect-orbis/task',
  ]);
});
