import { BUILTIN_CONTRACT_DEFS, effectiveLabel, OWNER_LOCALE } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { resetNavForTests } from '../../state/navigation';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';
import { EntityList } from './EntityList';
import { EntityRow } from './EntityRow';
import { type CaptureContext, QuickCapture } from './QuickCapture';

const ent = (id: string, title: string) => wireEntity({ id, title });

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  resetNavForTests();
});

test('EntityList: первая страница 50 через entity.query; «ещё» шлёт limit=100', async () => {
  const page = Array.from({ length: 50 }, (_, i) => ent(`e${i}`, `T${i}`));
  const { calls } = renderWithProviders(
    <EntityList showPagesAndApps={false} onOpen={() => {}} />,
    (path, input) => {
      if (path === 'entity.query') {
        const q = (input as { query: string }).query;
        return q.includes('limit=100') ? [...page, ent('e50', 'T50')] : page;
      }
      throw new Error(`unexpected ${path}`);
    },
  );
  await waitFor(() => expect(screen.getAllByTestId('entity-row')).toHaveLength(50));
  fireEvent.click(screen.getByRole('button', { name: /ещё/i }));
  // Отбор по ПУТИ обязателен: в журнале вызовов лежат не только `entity.query` (строка
  // сущности читает снимок реестра — `registry.effective` идёт без входа вовсе), и слепой
  // перебор всех вызовов падал бы на чужом входе вместо ответа на свой вопрос.
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.path === 'entity.query' &&
          String((c.input as { query?: string } | undefined)?.query ?? '').includes('limit=100'),
      ),
    ).toBe(true),
  );
});

test('QuickCapture: title-only через entity.create(source:quick_capture) без интерпретации', async () => {
  const { calls } = renderWithProviders(<QuickCapture context={{ kind: 'root' }} />, (path) =>
    path === 'entity.create' ? ent('new', 'купить молоко 200') : {},
  );
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), {
    target: { value: 'купить молоко 200' },
  });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.create');
    expect(c?.input).toMatchObject({
      source: 'quick_capture',
      input: { title: 'купить молоко 200', tags: [] },
    });
    // никакой интерпретации: нет aspects orbis/financial
    expect((c?.input as { input: { aspects?: unknown } }).input.aspects).toBeUndefined();
    expect(c?.input).not.toHaveProperty('link');
  });
});

test('QuickCapture внутри записи: подпункт рождается ЗАДАЧЕЙ, связь несёт роль subitem (§А4-3)', async () => {
  // Ветка `context.kind === 'entity'`: быстрая запись внутри записи заводит ПОДПУНКТ.
  // Роль здесь не украшение — по ней секция подзадач и отбирает детей, а прогон
  // исполнителя (роль `run`) в неё попасть не должен.
  const { calls } = renderWithProviders(
    <QuickCapture context={{ kind: 'entity', parentId: 'p1' }} />,
    (path) => (path === 'entity.create' ? ent('child', 'подзадача') : {}),
  );
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), { target: { value: 'подзадача' } });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));

  /**
   * ЗАПИСЬ С НУЛЯ: аспект задачи навешивается ЯВНО (§А1-1).
   *
   * Старая карта вешала `orbis/task` самим фактом ключа `status`; новая форма требует
   * списка, и потеря его наблюдаема не отказом, а ТИШИНОЙ: подпункт рождается без чекбокса,
   * мимо Повестки и мимо смарт-листа `aspect=orbis/task`. До этой пробы сьют был к такой
   * потере слеп целиком — проверялась только роль связи (гейт-ревью 13c, Important-1).
   */
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));
  const create = calls.find((c) => c.path === 'entity.create')?.input as {
    input: { title: string; props?: Record<string, unknown>; aspects?: string[] };
    link: { parentId: string; role: string };
  };
  expect(create.input.aspects).toEqual(['orbis/task']);
  expect(create.input.props).toEqual({ 'orbis/task_status': 'inbox' });

  await waitFor(() => expect(screen.getByLabelText(/быстрая запись/i)).toHaveValue(''));
  expect(calls.filter((call) => call.path === 'entity.create')).toHaveLength(1);
  expect(create.link).toEqual({ parentId: 'p1', role: 'subitem' });
  expect(calls.filter((call) => call.path === 'relation.create')).toHaveLength(0);
});

test('EntityList: загрузка → skeleton-ряды (role=status), не текст «Загрузка…»', () => {
  renderWithProviders(
    <EntityList showPagesAndApps={false} onOpen={() => {}} />,
    () => new Promise(() => {}),
  ); // запрос висит
  expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThanOrEqual(6);
  expect(screen.queryByText(/Загрузка…/)).not.toBeInTheDocument();
});

test('EntityList: пусто → EmptyState «Здесь появятся ваши записи»', async () => {
  renderWithProviders(<EntityList showPagesAndApps={false} onOpen={() => {}} />, (path) => {
    if (path === 'entity.query') return [];
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByText('Здесь появятся ваши записи')).toBeInTheDocument());
  expect(screen.getByText(/Добавьте первую через быструю запись/)).toBeInTheDocument();
});

test('QuickCapture: ошибка мутации → toast «Не удалось сохранить», ввод сохранён', async () => {
  renderWithProviders(
    <>
      <QuickCapture context={{ kind: 'root' }} />
      <Toaster />
    </>,
    (path) => {
      if (path === 'entity.create') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    },
  );
  fireEvent.change(screen.getByLabelText(/быстрая запись/i), {
    target: { value: 'важная заметка' },
  });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));

  await waitFor(() => expect(screen.getByText('Не удалось сохранить')).toBeInTheDocument());
  // Введённый текст НЕ очищен — пользователь может повторить сабмит.
  expect(screen.getByLabelText(/быстрая запись/i)).toHaveValue('важная заметка');
});

