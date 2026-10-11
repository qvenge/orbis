/**
 * Правило открытия с приложением в адресе — в web (срез 1б §5, §7.2, §7.4; С1б-1 web, Фокус ревью
 * п. 3; РП-20, РП-21, R-25). Рисуется `<App/>` целиком: решение правила, замена адреса, рамка и
 * плашки проверяются вместе — по отдельности они зеленели бы и при разъехавшемся экране.
 */
import { APP_DISABLED, APP_OPENS_OVER } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../../App';
import {
  navModel,
  resetFrame,
  SHELL,
  shownPath,
  stubLaunchMode,
  unstubLaunchMode,
} from '../../app/frame/frame-fixtures';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { useToastStore } from '../../ui/toast-store';
import {
  type AppsWorld,
  appRow,
  appsHandler,
  appsWorld,
  CHIPS,
  DACHA,
  DACHA_ROW,
  IDEA,
  IDEA_ROW,
  MY,
  MY_HOME,
  MY_ROW,
  NOTES,
  NOTES_ROW,
  PLAIN,
  PLAIN_ROW,
  PROJ,
  PROJ_ROW,
  page,
  TASK,
  TASK_ROW,
  TPL_MY,
  TPL_NOTES,
  TPL_PROJ,
  UTRO,
} from './apps-world';
import { OpenPlaqueList } from './OpenPlaqueList';

installCrashTrap();

beforeEach(() => {
  resetRegistryVersionForTests();
  noteRegistryVersion(BUILTIN_REGISTRY.version);
  vi.stubGlobal('requestIdleCallback', () => 1);
  stubLaunchMode('site');
});

afterEach(() => {
  vi.unstubAllGlobals();
  unstubLaunchMode();
  resetFrame('/');
});

function renderApp(
  world: AppsWorld = appsWorld(),
  extra?: (path: string, input: unknown) => unknown,
) {
  const base = appsHandler(world);
  return renderWithProviders(<App />, (path, input, type) => {
    const got = extra?.(path, input);
    return got !== undefined ? got : base(path, input, type);
  });
}

/** Первое ожидание ждёт ленивый чанк экрана записи (холодный кеш vite — гейт 19, M-1). */
const heading = (name: string) =>
  screen.findByRole('heading', { level: 1, name }, { timeout: 5000 });

/** Иконка рамки в присутствии хоста: «🏡 · …» — «Мой дом», «🪐 · …» — хост. */
const frameIcon = () => within(screen.getByTestId('host-presence')).getByTestId('nav-switch');

const back = () =>
  fireEvent.click(
    within(screen.getByTestId('host-presence')).getByRole('button', { name: 'Назад' }),
  );

const batches = (calls: { path: string; input: unknown }[]) =>
  calls.filter((c) => c.path === 'entity.updateBatch');

// ─── (а) одно приложение с видом — сразу туда, адрес заменён ───────────────────────────────────

test('(а) задача из чата — в рамке «Мой дом», адрес заменён (replaceState), «‹» — в чат', async () => {
  resetFrame('/chat');
  const world = appsWorld();
  const base = appsHandler(world);
  const push = vi.spyOn(window.history, 'pushState');
  renderWithProviders(<App />, (path, input, type) =>
    path === 'chat.listMessages'
      ? [
          {
            id: 'm1',
            threadId: 'g',
            role: 'assistant',
            content: `готово: [[entity:${TASK}]]`,
            metadata: {},
            createdAt: '2026-07-05T12:00:00.000Z',
          },
        ]
      : base(path, input, type),
  );
  await heading('Чат');
  fireEvent.click(await screen.findByRole('link', { name: TASK }));
  await heading('Починить кран');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(navModel().activeApp).toBe(MY);
  // Один шаг истории — переход из чата; уточнение места правилом шага не добавило (РП-21).
  expect(push).toHaveBeenCalledTimes(1);
  push.mockRestore();
  expect(await screen.findByText('Вид «Задачи дома».')).toBeInTheDocument();

  back();
  await heading('Чат');
  expect(shownPath()).toBe('/chat');
});

// ─── (б) спор мест: вопрос с галочкой «запомнить» ──────────────────────────────────────────────

const TWO_PLACES = () => appsWorld({ templates: [TPL_MY, TPL_PROJ] });

