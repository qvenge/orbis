import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DetailScreen } from '../../features/entity-detail/DetailScreen';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { queryBlocks } from '../browser/query';
import { QueryTextEditor } from './QueryTextEditor';

// Реестр аспектов — настоящий: каталог полей грамматики в тесте тот же, что в проде,
// иначе «невалидный блок» в тесте оказался бы валидным в продукте (и наоборот).
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));

const entity = {
  id: 'e1',
  ownerId: 'u',
  title: 'Список',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: {},
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
};

/** Detail с заданным телом; entity.update возвращает присланный body. */
const bodyHandler =
  (body: string): MockHandler =>
  (path, input) => {
    if (path === 'entity.get') return { entity: { ...entity, body }, relations: [], thread: null };
    if (path === 'entity.update')
      return { ...entity, body: (input as { body?: string }).body ?? body };
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') return [];
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

const TWO_BLOCKS =
  'Утренний обзор\n\n{{query: tags=work, title=Работа}}\n\nмежду\n\n{{query: tags=home, title=Дом}}\n\nхвост';

/** Открывает редактор N-го блока кнопкой «Настроить» на его виджете. */
async function openBlockEditor(index = 0): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('qb-configure').length).toBeGreaterThan(index));
  const button = screen.getAllByTestId('qb-configure')[index];
  if (button === undefined) throw new Error(`нет виджета №${index}`);
  fireEvent.click(button);
  return await screen.findByRole('dialog');
}

function editorField(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByTestId('query-text-edit') as HTMLTextAreaElement;
}

test('«Настроить» у невалидного блока открывает редактор с текстом блока и позицией ошибки', async () => {
  renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler('{{query: aspect=orbis/task, status=}}'),
  );
  // §6.4: битый блок — плашка, а не пустой список; настроить его надо уметь именно оттуда,
  // иначе единственный путь починки — редактировать весь body руками.
  await screen.findByTestId('qb-error');

  const dialog = await openBlockEditor();
  expect(editorField(dialog)).toHaveValue('aspect=orbis/task, status=');
  expect(within(dialog).getByTestId('query-text-error')).toHaveTextContent(/позиция \d+/);
});

test('сохранение изменённого текста заменяет только этот блок в body', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const dialog = await openBlockEditor(1);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=home, limit=5, title=Дом' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect((c?.input as { body: string }).body).toBe(
      'Утренний обзор\n\n{{query: tags=work, title=Работа}}\n\nмежду\n\n{{query: tags=home, limit=5, title=Дом}}\n\nхвост',
    );
    // §5.2: тот же контракт, что у правки тела руками — версия сущности едет с записью.
    expect((c?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(entity.updatedAt);
  });
});

// Р3. Сидированные списки многострочные, с 9-пробельными отступами continuation-строк:
// пересборка блока из показанного в поле текста схлопнула бы их в одну строку — «ничего не
// менял, а запись переписалась».
test('сохранение без изменений не шлёт мутацию', async () => {
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(DAILY_PLANNING_BODY),
  );
  const dialog = await openBlockEditor(1);
  expect(editorField(dialog)).toHaveValue(queryBlocks(DAILY_PLANNING_BODY)[1]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

test('«Отмена» закрывает редактор и ничего не пишет', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=work, limit=1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

// Канон §6.4: невалидный блок — это состояние продукта (красная плашка), а не запрет на
// запись. Кнопка «Сохранить» без парсера: иначе из битого блока не выйти правкой по шагам.
test('невалидную строку сохранить можно', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=' } });
  const save = within(dialog).getByRole('button', { name: 'Сохранить' });
  expect(save).toBeEnabled();
  fireEvent.click(save);

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect((c?.input as { body: string }).body).toContain('{{query: tags=}}');
  });
});

// Виджет — не текст записи: жест «настроить» обязан остаться жестом виджета.
test('клик по «Настроить» не открывает редактор тела', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  await openBlockEditor(0);
  expect(screen.queryByTestId('body-edit')).toBeNull();
});

// Модалка Radix живёт в портале, но React-события из портала всплывают по ДЕРЕВУ React:
// смонтируй её внутри кликабельного просмотра тела — и клик по её заголовку открыл бы
// textarea прямо под открытой модалкой (обработчик просмотра ловит не всё: заголовок
// модалки не подходит ни под один селектор его белого списка).
test('клик внутри модалки не открывает редактор тела под ней', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const dialog = await openBlockEditor(0);
  fireEvent.click(within(dialog).getByRole('heading'));
  expect(screen.queryByTestId('body-edit')).toBeNull();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

// Р5. В правке тела blur сохраняет body и уходит в просмотр — клик по «Настроить» породил
// бы вторую запись подряд с устаревшим expectedUpdatedAt (updatedAt приезжает только
// рефетчем) и ложный 409. Путь один: сперва выйти из правки.
test('в режиме правки тела кнопки «Настроить» нет', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  await waitFor(() => expect(screen.getAllByTestId('qb-configure')).toHaveLength(2));
  fireEvent.click(screen.getByTestId('body-view'));
  await screen.findByTestId('body-edit');
  // Виджеты в правке остаются (список под textarea), а кнопки на них — нет.
  await waitFor(() => expect(screen.getAllByTestId('qb-count')).toHaveLength(2));
  expect(screen.queryAllByTestId('qb-configure')).toHaveLength(0);
});

test('кнопка «Настроить» — настоящая кнопка с доступным именем', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const buttons = await screen.findAllByRole('button', { name: 'Настроить' });
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.tagName).toBe('BUTTON');
});

// --- сам редактор ----------------------------------------------------------------------

const editorHandler: MockHandler = (path) => (path === 'aspect.list' ? realAspects : {});

test('поле редактора имеет доступное имя и фокус при открытии', async () => {
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  expect(field.tagName).toBe('TEXTAREA');
  await waitFor(() => expect(field).toHaveFocus());
});

// Ошибка описывает ТЕКУЩИЙ текст: замри она на исходном, и починенный запрос продолжал бы
// показывать красную плашку — «почини то, чего уже нет».
test('сообщение об ошибке пересчитывается по мере правки', async () => {
  renderWithProviders(
    <QueryTextEditor initial="tags=work, status=" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  await screen.findByTestId('query-text-error');

  fireEvent.change(field, { target: { value: 'tags=work, status=inbox' } });
  await waitFor(() => expect(screen.queryByTestId('query-text-error')).toBeNull());
});

// В поле — ВНУТРЕННОСТЬ блока: обёртку экран приставит сам. Разбирай редактор текст с
// поблажкой на обёртку (её делает parseBlock для виджета), вставленный целиком блок
// показал бы «ошибок нет», а сохранение вложило бы {{query: внутрь {{query: и порвало
// разметку тела — ошибку пользователь увидел бы уже постфактум, на плашке виджета.
test('вставленный целиком {{query:…}} — ошибка, а не молчаливое согласие', async () => {
  renderWithProviders(
    <QueryTextEditor initial="{{query: tags=work}}" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  expect(await screen.findByTestId('query-text-error')).toBeInTheDocument();
});

test('onSave получает текст поля, onCancel — по Esc', async () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={onSave} onCancel={onCancel} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');
  fireEvent.change(field, { target: { value: 'tags=home' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).toHaveBeenCalledWith('tags=home');

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(onCancel).toHaveBeenCalled());
});
