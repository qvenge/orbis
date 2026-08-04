import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DetailScreen } from '../../features/entity-detail/DetailScreen';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { trpc } from '../../trpc';
import { Toaster } from '../../ui/Toast';
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

// Те же два блока, но НЕразбираемые (`status=` — пустое значение). Строковый редактор — это
// редактор именно битого блока (§3.4): у валидного «Настроить» открывает форму, поэтому
// тесты текстового пути обязаны идти по битому, иначе они проверяли бы не тот редактор.
const TWO_BLOCKS_BROKEN = TWO_BLOCKS.replaceAll('tags=', 'status=, tags=');

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
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(TWO_BLOCKS_BROKEN),
  );
  const dialog = await openBlockEditor(1);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=home, limit=5, title=Дом' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect((c?.input as { body: string }).body).toBe(
      'Утренний обзор\n\n{{query: status=, tags=work, title=Работа}}\n\nмежду\n\n{{query: tags=home, limit=5, title=Дом}}\n\nхвост',
    );
    // §5.2: тот же контракт, что у правки тела руками — версия сущности едет с записью.
    expect((c?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(entity.updatedAt);
  });
});

// Р3, сквозная проверка. Сидированные списки многострочные, с 9-пробельными отступами
// continuation-строк, а сериализатор по построению даёт ОДНУ строку: пересборка блока из
// формы схлопнула бы их — «ничего не менял, а запись переписалась».
test('сохранение формы без изменений не шлёт мутацию', async () => {
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(DAILY_PLANNING_BODY),
  );
  const dialog = await openBlockEditor(1);
  // Открылась именно форма: у валидного блока строкового редактора быть не должно.
  expect(await within(dialog).findByLabelText('Заголовок')).toHaveValue('Сегодня');
  expect(within(dialog).queryByTestId('query-text-edit')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

test('правка формы заменяет только этот блок в body', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const dialog = await openBlockEditor(1);
  fireEvent.change(await within(dialog).findByLabelText('Лимит'), { target: { value: '5' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    expect((c?.input as { body: string }).body).toBe(
      'Утренний обзор\n\n{{query: tags=work, title=Работа}}\n\nмежду\n\n{{query: tags=home, limit=5, title=Дом}}\n\nхвост',
    );
  });
});

// §3.4: «редактировать как текст» — тот же строковый редактор с ТЕКУЩЕЙ сериализацией,
// иначе набранное в форме терялось бы на переходе.
test('из формы «Редактировать как текст» открывает строковый редактор с правками формы', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const form = await openBlockEditor(0);
  fireEvent.change(await within(form).findByLabelText('Заголовок'), { target: { value: 'Дела' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Редактировать как текст' }));

  const text = await screen.findByRole('dialog');
  expect(editorField(text)).toHaveValue('tags=work, title=Дела');
});

test('«Отмена» закрывает редактор и ничего не пишет', async () => {
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(TWO_BLOCKS_BROKEN),
  );
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=work, limit=1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

// Канон §6.4: невалидный блок — это состояние продукта (красная плашка), а не запрет на
// запись. Кнопка «Сохранить» без парсера: иначе из битого блока не выйти правкой по шагам.
test('невалидную строку сохранить можно', async () => {
  const { calls } = renderWithProviders(
    <DetailScreen entityId="e1" />,
    bodyHandler(TWO_BLOCKS_BROKEN),
  );
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

/** Кнопка, роняющая кэш entity.get: имитирует ФОНОВЫЙ рефетч (чужая правка приехала). */
function Refetcher() {
  const utils = trpc.useUtils();
  return (
    <button type="button" data-testid="refetch" onClick={() => void utils.entity.get.invalidate()}>
      обновить
    </button>
  );
}

// Модалка живёт долго (а форма-редактор будет жить ещё дольше), и body под ней может
// смениться фоновым рефетчем: индекс блока остался бы прежним числом, а блок по нему —
// уже чужим. Записать в него текст, набранный для ДРУГОГО запроса, — молча испортить
// чужую правку, причём expectedUpdatedAt здесь не спасает: клиент уже принял новую версию.
test('body сменился под открытой модалкой — правка в чужой блок не уезжает', async () => {
  // Первый блок битый: сверка «тот ли это ещё блок» живёт в BodySection и общая для обоих
  // редакторов, а строковый показывает набранный черновик прямо в поле. Второй — валидный:
  // его заголовок и есть видимый признак того, что фоновый рефетч доехал.
  const before = '{{query: status=, tags=work, title=Работа}}\n\n{{query: tags=home, title=Дом}}';
  const after = '{{query: status=, tags=other, title=ЧУЖОЙ}}\n\n{{query: tags=home, title=ДРУГОЙ}}';
  let gets = 0;
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <Refetcher />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'entity.get') {
        gets += 1;
        return {
          entity: { ...entity, body: gets === 1 ? before : after },
          relations: [],
          thread: null,
        };
      }
      if (path === 'entity.update')
        return { ...entity, body: (input as { body?: string }).body ?? after };
      if (path === 'aspect.list') return realAspects;
      if (path === 'entity.query') return [];
      return {};
    },
  );
  const dialog = await openBlockEditor(0);
  fireEvent.change(editorField(dialog), { target: { value: 'tags=work, limit=5' } });

  fireEvent.click(screen.getByTestId('refetch'));
  await screen.findByText('ДРУГОЙ');

  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
  // Отказ громкий и без потерь: сказано почему, модалка на месте, набранный текст цел.
  // Ожидание сообщения заодно прокручивает микрозадачи — ушедшая мутация к этому моменту
  // уже добралась бы до линка, и проверка ниже увидела бы её.
  expect(await screen.findByText(/откройте.*заново/i)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(editorField(dialog)).toHaveValue('tags=work, limit=5');
  expect(calls.some((c) => c.path === 'entity.update')).toBe(false);
});

test('кнопка «Настроить» — настоящая кнопка с доступным именем', async () => {
  renderWithProviders(<DetailScreen entityId="e1" />, bodyHandler(TWO_BLOCKS));
  const buttons = await screen.findAllByRole('button', { name: 'Настроить' });
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.tagName).toBe('BUTTON');
});

// --- сам редактор ----------------------------------------------------------------------

const editorHandler: MockHandler = (path) => (path === 'aspect.list' ? realAspects : {});

// Radix сам проставляет content'у aria-describedby на свой Description; примитив ui/Dialog
// его не рендерит, поэтому ссылка вела в никуда — скринридер объявлял бы модалку с
// описанием, которого нет. Первым потребителем примитива стал этот редактор.
test('у модалки нет ссылки на несуществующее описание', async () => {
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={() => {}} onCancel={() => {}} />,
    editorHandler,
  );
  const dialog = await screen.findByRole('dialog');
  const described = dialog.getAttribute('aria-describedby');
  if (described !== null) expect(document.getElementById(described)).not.toBeNull();
  expect(described).toBeNull();
});

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

// Единственный запрет на сохранение — и ровно про РАЗМЕТКУ тела, а не про грамматику.
// `}}` парсер принимает молча (`tags=a}}b` разбирается без ошибки, красной плашки нет), но
// рендерер блоков закроет обёртку на первом же вхождении: хвост запроса станет текстом
// заметки, а `{{query:` в нём заведёт лишний блок и сдвинет нумерацию, на которой стоит
// бейдж pinned-сущности (§3.2). §6.4 оставляет «Сохранить» доступным у НЕразбираемой
// строки — испортить обёртку она права не даёт.
test('`}}` в тексте гасит сохранение с объяснением причины', async () => {
  const onSave = vi.fn();
  renderWithProviders(
    <QueryTextEditor initial="tags=work" onSave={onSave} onCancel={() => {}} />,
    editorHandler,
  );
  const field = await screen.findByLabelText('Текст запроса');

  fireEvent.change(field, { target: { value: 'tags=a}}b' } });
  // Разбор молчит — сообщение обязано быть своё, отдельное от плашки парсера.
  expect(screen.queryByTestId('query-text-error')).toBeNull();
  const blocked = screen.getByTestId('query-text-wrapper');
  expect(blocked).toHaveTextContent('}}');
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(onSave).not.toHaveBeenCalled();

  // Вставленный целиком блок — тот же пролом (плюс своя ошибка разбора).
  fireEvent.change(field, { target: { value: '{{query: tags=work}}' } });
  expect(screen.getByTestId('query-text-wrapper')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();

  // Убрал маркер — запрет снят: запрет ровно на порчу обёртки, а не на «непонятную строку».
  fireEvent.change(field, { target: { value: 'tags=ab' } });
  expect(screen.queryByTestId('query-text-wrapper')).toBeNull();
  const save = screen.getByRole('button', { name: 'Сохранить' });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledWith('tags=ab');
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
