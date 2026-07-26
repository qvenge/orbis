import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { onlineManager } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { queryBlocks } from '../browser/query';
import { AspectCards } from './AspectCards';
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

// --- подзадачи читают связи из entity.get (D5d п.3) -------------------------------------
// Раньше секция дублировала чтение графа своим relation.listFor: та же выборка, второй
// сетевой запрос на каждое открытие detail. Инвалидация после создания переехала на тот
// же ключ entity.get — иначе созданная подзадача не появлялась бы в списке.

test('подзадачи: список из entity.get; после создания — рефетч того же ключа, без relation.listFor', async () => {
  let childId: string | null = null;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      // Титул подзадачи дочитывает EntityRef отдельным entity.get без include.
      if (id !== 'e1') return { entity: { ...entity, id, title: 'Купить молоко' } };
      return {
        entity,
        relations:
          childId === null
            ? []
            : [
                {
                  id: 'r1',
                  sourceId: 'e1',
                  targetId: childId,
                  relationType: 'parent',
                  meta: {},
                  createdAt: '2026-07-05T00:00:00.000Z',
                  updatedAt: '2026-07-05T00:00:00.000Z',
                },
              ],
        thread: { threadId: 'th1', messages: [] },
      };
    }
    if (path === 'entity.create') {
      const { input: created } = input as { input: { id: string; title: string } };
      return { ...entity, id: created.id, title: created.title };
    }
    if (path === 'relation.create') {
      childId = (input as { target_id: string }).target_id;
      return {
        id: 'r1',
        sourceId: 'e1',
        targetId: childId,
        relationType: 'parent',
        meta: {},
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-05T00:00:00.000Z',
      };
    }
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  expect(screen.queryByTestId('subtask')).toBeNull();

  const field = screen.getByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: 'Купить молоко' } });
  fireEvent.keyDown(field, { key: 'Enter' });

  expect(await screen.findByTestId('subtask')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Купить молоко' })).toBeInTheDocument();
  // Второе чтение той же выборки ушло: секция живёт на relations из entity.get.
  expect(calls.some((c) => c.path === 'relation.listFor')).toBe(false);
});

// --- inline-правка заголовка (DF п.3) --------------------------------------------------
// 02-core-os §2.7: «правка памяти = правка обычной сущности (title, поля аспекта, body)»,
// а вся машиночитаемая часть memory-правила живёт именно в title (K19.4) — до этого
// правки title в web не было ни в одной точке, и экран «Память AI» обещал невозможное.
// Контракт тот же, что у body и полей аспектов: optimistic + expectedUpdatedAt, внешнее
// значение подхватывается только на нетронутом черновике.

test('inline правка заголовка уходит в entity.update с новым title', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, title: 'кофе → Транспорт' };
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await screen.findByLabelText('Заголовок');
  fireEvent.change(field, { target: { value: 'кофе → Транспорт' } });
  fireEvent.blur(field);

  await waitFor(() => {
    const c = calls.find(
      (x) => x.path === 'entity.update' && (x.input as { title?: string }).title !== undefined,
    );
    expect(c?.input).toEqual({
      id: 'e1',
      title: 'кофе → Транспорт',
      expectedUpdatedAt: '2026-07-05T10:00:00.000Z',
    });
  });
});

/** Обработчик, у которого entity.get после первого чтения отдаёт ЧУЖОЙ заголовок. */
function externalTitleChange(): { handler: MockHandler; getCalls: () => number } {
  let getCalls = 0;
  const renamed = {
    ...entity,
    title: 'Переименована извне',
    updatedAt: '2026-07-05T11:00:00.000Z',
  };
  return {
    getCalls: () => getCalls,
    handler: (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        return {
          entity: getCalls === 1 ? entity : renamed,
          relations: [],
          thread: { threadId: 'th1', messages: [] },
        };
      }
      if (path === 'entity.update') return renamed;
      if (path === 'aspect.list') return [];
      return {};
    },
  };
}

test('незакоммиченный ввод в заголовок переживает внешнее изменение', async () => {
  const { handler, getCalls } = externalTitleChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('Заголовок');
  // Печатаем, но НЕ сохраняем (blur не было)
  fireEvent.change(field, { target: { value: 'кофе → Тра' } });

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls()).toBeGreaterThan(1)); // рефетч с чужим title пришёл
  expect(screen.getByLabelText('Заголовок')).toHaveValue('кофе → Тра');
});

