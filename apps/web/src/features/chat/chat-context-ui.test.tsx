/**
 * Чат со ссылкой на текущую запись и «＋» с контекстом (спека 1б §6.4, РП-27, РП-9, В-6).
 *
 * 💬 — в поле ввода уже стоит снимаемая ссылка на текущую запись или страницу: агент видит контекст
 * обычной ссылкой `[[entity:<id>]]`. С ней быстрый путь не пробуется — «такси 500» про запись —
 * вопрос агенту, а не расход. Телефон — экран хоста, десктоп — боковой чат. ＋ на записи —
 * подзадача, на странице и экранах хоста — без контекста.
 *
 * Рисуется `<App/>` целиком: контекст приходит из модели навигации и рамки, а не пропом.
 */
import { ROLE_SUBITEM } from '@orbis/shared';
import { HOST_APP } from '@orbis/shared/nav';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  BREAD,
  frameHandler,
  frameWorld,
  GLOBAL_THREAD,
  NOTE,
  resetFrame,
  stubViewport,
  UPCOMING,
  unstubLaunchMode,
} from '../../app/frame/frame-fixtures';
import { useSideChat } from '../../app/frame/side-chat-store';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import type { CaptureContext } from '../browser/QuickCapture';
import { withRecordContext } from './record-context';

installCrashTrap();

/** Запись-задача: «＋» на ней — подзадача. */
const TASK = '00000000-0000-4000-8000-000000002560';

/** Категория с синонимом «такси»: «такси 500» без контекста — уверенный быстрый путь. */
const TAXI = wireEntity({
  id: '00000000-0000-4000-8000-000000002561',
  title: 'Транспорт',
  aspects: ['orbis/category'],
  props: { 'orbis/aliases': ['такси'], 'orbis/spend_class': 'variable' },
});

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  act(() => useSideChat.setState({ open: false }));
  resetFrame('/');
});

/**
 * `hold` — ответ `entity.get` по этому id ждёт `release()` (холодный старт: экран записи ещё не прочёл
 * запись, а «＋» уже нажат).
 */
function renderApp(hold?: { id: string; until: Promise<void> }) {
  const base = frameWorld();
  const world = frameWorld({
    all: [
      ...base.all,
      wireEntity({
        id: TASK,
        title: 'Починить кран',
        aspects: ['orbis/task'],
        props: { 'orbis/task_status': 'inbox' },
      }),
    ],
  });
  const answer = frameHandler(world);
  return renderWithProviders(<App />, async (path, input, type) => {
    if (path === 'entity.get' && hold !== undefined && (input as { id: string }).id === hold.id) {
      await hold.until;
    }
    switch (path) {
      case 'ai.sendMessage': {
        const { id } = input as { id: string };
        return {
          assistantMessage: {
            id: `reply-${id}`,
            threadId: GLOBAL_THREAD,
            role: 'assistant',
            content: 'ок',
            metadata: {},
            createdAt: '2026-07-05T12:00:00.000Z',
          },
          actions: [],
          pending: [],
          replayed: false,
        };
      }
      case 'entity.create': {
        const { input: e } = input as { input: { id: string; title: string; aspects?: string[] } };
        return wireEntity({ id: e.id, title: e.title, aspects: e.aspects ?? [] });
      }
      case 'entity.query':
        if ((input as { query?: string }).query === 'aspect=orbis/category') return [TAXI];
        return answer(path, input, type);
      default:
        return answer(path, input, type);
    }
  });
}

const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });
/**
 * Рамка десктопа — ленивый чанк: пока он едет, стоит рамка телефона (гейт 25, m-5), и её 💬 открыл бы
 * экран чата. Десктопный тест жмёт кнопки хоста только после приезда рейки.
 */
async function frameReady(desktop: boolean) {
  if (desktop) await screen.findByTestId('host-rail', {}, { timeout: 5000 });
}
const hostButton = (name: RegExp) =>
  within(screen.getByTestId('host-buttons')).getByRole('button', { name });