test('(б) два места без выбора — запись в хосте и вопрос; «Мой дом» с галочкой — одна пачка и переход', async () => {
  resetFrame(`/r/${TASK}`);
  const world = TWO_PLACES();
  const { calls } = renderApp(world);
  await heading('Починить кран');
  const question = await screen.findByTestId('place-question');
  expect(question).toHaveTextContent('Где открывать такие записи?');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  expect(shownPath()).toBe(`/r/${TASK}`);
  const remember = within(question).getByRole('checkbox', { name: 'Запомнить' });
  expect(remember).toBeChecked();

  fireEvent.click(within(question).getByRole('button', { name: 'Мой дом' }));
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  const written = batches(calls);
  expect(written).toHaveLength(1);
  expect(written[0]?.input).toMatchObject({
    operations: [{ tool: 'entity_update', input: { id: MY, props: { [APP_OPENS_OVER]: [PROJ] } } }],
  });
  await waitFor(() => expect(screen.queryByTestId('place-question')).toBeNull());

  // Повторное открытие из хоста — сразу туда, без вопроса.
  act(() => useNav.getState().goHome());
  await heading('Домой');
  act(() => useNav.getState().openRecord(TASK, { app: 'host' }));
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  expect(screen.queryByTestId('place-question')).toBeNull();
  expect(batches(calls)).toHaveLength(1);
});

test('(б) без галочки — переход разовый, пачки нет; повторное открытие снова спрашивает', async () => {
  resetFrame(`/r/${TASK}`);
  const { calls } = renderApp(TWO_PLACES());
  const question = await screen.findByTestId('place-question');
  fireEvent.click(within(question).getByRole('checkbox', { name: 'Запомнить' }));
  fireEvent.click(within(question).getByRole('button', { name: 'Проекты' }));
  await waitFor(() => expect(shownPath()).toBe(`/a/${PROJ}/r/${TASK}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('📁'));
  expect(batches(calls)).toHaveLength(0);

  act(() => useNav.getState().goHome());
  await heading('Домой');
  act(() => useNav.getState().openRecord(TASK, { app: 'host' }));
  expect(await screen.findByTestId('place-question')).toBeInTheDocument();
  expect(shownPath()).toBe(`/r/${TASK}`);
});

test('(б) повтор того же выбора — пустая карта, пустой пачки нет (carry, Fable M-4)', async () => {
  resetFrame(`/r/${TASK}`);
  // Выбор уже сделан; вопрос открыт меню «Сменить, где открывать такие записи».
  const world = appsWorld({
    apps: [appRow(MY, 'Мой дом', '🏡', { [APP_OPENS_OVER]: [PROJ] }), PROJ_ROW],
    templates: [TPL_MY, TPL_PROJ],
  });
  const { calls } = renderApp(world);
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  await heading('Починить кран');
  fireEvent.click(screen.getByTestId('screen-menu'));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Сменить, где открывать такие записи' }),
  );
  const question = await screen.findByTestId('place-question');
  fireEvent.click(within(question).getByRole('button', { name: 'Мой дом' }));
  await waitFor(() => expect(screen.queryByTestId('place-question')).toBeNull());
  expect(batches(calls)).toHaveLength(0);
});

// ─── (в) адрес на выключенное, архивное, не-приложение, резерв (Фокус ревью п. 3) ─────────────

test('(в) /a/<выключенное>/r/<id> — хост и плашка «выключено — [включить]»; «включить» зовёт app.setDisabled', async () => {
  resetFrame(`/a/${MY}/r/${TASK}`);
  const world = appsWorld({ apps: [appRow(MY, 'Мой дом', '🏡', { [APP_DISABLED]: true })] });
  const { calls } = renderApp(world);
  await heading('Починить кран');
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Мой дом выключено');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  // Адрес держит плашку: «включить» обязано вернуть в то самое приложение.
  expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`);
  expect(within(plaque).queryByRole('button', { name: 'восстановить' })).toBeNull();
  fireEvent.click(within(plaque).getByRole('button', { name: 'включить' }));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'app.setDisabled')).toEqual([
      { path: 'app.setDisabled', input: { appId: MY, disabled: false, extensions: [] } },
    ]),
  );
  // Включилось — перечитанный список даёт приложение: рамка «Мой дом», его вид, плашки нет.
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(await screen.findByText('Вид «Задачи дома».')).toBeInTheDocument();
  expect(screen.queryByTestId('open-plaque')).toBeNull();
});

