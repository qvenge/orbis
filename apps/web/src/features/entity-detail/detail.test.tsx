import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { DetailScreen } from './DetailScreen';
import { detailGetInput } from './useEntityDetail';

// Пробник читает ТУ ЖЕ entity.get-запись из кэша (общий ключ detailGetInput) и рендерит
// body как plain-текст без локального стейта — в отличие от keyed-textarea он честно
// отражает финальное состояние кэша (React коалесцирует optimistic+rollback в один коммит).
function BodyProbe() {
  const q = trpc.entity.get.useQuery(detailGetInput('e1'));
  return <span data-testid="body-probe">{q.data?.entity.body ?? ''}</span>;
}

const entity = {
  id: 'e1',
  ownerId: 'u',
  title: 'Задача',
  emoji: null,
  body: 'тело',
  bodyRefs: [],
  tags: ['work'],
  meta: {},
  aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } },
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
};

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

test('чекбокс task → entity.update status=done + completed_at', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update')
      return { ...entity, aspects: { 'orbis/task': { status: 'done', completed_at: 'now' } } };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  // Этап 3: title теперь и в ScreenHeader (h1), и в NativeRow — целимся в шапку.
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    const input = c?.input as {
      id: string;
      aspects: { 'orbis/task': { status: string; completed_at?: unknown } };
    };
    expect(input.id).toBe('e1');
    expect(input.aspects['orbis/task'].status).toBe('done');
    expect(input.aspects['orbis/task'].completed_at).toBeTruthy();
  });
});

test('inline body-правка шлёт expectedUpdatedAt = точная строка updatedAt', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, body: 'новое' };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'новое' } });
  fireEvent.blur(screen.getByTestId('body-edit'));
  await waitFor(() => {
    const c = calls.find(
      (x) => x.path === 'entity.update' && (x.input as { body?: string }).body === 'новое',
    );
    expect((c?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(
      '2026-07-05T10:00:00.000Z',
    );
  });
});

// Редактор больше не ремоунтится по updatedAt: refetch после save приносил новый key и
// стирал текст, допечатанный за время запроса.
test('текст, набранный во время сохранения, переживает refetch', async () => {
  let getCalls = 0;
  const saved = { ...entity, body: 'новое', updatedAt: '2026-07-05T11:00:00.000Z' };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') {
      getCalls += 1;
      const e = getCalls === 1 ? entity : saved;
      return { entity: e, relations: [], thread: { threadId: 'th1', messages: [] } };
    }
    if (path === 'entity.update') return saved;
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());

  const ta = screen.getByTestId('body-edit');
  fireEvent.change(ta, { target: { value: 'новое' } });
  fireEvent.blur(ta); // save уходит на сервер
  fireEvent.change(ta, { target: { value: 'новое, и ещё абзац' } }); // печатаем, пока он летит

  await waitFor(() => expect(getCalls).toBeGreaterThan(1)); // refetch с новым updatedAt пришёл
  expect(screen.getByTestId('body-edit')).toHaveValue('новое, и ещё абзац');
});

test('нетронутый черновик подхватывает изменение тела с сервера', async () => {
  let getCalls = 0;
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get') {
      getCalls += 1;
      const e = getCalls === 1 ? entity : { ...entity, body: 'извне', updatedAt: 'B' };
      return { entity: e, relations: [], thread: { threadId: 'th1', messages: [] } };
    }
    if (path === 'entity.update') return entity;
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toHaveValue('тело'));
  // Чекбокс задачи → mutation → invalidate → refetch с чужим body; поле не редактировали.
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(screen.getByTestId('body-edit')).toHaveValue('извне'));
});