type Calls = { path: string; input: unknown }[];
const sent = (calls: Calls) =>
  calls
    .filter((c) => c.path === 'ai.sendMessage')
    .map((c) => (c.input as { content: string }).content);
const created = (calls: Calls) => calls.filter((c) => c.path === 'entity.create');
const related = (calls: Calls) => calls.filter((c) => c.path === 'relation.create');

function send(where: HTMLElement, text: string) {
  const box = within(where).getByRole('textbox', { name: 'Сообщение' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(within(where).getByRole('button', { name: 'Отправить' }));
}

// ─── (б) чип «Про: …» в поле ввода чата ───────────────────────────────────────────────────────

describe('(б) телефон: 💬 со ссылкой на текущую запись (§6.4, РП-27)', () => {
  test('чип «Про: <запись>»; отправка — с префиксом ссылки; с чипом быстрый путь не пробуется; снятый чип — быстрый путь', async () => {
    stubViewport(false);
    resetFrame(`/r/${BREAD}`);
    const { calls } = renderApp();
    await heading('Купить хлеб');
    fireEvent.click(hostButton(/Чат/));
    await heading('Чат');
    const chip = await screen.findByText('Про: Купить хлеб');
    expect(
      within(chip.parentElement as HTMLElement).getByRole('button', { name: 'Убрать ссылку' }),
    ).toBeInTheDocument();

    const main = screen.getByTestId('screen-content');
    send(main, 'когда?');
    await waitFor(() => expect(sent(calls)).toEqual([withRecordContext('когда?', BREAD)]));
    // Чип держится между сообщениями, пока контекст тот же.
    expect(screen.getByText('Про: Купить хлеб')).toBeInTheDocument();

    send(main, 'такси 500');
    await waitFor(() =>
      expect(sent(calls)).toEqual([
        withRecordContext('когда?', BREAD),
        withRecordContext('такси 500', BREAD),
      ]),
    );
    expect(created(calls)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Убрать ссылку' }));
    expect(screen.queryByText(/^Про:/)).toBeNull();
    send(main, 'такси 500');
    await waitFor(() => expect(created(calls)).toHaveLength(1));
    expect(sent(calls)).toHaveLength(2);
  });

  test('на «Настройках» — без чипа', async () => {
    stubViewport(false);
    resetFrame(`/r/${BREAD}`);
    renderApp();
    await heading('Купить хлеб');
    act(() => useNav.getState().openHostScreen('settings'));
    await heading('Настройки');
    fireEvent.click(hostButton(/Чат/));
    await heading('Чат');
    // Дать заголовку чипа приехать, если бы он был.
    await screen.findByRole('textbox', { name: 'Сообщение' });
    await act(async () => {});
    expect(screen.queryByText(/^Про:/)).toBeNull();
  });

  test('на странице — заголовок страницы; на «Домой» — «Про: Домой»', async () => {
    stubViewport(false);
    resetFrame(`/r/${UPCOMING}`);
    renderApp();
    await heading('Upcoming');
    fireEvent.click(hostButton(/Чат/));
    await heading('Чат');
    expect(await screen.findByText('Про: Upcoming')).toBeInTheDocument();

    act(() => useNav.getState().goHome());
    await heading('Домой');
    fireEvent.click(hostButton(/Чат/));
    await heading('Чат');
    expect(await screen.findByText('Про: Домой')).toBeInTheDocument();
  });
});

describe('(б) десктоп: чип бокового чата — текущая запись основной области', () => {
  test('меняется вслед за основной областью; снятый чип возвращается с новым контекстом', async () => {
    stubViewport(true);
    resetFrame(`/r/${BREAD}`);
    const { calls } = renderApp();
    await heading('Купить хлеб');
    await frameReady(true);
    fireEvent.click(hostButton(/Чат/));
    const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
    expect(await within(side).findByText('Про: Купить хлеб')).toBeInTheDocument();
    send(side, 'когда?');
    await waitFor(() => expect(sent(calls)).toEqual([withRecordContext('когда?', BREAD)]));

    fireEvent.click(within(side).getByRole('button', { name: 'Убрать ссылку' }));
    expect(within(side).queryByText(/^Про:/)).toBeNull();

    act(() => useNav.getState().openRecord(NOTE));
    await heading('Заметка');
    expect(await within(side).findByText('Про: Заметка')).toBeInTheDocument();
    send(side, 'а тут?');
    await waitFor(() => expect(sent(calls)).toContain(withRecordContext('а тут?', NOTE)));

    // Назад на первую запись — снова новый контекст: снятие чипа прежней записи не живёт дольше
    // самого контекста (гейт 25, m-2).
    act(() => useNav.getState().openRecord(BREAD));
    await heading('Купить хлеб');
    expect(await within(side).findByText('Про: Купить хлеб')).toBeInTheDocument();
  });
});

// ─── (в) «＋» с контекстом ─────────────────────────────────────────────────────────────────────

async function capture(calls: Calls, text: string) {
  fireEvent.click(hostButton(/Новая запись/));
  const form = await screen.findByTestId('quick-capture-form');
  fireEvent.change(within(form).getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: text },
  });
  fireEvent.submit(form);
  await waitFor(() =>
    expect(
      created(calls).some((c) => (c.input as { input: { title: string } }).input.title === text),
    ).toBe(true),
  );
  const call = created(calls).find(
    (c) => (c.input as { input: { title: string } }).input.title === text,
  );
  return (call?.input as { input: { aspects?: string[] } }).input;
}

describe.each([
  ['телефон', false],
  ['десктоп', true],
] as const)('(в) %s: «＋» (РП-9, В-6)', (_name, desktop) => {
  test('на записи-задаче — подзадача', async () => {
    stubViewport(desktop);
    resetFrame(`/r/${TASK}`);
    const { calls } = renderApp();
    await heading('Починить кран');
    await frameReady(desktop);
    const input = await capture(calls, 'купить прокладку');
    expect(input.aspects).toEqual(['orbis/task']);
    await waitFor(() => expect(related(calls)).toHaveLength(1));
    expect(related(calls)[0]?.input).toMatchObject({ source_id: TASK, role: ROLE_SUBITEM });
  });

  test('на странице — без связи', async () => {
    stubViewport(desktop);
    resetFrame(`/r/${UPCOMING}`);
    const { calls } = renderApp();
    await heading('Upcoming');
    await frameReady(desktop);
    const input = await capture(calls, 'идея');
    expect(input.aspects).toBeUndefined();
    await act(async () => {});
    expect(related(calls)).toEqual([]);
  });
});

test.each([
  ['телефон', 'chat', false, 'Чат'],
  ['телефон', 'settings', false, 'Настройки'],
  ['десктоп', 'chat', true, 'Чат'],
  ['десктоп', 'settings', true, 'Настройки'],
] as const)('(в) %s: «＋» на экране хоста %s — без контекста', async (_w, hostScreen, desktop, title) => {
  // Экран хоста лежит поверх записи-задачи: «＋» про экран, а не про место под ним (гейт 25, m-3).
  stubViewport(desktop);
  resetFrame(`/r/${TASK}`);
  const { calls } = renderApp();
  await heading('Починить кран');
  await frameReady(desktop);
  act(() => useNav.getState().openHostScreen(hostScreen));
  await heading(title);
  expect(useNav.getState().model.activeApp).toBe(HOST_APP);
  const input = await capture(calls, 'мысль');
  expect(input.aspects).toBeUndefined();
  await act(async () => {});
  expect(related(calls)).toEqual([]);
});

// ─── гейт 25, m-1: «＋» не знает, страница ли место, — без контекста; плашка поверх модели ─────────

test('(в) «＋» на странице, пока её запись не прочтена, — без контекста; и после приезда тоже', async () => {
  let release!: () => void;
  const until = new Promise<void>((r) => {
    release = r;
  });
  stubViewport(false);
  resetFrame(`/r/${UPCOMING}`);
  const { calls } = renderApp({ id: UPCOMING, until });
  await screen.findByTestId('host-buttons');
  const early = await capture(calls, 'рано');
  expect(early.aspects).toBeUndefined();
  release();
  await heading('Upcoming');
  // Форма «＋» ещё открыта (второе нажатие закрыло бы её): пишем в неё же.
  const form = screen.getByTestId('quick-capture-form');
  fireEvent.change(within(form).getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: 'поздно' },
  });
  fireEvent.submit(form);
  await waitFor(() => expect(created(calls)).toHaveLength(2));
  const late = (created(calls)[1]?.input as { input: { aspects?: string[] } }).input;
  expect(late.aspects).toBeUndefined();
  await act(async () => {});
  expect(related(calls)).toEqual([]);
});

