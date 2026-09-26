/**
 * Предпросмотр шаблона — только чтение ЦЕЛИКОМ (спека 1б §10, 1а новое-5; принцип §0.2 п. 2).
 *
 * Запись взята для примера: показ шаблона на ней не повод править её заголовок, чекбокс, теги,
 * подзадачи, блокировки, тред, свойства, назначение, рутину или прогон. Тест открывает шаблон так,
 * как его откроет человек (`DetailScreen` → плашка предпросмотра → запись), и проверяет две вещи:
 * явные ожидания (контролов правки нет) и обход — каждая доступная кнопка нажата, в каждое поле
 * введено, — после которого в сеть не ушло НИ ОДНОЙ мутации. Мутацию узнаёт род операции tRPC
 * (`MockHandler`, третий аргумент), а не список имён процедур: новая кнопка с новой процедурой
 * иначе прошла бы мимо сторожа.
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY } from '@orbis/shared';
import { parseBody } from '@orbis/shared/doc';
import type { QueryAst } from '@orbis/shared/query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
  TICKET_ROUTINE_FIXTURE,
} from '../entity-detail/structure-fixtures';
import { HOST_TEMPLATE_TEXT } from './host-template';
import { PAGE_TEMPLATES_QUERY } from './usePageTemplates';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  useToastStore.setState({ toasts: [] });
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  // Простой — сразу: редактор тела, которому позволено встать, встал бы; только чтение — нет.
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 1;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TPL = uuid(1701);
// Подзадача и блокер — записи мира обработчика экрана (`structure-fixtures.ts`): их заголовки и
// завершаемость он отдаёт сам (`entity.resolveRefs`).
const SUBTASK = uuid(901);
const BLOCKER = uuid(902);
const MENTIONER = uuid(1704);

/** Шаблон владельца — текстом шаблона хоста: в нём стоят все примитивы записи и все карточки. */
const templateFor = (forAspects: string[]): WireEntityFixture =>
  wireEntity({
    id: TPL,
    title: 'Вид для предпросмотра',
    body: HOST_TEMPLATE_TEXT,
    bodyDoc: parseBody(HOST_TEMPLATE_TEXT),
    aspects: [PAGE_ASPECT],
    props: { [TEMPLATE_FOR_PROPERTY]: forAspects },
  });

/** Связи записи: подзадача и блокировка — чтобы строкам «Подзадачи» и «Блокировки» было что снять. */
const relationsOf = (id: string) => [
  {
    id: uuid(1711),
    sourceId: id,
    targetId: SUBTASK,
    role: 'subitem',
    meta: {},
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
  },
  {
    id: uuid(1712),
    sourceId: BLOCKER,
    targetId: id,
    role: 'dependency',
    meta: {},
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
  },
];

/** Прогон рутины с вопросом и пачкой решений — для ленты прогона (вопрос, «Принять все», откат). */
const ROUTINE_RUN: StructureFixture = {
  name: 'routine-run',
  entity: wireEntity({
    id: uuid(1720),
    title: 'Прогон рутины',
    body: '',
    bodyDoc: parseBody(''),
    aspects: ['orbis/agent-run'],
    props: {
      'orbis/run_routine': uuid(1721),
      'orbis/run_bucket': '2026-09-20T07:00',
      'orbis/run_outcome': 'checkpoint',
      'orbis/run_started_at': '2026-09-20T07:00:00.000Z',
      'orbis/run_checkpoint': {
        question: 'Перенести встречу на четверг?',
        asked_at: '2026-09-20T07:10:00.000Z',
      },
      'orbis/undecided': true,
      'orbis/step_count': 1,
      'orbis/run_steps': [
        { seq: 1, at: '2026-09-20T07:05:00.000Z', summary: 'Прочитал входящие', external: false },
      ],
    },
  }),
};

const RUN_UNITS = [
  {
    pendingId: 'q1',
    kind: 'question',
    createdAt: '2026-09-20T07:10:00.000Z',
    question: 'Перенести встречу на четверг?',
    options: ['Да', 'Нет'],
    card: {
      kind: 'question_card',
      pendingId: 'q1',
      runId: uuid(1720),
      routineId: uuid(1721),
      question: 'Перенести встречу на четверг?',
      options: ['Да', 'Нет'],
    },
    fate: 'open',
  },
  {
    pendingId: 'd1',
    kind: 'action',
    createdAt: '2026-09-20T07:11:00.000Z',
    tool: 'entity_update',
    card: {
      kind: 'deferred_action_card',
      pendingId: 'd1',
      runId: uuid(1720),
      routineId: uuid(1721),
      summary: 'Архивация: «Старый проект»',
      rows: [{ field: 'archived', before: 'false', after: 'true' }],
    },
    fate: 'open',
  },
];

