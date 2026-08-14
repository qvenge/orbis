import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { DetailScreen } from './DetailScreen';

// Task D5: секции 6 «Блокировки» (02-core-os §3.5.6) и 7 «Связанное (backlinks)» (§3.5.7)
// на detail-экране. Файл покрывает обе секции — так назван Test-пункт брифа D5.

type Aspects = Record<string, Record<string, unknown>>;

const ent = (id: string, title: string, aspects: Aspects = {}) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects,
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
});

const self = ent('e1', 'Задача', { 'orbis/task': { status: 'inbox' } });
const outgoing = ent('t1', 'Ждёт меня');
const liveBlocker = ent('b1', 'Живой блокер', { 'orbis/task': { status: 'inbox' } });
const doneBlocker = ent('b2', 'Закрытый блокер', { 'orbis/task': { status: 'done' } });
const found = ent('x1', 'Найденная сущность');

const rel = (id: string, sourceId: string, targetId: string, relationType: string) => ({
  id,
  sourceId,
  targetId,
  relationType,
  meta: {},
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
});

/**
 * Форма строки entity.suggest / entity.resolveRefs: только то, что рисуется, и статус
 * task-аспекта ПЛОСКИМ полем — сущности целиком секция больше не получает.
 */
const sugg = (e: ReturnType<typeof ent>) => ({
  id: e.id,
  title: e.title,
  emoji: e.emoji,
  status: (e.aspects['orbis/task']?.status as string | undefined) ?? null,
  archived: e.archived,
});

type Fixture = {
  relations?: ReturnType<typeof rel>[];
  backlinks?: { entity: ReturnType<typeof ent>; via: string }[];
  backlinksTruncated?: boolean;
  onRelationCreate?: () => unknown;
  onRelationDelete?: () => unknown;
  onSuggest?: () => unknown;
};

const OTHERS = [outgoing, liveBlocker, doneBlocker, found];

function handler(fx: Fixture) {
  return (path: string, input: unknown) => {
    if (path === 'entity.get') {
      const id = (input as { id: string }).id;
      if (id === 'e1')
        return {
          entity: self,
          relations: fx.relations ?? [],
          backlinks: fx.backlinks ?? [],
          ...(fx.backlinksTruncated === true && { backlinksTruncated: true }),
          thread: { threadId: 'th1', messages: [] },
        };
      const e = OTHERS.find((x) => x.id === id);
      return e ? { entity: e, relations: [] } : { entity: ent(id, id), relations: [] };
    }
    // Заголовки сторон — ОДНИМ запросом. Ненайденные просто отсутствуют в ответе (контракт
    // процедуры), заглушки на каждый id тут не выдумываем: секция сама рисует обрубок.
    if (path === 'entity.resolveRefs') {
      const ids = (input as { ids: string[] }).ids;
      return ids.flatMap((id) => {
        const e = OTHERS.find((x) => x.id === id);
        return e ? [sugg(e)] : [];
      });
    }
    if (path === 'entity.suggest') return fx.onSuggest ? fx.onSuggest() : [sugg(found)];
    // Остался только соседям-спискам (ListProbe): пикер на entity.query больше не ходит.
    if (path === 'entity.query') return [];
    if (path === 'relation.create') {
      if (fx.onRelationCreate) return fx.onRelationCreate();
      return rel('new', 'e1', 'x1', 'blocks');
    }
    if (path === 'relation.delete')
      return fx.onRelationDelete ? fx.onRelationDelete() : { ok: true };
    if (path === 'aspect.list') return [];
    return {};
  };
}

// Список-сосед (Browser/Повестка/списки с excludeBlocked) на том же ключе entity.query:
// его перечитывание — единственный наблюдаемый признак инвалидации.
const PROBE_QUERY = { query: 'aspect=orbis/task, status=!done, limit=10' };

function ListProbe() {
  const q = trpc.entity.query.useQuery(PROBE_QUERY);
  return <span data-testid="list-probe">{(q.data ?? []).length}</span>;
}

/**
 * Detail второй стороны связи держит СВОЙ список связей и после правки графа врёт — его
 * инвалидацию секция делает по ключу entity.get({id}). Наблюдать её стало нечем: титулы
 * сторон секция теперь берёт из entity.resolveRefs, а не из построчных entity.get. Зонд —
 * тот же приём, что ListProbe для entity.query: держит ключ в кэше, чтобы рефетч был виден.
 */
