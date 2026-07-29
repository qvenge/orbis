import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError } from '../../test/harness';
import { NativeRow } from './NativeRow';

const base = {
  id: 'e1',
  ownerId: 'u',
  title: 'Обед',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
};

// Категория-сущность в форме ответа entity.query (тот же список, что у пикера D3b).
const category = (id: string, title: string) => ({
  ...base,
  id,
  title,
  aspects: { 'orbis/category': { icon: '🍔' } },
});

const financial = (fields: Record<string, unknown>) =>
  ({ ...base, aspects: { 'orbis/financial': fields } }) as never;

const CAT_FOOD = 'a3d6d4b2-7f3a-4a1f-9c1e-2d5b8f0a1c77';
// Ссылка в категорию, которой в списке нет — запасной вариант «показать uuid».
const CAT_GHOST = 'd1f0c8e5-4b2a-4d6e-8f01-9a7c3b5e2d44';

test('financial: сумма с минусом и тоном danger', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
  );
  const amount = screen.getByTestId('native-amount');
  expect(amount.textContent?.startsWith('−')).toBe(true);
  expect(amount.className).toContain('text-danger');
});

test('financial: income → плюс и позитивный тон', () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'income', category_ref: 'cat-salary' })}
      onToggleTask={() => {}}
    />,
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
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
    (path) => (path === 'entity.query' ? [category(CAT_FOOD, 'Еда')] : {}),
  );
  expect(await screen.findByText('Еда')).toBeInTheDocument();
  expect(screen.queryByText(CAT_FOOD)).toBeNull();
  // Источник категорий — тот же запрос (и тот же кэш), что у пикера D3b: второго нет
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/category, sortBy=title:asc, limit=200',
  });
});

// D6d п.2: прежняя версия утверждала uuid в DOM сразу после рендера — а он там и так есть,
// пока список категорий не доехал. Соседняя строка с ИЗВЕСТНОЙ категорией — маркер того,
// что запрос разрешён: только после её названия отсутствие имени значит «категории нет».
test('financial: категории нет в списке → uuid как запасной вариант (D6c п.2)', async () => {
  renderWithProviders(
    <>
      <NativeRow
        entity={financial({ amount: '10.00', direction: 'expense', category_ref: CAT_FOOD })}
        onToggleTask={() => {}}
      />
      <NativeRow
        entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_GHOST })}
        onToggleTask={() => {}}
      />
    </>,
    (path) => (path === 'entity.query' ? [category(CAT_FOOD, 'Еда')] : {}),
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
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
    (path) => (path === 'entity.query' ? categories : {}),
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
      entity={{ ...base, aspects: { 'orbis/task': { status: 'inbox' } } } as never}
      onToggleTask={() => {}}
    />,
  );
  await screen.findByRole('checkbox');
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

test('task: рендерит чекбокс', () => {
  render(
    <NativeRow
      entity={
        { ...base, aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } } } as never
      }
      onToggleTask={() => {}}
    />,
  );
  expect(screen.getByRole('checkbox')).toBeInTheDocument();
});

test('generic: 2-3 keyFields из реестра', () => {
  render(
    <NativeRow
      entity={
        { ...base, aspects: { 'orbis/note': { content_type: 'text', pinned: true } } } as never
      }
      onToggleTask={() => {}}
    />,
  );
  expect(screen.getByTestId('native-generic')).toBeInTheDocument();
});

// Уборочная фаза (E4): вся машиночитаемая часть memory-правила лежит в title (K19.4),
// а inline-правка заголовка позволяет сломать формат одним символом. Признака «правило
// больше не распознаётся» не было нигде: запись оставалась в «Памяти AI» и выглядела
// живой, хотя ни fast-path, ни резолв импорта её уже не применяли.
const memory = (kind: string, title: string) =>
  ({ ...base, title, aspects: { 'orbis/memory': { kind, scope: 'orbis/financial' } } }) as never;

test('память: правило с распознанным форматом предупреждения не показывает', () => {
  render(
    <NativeRow
      entity={memory('rule', 'кофе → Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: правку правила в текст без разделителя видно сразу — предупреждение', () => {
  render(
    <NativeRow
      entity={memory('rule', 'кофе это развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  expect(screen.getByTestId('title-warning')).toBeInTheDocument();
});

// Заявленное поведение — предупреждение по ЧЕРНОВИКУ, то есть ДО сохранения: владелец
// ломает рабочее правило прямо в поле и обязан увидеть это сразу. Проверка по
// сохранённому значению (warn(value)) все прежние тесты проходила.
test('память: предупреждение появляется на ЧЕРНОВИКЕ, без сохранения', () => {
  render(
    <NativeRow
      entity={memory('rule', 'кофе → Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
  fireEvent.change(screen.getByTestId('title-edit'), {
    target: { value: 'кофе это развлечения' },
  });
  expect(screen.getByTestId('title-warning')).toBeInTheDocument();
});

test('память: предупреждение доступно скринридеру и связано с полем', () => {
  render(
    <NativeRow
      entity={memory('rule', 'кофе это развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  const warning = screen.getByTestId('title-warning');
  expect(warning).toHaveAttribute('role', 'status');
  expect(screen.getByTestId('title-edit')).toHaveAttribute('aria-describedby', warning.id);
});

test('память: клавиатурная стрелка «->» правилом считается — предупреждения нет', () => {
  render(
    <NativeRow
      entity={memory('rule', 'кофе -> Развлечения')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: у ФАКТА формата правила нет — предупреждения быть не должно', () => {
  render(
    <NativeRow
      entity={memory('fact', 'Работаю из дома по пятницам')}
      onToggleTask={() => {}}
      onSaveTitle={() => {}}
    />,
  );
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

test('память: в списке (без inline-правки) предупреждения нет — правит только Detail', () => {
  render(<NativeRow entity={memory('rule', 'кофе это развлечения')} onToggleTask={() => {}} />);
  expect(screen.queryByTestId('title-warning')).toBeNull();
});

// Уборочная фаза: третье состояние названия категории. При ОТКАЗЕ загрузки списка
// бейдж печатал сырой uuid — та же ложь, что мелькающий uuid на загрузке (D6d развёл
// только «грузится» и «не найдена»).
test('категория: отказ списка категорий — бейджа нет, uuid не печатается', async () => {
  renderWithProviders(
    <NativeRow
      entity={financial({ amount: '340.00', direction: 'expense', category_ref: CAT_FOOD })}
      onToggleTask={() => {}}
    />,
    (path) => {
      if (path === 'entity.query') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    },
  );
  await screen.findByTestId('native-financial');
  await waitFor(() => expect(screen.queryByText(CAT_FOOD)).toBeNull());
  expect(screen.getByTestId('native-financial').textContent).not.toContain(CAT_FOOD);
});
