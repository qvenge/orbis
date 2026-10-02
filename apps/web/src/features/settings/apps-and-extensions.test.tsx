/**
 * Вкладка «Приложения и расширения» (срез 1б §8.6, §9.1 п. 2–3; С1б-6 web, С1б-10, С1б-11): расширения
 * с переключателями, приложения с «Выключить» / «Удалить» / «Новое приложение», «Обновления» поставки
 * предложениями. Экран настроек рисуется целиком; сеть — мок по путям.
 */
import {
  APP_ASPECT,
  APP_DISABLED,
  APP_EXTENSIONS,
  APP_HOME,
  APP_NAV,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { etalonOf } from '@orbis/shared/supply';
import { printAppProps, printPageRecord } from '@orbis/shared/supply/print';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  installCrashTrap,
  type MockHandler,
  renderWithProviders,
  wireEntity,
} from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { APPS_QUERY } from '../apps/useApps';
import { SUPPLY_UPDATES_STALE_MS, type SupplyUpdate } from '../supply/useSupply';
import { SettingsScreen } from './SettingsScreen';

installCrashTrap();

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
});

const id = (n: number) => `00000000-0000-4000-8000-0000000022${String(n).padStart(2, '0')}`;
const SHELL = id(1);
const WORK = id(2);
const STUDY = id(3);
const DACHA = id(4);
const ACT = id(90);

const SETTINGS = {
  graphId: 'g',
  plan: 'dev',
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 'monday',
  tagColors: {},
  installedViews: [],
  pinnedEntities: [],
  viewPreferences: {},
  disabledModules: ['finance'],
  updatedAt: 'x',
};

const APPS = [
  wireEntity({
    id: SHELL,
    title: 'Orbis',
    emoji: '🪐',
    aspects: [APP_ASPECT, SUPPLY_ASPECT],
    props: { [SUPPLY_KEY]: 'host-shell', [APP_NAV]: [] },
  }),
  wireEntity({
    id: WORK,
    title: 'Работа',
    emoji: '💼',
    aspects: [APP_ASPECT],
    props: { [APP_EXTENSIONS]: ['goals', 'projects'], [APP_HOME]: null },
  }),
  wireEntity({
    id: STUDY,
    title: 'Учёба',
    emoji: '📚',
    aspects: [APP_ASPECT],
    props: { [APP_EXTENSIONS]: ['projects'] },
  }),
  wireEntity({
    id: DACHA,
    title: 'Дача',
    emoji: '🌲',
    aspects: [APP_ASPECT],
    props: { [APP_EXTENSIONS]: ['goals'], [APP_DISABLED]: true },
  }),
];

const pagePrint = (key: Parameters<typeof etalonOf>[0], body: string) => {
  const e = etalonOf(key);
  return printPageRecord({ title: e.title, emoji: e.emoji, body });
};

const update = (over: Partial<SupplyUpdate> & Pick<SupplyUpdate, 'key'>): SupplyUpdate => ({
  kind: 'update',
  recordId: id(50),
  edited: false,
  declined: false,
  etalonText: pagePrint(over.key, 'Эталон.'),
  recordText: pagePrint(over.key, 'Запись.'),
  ...over,
});

/** Заголовки записей для `entity.resolveRefs` (сравнение приложения показывает их вместо id). */
const TITLES: Record<string, string> = { [id(60)]: 'Записи', [id(61)]: 'Моя страница' };

/** «Рутины» правлены владельцем, «Домой» — нет (шаг 1 (г) плана). */
const TWO_UPDATES: SupplyUpdate[] = [
  update({
    key: 'routines',
    recordId: id(51),
    edited: true,
    recordText: pagePrint('routines', 'Мои утренние рутины.'),
    etalonText: pagePrint('routines', 'Рутины поставки.'),
  }),
  update({ key: 'home', recordId: id(52) }),
];

type BatchOp = { tool: string; input: Record<string, unknown> & { id: string } };