function SideProbe({ id }: { id: string }) {
  const q = trpc.entity.get.useQuery({ id });
  // Рисуем id, а НЕ титул: титул той же сущности уже стоит строкой блокировки, и
  // findByText('Ждёт меня') нашёл бы два узла и упал бы на неоднозначности.
  return <span data-testid="side-probe">{q.data ? id : ''}</span>;
}

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

// Титулы строк дочитываются одним entity.resolveRefs (Blocks.tsx), то есть ждать
// приходится ВТОРОЙ круг сети после entity.get самого экрана. Первый тест файла платит
// вдобавок за прогрев (импорт модулей, первый рендер DetailScreen), а в полном корневом
// прогоне 48 web-файлов идут параллельно с 653 серверными тестами против локальной БД:
// ядра заняты, и дефолтная 1 с у findBy означает уже не «данные не доехали», а голодание
// по CPU. Таймауты щедрее дефолтов — тот же приём, что у пагинации в
// TransactionsScreen/CategoryScreen; точечный прогон от этого не медленнее, потому что
// ожидания завершаются по факту, а не по таймеру.
const SIDES_LOADED = { timeout: 10_000 };

test('блокировки: «блокирует» — исходящие, «заблокирована» — только незакрытые задачи', {
  timeout: 30_000,
}, async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      relations: [
        rel('r1', 'e1', 't1', 'blocks'),
        rel('r2', 'b1', 'e1', 'blocks'),
        rel('r3', 'b2', 'e1', 'blocks'),
        rel('r4', 'e1', 'c1', 'parent'), // не блокировка — секции не касается
      ],
    }),
  );

  expect(await screen.findByText('Ждёт меня', undefined, SIDES_LOADED)).toBeInTheDocument();
  expect(await screen.findByText('Живой блокер', undefined, SIDES_LOADED)).toBeInTheDocument();
  expect(screen.getByText(/блокирует/i)).toBeInTheDocument();
  expect(screen.getByText(/заблокирована/i)).toBeInTheDocument();
  // Закрытая задача (status=done) блокировкой не считается — семантика excludeBlocked §6.1.
  // Ждём ТЕРМИНАЛЬНОЕ состояние — ровно две строки (t1 + b1) — а не «текста пока нет»:
  // пока per-id entity.get блокера b2 в полёте, его строка отрисована плейсхолдером «b2…»
  // (блокер без данных считается живым), и негативная проверка прошла бы вхолостую, не
  // подтвердив ничего. Третья строка исчезает ровно тогда, когда статус b2 доехал.
  await waitFor(() => expect(screen.getAllByTestId('block-row')).toHaveLength(2), SIDES_LOADED);
  expect(screen.queryByText('Закрытый блокер')).not.toBeInTheDocument();
});

test('пустые списки блокировок и пустой backlinks скрыты (кнопка добавления остаётся)', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-view'); // экран отрисован

  expect(screen.queryByText(/^блокирует$/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^заблокирована$/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/связанное/i)).not.toBeInTheDocument();
  // Кнопка «+» — единственный путь создания blocks-связи из UI, её прячем только вместе
  // с самим экраном (прецедент «тихой строки добавления» у Подзадач).
  expect(screen.getByRole('button', { name: 'Добавить блокировку' })).toBeInTheDocument();
});

test('добавление блокировки: поиск через entity.suggest по префиксу → relation.create blocks', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });

  await waitFor(() =>
    expect(calls.find((c) => c.path === 'entity.suggest')?.input).toEqual({
      prefix: 'Найд',
      limit: 10,
    }),
  );
  // Грамматика `search=` из пикера ушла совсем: остаточный запрос по ней означал бы, что
  // поиск по целому слову жив вторым путём.
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'relation.create')?.input).toEqual({
      source_id: 'e1',
      target_id: 'x1',
      relation_type: 'blocks',
    }),
  );
});

// D5d п.1: до добивки форма жёстко ставила source_id = текущая сущность, поэтому список
// «Заблокирована» было нечем пополнить — приходилось открывать detail самого блокера.
test('добавление блокировки: направление «заблокирована» шлёт обратную связь', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Направление блокировки'), { target: { value: 'in' } });
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));

  // Стороны переставлены: блокирует НАЙДЕННАЯ сущность, а текущая заблокирована ею.
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'relation.create')?.input).toEqual({
      source_id: 'x1',
      target_id: 'e1',
      relation_type: 'blocks',
    }),
  );
});

