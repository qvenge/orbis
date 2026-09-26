/**
 * Рендерер показа и страница своим телом (спека страниц 1а §6.1, §4.2 шаг 1, §6.4, §5.5, задача 13).
 *
 * Страница открывается экраном записи (`DetailScreen`) — так, как её откроет человек: данные
 * обвязки приходят ОДНИМ `entity.get` экрана (РП-13, Э-14), и тест считает это по сети.
 * `this` у блоков данных — только uuid: боевые пути другой формы не принимают.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { GRAMMAR_ERROR_MESSAGES } from '@orbis/shared/doc/page-grammar';
import { SECOND_CARDS_MESSAGE, secondCardMessage } from '@orbis/shared/doc/placement';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import {
  blocksReply,
  blockTexts,
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  trpcError,
  type WireEntityFixture,
  wireEntity,
} from '../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { queryClient } from '../../trpc';
import { DetailScreen } from '../entity-detail/DetailScreen';
import {
  type EntityGetReply,
  STRUCTURE_FIXTURES,
  structureHandler,
} from '../entity-detail/structure-fixtures';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { REGISTRY_FAILED_MESSAGE } from './blocks/BlockPlaque';
import { PageView } from './PageView';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';

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
});

const PAGE_ID = '00000000-0000-4000-8000-000000000501';
const MENTIONER_ID = '00000000-0000-4000-8000-000000000502';

const page = (body: string, over: Partial<WireEntityFixture> = {}): WireEntityFixture =>
  wireEntity({
    id: PAGE_ID,
    title: 'Утро',
    body,
    aspects: [PAGE_ASPECT],
    ...over,
  });

const row = (id: string, title: string) => wireEntity({ id, title, aspects: ['orbis/task'] });

/**
 * Экран записи над страницей: обработчик экрана записи (`structureHandler`), блоки данных — по
 * карте «текст → строки», прочее переопределяется `extra`/`over`.
 */
function openPage(
  entity: WireEntityFixture,
  opts: {
    blocks?: Parameters<typeof blocksReply>[0];
    extra?: Partial<EntityGetReply>;
    over?: MockHandler;
  } = {},
) {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: entity.id }], agenda: [], budget: [] },
  });
  const screenHandler = structureHandler({ name: 'page', entity, extra: opts.extra ?? {} });
  const map = opts.blocks ?? {};
  const blocks = blocksReply(map);
  const handler: MockHandler = async (path, input) => {
    const own = opts.over ? await opts.over(path, input) : undefined;
    if (own !== undefined) return own;
    // Тот же текст запроса отвечает и мимо пачки — прямым `entity.query`. Иначе блок, ушедший в
    // обход собирателя, упал бы на пустом ответе, а не на сверке «одна пачка»: тест мерил бы
    // обвязку, а не путь данных (мутация (б) задачи 13).
    const text = path === 'entity.query' ? (input as { query?: string }).query?.trim() : undefined;
    const direct = text === undefined ? undefined : map[text];
    if (Array.isArray(direct)) return direct;
    return blocks(path, input) ?? screenHandler(path, input);
  };
  return renderWithProviders(<DetailScreen entityId={entity.id} />, handler, {
    queries: queryClient.getDefaultOptions().queries,
  });
}

const tabPanelOf = (el: HTMLElement): HTMLElement => {
  const panel = el.closest<HTMLElement>('[role="tabpanel"]');
  if (panel === null) throw new Error('узел не во вкладке');
  return panel;
};

const MORNING = `Доброе утро, план на день.

{{columns}}
{{column}}
{{query: aspect=orbis/task}}
{{/column}}
{{column}}
{{query: aspect=orbis/goal}}
{{query: aspect=orbis/note}}
{{/column}}
{{/columns}}
`;