test('inline body-правка: CONFLICT (409) → откат кэша к прежнему body + alert «обновите»', async () => {
  let getCalls = 0;
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <BodyProbe />
    </>,
    async (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        if (getCalls === 1)
          return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
        // 2-й get (refetch после invalidate в onSettled) намеренно «зависает»: он НЕ даёт
        // независимого источника прежнего body, поэтому 'тело' в кэше — заслуга onError-отката
        // setData(ctx.prev), а не refetch. Уберёшь откат — здесь останется 'конфликтное' (не-тавтология).
        return new Promise(() => {});
      }
      if (path === 'entity.update') throw trpcError('CONFLICT');
      if (path === 'relation.listFor') return [];
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  expect(screen.getByTestId('body-probe')).toHaveTextContent('тело');

  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'конфликтное' } });
  fireEvent.blur(screen.getByTestId('body-edit'));

  // (б) сообщение конфликта показано
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/Изменено в другом месте.*обновите/),
  );
  // (а) кэш откатился к прежнему body: оптимистичный патч 'конфликтное' снят (snapshot восстановлен)
  await waitFor(() => expect(screen.getByTestId('body-probe')).toHaveTextContent('тело'));
  expect(screen.getByTestId('body-probe')).not.toHaveTextContent('конфликтное');
});

// --- пикер категории для financial-сущности (sign-off владельца K6, D3b) ---------------
// До D3b единственным способом сменить категорию на detail был свободный ввод UUID.

const CAT_FOOD = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';
const CAT_FUN = 'b8e1c9a4-2d5e-4c3b-8f7a-1e9d0c2b3a55';

const finEntity = {
  ...entity,
  title: 'Кофе Хауз',
  aspects: {
    'orbis/financial': {
      amount: '340.00',
      currency: 'RUB',
      direction: 'expense',
      occurred_on: '2026-07-20',
      category_ref: CAT_FOOD,
    },
  },
};

const category = (id: string, title: string) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/category': {} },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

const finHandler = (path: string) => {
  if (path === 'entity.get')
    return { entity: finEntity, relations: [], thread: { threadId: 'th1', messages: [] } };
  if (path === 'entity.query') return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
  if (path === 'entity.update') return finEntity;
  if (path === 'relation.listFor') return [];
  if (path === 'aspect.list') return [];
  return {};
};

test('financial: category_ref — выбор из категорий с названиями, а не UUID в инпуте', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, finHandler);
  const select = await screen.findByLabelText('orbis/financial category_ref');
  expect(select.tagName).toBe('SELECT');
  await screen.findByRole('option', { name: 'Развлечения' });
  // Показано НАЗВАНИЕ выбранной категории (displayValue у select — текст выбранной опции)
  expect(select).toHaveDisplayValue('Еда');
  // Список категорий берётся тем же запросом, что и экраны Budget (один кэш)
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/category, sortBy=title:asc, limit=200',
  });
});

test('financial: выбор категории шлёт entity.update с новым category_ref', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, finHandler);
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список категорий доехал
  fireEvent.change(select, { target: { value: CAT_FUN } });
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect(c?.input).toEqual({
      id: 'e1',
      expectedUpdatedAt: '2026-07-05T10:00:00.000Z',
      aspects: { 'orbis/financial': { category_ref: CAT_FUN } },
    });
  });
});

test('нефинансовая сущность: поля прежние (инпут), список категорий не запрашивается', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return entity;
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await screen.findByLabelText('orbis/task status');
  expect(field.tagName).toBe('INPUT');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

test('conflict-баннер: клик «Обновить» → refetch entity.get + баннер скрыт', async () => {
  const calls: string[] = [];
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    calls.push(path);
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') throw trpcError('CONFLICT');
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());

  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'конфликтное' } });
  fireEvent.blur(screen.getByTestId('body-edit'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

  const getsBefore = calls.filter((p) => p === 'entity.get').length;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));

  // Баннер снят немедленно (dismissConflict), refetch ушёл на сервер.
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  await waitFor(() =>
    expect(calls.filter((p) => p === 'entity.get').length).toBeGreaterThan(getsBefore),
  );
});
