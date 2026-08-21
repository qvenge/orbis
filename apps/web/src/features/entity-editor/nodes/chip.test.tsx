import { ENTITY_RESOLVE_REFS_MAX } from '@orbis/shared';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../../state/navigation';
import { installCrashTrap, renderWithProviders, trpcError } from '../../../test/harness';
import { BodyEditor } from '../BodyEditor';
import { RefTitlesProvider } from './RefTitlesContext';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Ровно то, что отдаёт entity.resolveRefs (routers/entity.ts: toSuggestion). */
type Row = {
  id: string;
  title: string;
  emoji: string | null;
  status: string | null;
  archived: boolean;
};
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title: 'Заголовок',
  emoji: null,
  status: null,
  archived: false,
  ...over,
});

// Чип живёт NodeView'ом, и его клики с резолвом идут через обработчики событий: крах там не
// роняет тест, а только код возврата прогона. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// Мок — ФУНКЦИЯ (path, input): карты `{'entity.resolveRefs': fn}` у харнесса нет.
// Отвечает ровно про СПРОШЕННОЕ, как сервер. Мок, отдающий весь список кому попало, делал бы
// резолв документом неотличимым от резолва на каждый чип: при per-id запросе каждый чип
// получал бы чужую первую строку и рисовал бы правильный заголовок по ложной причине
// (поймано пробой — мутация «хук внутри чипа» падала не на счётчике вызовов, а на подсчёте
// одинаковых подписей).
// Потолок контракта мок соблюдает НАСТОЯЩИМ отказом: без него запрос на 201 id «удавался» бы,
// и тест про нарезку падал бы только на счётчике вызовов, а не на том, ради чего он написан, —
// на посеревших чипах. Мок, который принимает то, что сервер отвергает, — это тест, зелёный по
// ложной причине, только с другой стороны провода.
const refs =
  (rows: Row[]) =>
  (path: string, input: unknown): unknown => {
    if (path !== 'entity.resolveRefs') return {};
    const ids = (input as { ids?: string[] }).ids ?? [];
    if (ids.length > ENTITY_RESOLVE_REFS_MAX || ids.length === 0) {
      throw trpcError('BAD_REQUEST', `ids: ожидалось от 1 до ${ENTITY_RESOLVE_REFS_MAX}`);
    }
    const asked = new Set(ids);
    return rows.filter((r) => asked.has(r.id));
  };

// Держатель редактора: после присваивания в колбэке TS сузил бы `let` до null (тот же приём,
// что в editor.test.tsx).
type Held = { editor: Editor | null };
const held = (): Held => ({ editor: null });