test('страница «Утро»: текст, две колонки, три блока данных — одной пачкой (С1а-4)', async () => {
  const { calls } = openPage(page(MORNING), {
    blocks: {
      'aspect=orbis/task': [row('00000000-0000-4000-8000-000000000511', 'Задача дня')],
      'aspect=orbis/goal': [row('00000000-0000-4000-8000-000000000512', 'Цель года')],
      'aspect=orbis/note': [row('00000000-0000-4000-8000-000000000513', 'Заметка утра')],
    },
  });
  expect(await screen.findByText('Доброе утро, план на день.')).toBeInTheDocument();
  expect(screen.getByTestId('page-text')).toHaveTextContent('Доброе утро');

  const columns = screen.getByTestId('page-columns');
  // Столбиком на узком экране, сеткой в две колонки на `md`.
  expect(columns).toHaveClass('flex', 'flex-col', 'md:grid', 'md:grid-cols-2');
  const parts = within(columns).getAllByTestId('page-column');
  expect(parts).toHaveLength(2);

  expect(await within(parts[0] as HTMLElement).findByText('Задача дня')).toBeInTheDocument();
  expect(await within(parts[1] as HTMLElement).findByText('Цель года')).toBeInTheDocument();
  expect(within(parts[1] as HTMLElement).getByText('Заметка утра')).toBeInTheDocument();

  const batches = calls.filter((c) => c.path === 'entity.blocks');
  expect(batches).toHaveLength(1);
  expect(blockTexts(batches[0] as { input: unknown }).map((t) => t.trim())).toEqual([
    'aspect=orbis/task',
    'aspect=orbis/goal',
    'aspect=orbis/note',
  ]);
  // `this` — сама страница (§6.4).
  const items = (batches[0] as { input: { blocks: { thisEntityId?: string }[] } }).input.blocks;
  expect(items.map((b) => b.thisEntityId)).toEqual([PAGE_ID, PAGE_ID, PAGE_ID]);
});

test('вкладки: видна «А», переключение показывает «Б»; колонки внутри вкладки рисуются', async () => {
  openPage(
    page(`{{tabs}}
{{tab: А}}
Текст А
{{columns}}
{{column}}
Левая
{{/column}}
{{column}}
Правая
{{/column}}
{{/columns}}
{{/tab}}
{{tab: Б}}
Текст Б
{{/tab}}
{{/tabs}}
`),
  );
  const a = await screen.findByText('Текст А');
  expect(tabPanelOf(a)).toHaveAttribute('data-state', 'active');
  const nested = within(tabPanelOf(a)).getByTestId('page-columns');
  expect(within(nested).getAllByTestId('page-column')).toHaveLength(2);
  expect(within(nested).getByText('Левая')).toBeInTheDocument();
  expect(within(nested).getByText('Правая')).toBeInTheDocument();
  expect(tabPanelOf(screen.getByText('Текст Б'))).toHaveAttribute('data-state', 'inactive');

  fireEvent.click(screen.getByRole('tab', { name: 'Б' }));
  await waitFor(() =>
    expect(tabPanelOf(screen.getByText('Текст Б'))).toHaveAttribute('data-state', 'active'),
  );
  expect(tabPanelOf(screen.getByText('Текст А'))).toHaveAttribute('data-state', 'inactive');
});

test('{{title}} — заголовок САМОЙ страницы, {{backlinks}} — её обратные ссылки (§6.4)', async () => {
  const mentioner = wireEntity({ id: MENTIONER_ID, title: 'Дневник' });
  openPage(page('{{title}}\n\n{{backlinks}}\n'), {
    extra: { backlinks: [{ entity: mentioner, via: 'mention', viaLabel: 'Упоминание' }] as never },
  });
  const view = await screen.findByTestId('page-view');
  expect(await within(view).findByTestId('title-edit')).toHaveValue('Утро');
  const link = await within(view).findByTestId('backlink');
  expect(link).toHaveTextContent('Дневник');
});