// D5d п.2: relation.create не отдаёт actionId (Undo из секции невозможен), а серверная
// процедура relation.delete существует — снятие ошибочной связи идёт через неё.
test('снятие блокировки: крестик → подтверждение → relation.delete обеими сторонами', async () => {
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({ relations: [rel('r1', 'e1', 't1', 'blocks')] }),
  );
  expect(await screen.findByText('Ждёт меня')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Снять блокировку' }));
  // Минимум подтверждения: разрушающее действие не выполняется первым же кликом.
  expect(calls.some((c) => c.path === 'relation.delete')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'relation.delete')?.input).toEqual({
      source_id: 'e1',
      target_id: 't1',
      relation_type: 'blocks',
    }),
  );
});

// D5d п.4: пикер шёл в сеть на КАЖДОЕ нажатие — три буквы давали три полнотекстовых
// запроса подряд, из которых полезен только последний.
test('пикер: быстрый ввод трёх символов даёт один запрос, а не три', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  const input = screen.getByLabelText('Поиск сущности');
  fireEvent.change(input, { target: { value: 'На' } });
  fireEvent.change(input, { target: { value: 'Най' } });
  fireEvent.change(input, { target: { value: 'Найд' } });

  const queries = () => calls.filter((c) => c.path === 'entity.suggest');
  await waitFor(() => expect(queries()).toHaveLength(1));
  expect(queries()[0]?.input).toEqual({ prefix: 'Найд', limit: 10 });
});

// Состояния пикера остались все пять и в том же порядке, изменился только текст первой
// подсказки: извиняться за поиск по ЦЕЛОМУ слову больше не за что — suggest ищет по
// префиксу. Немая пустая область по-прежнему недопустима.
test('пикер: подсказка до ввода, спиннер в полёте, «ничего не найдено» на пустом ответе', async () => {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((res) => {
    release = res;
  });
  renderWithProviders(<DetailScreen entityId="e1" />, handler({ onSuggest: () => gate }));
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  expect(screen.getByText(/поиск от 2 символов/i)).toBeInTheDocument();
  // Обещания искать по целому слову в интерфейсе больше нет — ни в подсказке, ни в пустом
  // результате: оно врало бы про префиксный поиск.
  expect(screen.queryByText(/целому слову|слово целиком/i)).toBeNull();

  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Куп' } });
  expect(await screen.findByRole('status', { name: 'Поиск' })).toBeInTheDocument();

  release([]);
  expect(await screen.findByText(/ничего не найдено/i)).toBeInTheDocument();
  expect(screen.queryByText(/слово целиком/i)).toBeNull();
});

test('пикер: отказ поиска показан плашкой, а не пустотой', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      onSuggest: () => {
        throw trpcError('INTERNAL_SERVER_ERROR', 'boom');
      },
    }),
  );
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Куп' } });

  expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось выполнить поиск/i);
});

test('цикл blocks: серверный отказ показан плашкой с путём цикла', async () => {
  const message =
    'blocks-связь замкнула бы цикл: «Задача» → «Найденная сущность» → «Задача» ' +
    '(§4.2, граф blocks обязан оставаться ацикличным)';
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      onRelationCreate: () => {
        throw trpcError('UNPROCESSABLE_CONTENT', message);
      },
    }),
  );
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));

  // Путь цикла доезжает до клиента только в message (K17: cause по HTTP не сериализуется)
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/замкнула бы цикл/);
  expect(alert).toHaveTextContent('«Задача» → «Найденная сущность» → «Задача»');
});

// D5e п.1: направление оставалось выбранным после создания связи — внешне свежая форма
// молча создавала следующую связь в обратную сторону.
test('форма: после создания связи направление возвращается к дефолтному', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Направление блокировки'), { target: { value: 'in' } });
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));

  await waitFor(() => expect(screen.queryByLabelText('Направление блокировки')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  expect(screen.getByLabelText('Направление блокировки')).toHaveValue('out');
});

// D5e п.2: «Отмена» подтверждения снимала только вопрос, а красная плашка отказа
// relation.delete висела до ухода с экрана.
test('плашка: «Отмена» подтверждения убирает ошибку снятия', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      relations: [rel('r1', 'e1', 't1', 'blocks')],
      onRelationDelete: () => {
        throw trpcError('NOT_FOUND', 'связь уже снята');
      },
    }),
  );
  expect(await screen.findByText('Ждёт меня')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/связь уже снята/);

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

