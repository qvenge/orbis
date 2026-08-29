import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { MockHandler } from '../../test/harness';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { NativeRow } from './NativeRow';

/**
 * Подписи полей шапка берёт из реестра (§А9-2), и он приезжает tRPC — значит рендерить её
 * надо под провайдерами даже там, где никакой другой сети в тесте нет. Реестр НАСТОЯЩИЙ:
 * слово, которым тест проверяет подпись, обязано быть тем же, что увидит владелец.
 */
const registryHandler: MockHandler = (path) => registryReply(path) ?? {};

/**
 * Реестр + выдача категорий. Реестр обязателен ДАЖЕ там, где тест проверяет только бейдж:
 * множество категорий пикер и подпись ссылки берут из ЦЕЛИ свойства `orbis/finance_category`
 * (§А6-1), то есть без снимка реестра спрашивать нечего — и строка честно остаётся в
 * состоянии «ещё грузится».
 */
const withCategories =
  (categories: unknown): MockHandler =>
  (path) =>
    path === 'entity.query' ? categories : (registryReply(path) ?? {});

/** Q-AST выдачи пикера: цель `orbis/finance_category` ⊕ проекция (`RefField.refQueryAst`). */
const CATEGORY_PICKER_AST = {
  ast: {
    filter: { aspect: 'orbis/category' },
    sortBy: [{ field: 'orbis/title', dir: 'asc' }],
    limit: 200,
  },
};

// Категория-сущность в форме ответа entity.query (тот же список, что у пикера D3b).
const category = (id: string, title: string) =>
  wireEntity({ id, title, props: { 'orbis/icon': '🍔' }, aspects: ['orbis/category'] });

/**
 * Финансовая строка: значения — плоско в `props` по id свойства, аспект — СПИСКОМ (§А1-1).
 * Форму собирает фабрика производителя, а не рукописный объект.
 */
const financial = (props: Record<string, unknown>) =>
  wireEntity({ id: 'e1', title: 'Обед', props, aspects: ['orbis/financial'] }) as never;

const row = (
  props: Record<string, unknown>,
  aspects: string[],
  over: Record<string, unknown> = {},
) => wireEntity({ id: 'e1', title: 'Обед', props, aspects, ...over }) as never;

const CAT_FOOD = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';
// Ссылка в категорию, которой в списке нет — запасной вариант «показать uuid».
const CAT_GHOST = 'd1f0c8e5-4b2a-4d6e-8f01-9a7c3b5e2d44';

test('financial: сумма с минусом и тоном danger', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({
        'orbis/amount': '340.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CAT_FOOD,
      })}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('−')).toBe(true);
  expect(amount.className).toContain('text-danger');
});

test('financial: income → плюс и позитивный тон', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({
        'orbis/amount': '340.00',
        'orbis/direction': 'income',
        'orbis/finance_category': 'cat-salary',
      })}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('+')).toBe(true);
  expect(amount.className).toContain('text-success');
});

// D6c п.2 (живой смоук D6b): в шапке detail печатался сырой category_ref — для
// транзакции без конверта пользователь не видел названия категории вообще.
test('financial: бейдж — НАЗВАНИЕ категории, а не uuid (D6c п.2)', async () => {
  const { calls } = renderWithProviders(
    <NativeRow
      entity={financial({
        'orbis/amount': '340.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CAT_FOOD,
      })}
      onToggleTask={() => {}}
    />,
    withCategories([category(CAT_FOOD, 'Еда')]),
  );
  expect(await screen.findByText('Еда')).toBeInTheDocument();
  expect(screen.queryByText(CAT_FOOD)).toBeNull();
  // Источник категорий — тот же запрос (и тот же кэш), что у ОБЩЕГО пикера ссылки: второго
  // нет. Форма — Q-AST цели свойства из реестра (§А6-1), а не текст грамматики.
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual(CATEGORY_PICKER_AST);
});

// D6d п.2: прежняя версия утверждала uuid в DOM сразу после рендера — а он там и так есть,
// пока список категорий не доехал. Соседняя строка с ИЗВЕСТНОЙ категорией — маркер того,
// что запрос разрешён: только после её названия отсутствие имени значит «категории нет».
test('financial: категории нет в списке → uuid как запасной вариант (D6c п.2)', async () => {
  renderWithProviders(
    <>
      <NativeRow
        entity={financial({
          'orbis/amount': '10.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CAT_FOOD,
        })}
        onToggleTask={() => {}}
      />
      <NativeRow
        entity={financial({
          'orbis/amount': '340.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': CAT_GHOST,
        })}
        onToggleTask={() => {}}
      />
    </>,
    withCategories([category(CAT_FOOD, 'Еда')]),
  );
  // Обе строки делят один запрос и один кэш — «Еда» доказывает, что список уже разрешён.
  expect(await screen.findByText('Еда')).toBeInTheDocument();
  expect(screen.getByText(CAT_GHOST)).toBeInTheDocument();
});