function render(updates: () => SupplyUpdate[] = () => []) {
  // «Сервер в памяти» для записей-приложений: пачка правит их, перечитывание видит записанное.
  const apps = new Map(APPS.map((a) => [a.id, { ...a, props: { ...a.props } }]));
  const handler: MockHandler = (path, input) => {
    switch (path) {
      case 'user.getSettings':
        return SETTINGS;
      case 'entity.query':
        return (input as { query: string }).query === APPS_QUERY ? [...apps.values()] : [];
      case 'entity.updateBatch': {
        for (const { tool, input: op } of (input as { operations: BatchOp[] }).operations) {
          const cur = apps.get(op.id);
          if (tool !== 'entity_update' || cur === undefined) continue;
          const props = { ...cur.props, ...(op.props as Record<string, unknown> | undefined) };
          for (const k of (op.unset as string[] | undefined) ?? []) delete props[k];
          apps.set(op.id, { ...cur, props });
        }
        return { actionId: ACT, consequences: false, results: [] };
      }
      case 'supply.updates':
        return updates();
      case 'supply.acceptAll':
        return { actionId: ACT, consequences: false, accepted: ['home'] };
      case 'user.setModuleEnabled':
        return { ...SETTINGS, actionId: ACT, consequences: false };
      case 'supply.accept':
      case 'supply.decline':
      case 'supply.add':
      case 'supply.revert':
      case 'app.setDisabled':
      case 'app.archive':
        return { actionId: ACT, consequences: false };
      case 'ai.undo':
        return { ok: true, actionId: ACT };
      case 'entity.resolveRefs':
        return (input as { ids: string[] }).ids.flatMap((rid) => {
          const title = TITLES[rid];
          return title === undefined
            ? []
            : [{ id: rid, title, emoji: null, completable: null, archived: false }];
        });
      default:
        return {};
    }
  };
  const r = renderWithProviders(<SettingsScreen />, handler);
  const callsOf = (path: string) => r.calls.filter((c) => c.path === path).map((c) => c.input);
  return { ...r, callsOf };
}

async function openTab(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: 'Приложения и расширения' }));
  await screen.findByRole('region', { name: 'Расширения' });
}

const toasts = () => useToastStore.getState().toasts;

async function undoLastToast(title: string): Promise<void> {
  await waitFor(() => expect(toasts().map((t) => t.title)).toContain(title));
  const t = toasts().find((x) => x.title === title);
  expect(t?.action?.label).toBe('Отменить');
  t?.action?.onSelect();
}

// ─── (а) вкладка, расширения, приложения ──────────────────────────────────────────────────────────

test('(а) С1б-10: вкладка «Приложения и расширения», слова «Views» в интерфейсе нет', async () => {
  render();
  const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent);
  expect(tabs).toContain('Приложения и расширения');
  expect(document.body.textContent).not.toMatch(/Views/);
  await openTab();
  expect(document.body.textContent).not.toMatch(/Views/);
});