test('(в) «＋» на записи-задаче, чья запись приехала после открытия «＋», — подзадача (подписка на кеш)', async () => {
  let release!: () => void;
  const until = new Promise<void>((r) => {
    release = r;
  });
  stubViewport(false);
  resetFrame(`/r/${TASK}`);
  const { calls } = renderApp({ id: TASK, until });
  await screen.findByTestId('host-buttons');
  fireEvent.click(hostButton(/Новая запись/));
  await screen.findByTestId('quick-capture-form');
  release();
  await heading('Починить кран');
  // «＋» открыт ДО ответа — `capture` жмёт «＋» ещё раз и закрыл бы его: пишем в открытую форму.
  const form = screen.getByTestId('quick-capture-form');
  fireEvent.change(within(form).getByRole('textbox', { name: 'Быстрая запись' }), {
    target: { value: 'подзадача' },
  });
  fireEvent.submit(form);
  await waitFor(() => expect(related(calls)).toHaveLength(1));
  expect(related(calls)[0]?.input).toMatchObject({ source_id: TASK, role: ROLE_SUBITEM });
});

const BUDGET_OVERLAY = { kind: 'reserved', key: 'budget', path: '/budget' } as const;

test('(в) телефон: плашка поверх записи-задачи — «＋» без контекста, 💬 без чипа', async () => {
  stubViewport(false);
  resetFrame(`/r/${TASK}`);
  const { calls } = renderApp();
  await heading('Починить кран');
  act(() => useNav.setState({ overlay: BUDGET_OVERLAY }));
  await screen.findByText(/Бюджет придёт/);
  const input = await capture(calls, 'под плашкой');
  expect(input.aspects).toBeUndefined();
  await act(async () => {});
  expect(related(calls)).toEqual([]);

  fireEvent.click(hostButton(/Чат/));
  await heading('Чат');
  await screen.findByRole('textbox', { name: 'Сообщение' });
  await act(async () => {});
  expect(screen.queryByText(/^Про:/)).toBeNull();
});

test('(б) десктоп: плашка поверх записи — чип бокового чата снят, ушла — вернулся', async () => {
  stubViewport(true);
  resetFrame(`/r/${TASK}`);
  renderApp();
  await heading('Починить кран');
  await frameReady(true);
  fireEvent.click(hostButton(/Чат/));
  const side = await screen.findByRole('complementary', { name: 'Чат' }, { timeout: 5000 });
  expect(await within(side).findByText('Про: Починить кран')).toBeInTheDocument();
  act(() => useNav.setState({ overlay: BUDGET_OVERLAY }));
  await waitFor(() => expect(within(side).queryByText(/^Про:/)).toBeNull());
  act(() => useNav.setState({ overlay: null }));
  expect(await within(side).findByText('Про: Починить кран')).toBeInTheDocument();
});

test('(в) вариант контекста `smart-list` снят (§9.4) — typecheck держит', () => {
  // @ts-expect-error — варианта больше нет: быстрый ввод знает только `root` и `entity`.
  const x: CaptureContext = { kind: 'smart-list' };
  expect(x.kind).toBe('smart-list');
});