// D5e п.3: `relate.error ?? unrelate.error` отдавал приоритет самой ранней ошибке —
// после отказа создания отказ снятия был не виден, а старое сообщение висело и после успеха.
test('плашка: ошибка снятия сменяет ошибку создания, после успеха плашки нет', async () => {
  let deleteFails = true;
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      relations: [rel('r1', 'e1', 't1', 'blocks')],
      onRelationCreate: () => {
        throw trpcError('UNPROCESSABLE_CONTENT', 'blocks-связь замкнула бы цикл');
      },
      onRelationDelete: () => {
        if (!deleteFails) return { ok: true };
        deleteFails = false;
        throw trpcError('NOT_FOUND', 'связь уже снята');
      },
    }),
  );
  expect(await screen.findByText('Ждёт меня')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/замкнула бы цикл/);

  fireEvent.click(screen.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/связь уже снята/));

  fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

// D5e п.4: список «Заблокирована» показывает только незакрытые задачи (§3.5.6) — связь
// с закрытым блокером была бы создана, но не видна ни в одном списке и неповторима
// (id уже в known). Для исходящей связи ограничения нет: «Блокирует» показывает всё.
test('пикер: закрытая задача не предлагается блокером, но предлагается заблокированной', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({ onSuggest: () => [sugg(found), sugg(doneBlocker)] }),
  );
  await screen.findByTestId('body-view'); // экран отрисован

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'блокер' } });
  expect(await screen.findByRole('button', { name: 'Закрытый блокер' })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Направление блокировки'), { target: { value: 'in' } });
  expect(screen.queryByRole('button', { name: 'Закрытый блокер' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Найденная сущность' })).toBeInTheDocument();
});

test('backlinks: одна секция, пометка источника «связь» / «упоминание»', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      backlinks: [
        { entity: ent('l1', 'Явная связь'), via: 'relation' },
        { entity: ent('m1', 'Упомянувшая заметка'), via: 'mention' },
      ],
    }),
  );

  expect(await screen.findByText('Явная связь')).toBeInTheDocument();
  expect(screen.getByText('Упомянувшая заметка')).toBeInTheDocument();
  // Список поместился целиком — счётчик точный, без «+»
  expect(screen.getByText('Связанное (2)')).toBeInTheDocument();
  expect(screen.getByText('связь')).toBeInTheDocument();
  expect(screen.getByText('упоминание')).toBeInTheDocument();
});

// --- DF п.5: новая/снятая связь обязана появляться в списках ---------------------------
// Секция инвалидировала только entity.get текущей сущности. С Повесткой (staleTime ≥ 60 с,
// K16) это стало заметным: новая блокировка до минуты не видна ни в Browser, ни в
// Повестке, ни в списках с excludeBlocked (§6.1), а detail второй стороны держит СВОЙ
// список связей и врал бы столько же.

test('создание блокировки инвалидирует entity.query (списки перечитываются)', async () => {
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <ListProbe />
    </>,
    handler({}),
  );
  await screen.findByTestId('body-view'); // экран отрисован
  const probes = () =>
    calls.filter(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === PROBE_QUERY.query,
    );
  await waitFor(() => expect(probes()).toHaveLength(1));

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Найденная сущность' }));

  await waitFor(() => expect(probes().length).toBeGreaterThan(1));
});

test('снятие блокировки инвалидирует вторую сторону связи и entity.query', async () => {
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <ListProbe />
      <SideProbe id="t1" />
    </>,
    handler({ relations: [rel('r1', 'e1', 't1', 'blocks')] }),
  );
  expect(await screen.findByText('Ждёт меня')).toBeInTheDocument();
  const probes = () =>
    calls.filter(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === PROBE_QUERY.query,
    );
  const sideGets = () =>
    calls.filter((c) => c.path === 'entity.get' && (c.input as { id: string }).id === 't1');
  await waitFor(() => expect(probes()).toHaveLength(1));
  const sidesBefore = sideGets().length;

  fireEvent.click(screen.getByRole('button', { name: 'Снять блокировку' }));
  fireEvent.click(screen.getByRole('button', { name: 'Снять' }));

  await waitFor(() => expect(sideGets().length).toBeGreaterThan(sidesBefore));
  await waitFor(() => expect(probes().length).toBeGreaterThan(1));
});

// DF п.4: сервер отдаёт до 100 связей и признак усечения — «Связанное (100)» читалось
// как точный счётчик, хотя за списком осталось ещё (урок C6).
test('backlinks: усечённый список показан как «+», а не точным счётчиком', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      backlinks: [{ entity: ent('l1', 'Явная связь'), via: 'relation' }],
      backlinksTruncated: true,
    }),
  );

  expect(await screen.findByText('Явная связь')).toBeInTheDocument();
  expect(screen.getByText('Связанное (1+)')).toBeInTheDocument();
});