test('(в) архивное — плашка «в архиве — [восстановить]», «восстановить» — пачка с archived:false (Э-20)', async () => {
  resetFrame(`/a/${MY}/r/${PLAIN}`);
  const world = appsWorld({ apps: [appRow(MY, 'Мой дом', '🏡', {}, { archived: true })] });
  const { calls } = renderApp(world);
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Мой дом в архиве');
  expect(within(plaque).queryByRole('button', { name: 'включить' })).toBeNull();
  fireEvent.click(within(plaque).getByRole('button', { name: 'восстановить' }));
  await waitFor(() => expect(batches(calls)).toHaveLength(1));
  expect(batches(calls)[0]?.input).toMatchObject({
    operations: [{ tool: 'entity_update', input: { id: MY, archived: false } }],
  });
  expect(calls.filter((c) => c.path === 'app.setDisabled')).toEqual([]);
});

test('(в) /a/<id обычной записи> — хост и плашка «приложение не найдено», не пустота', async () => {
  resetFrame(`/a/${PLAIN}`);
  renderApp();
  const plaque = await screen.findByTestId('open-plaque', undefined, { timeout: 5000 });
  expect(plaque).toHaveTextContent('Приложение не найдено');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  expect(screen.getByTestId('host-buttons')).toBeInTheDocument();
});