/**
 * Мир предпросмотра: экран — шаблон, подходящая запись — `record` (связи, версия, прогоны, пачка).
 * Каждая мутация складывается в `mutations`: после обхода их быть не должно.
 */
function openPreview(record: StructureFixture, forAspects: string[]) {
  const tpl = templateFor(forAspects);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: TPL }], agenda: [], budget: [] },
  });
  const withRelations: StructureFixture = {
    ...record,
    extra: {
      ...record.extra,
      relations: relationsOf(record.entity.id),
      backlinks: [
        {
          entity: wireEntity({ id: MENTIONER, title: 'Дневник', aspects: ['orbis/note'] }),
          via: 'mention',
          viaLabel: 'Упоминание',
        },
      ] as never,
    },
  };
  const recordScreen = structureHandler(withRelations);
  const tplScreen = structureHandler({ name: 'tpl', entity: tpl });
  const mutations: { path: string; input: unknown }[] = [];
  const handler: MockHandler = (path, input, type) => {
    if (type === 'mutation') {
      mutations.push({ path, input });
      return {};
    }
    if (path === 'entity.query') {
      const q = input as { query?: string; ast?: QueryAst };
      if (q.query === PAGE_TEMPLATES_QUERY) return [tpl];
      if (q.ast !== undefined) return [record.entity];
    }
    if (path === 'entity.get') {
      const id = (input as { id: string }).id;
      if (id === TPL) return tplScreen(path, input);
      if (id === record.entity.id) return recordScreen(path, input);
    }
    if (path === 'version.list') {
      return [
        {
          id: uuid(1730),
          entityId: record.entity.id,
          label: 'До правки',
          createdAt: '2026-09-19T10:00:00.000Z',
          hasDoc: true,
        },
      ];
    }
    if (path === 'routine.runUnits') return RUN_UNITS;
    return recordScreen(path, input);
  };
  const r = renderWithProviders(
    <>
      <DetailScreen entityId={TPL} />
      <Toaster />
    </>,
    handler,
    { queries: queryClient.getDefaultOptions().queries },
  );
  return { ...r, mutations };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

/** Предпросмотр встал: обёртка записи и шапка ЭТОЙ записи на месте (заголовок — текстом или полем). */
async function previewRoot(title: string): Promise<HTMLElement> {
  const root = await screen.findByTestId('template-preview-record');
  const row = await within(root).findByTestId('native-row');
  await waitFor(() =>
    expect(
      row.textContent?.includes(title) ||
        (row.querySelector('input') as HTMLInputElement | null)?.value === title,
    ).toBe(true),
  );
  await settle();
  return root;
}

/**
 * Обход: каждая вкладка шаблона, в ней — каждая доступная кнопка, флажок и переключатель (кроме
 * вкладок), в каждое поле ввода — «x» и Enter, затем уход фокуса. Список кнопок перечитывается
 * после каждого нажатия: нажатие вправе открыть новую (подтверждение отката) — её тоже нажмём.
 */