test('{{body}} на странице — плашка BLOCK_MISPLACED; незакрытый контейнер — плашка на месте, остальное рисуется', async () => {
  const body = 'Вступление\n\n{{body}}\n\n{{columns}}\n{{column}}\nВнутри\n{{/column}}\n';
  const { calls } = openPage(page(body));
  const view = await screen.findByTestId('page-view');
  expect(await within(view).findByText('Вступление')).toBeInTheDocument();

  const misplaced = within(view).getByTestId('block-misplaced');
  expect(misplaced).toHaveTextContent(
    'Блок {{body}} работает только в шаблоне, на странице он не показывается.',
  );
  // Редактора тела на странице нет.
  expect(within(view).queryByTestId('editor-preview')).toBeNull();

  const broken = within(view).getByTestId('qb-error');
  expect(broken).toHaveTextContent(GRAMMAR_ERROR_MESSAGES.CONTAINER_UNCLOSED);
  expect(within(view).queryByText('Внутри')).toBeNull();
  // Текст узла в теле цел: показ ничего не пишет.
  expect(calls.some((c) => c.path.startsWith('entity.update'))).toBe(false);
});

test('один запрос записи: открытие страницы — РОВНО один entity.get с DETAIL_INCLUDE (РП-13, Э-14)', async () => {
  const text = 'aspect=orbis/task';
  const { calls } = openPage(
    page(`{{title}}\n\n{{query: ${text}}}\n\n{{subtasks}}\n\n{{backlinks}}\n\n{{blockers}}\n`),
    { blocks: { [text]: [row('00000000-0000-4000-8000-000000000521', 'Строка блока')] } },
  );
  expect(await screen.findByText('Строка блока')).toBeInTheDocument();
  await screen.findByTestId('title-edit');
  const gets = calls.filter((c) => c.path === 'entity.get');
  expect(gets).toEqual([{ path: 'entity.get', input: detailGetInput(PAGE_ID) }]);
});

test('шаблон сам на себе: {{body}} — заглушка без редактора, второй {{body}} — плашка (SECOND_BODY)', async () => {
  openPage(
    page('{{title}}\n\n{{body}}\n\n{{body}}\n', {
      title: 'Вид задачи',
      props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'] },
    }),
  );
  const view = await screen.findByTestId('page-view');
  expect(await within(view).findByTestId('body-stub')).toHaveTextContent('[Тело записи]');
  expect(within(view).getAllByTestId('body-stub')).toHaveLength(1);
  expect(within(view).queryByTestId('editor-preview')).toBeNull();
  expect(within(view).getByTestId('block-misplaced')).toHaveTextContent('Второй блок {{body}}');
});

test('показ не редактирует: в PageView нет contenteditable', async () => {
  openPage(
    page(
      '# Заголовок раздела\n\nАбзац.\n\n{{title}}\n\n{{tabs}}\n{{tab: А}}\nТекст\n{{/tab}}\n{{/tabs}}\n',
    ),
  );
  const view = await screen.findByTestId('page-view');
  await within(view).findByText('Абзац.');
  // Простой наступает — редактор первого кадра встал бы, будь он здесь.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(view.querySelector('[contenteditable]')).toBeNull();
  expect(within(view).queryByTestId('editor-preview')).toBeNull();
});

test('правка заголовка через {{title}} страницы — оптимистично, прежним useEntityUpdate', async () => {
  const { calls } = openPage(page('{{title}}\n'), {
    // Ответ не приходит: видимое — только оптимистичный патч под ключом detailGetInput(id).
    over: (path) => (path === 'entity.update' ? new Promise(() => {}) : undefined),
  });
  const input = await screen.findByTestId('title-edit');
  fireEvent.change(input, { target: { value: 'Вечер' } });
  fireEvent.blur(input);
  expect(await screen.findByRole('heading', { name: 'Вечер' })).toBeInTheDocument();
  const update = calls.find((c) => c.path === 'entity.update');
  expect(update?.input).toMatchObject({ id: PAGE_ID, title: 'Вечер' });
});