test('нетронутый заголовок подхватывает переименование с сервера', async () => {
  const { handler } = externalTitleChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  expect(await screen.findByLabelText('Заголовок')).toHaveValue('Задача');

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() =>
    expect(screen.getByLabelText('Заголовок')).toHaveValue('Переименована извне'),
  );
});

// --- поле аспекта и внешние изменения значения (D6c п.3) -------------------------------
// Смоук D6b: после перевода задачи в «Готово» чекбоксом поле «статус» продолжало
// показывать inbox — AspectField держал значение в useState(initial) без синхронизации.
// Политика — та же, что у BodyEditor: внешнее значение подхватывается, пока черновик
// не трогали; набранный текст наивным useEffect'ом не затирается.

/** Обработчик, у которого entity.get после первого чтения отдаёт `done`. */
function externalStatusChange(): { handler: MockHandler; getCalls: () => number } {
  let getCalls = 0;
  const done = {
    ...entity,
    aspects: { 'orbis/task': { status: 'done', priority: 'high' } },
    updatedAt: '2026-07-05T11:00:00.000Z',
  };
  return {
    getCalls: () => getCalls,
    handler: (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        return {
          entity: getCalls === 1 ? entity : done,
          relations: [],
          thread: { threadId: 'th1', messages: [] },
        };
      }
      if (path === 'entity.update') return done;
      if (path === 'aspect.list') return [];
      return {};
    },
  };
}

test('поле аспекта подхватывает внешнее изменение значения (статус после чекбокса)', async () => {
  const { handler } = externalStatusChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('orbis/task status');
  expect(field).toHaveValue('inbox');

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(screen.getByLabelText('orbis/task status')).toHaveValue('done'));
});

test('незакоммиченный ввод в поле аспекта переживает внешнее изменение', async () => {
  const { handler, getCalls } = externalStatusChange();
  renderWithProviders(<DetailScreen entityId="e1" />, handler);
  const field = await screen.findByLabelText('orbis/task status');
  // Печатаем, но НЕ сохраняем (blur не было) — правка пользователя ещё жива
  fireEvent.change(field, { target: { value: 'in_progress' } });

  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(getCalls()).toBeGreaterThan(1)); // рефетч с чужим статусом пришёл
  expect(screen.getByLabelText('orbis/task status')).toHaveValue('in_progress');
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

// D5c п.4: упавший запрос списка и живая ссылка на исчезнувшую категорию — РАЗНЫЕ беды.
// Общий текст «Категория не найдена» на отказе сети врал бы про целую транзакцию, что
// связь с категорией потеряна (приём RolloverScreen: ветка isError отдельно от пустоты).
test('financial: запрос категорий упал → «Не удалось загрузить категории», а не «не найдена»', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: finEntity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await waitFor(() => expect(select).toHaveDisplayValue('Не удалось загрузить категории'));
  expect(select).not.toHaveDisplayValue('Категория не найдена');
});

test('financial: список пришёл, а ссылка ведёт мимо него → «Категория не найдена»', async () => {
  const orphan = {
    ...finEntity,
    aspects: {
      'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: 'gone' },
    },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: orphan, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query')
      return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список доехал целым
  expect(select).toHaveDisplayValue('Категория не найдена');
});

// D5d п.5: три дефекта одной цепочки подписи «своей» опции пикера.

// (а) пустой category_ref — не «беда со списком»: подпись «Без категории» обязана
// пережить упавший запрос, иначе транзакция без категории выглядит как сломанная связь.
test('financial: без категории при упавшем запросе — «Без категории», а не отказ', async () => {
  const noCategory = {
    ...finEntity,
    aspects: { 'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: '' } },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: noCategory, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await waitFor(() => expect(select).toHaveDisplayValue('Без категории'));
});

// (б) v5 сохраняет data при ошибке РЕФЕТЧА: список категорий известен целиком, и
// «Не удалось загрузить категории» врало бы — ссылка действительно ведёт в никуда.
test('financial: рефетч списка упал, но список уже есть → «Категория не найдена»', async () => {
  let queries = 0;
  const orphan = {
    ...finEntity,
    aspects: {
      'orbis/financial': { ...finEntity.aspects['orbis/financial'], category_ref: 'gone' },
    },
  };
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity: orphan, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.query') {
      queries += 1;
      if (queries === 1) return [category(CAT_FOOD, 'Еда'), category(CAT_FUN, 'Развлечения')];
      throw trpcError('INTERNAL_SERVER_ERROR');
    }
    if (path === 'entity.update') return orphan;
    if (path === 'aspect.list') return [];
    return {};
  });
  const select = await screen.findByLabelText('orbis/financial category_ref');
  await screen.findByRole('option', { name: 'Развлечения' }); // список доехал целым
  // Любая правка сущности инвалидирует entity.query (useEntityUpdate.onSettled) — рефетч
  // падает, но data остаётся: state = error + непустой список.
  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'новое' } });
  fireEvent.blur(screen.getByTestId('body-edit'));

  await waitFor(() => expect(queries).toBeGreaterThan(1));
  expect(select).toHaveDisplayValue('Категория не найдена');
});