// Контекст входит в намерение: потерянный ответ предыдущего родителя не должен перехватить новую отправку.
function CaptureSwitch({ initial }: { initial: CaptureContext }) {
  const [context, setContext] = useState(initial);
  return (
    <>
      <QuickCapture context={context} />
      <button type="button" onClick={() => setContext({ kind: 'entity', parentId: 'p2' })}>
        Другой родитель
      </button>
      <button type="button" onClick={() => setContext({ kind: 'root' })}>
        Без родителя
      </button>
      <Toaster />
    </>
  );
}

test('QuickCapture: отказ сохраняет черновик; повтор того же намерения шлёт тот же id', async () => {
  let attempts = 0;
  const { calls } = renderWithProviders(
    <CaptureSwitch initial={{ kind: 'entity', parentId: 'p1' }} />,
    (path, input) => {
      if (path === 'entity.create') {
        if (++attempts === 1) throw trpcError('INTERNAL_SERVER_ERROR');
        const created = (input as { input: { id: string; title: string } }).input;
        return ent(created.id, created.title);
      }
      return {};
    },
  );
  const field = screen.getByLabelText(/быстрая запись/i);
  fireEvent.change(field, { target: { value: 'Тот же текст' } });
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  expect(await screen.findByText('Не удалось сохранить')).toBeInTheDocument();
  expect(field).toHaveValue('Тот же текст');
  fireEvent.submit(screen.getByTestId('quick-capture-form'));
  await waitFor(() => expect(field).toHaveValue(''));
  const creates = calls.filter((call) => call.path === 'entity.create');
  expect(creates).toHaveLength(2);
  expect(creates[1]?.input).toEqual(creates[0]?.input);
  expect(calls.filter((call) => call.path === 'relation.create')).toHaveLength(0);
});

for (const next of ['Другой родитель', 'Без родителя']) {
  test(`QuickCapture: одинаковый текст после отказа и смены контекста «${next}» получает новый id`, async () => {
    const { calls } = renderWithProviders(
      <CaptureSwitch initial={{ kind: 'entity', parentId: 'p1' }} />,
      (path) => {
        if (path === 'entity.create') throw trpcError('INTERNAL_SERVER_ERROR');
        return {};
      },
    );
    fireEvent.change(screen.getByLabelText(/быстрая запись/i), {
      target: { value: 'Тот же текст' },
    });
    fireEvent.submit(screen.getByTestId('quick-capture-form'));
    await screen.findByText('Не удалось сохранить');
    fireEvent.click(screen.getByRole('button', { name: next }));
    fireEvent.submit(screen.getByTestId('quick-capture-form'));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === 'entity.create')).toHaveLength(2),
    );
    const creates = calls
      .filter((call) => call.path === 'entity.create')
      .map(
        (call) =>
          call.input as { input: { id: string }; link?: { parentId: string; role: string } },
      );
    expect(creates[1]?.input.id).not.toBe(creates[0]?.input.id);
    if (next === 'Другой родитель')
      expect(creates[1]?.link).toEqual({ parentId: 'p2', role: 'subitem' });
    else expect(creates[1]).not.toHaveProperty('link');
  });
}

// Строка списка — таблица M14 (§Б5-6): порядок чекбокс → заголовок → дата → сумма → бейджи, и ни
// одного `if` по имени аспекта. Реестр НАСТОЯЩИЙ: правило берётся из привязок встроенных аспектов.
const m14 = (path: string) => registryReply(path) ?? {};
// Слова классов выбирает сид (задача 1) — тест их не пинит, он пинит «подпись, а не ключ».
const classLabelOf = (cls: string): string => {
  const found = (
    BUILTIN_CONTRACT_DEFS.find((c) => c.id === 'orbis/completable')?.classes ?? []
  ).find((c) => c.key === cls);
  if (found === undefined) throw new Error(`класс ${cls} не найден в контракте`);
  return effectiveLabel(found.label, OWNER_LOCALE);
};

test('M14: у платежа со сроком печатаются И дата, И сумма — элементы разные', async () => {
  const payment = wireEntity({
    id: 'p1',
    title: 'Аренда',
    aspects: ['orbis/task', 'orbis/financial'],
    props: {
      'orbis/task_status': 'planned',
      'orbis/due_date': '2026-09-10',
      'orbis/amount': '1200.00',
      'orbis/direction': 'expense',
    },
  });
  renderWithProviders(<EntityRow entity={payment} />, m14);
  expect(await screen.findByText('−1 200.00')).toBeInTheDocument();
  expect(screen.getByText('10 сент.')).toBeInTheDocument();
});

test('M14: отменённая — зачёркнута и с бейджем класса ПОДПИСЬЮ, а не ключом', async () => {
  const cancelled = wireEntity({
    id: 'c1',
    title: 'Отменённая',
    aspects: ['orbis/task'],
    props: { 'orbis/task_status': 'cancelled' },
  });
  renderWithProviders(<EntityRow entity={cancelled} />, m14);
  expect(await screen.findByText(classLabelOf('cancelled'))).toBeInTheDocument();
  expect(screen.queryByText('cancelled')).toBeNull(); // ключ варианта на экран не выходит
  expect(screen.getByText('Отменённая').className).toContain('line-through');
});