test('{{cards}} на странице своим телом не рисует карточку «Страница» (РП-25); card: не повторяется в cards', async () => {
  openPage(
    page('{{card: "Цель"}}\n\n{{cards}}\n', {
      aspects: [PAGE_ASPECT, 'orbis/goal', 'orbis/note'],
    }),
  );
  const view = await screen.findByTestId('page-view');
  await within(view).findByTestId('aspect-orbis/note');
  // Цель размещена `card:` (по подписи) — в `{{cards}}` её нет, на месте она одна.
  expect(within(view).getAllByTestId('aspect-orbis/goal')).toHaveLength(1);
  expect(within(view).queryByTestId(`aspect-${PAGE_ASPECT}`)).toBeNull();
});

test('обычная запись без аспекта «страница» — шаблоном хоста с вкладками, а не своим телом', async () => {
  openPage(wireEntity({ id: PAGE_ID, title: 'Заметка', body: '{{title}}\n' }));
  expect(await screen.findByTestId('record-view')).toBeInTheDocument();
  expect(screen.getByTestId('page-tabs')).toBeInTheDocument();
  expect(screen.queryByTestId('page-view')).toBeNull();
});

test('вкладки и сеть: версии на скрытой вкладке (и во вложенной под скрытой) не грузятся, тред монтируется только открытым', async () => {
  const { calls } = openPage(
    page(`{{tabs}}
{{tab: Главная}}
Первая вкладка
{{/tab}}
{{tab: Версии}}
{{versions}}
{{/tab}}
{{tab: Вложенные}}
{{tabs}}
{{tab: Внутри}}
{{versions}}
{{/tab}}
{{/tabs}}
{{/tab}}
{{tab: Тред}}
{{thread}}
{{/tab}}
{{/tabs}}
`),
  );
  await screen.findByText('Первая вкладка');
  expect(await screen.findAllByTestId('versions-card')).toHaveLength(2);
  const touched = (p: string) => calls.some((c) => c.path === p);
  expect(touched('version.list')).toBe(false);
  expect(touched('chat.ensureThread') || touched('chat.listMessages')).toBe(false);

  fireEvent.click(screen.getByRole('tab', { name: 'Вложенные' }));
  await waitFor(() => expect(touched('version.list')).toBe(true));

  fireEvent.click(screen.getByRole('tab', { name: 'Тред' }));
  expect(await screen.findByTestId('message-list')).toBeInTheDocument();
});

test('вкладок стало меньше, чем номер открытой, — открыта первая, а не пустота (§6.5)', async () => {
  const three = page(
    '{{tabs}}\n{{tab: T1}}\nПервая\n{{/tab}}\n{{tab: T2}}\nВторая\n{{/tab}}\n{{tab: T3}}\nТретья\n{{/tab}}\n{{/tabs}}\n',
  );
  const two = page(
    '{{tabs}}\n{{tab: T1}}\nПервая\n{{/tab}}\n{{tab: T2}}\nВторая\n{{/tab}}\n{{/tabs}}\n',
  );
  const reply = (entity: WireEntityFixture) =>
    ({
      entity,
      relations: [],
      backlinks: [],
      thread: null,
      registryVersion: BUILTIN_REGISTRY.version,
    }) as unknown as EntityGetReply;
  // Текст страницы меняется без размонтирования (правка агентом, переход по кешу): тот же
  // `PageView`, новый ответ `entity.get`.
  function Switch() {
    const [current, setCurrent] = useState(reply(three));
    return (
      <>
        <button type="button" onClick={() => setCurrent(reply(two))}>
          сменить текст
        </button>
        <PageView reply={current} />
      </>
    );
  }
  renderWithProviders(<Switch />, (path) => registryReply(path) ?? {});
  fireEvent.click(await screen.findByRole('tab', { name: 'T3' }));
  await waitFor(() =>
    expect(tabPanelOf(screen.getByText('Третья'))).toHaveAttribute('data-state', 'active'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'сменить текст' }));
  await waitFor(() => expect(screen.queryByText('Третья')).toBeNull());
  expect(tabPanelOf(screen.getByText('Первая'))).toHaveAttribute('data-state', 'active');
  expect(screen.getByRole('tab', { name: 'T1' })).toHaveAttribute('data-state', 'active');
});