// D6d п.1: холодный кэш категорий (вход в detail из Chat/Browser) — в шапке на ~200 мс
// печатался uuid и подменялся названием, бейдж дёргался по ширине.
test('financial: пока категории грузятся, бейджа с uuid нет (D6d)', async () => {
  let release: (categories: unknown) => void = () => {};
  const categories = new Promise((resolve) => {
    release = resolve;
  });
  renderWithProviders(
    <NativeRow
      entity={financial({
        'orbis/amount': '340.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CAT_FOOD,
      })}
      onToggleTask={() => {}}
    />,
    withCategories(categories),
  );
  // Значение ещё неизвестно — бейджа нет вовсе (ни uuid, ни пустой пилюли).
  expect(screen.queryByText(CAT_FOOD)).toBeNull();
  expect(screen.getByTestId('native-financial').querySelectorAll('span')).toHaveLength(2);

  release([category(CAT_FOOD, 'Еда')]);
  expect(await screen.findByText('Еда')).toBeInTheDocument();
});

test('нефинансовая строка список категорий не запрашивает', async () => {
  const { calls } = renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/task_status': 'inbox' }, ['orbis/task'])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  await screen.findByRole('checkbox');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

test('task: рендерит чекбокс', () => {
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/task_status': 'inbox', 'orbis/priority': 'high' }, ['orbis/task'])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  expect(screen.getByRole('checkbox')).toBeInTheDocument();
});

/**
 * «Первый аспект» generic-строки — первый по RANK РЕЕСТРА, а не первый ключ объекта.
 *
 * Прежде порядок задавала карта `aspects_legacy`, то есть порядок, в котором аспекты
 * навешивали: одна и та же запись показывала разные поля у двух владельцев, и поймать это
 * было нечем. `entity.aspects` так же неупорядочен — поэтому порядок берётся у выдачи
 * реестра (она сортирована по `rank`, §А2-2).
 */
test('generic: строку подписывает аспект с наименьшим rank, а не первый в списке записи', async () => {
  // `orbis/note` (rank 4) объявлен ПОСЛЕ `orbis/repo` (rank 11) — если бы порядок брался у
  // записи, шапка показала бы поля репозитория.
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/repo_url': 'https://git/x', 'orbis/content_type': 'markdown' }, [
        'orbis/repo',
        'orbis/note',
      ])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  expect(await screen.findByText('Вид текста:')).toBeInTheDocument();
  expect(screen.queryByText('URL репозитория:')).toBeNull();
});

test('generic: состав keyFields берётся из СНИМКА реестра, а не из статики кода', async () => {
  // Подмена `view_config.keyFields` в ответе реестра обязана менять шапку: иначе состав
  // строки задавала бы вторая правда, которую владелец поменять не может.
  const patched = {
    ...BUILTIN_REGISTRY,
    aspects: BUILTIN_REGISTRY.aspects.map((a) =>
      a.id === 'orbis/note'
        ? { ...a, viewConfig: { ...a.viewConfig, keyFields: ['orbis/pinned'] } }
        : a,
    ),
  };
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/content_type': 'markdown', 'orbis/pinned': true }, ['orbis/note'])}
      onToggleTask={() => {}}
    />,
    (path) => (path === 'registry.effective' ? patched : (registryReply(path) ?? {})),
  );
  expect(await screen.findByText('Закреплена:')).toBeInTheDocument();
  expect(screen.queryByText('Вид текста:')).toBeNull();
  // Значение печатается ПО ТИПУ свойства: у булева это «да», а не `true`.
  expect(screen.getByText('да')).toBeInTheDocument();
});

test('generic: 2-3 keyFields из реестра', () => {
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/content_type': 'text', 'orbis/pinned': true }, ['orbis/note'])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  expect(screen.getByTestId('native-generic')).toBeInTheDocument();
});