test('(а) расширения: четыре строки — иконка, имя, описание, переключатель; Финансы по маске выключены', async () => {
  render();
  await openTab();
  const region = screen.getByRole('region', { name: 'Расширения' });
  const switches = within(region).getAllByRole('switch');
  expect(switches.map((s) => s.getAttribute('aria-label'))).toEqual([
    'Расширение «Финансы»',
    'Расширение «Цели»',
    'Расширение «Проекты»',
    'Расширение «Разработка»',
  ]);
  const finance = within(region).getByTestId('extension-finance');
  expect(finance).toHaveTextContent('💰');
  expect(finance).toHaveTextContent('Расходы и доходы, категории');
  await waitFor(() =>
    expect(within(region).getByRole('switch', { name: 'Расширение «Финансы»' })).toHaveAttribute(
      'aria-checked',
      'false',
    ),
  );
  expect(within(region).getByRole('switch', { name: 'Расширение «Цели»' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('(а) включить Финансы → user.setModuleEnabled, тост «Отменить» → ai.undo этого действия', async () => {
  const { callsOf } = render();
  await openTab();
  const sw = screen.getByRole('switch', { name: 'Расширение «Финансы»' });
  await waitFor(() => expect(sw).toBeEnabled());
  fireEvent.click(sw);
  await waitFor(() =>
    expect(callsOf('user.setModuleEnabled')).toEqual([{ module: 'finance', enabled: true }]),
  );
  await undoLastToast('Расширение «Финансы» включено');
  await waitFor(() => expect(callsOf('ai.undo')).toEqual([{ actionId: ACT }]));
});

test('(а) приложения: хост без «Выключить»/«Удалить», свои — с ними; «Новое приложение» открывает диалог', async () => {
  render();
  await openTab();
  const region = screen.getByRole('region', { name: 'Приложения' });
  const host = await within(region).findByTestId('app-host');
  expect(host).toHaveTextContent('Orbis');
  expect(within(host).queryAllByRole('button')).toEqual([]);
  const work = within(region).getByTestId(`app-${WORK}`);
  expect(work).toHaveTextContent('Состав: Цели, Проекты');
  expect(within(work).getByRole('button', { name: 'Выключить приложение' })).toBeInTheDocument();
  expect(within(work).getByRole('button', { name: 'Удалить приложение' })).toBeInTheDocument();
  const dacha = within(region).getByTestId(`app-${DACHA}`);
  expect(within(dacha).getByRole('button', { name: 'Включить приложение' })).toBeInTheDocument();

  fireEvent.click(within(region).getByRole('button', { name: 'Новое приложение' }));
  expect(await screen.findByRole('dialog', { name: 'Новое приложение' })).toBeInTheDocument();
});

// ─── (в) выключение и архив приложения ────────────────────────────────────────────────────────────

async function openAppDialog(appId: string, button: string): Promise<HTMLElement> {
  await openTab();
  const row = await screen.findByTestId(`app-${appId}`);
  fireEvent.click(within(row).getByRole('button', { name: button }));
  return screen.findByRole('dialog');
}

test('(в) «Выключить приложение»: место и «Цели» отмечены; снятая галочка → extensions: []', async () => {
  const { callsOf } = render();
  const dialog = await openAppDialog(WORK, 'Выключить приложение');
  expect(within(dialog).getByTestId('disable-app-place')).toHaveTextContent('Место «Работа»');
  // Диалог обещает то, что будет (§8.6, финал C1 M-4): плитка остаётся приглушённой, а не пропадает.
  expect(within(dialog).getByTestId('disable-app-place')).toHaveTextContent(
    'останется приглушённой, с пометкой «выключено»',
  );
  expect(within(dialog).getByTestId('disable-app-place')).not.toHaveTextContent('пропадёт');
  const goals = within(dialog).getByRole('checkbox', { name: 'Цели' });
  expect(goals).toBeChecked();
  // «Проекты» держит включённая «Учёба» — не сирота; «Цели» у выключенной «Дачи» — не держит.
  expect(within(dialog).queryByRole('checkbox', { name: 'Проекты' })).toBeNull();
  fireEvent.click(goals);
  expect(goals).not.toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Выключить' }));
  await waitFor(() =>
    expect(callsOf('app.setDisabled')).toEqual([{ appId: WORK, disabled: true, extensions: [] }]),
  );
  await undoLastToast('Приложение «Работа» выключено');
  await waitFor(() => expect(callsOf('ai.undo')).toEqual([{ actionId: ACT }]));
});

test('(в) «Выключить приложение» по умолчанию выключает осиротевшие «Цели» той же пачкой', async () => {
  const { callsOf } = render();
  const dialog = await openAppDialog(WORK, 'Выключить приложение');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Выключить' }));
  await waitFor(() =>
    expect(callsOf('app.setDisabled')).toEqual([
      { appId: WORK, disabled: true, extensions: ['goals'] },
    ]),
  );
});

test('(в) «Удалить приложение» — app.archive с тем же выбором сирот', async () => {
  const { callsOf } = render();
  const dialog = await openAppDialog(WORK, 'Удалить приложение');
  expect(within(dialog).getByRole('checkbox', { name: 'Цели' })).toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
  await waitFor(() =>
    expect(callsOf('app.archive')).toEqual([{ appId: WORK, disableExtensions: ['goals'] }]),
  );
});

test('(в) R-33: «Включить приложение» — без каскада «Состава»', async () => {
  const { callsOf } = render();
  await openTab();
  const row = await screen.findByTestId(`app-${DACHA}`);
  fireEvent.click(within(row).getByRole('button', { name: 'Включить приложение' }));
  await waitFor(() =>
    expect(callsOf('app.setDisabled')).toEqual([{ appId: DACHA, disabled: false, extensions: [] }]),
  );
});

// ─── (г) «Обновления» ─────────────────────────────────────────────────────────────────────────────

test('(г) две строки; «Принять все» — только неправленые (названы до нажатия) → supply.acceptAll', async () => {
  const { callsOf } = render(() => TWO_UPDATES);
  await openTab();
  const region = screen.getByRole('region', { name: 'Обновления' });
  expect(await within(region).findByTestId('supply-update-routines')).toHaveTextContent(
    'Изменено вами',
  );
  expect(within(region).getByTestId('supply-update-home')).not.toHaveTextContent('Изменено вами');
  const scope = within(region).getByTestId('accept-all-scope');
  expect(scope).toHaveTextContent('Домой');
  expect(scope).not.toHaveTextContent('Рутины');
  fireEvent.click(within(region).getByRole('button', { name: 'Принять все' }));
  await waitFor(() => expect(callsOf('supply.acceptAll')).toHaveLength(1));
  await undoLastToast('Принято обновлений: 1');
  await waitFor(() => expect(callsOf('ai.undo')).toEqual([{ actionId: ACT }]));
});

test('(г) «Принять все» гаснет, когда все обновления — правленые', async () => {
  render(() => [TWO_UPDATES[0] as SupplyUpdate]);
  await openTab();
  const region = screen.getByRole('region', { name: 'Обновления' });
  expect(await within(region).findByRole('button', { name: 'Принять все' })).toBeDisabled();
});

test('(г) перенос 11: «Сравнить» — двустороннее сравнение по recordText и etalonText ответа', async () => {
  render(() => TWO_UPDATES);
  await openTab();
  const row = await screen.findByTestId('supply-update-routines');
  fireEvent.click(within(row).getByRole('button', { name: 'Сравнить' }));
  const compare = await screen.findByTestId('supply-compare', {}, { timeout: 5000 });
  // Стороны — печати из `supply.updates`, а не тело записи из кеша и не эталон кода.
  expect(compare).toHaveTextContent('Мои утренние');
  expect(compare).toHaveTextContent('поставки');
  expect(compare).toHaveTextContent('Зачёркнуто — сейчас у вас, выделено — в поставке.');
});

test('(г) «Оставить своё» → supply.decline; «Принять — прежняя версия сохранится» → supply.accept', async () => {
  const { callsOf } = render(() => TWO_UPDATES);
  await openTab();
  const routines = await screen.findByTestId('supply-update-routines');
  fireEvent.click(within(routines).getByRole('button', { name: 'Оставить своё' }));
  await waitFor(() => expect(callsOf('supply.decline')).toEqual([{ key: 'routines' }]));
  const home = screen.getByTestId('supply-update-home');
  fireEvent.click(
    within(home).getByRole('button', { name: 'Принять — прежняя версия сохранится' }),
  );
  await waitFor(() => expect(callsOf('supply.accept')).toEqual([{ key: 'home' }]));
});

test('(г) перенос Fable M-2: подпись «прежняя версия» не обещает заголовок и значок', async () => {
  render(() => [
    ...TWO_UPDATES,
    update({ key: 'host-shell', recordId: SHELL, etalonText: '{}', recordText: '{}' }),
  ]);
  await openTab();
  const home = await screen.findByTestId('supply-update-home');
  // Версия хранит только тело: про заголовок и значок сказано, что их вернёт «Отменить».
  expect(home).toHaveTextContent(
    'Прежний текст страницы останется в её версиях; прежние заголовок и значок вернёт «Отменить».',
  );
  // У приложения версий нет вовсе — прежнее место возвращает журнал.
  expect(screen.getByTestId('supply-update-host-shell')).toHaveTextContent(
    'версий у приложения нет',
  );
});

test('(г) новая запись поставки: «Добавить» → supply.add; R-18: Undo → ключ снова предлагается', async () => {
  const life = etalonOf('horizon-life');
  const offered: SupplyUpdate = {
    key: 'horizon-life',
    kind: 'new',
    recordId: null,
    edited: false,
    declined: false,
    etalonText: pagePrint('horizon-life', life.kind === 'app' ? '' : life.text),
    recordText: null,
  };
  let added = false;
  const { callsOf } = render(() => (added ? [] : [offered]));
  await openTab();
  const row = await screen.findByTestId('supply-update-horizon-life');
  expect(row).toHaveTextContent(`В поставке появилось: ${life.emoji} ${life.title}`);
  // Сервер после «Добавить» предлагать ключ перестаёт; после отмены — снова предлагает.
  added = true;
  fireEvent.click(within(row).getByRole('button', { name: 'Добавить' }));
  await waitFor(() => expect(callsOf('supply.add')).toEqual([{ key: 'horizon-life' }]));
  await waitFor(() => expect(screen.queryByTestId('supply-update-horizon-life')).toBeNull());
  added = false;
  await undoLastToast(`Добавлено из поставки: «${life.title}»`);
  await waitFor(() => expect(callsOf('ai.undo')).toEqual([{ actionId: ACT }]));
  expect(await screen.findByTestId('supply-update-horizon-life')).toBeInTheDocument();
});

test('(г) «Сравнить» у оболочки хоста — построчно по печати места, id показаны заголовками', async () => {
  const shellPrint = (nav: string[]) =>
    printAppProps({ title: 'Orbis', emoji: '🪐', props: { [APP_NAV]: nav } });
  render(() => [
    update({
      key: 'host-shell',
      recordId: SHELL,
      recordText: shellPrint([id(60), id(61)]),
      etalonText: shellPrint([id(60)]),
    }),
  ]);
  await openTab();
  const row = await screen.findByTestId('supply-update-host-shell');
  fireEvent.click(within(row).getByRole('button', { name: 'Сравнить' }));
  const lines = await screen.findByTestId('supply-compare-lines', {}, { timeout: 5000 });
  await waitFor(() =>
    expect(lines.querySelector('[data-kind="removed"]')).toHaveTextContent('«Моя страница»'),
  );
  expect(lines.querySelector('[data-kind="added"]')).toBeNull();
});

// ─── Раунд 1 гейта 22 ─────────────────────────────────────────────────────────────────────────────

test('I-1: «Новое приложение» с «Составом» — одна entity_create с расширениями, маска не трогается', async () => {
  const { callsOf } = render();
  await openTab();
  fireEvent.click(screen.getByRole('button', { name: 'Новое приложение' }));
  const dialog = await screen.findByRole('dialog', { name: 'Новое приложение' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Имя' }), {
    target: { value: 'Сад' },
  });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Цели' }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Проекты' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
  await waitFor(() => expect(callsOf('entity.updateBatch')).toHaveLength(1));
  const [batch] = callsOf('entity.updateBatch') as { operations: BatchOp[] }[];
  expect(batch?.operations).toHaveLength(1);
  expect(batch?.operations[0]?.tool).toBe('entity_create');
  expect((batch?.operations[0]?.input.props as Record<string, unknown>)[APP_EXTENSIONS]).toEqual([
    'goals',
    'projects',
  ]);
  expect(callsOf('user.setModuleEnabled')).toEqual([]);
});

test('I-1: правка «Состава» — одна entity_update без module_set; «Выключить приложение» видит новый «Состав»', async () => {
  const { callsOf } = render();
  await openTab();
  // «Учёба» держала «Проекты»; владелец убирает их из её «Состава».
  const study = await screen.findByTestId(`app-${STUDY}`);
  fireEvent.click(within(study).getByRole('button', { name: 'Изменить состав' }));
  const dialog = await screen.findByRole('dialog', { name: 'Состав «Учёба»' });
  const projects = within(dialog).getByRole('checkbox', { name: 'Проекты' });
  expect(projects).toBeChecked();
  fireEvent.click(projects);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(callsOf('entity.updateBatch')).toEqual([
      {
        operations: [{ tool: 'entity_update', input: { id: STUDY, unset: [APP_EXTENSIONS] } }],
        label: 'Изменить состав',
      },
    ]),
  );
  expect(callsOf('user.setModuleEnabled')).toEqual([]);
  await waitFor(() =>
    expect(screen.getByTestId(`app-${STUDY}`)).toHaveTextContent('Расширений в составе нет'),
  );
  // «Проекты» больше никто из включённых не держит — у «Работы» они теперь сироты.
  const work = screen.getByTestId(`app-${WORK}`);
  fireEvent.click(within(work).getByRole('button', { name: 'Выключить приложение' }));
  const off = await screen.findByRole('dialog', { name: 'Выключить приложение «Работа»' });
  expect(within(off).getByRole('checkbox', { name: 'Цели' })).toBeChecked();
  expect(within(off).getByRole('checkbox', { name: 'Проекты' })).toBeChecked();
});

test('M-2: правка графа гасит «Обновления» — признак «Изменено вами» не устаревает; повторный показ без запроса', async () => {
  let edited = false;
  const { callsOf } = render(() => [{ ...(TWO_UPDATES[1] as SupplyUpdate), edited }]);
  await openTab();
  const row = await screen.findByTestId('supply-update-home');
  expect(row).not.toHaveTextContent('Изменено вами');
  const before = callsOf('supply.updates').length;
  // Владелец правит «Домой» где-то ещё — любая правка графа идёт через `invalidateGraph` (здесь —
  // «Изменить состав», пачка того же механизма).
  edited = true;
  fireEvent.click(
    within(await screen.findByTestId(`app-${STUDY}`)).getByRole('button', {
      name: 'Изменить состав',
    }),
  );
  const dialog = await screen.findByRole('dialog', { name: 'Состав «Учёба»' });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Цели' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(screen.getByTestId('supply-update-home')).toHaveTextContent('Изменено вами'),
  );
  expect(callsOf('supply.updates').length).toBe(before + 1);
  // Уход с вкладки и возврат в пределах срока свежести: список из кеша, без нового запроса.
  fireEvent.click(screen.getByRole('tab', { name: 'Общие' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Приложения и расширения' }));
  expect(await screen.findByTestId('supply-update-home')).toHaveTextContent('Изменено вами');
  expect(callsOf('supply.updates').length).toBe(before + 1);
});

test('N-1: правка в обход клиента (агент, вторая вкладка) проявляется по истечении срока свежести', async () => {
  let edited = false;
  const { callsOf } = render(() => [{ ...(TWO_UPDATES[1] as SupplyUpdate), edited }]);
  await openTab();
  expect(await screen.findByTestId('supply-update-home')).not.toHaveTextContent('Изменено вами');
  const before = callsOf('supply.updates').length;
  // Запись правят мимо этого клиента — `invalidateGraph` здесь не звался.
  edited = true;
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + SUPPLY_UPDATES_STALE_MS + 1_000);
  try {
    fireEvent.click(screen.getByRole('tab', { name: 'Общие' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Приложения и расширения' }));
    await waitFor(() =>
      expect(screen.getByTestId('supply-update-home')).toHaveTextContent('Изменено вами'),
    );
    expect(callsOf('supply.updates').length).toBe(before + 1);
  } finally {
    clock.mockRestore();
  }
});