test('{{card: X}} с неузнанным аспектом — честная спокойная плашка, не «неуместный блок»', async () => {
  // Второй аспект с подписью «Цель» — подпись становится неоднозначной.
  const goal = BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/goal');
  if (goal === undefined) throw new Error('нет встроенного аспекта orbis/goal');
  const twin = { ...goal, id: 'user/goal-twin', key: 'user/goal-twin', graphId: 'u' };
  openPage(
    page('{{card: orbis/nope}}\n\n{{card: "Цель"}}\n', { aspects: [PAGE_ASPECT, 'orbis/goal'] }),
    {
      over: (path) =>
        path === 'registry.effective'
          ? { ...BUILTIN_REGISTRY, aspects: [...BUILTIN_REGISTRY.aspects, twin] }
          : undefined,
    },
  );
  const view = await screen.findByTestId('page-view');
  const plaques = await within(view).findAllByTestId('block-unresolved');
  expect(plaques).toHaveLength(2);
  expect(plaques[0]).toHaveTextContent('Блок {{card: orbis/nope}}: аспект не узнан.');
  expect(plaques[1]).toHaveTextContent('Блок {{card: "Цель"}}: аспект не узнан.');
  // Выход для неоднозначной подписи назван.
  expect(plaques[1]).toHaveTextContent('укажите ключ аспекта');
  expect(plaques[0]).toHaveAttribute('role', 'note');
  expect(within(view).queryByTestId('block-misplaced')).toBeNull();
  // Неоднозначная подпись не угадана: карточки цели нет.
  expect(within(view).queryByTestId('aspect-orbis/goal')).toBeNull();
});

test('вкладки страницы — её собственные: третья вкладка страницы A не открывает третью у B', async () => {
  const withTabs = (p: string) =>
    `{{tabs}}\n{{tab: Один}}\n${p} один\n{{/tab}}\n{{tab: Два}}\n${p} два\n{{/tab}}\n{{tab: Три}}\n${p} три\n{{/tab}}\n{{/tabs}}\n`;
  const a = page(withTabs('Утро'));
  const b = page(withTabs('Вечер'), { id: MENTIONER_ID, title: 'Вечер' });
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: a.id }], agenda: [], budget: [] },
  });
  // Переход страница → страница внутри того же экрана (роутер монтирует его без key).
  function Switcher() {
    const [id, setId] = useState(a.id);
    return (
      <>
        <button type="button" data-testid="go-b" onClick={() => setId(b.id)}>
          на B
        </button>
        <DetailScreen entityId={id} />
      </>
    );
  }
  renderWithProviders(<Switcher />, (path, input) => {
    if (path === 'entity.get') {
      const entity = (input as { id: string }).id === a.id ? a : b;
      return {
        entity,
        relations: [],
        backlinks: [],
        thread: null,
        registryVersion: BUILTIN_REGISTRY.version,
      };
    }
    return registryReply(path) ?? {};
  });
  fireEvent.click(await screen.findByRole('tab', { name: 'Три' }));
  expect(screen.getByRole('tab', { name: 'Три' })).toHaveAttribute('data-state', 'active');

  fireEvent.click(screen.getByTestId('go-b'));
  await screen.findByRole('heading', { name: 'Вечер' });
  expect(await screen.findByRole('tab', { name: 'Один' })).toHaveAttribute('data-state', 'active');
  expect(screen.getByRole('tab', { name: 'Три' })).toHaveAttribute('data-state', 'inactive');
});

test('реестр не загрузился — {{cards}} страницы плашкой с причиной, а не пустым местом (C1-I3)', async () => {
  openPage(page('Текст страницы\n\n{{cards}}\n'), {
    over: (path) => {
      if (path === 'registry.effective') throw trpcError('INTERNAL_SERVER_ERROR');
      return undefined;
    },
  });
  await screen.findByTestId('page-view');
  expect(await screen.findByTestId('qb-error')).toHaveTextContent(REGISTRY_FAILED_MESSAGE);
});

