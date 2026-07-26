import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, trpcError } from '../../test/harness';
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

type Fixture = {
  relations?: ReturnType<typeof rel>[];
  backlinks?: { entity: ReturnType<typeof ent>; via: string }[];
  onRelationCreate?: () => unknown;
  onRelationDelete?: () => unknown;
  onQuery?: () => unknown;
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
          thread: { threadId: 'th1', messages: [] },
        };
      const e = OTHERS.find((x) => x.id === id);
      return e ? { entity: e, relations: [] } : { entity: ent(id, id), relations: [] };
    }
    if (path === 'entity.query') return fx.onQuery ? fx.onQuery() : [found];
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

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

test('блокировки: «блокирует» — исходящие, «заблокирована» — только незакрытые задачи', async () => {
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

  expect(await screen.findByText('Ждёт меня')).toBeInTheDocument();
  expect(await screen.findByText('Живой блокер')).toBeInTheDocument();
  expect(screen.getByText(/блокирует/i)).toBeInTheDocument();
  expect(screen.getByText(/заблокирована/i)).toBeInTheDocument();
  // Закрытая задача (status=done) блокировкой не считается — семантика excludeBlocked §6.1
  await waitFor(() => expect(screen.queryByText('Закрытый блокер')).not.toBeInTheDocument());
});

test('пустые списки блокировок и пустой backlinks скрыты (кнопка добавления остаётся)', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-edit');

  expect(screen.queryByText(/^блокирует$/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^заблокирована$/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/связанное/i)).not.toBeInTheDocument();
  // Кнопка «+» — единственный путь создания blocks-связи из UI, её прячем только вместе
  // с самим экраном (прецедент «тихой строки добавления» у Подзадач).
  expect(screen.getByRole('button', { name: 'Добавить блокировку' })).toBeInTheDocument();
});

test('добавление блокировки: поиск через entity.query search= → relation.create blocks', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, handler({}));
  await screen.findByTestId('body-edit');

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Найд' } });

  await waitFor(() =>
    expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
      query: 'search=Найд, limit=10',
    }),
  );
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
  await screen.findByTestId('body-edit');

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
  await screen.findByTestId('body-edit');

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  const input = screen.getByLabelText('Поиск сущности');
  fireEvent.change(input, { target: { value: 'На' } });
  fireEvent.change(input, { target: { value: 'Най' } });
  fireEvent.change(input, { target: { value: 'Найд' } });

  const queries = () => calls.filter((c) => c.path === 'entity.query');
  await waitFor(() => expect(queries()).toHaveLength(1));
  expect(queries()[0]?.input).toEqual({ query: 'search=Найд, limit=10' });
});

// `search=` — FTS по целым словам (plainto_tsquery): набор по префиксу («Куп» для
// «Купить кроссовки») не находит ничего. Пикер обязан говорить это словами, а не молчать:
// немая пустая область читается как сломанная фича.
test('пикер: подсказка до ввода, спиннер в полёте, «ничего не найдено» на пустом ответе', async () => {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((res) => {
    release = res;
  });
  renderWithProviders(<DetailScreen entityId="e1" />, handler({ onQuery: () => gate }));
  await screen.findByTestId('body-edit');

  fireEvent.click(screen.getByRole('button', { name: 'Добавить блокировку' }));
  expect(screen.getByText(/по целому слову/i)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Поиск сущности'), { target: { value: 'Куп' } });
  expect(await screen.findByRole('status', { name: 'Поиск' })).toBeInTheDocument();

  release([]);
  expect(await screen.findByText(/ничего не найдено/i)).toBeInTheDocument();
});

test('пикер: отказ поиска показан плашкой, а не пустотой', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    handler({
      onQuery: () => {
        throw trpcError('INTERNAL_SERVER_ERROR', 'boom');
      },
    }),
  );
  await screen.findByTestId('body-edit');

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
  await screen.findByTestId('body-edit');

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
  await screen.findByTestId('body-edit');

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
    handler({ onQuery: () => [found, doneBlocker] }),
  );
  await screen.findByTestId('body-edit');

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
  expect(screen.getByText(/связанное/i)).toBeInTheDocument();
  expect(screen.getByText('связь')).toBeInTheDocument();
  expect(screen.getByText('упоминание')).toBeInTheDocument();
});