test('(в) /a/<id обычной записи>/r/<id> — запись в хосте и та же плашка', async () => {
  resetFrame(`/a/${PLAIN}/r/${IDEA}`);
  renderApp();
  await heading('Идея');
  expect(await screen.findByTestId('open-plaque')).toHaveTextContent('Приложение не найдено');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

test('(в) /a/<выключенное> — домашняя: хост и плашка «выключено — [включить]»', async () => {
  resetFrame(`/a/${DACHA}`);
  renderApp(appsWorld({ apps: [MY_ROW, DACHA_ROW] }));
  const plaque = await screen.findByTestId('open-plaque', undefined, { timeout: 5000 });
  expect(plaque).toHaveTextContent('Дача выключено');
  expect(within(plaque).getByRole('button', { name: 'включить' })).toBeInTheDocument();
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

test('(в) /a/budget/r/<id> — хост и «Бюджет придёт отдельным срезом»', async () => {
  resetFrame(`/a/budget/r/${PLAIN}`);
  renderApp();
  expect(await screen.findByTestId('reserved-screen')).toHaveTextContent(
    'Бюджет придёт отдельным срезом',
  );
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

test('(в) плашка правила открытия `reserved` — «Бюджет придёт отдельным срезом», без кнопки (1в §7.4)', async () => {
  // Второе место того же текста — чанк плашек (`OpenPlaqueList`), не экран `/budget`: правило
  // открытия кладёт `reserved` для `/a/budget` (shared `open-rule.ts`). Рисуется напрямую — в `<App/>`
  // адрес `/a/budget` раньше перехватывает оверлей `ReservedScreen`, и текст плашки остался бы без пина.
  renderWithProviders(
    <OpenPlaqueList
      plaques={[{ kind: 'reserved', key: 'budget' }]}
      apps={{ apps: [], byId: new Map(), hostShell: null, status: 'ok' }}
      record={null}
    />,
    () => ({}),
  );
  const plaque = screen.getByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Бюджет придёт отдельным срезом');
  expect(within(plaque).queryByRole('button')).toBeNull();
});

test('(в) R-25: /a/<выключенное>/r/<задача> при одном месте P — экран в P и плашка выключенного', async () => {
  resetFrame(`/a/${DACHA}/r/${TASK}`);
  const { calls } = renderApp(appsWorld({ apps: [MY_ROW, DACHA_ROW] }));
  await heading('Починить кран');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  // Плашка решения, вызвавшего замену, — после замены (пересчёт для нового адреса её не дал бы).
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Дача выключено');
  fireEvent.click(within(plaque).getByRole('button', { name: 'включить' }));
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'app.setDisabled')).toEqual([
      { path: 'app.setDisabled', input: { appId: DACHA, disabled: false, extensions: [] } },
    ]),
  );
  // До следующего перехода владельца: ушли — плашки нет и на возврате.
  act(() => useNav.getState().goHome());
  await heading('Домой');
  expect(screen.queryByTestId('open-plaque')).toBeNull();
});

// ─── (г) в приложении нет вида — шаблон хоста в его рамке и подсказка ──────────────────────────

test('(г) заметка в «Мой дом» без вида заметок — шаблон хоста в рамке «Мой дом» и «открыть в [Заметки]»', async () => {
  resetFrame(`/a/${MY}/r/${IDEA}`);
  renderApp(appsWorld({ apps: [MY_ROW, NOTES_ROW], templates: [TPL_MY, TPL_NOTES] }));
  await heading('Идея');
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('В «Мой дом» нет вида для таких записей');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(shownPath()).toBe(`/a/${MY}/r/${IDEA}`);
  expect(screen.queryByText('Вид «Заметки вид».')).toBeNull();
  fireEvent.click(within(plaque).getByRole('button', { name: 'Заметки' }));
  await waitFor(() => expect(shownPath()).toBe(`/a/${NOTES}/r/${IDEA}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('📝'));
  expect(await screen.findByText('Вид «Заметки вид».')).toBeInTheDocument();
});

// ─── (д) страница — в рамке своего дома ────────────────────────────────────────────────────────

test('(д) страница с «Домом» = «Мой дом», открытая из хоста, — в рамке «Мой дом», адрес заменён', async () => {
  resetFrame(`/r/${UTRO}`);
  const world = appsWorld({ records: [page(UTRO, 'Утро', MY, 'Доброе утро.')] });
  renderApp(world);
  await heading('Утро');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${UTRO}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
});

test('(д) дом страницы — не приложение: страница в хосте и своя плашка (не «адрес не приложение»)', async () => {
  resetFrame(`/r/${UTRO}`);
  renderApp(appsWorld({ records: [page(UTRO, 'Утро', PLAIN, 'Доброе утро.'), PLAIN_ROW] }));
  await heading('Утро');
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Дом страницы не найден');
  expect(plaque).not.toHaveTextContent('Приложение не найдено');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
});

// ─── (е) «⋯ → Открыть в [X]», «Сменить, где открывать такие записи» ────────────────────────────

test('(е) «⋯ → Открыть в «Проекты»» — разово в «Проекты»; «Сменить, где открывать…» — вопрос', async () => {
  resetFrame(`/r/${TASK}`);
  const world = appsWorld({
    apps: [appRow(MY, 'Мой дом', '🏡', { [APP_OPENS_OVER]: [PROJ] }), PROJ_ROW],
    templates: [TPL_MY, TPL_PROJ],
  });
  const { calls } = renderApp(world);
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${TASK}`));
  await heading('Починить кран');
  fireEvent.click(screen.getByTestId('screen-menu'));
  const own = await screen.findByRole('group', { name: 'Этот экран' });
  // Своя рамка пунктом не предлагается — открыть «в Моём доме», находясь в нём, нечего.
  expect(within(own).queryByRole('menuitem', { name: 'Открыть в «Мой дом»' })).toBeNull();
  fireEvent.click(within(own).getByRole('menuitem', { name: 'Открыть в «Проекты»' }));
  await waitFor(() => expect(shownPath()).toBe(`/a/${PROJ}/r/${TASK}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('📁'));
  expect(await screen.findByText('Вид «Задачи проектов».')).toBeInTheDocument();
  expect(batches(calls)).toHaveLength(0);

  fireEvent.click(screen.getByTestId('screen-menu'));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Сменить, где открывать такие записи' }),
  );
  expect(await screen.findByTestId('place-question')).toBeInTheDocument();
});

test('(е) одно место — «Открыть в» есть из хоста, «Сменить, где открывать…» нет', async () => {
  resetFrame(`/a/${PROJ}/r/${TASK}`);
  // В «Проекты» вида задач нет (шаг 3), место одно — «Мой дом».
  renderApp(appsWorld({ templates: [TPL_MY] }));
  await heading('Починить кран');
  fireEvent.click(screen.getByTestId('screen-menu'));
  const own = await screen.findByRole('group', { name: 'Этот экран' });
  expect(within(own).getByRole('menuitem', { name: 'Открыть в «Мой дом»' })).toBeInTheDocument();
  expect(
    within(own).queryByRole('menuitem', { name: 'Сменить, где открывать такие записи' }),
  ).toBeNull();
});

// ─── (ж) ссылка внутри страницы приложения несёт приложение ────────────────────────────────────

test('(ж) строка блока данных на странице «Утро» «Моего дома» — запись в рамке «Мой дом»', async () => {
  const block = 'aspect=orbis/task';
  resetFrame(`/a/${MY}/r/${UTRO}`);
  const world = appsWorld({
    records: [page(UTRO, 'Утро', MY, `Утро.\n\n{{query: ${block}}}`), PLAIN_ROW],
    blockRows: { [`{{query: ${block}}}`]: [PLAIN_ROW], [block]: [PLAIN_ROW] },
  });
  renderApp(world);
  await heading('Утро');
  fireEvent.click(await screen.findByText('Купить хлеб'));
  await heading('Купить хлеб');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}/r/${PLAIN}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
});

// ─── (з) чип на запись-приложение открывает приложение ─────────────────────────────────────────

test('(з) чип на запись-приложение «Мой дом» — /a/<мой дом>, домашняя в его рамке', async () => {
  resetFrame(`/r/${CHIPS}`);
  const note = wireEntity({ id: CHIPS, title: 'Ссылки', body: `Дом: [[entity:${MY}]]` });
  renderApp(appsWorld({ records: [note] }));
  await heading('Ссылки');
  fireEvent.click(await screen.findByRole('link', { name: MY }));
  await heading('Дом приложения');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}`));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
});

test('(з) чип на запись-оболочку хоста — «/», «Домой» хоста', async () => {
  resetFrame(`/a/${MY}/r/${CHIPS}`);
  const note = wireEntity({ id: CHIPS, title: 'Ссылки', body: `Хост: [[entity:${SHELL}]]` });
  renderApp(appsWorld({ records: [note] }));
  await heading('Ссылки');
  fireEvent.click(await screen.findByRole('link', { name: SHELL }));
  await heading('Домой');
  await waitFor(() => expect(shownPath()).toBe('/'));
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  // Домашняя — корень HOME_SECTION хоста одной записью, не двойник поверх «Домой» (финал C1 M-1).
  const host = useNav.getState().model.apps.host;
  expect(host?.activeSection).toBe('home');
  expect(host?.stacks.home?.map((e) => e.address)).toEqual([
    { kind: 'home', app: { kind: 'host' } },
  ]);
});

test('(з) чип на своё приложение изнутри него — домашняя одной записью в HOME_SECTION (финал C1 M-1)', async () => {
  resetFrame(`/a/${MY}/r/${CHIPS}`);
  const note = wireEntity({ id: CHIPS, title: 'Ссылки', body: `Дом: [[entity:${MY}]]` });
  renderApp(appsWorld({ records: [note] }));
  await heading('Ссылки');
  fireEvent.click(await screen.findByRole('link', { name: MY }));
  await heading('Дом приложения');
  await waitFor(() => expect(shownPath()).toBe(`/a/${MY}`));
  const my = useNav.getState().model.apps[MY];
  expect(my?.activeSection).toBe('home');
  expect(my?.stacks.home?.map((e) => e.address)).toEqual([
    { kind: 'home', app: { kind: 'app', ref: MY } },
  ]);
});

// Соседи, на которых правило не должно спотыкаться: обычная запись без мест и не-приложения.
test('запись без мест из хоста — хост, адрес тот же, плашек нет', async () => {
  resetFrame(`/r/${PLAIN}`);
  renderApp(appsWorld({ records: [TASK_ROW, IDEA_ROW, PLAIN_ROW] }));
  await heading('Купить хлеб');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  expect(shownPath()).toBe(`/r/${PLAIN}`);
  expect(screen.queryByTestId('open-plaque')).toBeNull();
  expect(screen.queryByTestId('place-question')).toBeNull();
});

// ─── Раунд 1 гейта (I-1, I-2, m-1, m-3) ────────────────────────────────────────────────────────

const OFF_MY = () =>
  appRow(MY, 'Мой дом', '🏡', { 'orbis/app_home': MY_HOME, [APP_DISABLED]: true });

test('I-1: домашняя /a/<выключенное> — «включить» возвращает место в рамку приложения', async () => {
  resetFrame(`/a/${MY}`);
  const { calls } = renderApp(appsWorld({ apps: [OFF_MY()] }));
  const plaque = await screen.findByTestId('open-plaque', undefined, { timeout: 5000 });
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  fireEvent.click(within(plaque).getByRole('button', { name: 'включить' }));
  await heading('Дом приложения');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(navModel().activeApp).toBe(MY);
  expect(shownPath()).toBe(`/a/${MY}`);
  expect(calls.filter((c) => c.path === 'app.setDisabled')).toHaveLength(1);
});

test('I-1: домашняя /a/<архивное> — «восстановить» возвращает место в рамку приложения', async () => {
  resetFrame(`/a/${MY}`);
  const archived = appRow(MY, 'Мой дом', '🏡', { 'orbis/app_home': MY_HOME }, { archived: true });
  renderApp(appsWorld({ apps: [archived] }));
  const plaque = await screen.findByTestId('open-plaque', undefined, { timeout: 5000 });
  fireEvent.click(within(plaque).getByRole('button', { name: 'восстановить' }));
  await heading('Дом приложения');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(navModel().activeApp).toBe(MY);
});

test('I-1: плитка выключенного приложения на «Домой» → плашка → «включить» → его домашняя в его рамке', async () => {
  resetFrame('/');
  renderApp(appsWorld({ apps: [OFF_MY()] }));
  await heading('Домой');
  fireEvent.click(await screen.findByTestId(`app-tile-${MY}`));
  const plaque = await screen.findByTestId('open-plaque');
  expect(plaque).toHaveTextContent('Мой дом выключено');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🪐'));
  fireEvent.click(within(plaque).getByRole('button', { name: 'включить' }));
  await heading('Дом приложения');
  await waitFor(() => expect(frameIcon()).toHaveTextContent('🏡'));
  expect(navModel().activeApp).toBe(MY);
});

test('m-3 / R-33: отказ «включить» — тост ошибки, не молча', async () => {
  resetFrame(`/a/${MY}`);
  useToastStore.setState({ toasts: [] });
  renderApp(appsWorld({ apps: [OFF_MY()] }), (path) => {
    if (path === 'app.setDisabled') throw new Error('отказ');
    return undefined;
  });
  const plaque = await screen.findByTestId('open-plaque', undefined, { timeout: 5000 });
  fireEvent.click(within(plaque).getByRole('button', { name: 'включить' }));
  await waitFor(() =>
    expect(useToastStore.getState().toasts).toMatchObject([
      { title: 'Не удалось включить «Мой дом»', tone: 'danger' },
    ]),
  );
  expect(frameIcon()).toHaveTextContent('🪐');
});

test('I-2: «Дом» страницы выключен и в старом, и в новом адресе — одна плашка, без двойных ключей', async () => {
  const errors = vi.spyOn(console, 'error');
  resetFrame(`/a/${MY}/r/${UTRO}`);
  renderApp(
    appsWorld({ apps: [MY_ROW, DACHA_ROW], records: [page(UTRO, 'Утро', DACHA, 'Утро.')] }),
  );
  await heading('Утро');
  await waitFor(() => expect(shownPath()).toBe(`/r/${UTRO}`));
  await waitFor(() => expect(screen.getAllByTestId('open-plaque')).toHaveLength(1));
  expect(screen.getByTestId('open-plaque')).toHaveTextContent('Дача выключено');
  expect(errors.mock.calls.flat().join(' ')).not.toContain('same key');
  errors.mockRestore();
});

test('I-2: /a/<оболочка хоста>/r/<задача> при споре мест — один вопрос', async () => {
  resetFrame(`/a/${SHELL}/r/${TASK}`);
  renderApp(TWO_PLACES());
  await heading('Починить кран');
  await waitFor(() => expect(shownPath()).toBe(`/r/${TASK}`));
  await screen.findByTestId('place-question');
  await waitFor(() => expect(screen.getAllByTestId('place-question')).toHaveLength(1));
});

test('m-1: «Сменить, где открывать…» при открытом вопросе второго не добавляет', async () => {
  resetFrame(`/r/${TASK}`);
  renderApp(TWO_PLACES());
  await screen.findByTestId('place-question');
  fireEvent.click(screen.getByTestId('screen-menu'));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Сменить, где открывать такие записи' }),
  );
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getAllByTestId('place-question')).toHaveLength(1);
});