test('вкладка без подписи ({{tab}}) на показе — «Вкладка N», а не пустой ярлык (F-M2)', async () => {
  openPage(
    page(
      '{{tabs}}\n{{tab}}\nТекст А\n{{/tab}}\n{{tab: Б}}\nТекст Б\n{{/tab}}\n{{tab}}\nТекст В\n{{/tab}}\n{{/tabs}}\n',
    ),
  );
  await screen.findByText('Текст А');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
    'Вкладка 1',
    'Б',
    'Вкладка 3',
  ]);
});

describe('плашка «второй» (SECOND_BLOCK, 1а новое-11)', () => {
  const TPL_ID = '00000000-0000-4000-8000-000000000591';

  /** Запись фикстуры экрана, показанная шаблоном владельца с данным телом. */
  function openWithTemplate(name: string, forAspects: string[], body: string) {
    const f = STRUCTURE_FIXTURES.find((x) => x.name === name);
    if (f === undefined) throw new Error(`нет фикстуры ${name}`);
    const tpl = wireEntity({
      id: TPL_ID,
      title: 'Вид с повтором',
      body,
      aspects: [PAGE_ASPECT],
      props: { [TEMPLATE_FOR_PROPERTY]: forAspects },
    });
    return openPage(f.entity, {
      extra: f.extra ?? {},
      over: (path, input) =>
        path === 'entity.query' && (input as { query?: string }).query === PAGE_TEMPLATES_QUERY
          ? [tpl]
          : undefined,
    });
  }

  test('ключ и подпись одного аспекта в шаблоне — карточка одна, на месте второй плашка', async () => {
    openWithTemplate(
      'goal',
      ['orbis/goal'],
      'Вид цели\n\n{{card: orbis/goal}}\n\n{{card: "Цель"}}\n',
    );
    await screen.findByText('Вид цели');
    const plaque = await screen.findByTestId('block-misplaced');
    expect(plaque).toHaveTextContent(secondCardMessage('{{card: "Цель"}}'));
    expect(screen.getAllByTestId('aspect-orbis/goal')).toHaveLength(1);
  });

  test('два {{cards}} на странице — карточки по одному разу, одна плашка', async () => {
    openPage(
      page('{{cards}}\n\n{{cards}}\n', { aspects: [PAGE_ASPECT, 'orbis/goal', 'orbis/note'] }),
    );
    const view = await screen.findByTestId('page-view');
    await within(view).findByTestId('aspect-orbis/note');
    expect(within(view).getAllByTestId('aspect-orbis/note')).toHaveLength(1);
    expect(within(view).getAllByTestId('aspect-orbis/goal')).toHaveLength(1);
    const plaques = within(view).getAllByTestId('block-misplaced');
    expect(plaques).toHaveLength(1);
    expect(plaques[0]).toHaveTextContent(SECOND_CARDS_MESSAGE);
  });

  test('карточка исполнителя дважды разными написаниями у тикета — ожидание и поле ответа одни', async () => {
    openWithTemplate(
      'ticket',
      ['orbis/assignment'],
      'Вид тикета\n\n{{card: orbis/assignment}}\n\n{{card: "Исполнитель"}}\n',
    );
    await screen.findByText('Вид тикета');
    await screen.findByTestId('ticket-waiting');
    // Лишняя копия жила бы своим состоянием: второе поле ответа, вторая «Ответить».
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getAllByTestId('ticket-waiting')).toHaveLength(1);
    expect(screen.getAllByLabelText('Ответ')).toHaveLength(1);
    expect(screen.getByTestId('block-misplaced')).toHaveTextContent(
      secondCardMessage('{{card: "Исполнитель"}}'),
    );
  });

  test('одна {{card: orbis/page}} на странице своим телом — не «вторая» (placed заранее несёт orbis/page)', async () => {
    openPage(page('Текст\n\n{{card: orbis/page}}\n', { aspects: [PAGE_ASPECT, 'orbis/goal'] }));
    const view = await screen.findByTestId('page-view');
    await within(view).findByText('Текст');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(within(view).queryByTestId('block-misplaced')).toBeNull();
  });
});