async function pokeEverything(root: HTMLElement): Promise<void> {
  const tabs = within(root).queryAllByRole('tab');
  const tabNames = tabs.length === 0 ? [null] : tabs.map((t) => t.textContent ?? '');
  for (const name of tabNames) {
    if (name !== null) {
      fireEvent.mouseDown(within(root).getByRole('tab', { name }));
      fireEvent.click(within(root).getByRole('tab', { name }));
      await settle();
    }
    const pressed = new Set<Element>();
    for (let round = 0; round < 20; round += 1) {
      const next = [
        ...within(root).queryAllByRole('button'),
        ...within(root).queryAllByRole('checkbox'),
        ...within(root).queryAllByRole('switch'),
        ...within(root).queryAllByRole('radio'),
        ...screen.queryAllByRole('dialog').flatMap((d) => within(d).queryAllByRole('button')),
      ].find((el) => !pressed.has(el) && !(el as HTMLButtonElement).disabled);
      if (next === undefined) break;
      pressed.add(next);
      fireEvent.click(next);
      await settle();
    }
    for (const box of within(root).queryAllByRole('textbox')) {
      fireEvent.focus(box);
      fireEvent.change(box, { target: { value: 'x' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      fireEvent.blur(box);
      await settle();
    }
  }
}

const RECORD_EDIT_BUTTONS = [
  'Прогнать сейчас',
  'Пауза',
  'Возобновить',
  'Закрыть тикет',
  'Ответить и вернуть в работу',
  'Восстановить',
  'Сохранить',
  'Снять назначение',
  'Добавить блокировку',
  'Снять блокировку',
];

test('тикет + рутина: контролов правки нет, обход по всем вкладкам не пишет ничего', async () => {
  const { mutations } = openPreview(TICKET_ROUTINE_FIXTURE, [
    'orbis/task',
    'orbis/assignment',
    'orbis/routine',
  ]);
  const root = await previewRoot('Разбирать входящие по утрам');

  // Вкладка «Запись»: шапка, карточки назначения и рутины.
  await within(root).findByTestId('routine-status');
  await within(root).findByTestId('ticket-waiting');
  for (const name of RECORD_EDIT_BUTTONS) {
    expect(within(root).queryByRole('button', { name })).toBeNull();
  }
  expect(within(root).getByRole('checkbox', { name: 'Готово' })).toBeDisabled();
  expect(within(root).queryByTestId('title-edit')).toBeNull();
  expect(within(root).queryByRole('textbox', { name: 'Заголовок' })).toBeNull();
  expect(within(root).queryByLabelText('Ответ')).toBeNull();
  expect(within(root).queryByRole('textbox', { name: 'Добавить тег' })).toBeNull();
  expect(within(root).queryByRole('radio')).toBeNull();
  // Секции аспектов — значениями, без контролов, навешивания и снятия.
  expect(within(root).queryAllByRole('button', { name: /^Снять аспект/ })).toEqual([]);

  // Вкладка «Детали»: версии, подзадачи, блокировки, секции аспектов.
  fireEvent.mouseDown(within(root).getByRole('tab', { name: 'Детали' }));
  fireEvent.click(within(root).getByRole('tab', { name: 'Детали' }));
  await within(root).findByText('До правки');
  expect(within(root).queryByRole('button', { name: 'Восстановить' })).toBeNull();
  expect(within(root).queryByRole('textbox', { name: 'Новая подзадача' })).toBeNull();
  expect(within(root).queryByRole('button', { name: 'Добавить блокировку' })).toBeNull();
  expect(within(root).queryByRole('button', { name: 'Снять блокировку' })).toBeNull();
  expect(within(root).queryAllByRole('button', { name: /^Снять аспект/ })).toEqual([]);
  expect(within(root).queryAllByRole('combobox')).toEqual([]);
  // Навигация остаётся: подзадача открывается — записи это не правит.
  expect(within(root).getByTestId('subtask')).toBeInTheDocument();

  // Вкладка «Тред»: лента без поля сообщения; тред не заводится.
  fireEvent.mouseDown(within(root).getByRole('tab', { name: 'Тред' }));
  fireEvent.click(within(root).getByRole('tab', { name: 'Тред' }));
  await settle();
  expect(within(root).queryAllByRole('textbox')).toEqual([]);

  await pokeEverything(root);
  expect(mutations).toEqual([]);
});

test('тикет с вопросом исполнителя: ответа нет, обход не пишет ничего', async () => {
  const ticket = STRUCTURE_FIXTURES.find((f) => f.name === 'ticket');
  if (ticket === undefined) throw new Error('нет фикстуры ticket');
  const { mutations } = openPreview(ticket, ['orbis/task', 'orbis/assignment']);
  const root = await previewRoot('Обновить зависимости');
  await within(root).findByTestId('ticket-waiting');
  expect(within(root).queryByLabelText('Ответ')).toBeNull();
  expect(within(root).queryByRole('button', { name: 'Ответить и вернуть в работу' })).toBeNull();
  await pokeEverything(root);
  expect(mutations).toEqual([]);
});

test('прогон рутины: вопрос, пачка и откат — без ответа, «Принять все», «Продолжить» и отката', async () => {
  const { mutations } = openPreview(ROUTINE_RUN, ['orbis/agent-run']);
  const root = await previewRoot('Прогон рутины');
  await within(root).findByTestId('routine-question');
  await within(root).findByTestId('run-decisions');
  await waitFor(() => expect(within(root).getAllByTestId('unit-stub')).toHaveLength(2));
  expect(within(root).queryByLabelText('Ответ')).toBeNull();
  for (const name of [
    'Ответить',
    'Принять все',
    'Продолжить сейчас',
    'Откатить прогон в Orbis',
    'Да',
    'Нет',
  ]) {
    expect(within(root).queryByRole('button', { name })).toBeNull();
  }
  await pokeEverything(root);
  expect(mutations).toEqual([]);
});