beforeEach(() => {
  // Навигационный стор persist'ится в localStorage и живёт между тестами файла: без сброса
  // «клик открыл сущность» проходил бы по стеку, набранному соседним тестом.
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

test('чип показывает АКТУАЛЬНЫЙ заголовок, а не вмороженную подпись из текста', async () => {
  // Подпись вморожена в текст при вставке; заголовок мог смениться месяц назад.
  renderWithProviders(
    <BodyEditor doc={parseBody(`См. [[entity:${A}|Старое имя]].`)} onChange={vi.fn()} />,
    refs([row(A, { title: 'Новое имя' })]),
  );
  await waitFor(() => expect(screen.getByTestId('entity-chip').textContent).toContain('Новое имя'));
  expect(screen.queryByText(/Старое имя/)).toBeNull();
});

test('весь документ резолвится ОДНИМ запросом со схлопнутым списком id', async () => {
  // Ради этого resolveRefs и заведён: хук внутри чипа дал бы отдельный ключ кэша на ссылку,
  // то есть запрос на каждое упоминание.
  const md = `[[entity:${A}]] и [[entity:${B}]] и снова [[entity:${A}|повтор]]`;
  const r = renderWithProviders(
    <BodyEditor doc={parseBody(md)} onChange={vi.fn()} />,
    refs([row(A, { title: 'Первая' }), row(B, { title: 'Вторая' })]),
  );
  // Ответ доехал — считать уже есть что; пауза сверху даёт второму запросу успеть уйти.
  await waitFor(() => expect(screen.getAllByText('Первая')).toHaveLength(2));
  await new Promise((res) => setTimeout(res, 50));

  const resolves = r.calls.filter((c) => c.path === 'entity.resolveRefs');
  expect(resolves).toHaveLength(1);
  const ids = (resolves[0]?.input as { ids: string[] }).ids;
  expect([...ids].sort()).toEqual([A, B].sort()); // дубль схлопнут
  // Страж вакуумности: упоминаний в документе действительно три, а не одно.
  expect(screen.getAllByTestId('entity-chip')).toHaveLength(3);
});

test('провайдер нормализует список: порядок и дубли не заводят второй запрос', async () => {
  // Схлопывание в самом провайдере — НЕ дубль bodyRefsFromDoc (он и так отдаёт уникальные в
  // порядке документа). Проверено пробой: сними здесь new Set — тест выше про один запрос
  // останется зелёным, потому что дублей до провайдера уже не доезжает. Но провайдер
  // экспортирован с контрактом `ids: string[]`, а ключ кэша React Query — сам объект входа:
  // [B,A,B] и [A,B] были бы ДВУМЯ ключами и двумя запросами за одним и тем же.
  const r = renderWithProviders(
    <>
      <RefTitlesProvider ids={[B, A, B]}>{null}</RefTitlesProvider>
      <RefTitlesProvider ids={[A, B]}>{null}</RefTitlesProvider>
    </>,
    refs([row(A), row(B)]),
  );
  const resolves = () => r.calls.filter((c) => c.path === 'entity.resolveRefs');
  await waitFor(() => expect(resolves().length).toBeGreaterThan(0));
  await new Promise((res) => setTimeout(res, 50));
  expect(resolves()).toHaveLength(1);
  expect((resolves()[0]?.input as { ids: string[] }).ids).toEqual([A, B]);
});

test('документ длиннее потолка контракта режется на пачки, а не теряет заголовки', async () => {
  // Потолок `entity.resolveRefs` — 200 id (entityResolveRefsInput). На 201 упоминании
  // ОДИН запрос вернулся бы ошибкой валидации, `data` осталась бы undefined, и ВСЕ чипы
  // документа навсегда остались бы серыми — без единого следа для пользователя. Обрезание
  // списка ничем не лучше: это молчаливая потеря заголовков у хвоста тела.
  // Пачки нарезаются ровно по контрактному потолку, поэтому число берётся из контракта, а не
  // переписывается сюда: разъехавшись, они дали бы либо вечную ошибку валидации, либо лишний
  // запрос — и то и другое молча.
  const ids = Array.from(
    { length: ENTITY_RESOLVE_REFS_MAX + 1 },
    (_, i) => `0f8fad5b-d9cb-469f-a165-708677${String(i).padStart(6, '0')}`,
  );
  const rows = ids.map((id, i) => row(id, { title: `Т${i}` }));
  const r = renderWithProviders(
    <BodyEditor
      doc={parseBody(ids.map((id) => `[[entity:${id}]]`).join(' '))}
      onChange={vi.fn()}
    />,
    refs(rows),
  );
  await waitFor(() => expect(screen.getAllByTestId('entity-chip')).toHaveLength(ids.length));
  // Хвост ВТОРОЙ пачки: id отсортированы, поэтому последний — тот, чей суффикс наибольший.
  await waitFor(() => expect(screen.getByText(`Т${ids.length - 1}`)).toBeInTheDocument());

  const resolves = r.calls.filter((c) => c.path === 'entity.resolveRefs');
  expect(resolves).toHaveLength(2);
  expect(
    resolves.map((c) => (c.input as { ids: string[] }).ids.length).sort((a, b) => a - b),
  ).toEqual([1, ENTITY_RESOLVE_REFS_MAX]);
  // Заголовок приехал КАЖДОМУ чипу, а не только первой пачке: без этого ассерта тест был бы
  // зелен и у реализации, которая вторую пачку запрашивает, но в карту не кладёт.
  const resolved = screen
    .getAllByTestId('entity-chip')
    .filter((el) => /^Т\d+$/.test(el.textContent ?? ''));
  expect(resolved).toHaveLength(ids.length);
});

test('пока резолв едет — на экране вмороженная подпись, а не пустое место', async () => {
  // Иначе чип мигал бы пустотой при каждом открытии записи.
  let release: (rows: Row[]) => void = () => {};
  const pending = new Promise<Row[]>((res) => {
    release = res;
  });
  renderWithProviders(
    <BodyEditor doc={parseBody(`См. [[entity:${A}|Старое имя]].`)} onChange={vi.fn()} />,
    (path) => (path === 'entity.resolveRefs' ? pending : {}),
  );
  const chip = await screen.findByTestId('entity-chip');
  expect(chip.textContent).toContain('Старое имя');

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: подпись именно ВРЕМЕННАЯ. Без него ассерт выше
  // зелен и у чипа, который заголовок показывать не умеет вовсе.
  release([row(A, { title: 'Новое имя' })]);
  await waitFor(() => expect(screen.getByTestId('entity-chip').textContent).toContain('Новое имя'));
});

test('неизвестный id не роняет редактор: чип на месте, серый, и в редактор можно набирать', async () => {
  const onChange = vi.fn();
  const h = held();
  renderWithProviders(
    <BodyEditor
      doc={parseBody(`См. [[entity:${A}]] тут`)}
      onChange={onChange}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    refs([]), // сущность не найдена (в т.ч. чужая под RLS) — её просто нет в ответе
  );
  const chip = await screen.findByTestId('entity-chip');
  await new Promise((res) => setTimeout(res, 50));
  expect(chip.className).toContain('text-text-muted');
  expect(chip.className).not.toContain('line-through');
  // Вместо заголовка — обрубок id: пустой чип был бы невидим и неотличим от пропажи ссылки.
  expect(chip.textContent).toContain(A.slice(0, 8));

  // Положительный контроль: редактор ЖИВ, а не тихо мёртв рядом с нерезолвнутым чипом.
  await waitFor(() => expect(h.editor).not.toBeNull());
  const area = screen.getByTestId('body-editor').querySelector('[contenteditable]');
  h.editor?.commands.focus('end');
  await userEvent.type(area as HTMLElement, ' хвост');
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('хвост');
});

test('закрытая задача — зачёркнутый чип, открытая — нет', async () => {
  // Два документа рядом: второй чип — контроль в том же тесте, иначе `line-through` мог бы
  // стоять на КАЖДОМ чипе, и тест этого не заметил бы.
  renderWithProviders(
    <>
      <BodyEditor doc={parseBody(`[[entity:${A}]]`)} onChange={vi.fn()} />
      <BodyEditor doc={parseBody(`[[entity:${B}]]`)} onChange={vi.fn()} />
    </>,
    refs([
      row(A, { title: 'Сделано', status: 'done' }),
      row(B, { title: 'В работе', status: 'in_progress' }),
    ]),
  );
  await waitFor(() => expect(screen.getAllByTestId('entity-chip')).toHaveLength(2));
  const [closed, open] = screen.getAllByTestId('entity-chip');
  await waitFor(() => expect(closed?.textContent).toContain('Сделано'));
  await waitFor(() => expect(open?.textContent).toContain('В работе'));
  expect(closed?.className).toContain('line-through');
  expect(open?.className).not.toContain('line-through');
});

test('клик по чипу открывает сущность, Ctrl-клик — нет', async () => {
  renderWithProviders(
    <BodyEditor doc={parseBody(`См. [[entity:${A}|имя]].`)} onChange={vi.fn()} />,
    refs([row(A)]),
  );
  const chip = await screen.findByTestId('entity-chip');
  // href настоящий — иначе перехватывать было бы нечего, и «новая вкладка» открывала бы пустоту.
  expect(chip.getAttribute('href')).toBe(`/entity/${A}`);

  // Слушатель на body: он висит ПОСЛЕ корневого слушателя React (корень RTL — div внутри
  // body), поэтому успевает прочитать defaultPrevented и лишь затем гасит сам переход.
  // Без гашения непойманный клик по настоящему href уводит документ, и прогон печатает
  // «Not implemented: navigation» — шум, за которым потом не разглядеть настоящую улику.
  const seen: boolean[] = [];
  const swallow = (e: Event) => {
    seen.push(e.defaultPrevented);
    e.preventDefault();
  };
  document.body.addEventListener('click', swallow);
  try {
    // Штатные жесты браузера не перехватываем (то же правило, что в Markdown.tsx:62).
    // ОБА модификатора «новой вкладки»: на маке живёт metaKey, и страж, покрывающий один
    // ctrlKey, был бы сломан ровно там, где этим жестом пользуются (найдено ревью).
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(seen).toEqual([false, false]);
    expect(useNav.getState().stacks.browser).toEqual([]);

    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(seen).toEqual([false, false, true]); // обычный клик перехвачен нами
    expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: A }]);
  } finally {
    document.body.removeEventListener('click', swallow);
  }
});

test('смена цели чипа считается правкой и доезжает до onChange', async () => {
  // Долг Задачи 7: canonicalDoc снимает `id` при сравнении документов. Цель чипа живёт в
  // ОТДЕЛЬНОМ атрибуте (entityId), и правка, которая меняет только её, обязана дойти до
  // сохранения — иначе перенаведённая ссылка молча не сохранилась бы.
  const onChange = vi.fn();
  const h = held();
  renderWithProviders(
    <BodyEditor
      doc={parseBody(`См. [[entity:${A}|имя]].`)}
      onChange={onChange}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    refs([row(A)]),
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  await new Promise((res) => setTimeout(res, 50)); // UniqueID отработал — и промолчал
  expect(onChange).not.toHaveBeenCalled();

  h.editor?.commands.setContent(parseBody(`См. [[entity:${B}|имя]].`).doc);
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain(B);
});