// (в) офлайн-пауза: fetchStatus='paused' даёт isLoading===false при status='pending' —
// по isLoading подпись срывалась в «Категория не найдена» на целой транзакции.
test('financial: офлайн-пауза списка категорий — «Загрузка…», а не «Категория не найдена»', async () => {
  onlineManager.setOnline(false);
  try {
    renderWithProviders(<AspectCards entity={finEntity} />, finHandler);
    const select = await screen.findByLabelText('orbis/financial category_ref');
    expect(select).toHaveDisplayValue('Загрузка…');
  } finally {
    onlineManager.setOnline(true);
  }
});

test('нефинансовая сущность: поля прежние (инпут), список категорий не запрашивается', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return entity;
    if (path === 'aspect.list') return [];
    return {};
  });
  const field = await screen.findByLabelText('orbis/task status');
  expect(field.tagName).toBe('INPUT');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

// --- query-блоки body (02-core-os §3.4) ------------------------------------------------
// Реестр аспектов — настоящий (schema из @orbis/shared), поэтому каталог полей грамматики
// в тесте тот же, что в проде: битая клауза упала бы плашкой qb-error, а не молча.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));
const found = (title: string) => ({
  id: title,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

// §3.4 нормирует: «Каждый {{query:...}}-блок в body рендерится виджетом». Это же условие —
// продуктовая половина приёмки 02-core-os §8.4 («задача видна в Daily Planning»): список
// «Сегодня» — ВТОРОЙ блок сида, и при рендере только первого он недостижим в UI.
// Body берётся из самого сида (@orbis/server/src/seed/smart-lists) — дрейф невозможен.
test('detail рендерит КАЖДЫЙ query-блок body: у Daily Planning — три секции, включая «Сегодня»', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get')
      return {
        entity: { ...entity, title: 'Daily Planning', body: DAILY_PLANNING_BODY, aspects: {} },
        relations: [],
        thread: null,
      };
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') {
      // Задача из приёмки §8.4: срок сегодня, статус in_progress — попадает ровно в «Сегодня».
      const q = (input as { query: string }).query;
      return q.includes('due_date=today|overdue') ? [found('Разобрать Inbox')] : [];
    }
    return {};
  });

  // Три виджета — по одному на блок, каждый со своим заголовком из title= (§3.4).
  await waitFor(() => expect(screen.getAllByTestId('qb-count')).toHaveLength(3));
  expect(screen.queryByTestId('qb-error')).not.toBeInTheDocument();
  for (const section of ['Inbox', 'Сегодня', 'Ожидание']) {
    expect(screen.getByText(section)).toBeInTheDocument();
  }

  // В entity.query ушли ВСЕ три блока дословно (inner каждого блока body).
  const sent = calls
    .filter((c) => c.path === 'entity.query')
    .map((c) => (c.input as { query: string }).query);
  expect([...sent].sort()).toEqual([...queryBlocks(DAILY_PLANNING_BODY)].sort());

  // …и результат «Сегодня» виден на экране — та самая половина §8.4, которой при рендере
  // одного лишь первого блока (Inbox) в продукте не существовало.
  await waitFor(() => expect(screen.getByTestId('qb-item')).toHaveTextContent('Разобрать Inbox'));
});

test('conflict-баннер: клик «Обновить» → refetch entity.get + баннер скрыт', async () => {
  const calls: string[] = [];
  renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    calls.push(path);
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') throw trpcError('CONFLICT');
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