// Круг правок 1 задачи E3 (I1): незаполненные keyFields не печатаются вовсе — то же
// правило, по которому сервер собирает keyFields чат-карточек (tools/dispatch.ts).
// У цели `current_value` не пишет НИКТО (прогресс считается на каждом чтении), и шапка
// печатала вечный `current_value: —` прямо над полосой с настоящим числом.
test('generic: незаполненное keyField не печатается прочерком', async () => {
  renderWithProviders(
    <NativeRow
      entity={row(
        {
          'orbis/progress_source': { query: { filter: {} }, aggregate: 'count' },
          'orbis/target_value': '300000.00',
          'orbis/unit': '₽',
        },
        ['orbis/goal'],
      )}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  // `find`, а не `get`: подписи приезжают реестром (§А9-2), то есть асинхронно — до первого
  // ответа шапка честно показывает сырые адреса свойств.
  expect(await screen.findByText('Целевое значение:')).toBeInTheDocument();
  expect(screen.getByText('Единица:')).toBeInTheDocument();
  expect(screen.queryByText('Текущее значение:')).toBeNull();
  expect(screen.queryByText('—')).toBeNull();
});

// Волна правок финального ревью (M1): шапка подписывает поля тем же источником, что карточка
// аспекта прямо под ней. До этого у цели «target_value: 300000.00» стояло над «Целевое
// значение: 300000.00» — одно поле с двумя именами на одном экране.
test('generic: ключи подписаны по-русски, а не сырой латиницей', async () => {
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/target_value': '300000.00', 'orbis/unit': '₽' }, ['orbis/goal'])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  // Сначала ЖДЁМ подпись из реестра, и только потом проверяем отсутствие сырой: без
  // ожидания оба `queryByText` были бы истинны и до прихода реестра (там стоит
  // `orbis/target_value:`, а не `target_value:`), то есть тест не мог бы упасть вовсе.
  expect(await screen.findByText('Целевое значение:')).toBeInTheDocument();
  expect(screen.getByText('Единица:')).toBeInTheDocument();
  expect(screen.queryByText('target_value:')).toBeNull();
  expect(screen.queryByText('unit:')).toBeNull();
});

// Поле, которого в прежнем рукописном словаре подписей не было вовсе: `content_type` печатался
// сырым не потому, что подписи ему не полагалось, а потому, что словарь его не знал. Реестр
// знает КАЖДОЕ свойство, и пробел закрылся сам — проба стоит здесь именно на этом поле.
// Деградация до сырого адреса никуда не делась и проверяется там, где она достижима:
// `lib/registry/labels.test.ts` (свойства нет в снимке) и `proposal-text.test.ts`.
test('generic: поле, которого не знал прежний словарь, подписано реестром', async () => {
  renderWithProviders(
    <NativeRow
      entity={row({ 'orbis/content_type': 'text' }, ['orbis/note'])}
      onToggleTask={() => {}}
    />,
    registryHandler,
  );
  expect(await screen.findByText('Вид текста:')).toBeInTheDocument();
  expect(screen.queryByText('content_type:')).toBeNull();
});

// Уборочная фаза (E4): вся машиночитаемая часть memory-правила лежит в title (K19.4),
// а inline-правка заголовка позволяет сломать формат одним символом. Признака «правило
// больше не распознаётся» не было нигде: запись оставалась в «Памяти AI» и выглядела
// живой, хотя ни fast-path, ни резолв импорта её уже не применяли.
const memory = (kind: string, title: string) =>
  wireEntity({
    id: 'e1',
    title,
    props: { 'orbis/memory_kind': kind, 'orbis/rule_scope': 'orbis/money-movement' },
    aspects: ['orbis/memory'],
  }) as never;

test('память: правило с распознанным форматом предупреждения не показывает', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('rule', 'кофе → Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: правку правила в текст без разделителя видно сразу — предупреждение', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('rule', 'кофе это развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  expect(screen.getByTestId('title-warning')).toBeInTheDocument();
});

// Заявленное поведение — предупреждение по ЧЕРНОВИКУ, то есть ДО сохранения: владелец
// ломает рабочее правило прямо в поле и обязан увидеть это сразу. Проверка по
// сохранённому значению (warn(value)) все прежние тесты проходила.
test('память: предупреждение появляется на ЧЕРНОВИКЕ, без сохранения', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('rule', 'кофе → Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
  fireEvent.change(screen.getByTestId('title-edit'), {
    target: { value: 'кофе это развлечения' },
  });
  expect(screen.getByTestId('title-warning')).toBeInTheDocument();
});

test('память: предупреждение доступно скринридеру и связано с полем', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('rule', 'кофе это развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  const warning = screen.getByTestId('title-warning');
  expect(warning).toHaveAttribute('role', 'status');
  expect(screen.getByTestId('title-edit')).toHaveAttribute('aria-describedby', warning.id);
});

test('память: клавиатурная стрелка «->» правилом считается — предупреждения нет', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('rule', 'кофе -> Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: у ФАКТА формата правила нет — предупреждения быть не должно', () => {
  renderWithProviders(
    <NativeRow
      entity={memory('fact', 'Работаю из дома по пятницам')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
    registryHandler,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: в списке (без inline-правки) предупреждения нет — правит только Detail', () => {
  renderWithProviders(
    <NativeRow entity={memory('rule', 'кофе это развлечения')} onToggleTask={() => {}} />,
    registryHandler,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

// Уборочная фаза: третье состояние названия категории. При ОТКАЗЕ загрузки списка
// бейдж печатал сырой uuid — та же ложь, что мелькающий uuid на загрузке (D6d развёл
// только «грузится» и «не найдена»).
test('категория: отказ списка категорий — бейджа нет, uuid не печатается', async () => {
  renderWithProviders(
    <NativeRow
      entity={financial({
        'orbis/amount': '340.00',
        'orbis/direction': 'expense',
        'orbis/finance_category': CAT_FOOD,
      })}
      onToggleTask={() => {}}
    />,
    (path) => {
      if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
      return registryReply(path) ?? {};
    },
  );
  await screen.findByTestId('native-financial');
  await waitFor(() => expect(screen.queryByText(CAT_FOOD)).toBeNull());
  expect(screen.getByTestId('native-financial').textContent).not.toContain(CAT_FOOD);
});
