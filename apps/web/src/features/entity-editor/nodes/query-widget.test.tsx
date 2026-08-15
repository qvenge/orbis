import { DAILY_PLANNING_BODY } from '@orbis/server/src/seed/smart-lists';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS } from '@orbis/shared';
import { parseBody, serializeBody } from '@orbis/shared/doc';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../../test/harness';
import { Toaster } from '../../../ui/Toast';
import { BodyEditor } from '../BodyEditor';
import { EditorShell, isBodyGesture } from '../EditorShell';

/**
 * Подмена редактора блока для ОДНОГО теста — рубежа `}}`. Сегодня этот рубеж недостижим
 * через интерфейс: строковый редактор гасит «Сохранить» на `}}`, а форма вовсе не печатает
 * такой AST (serializeQuery бросает, printQuery отдаёт text=null и блокирует запись). Он и
 * есть ВТОРОЙ барьер — тот же, что стоял в replaceQueryBlock, и по той же причине: тихая
 * запись испорченного блока хуже отказа. Проверить второй барьер, не убрав первый, нельзя,
 * поэтому здесь на время подменяется собеседник виджета, а не ослабляется ассерт.
 */
const hijack = vi.hoisted(() => ({ query: null as string | null }));
vi.mock('../../query-builder/QueryBlockEditor', async (orig) => {
  const actual = await orig<typeof import('../../query-builder/QueryBlockEditor')>();
  return {
    QueryBlockEditor: (props: {
      initial: string;
      onSave: (query: string) => void;
      onCancel: () => void;
    }) =>
      hijack.query === null ? (
        <actual.QueryBlockEditor {...props} />
      ) : (
        <button
          type="button"
          data-testid="hijack-save"
          onClick={() => props.onSave(hijack.query ?? '')}
        >
          сохранить в обход
        </button>
      ),
  };
});

// Реестр аспектов — настоящий (как в editor.test.tsx и query-builder.test.tsx): с пустым
// каталогом ЛЮБОЙ блок падал бы плашкой qb-error, и «виджет живой» проходило бы по ложной
// причине.
const realAspects = BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) }));

/**
 * СТРОГИЙ мок: `entity.query` отвечает только про ТОТ ЗАПРОС, о котором спросили. Мок,
 * отдающий один и тот же список на что угодно, делал бы виджет со СТАРЫМ атрибутом
 * неотличимым от виджета с новым — правка «сохранилась» бы на экране и без правки атрибута.
 */
const lists =
  (byQuery: Record<string, { id: string; title: string }[]>) =>
  (path: string, input: unknown): unknown => {
    if (path === 'aspect.list') return realAspects;
    if (path === 'entity.query') return byQuery[(input as { query: string }).query] ?? [];
    return {};
  };

/** Обёртка блока — одним местом: ключи мока и текст документа обязаны совпадать дословно. */
const block = (inner: string) => `{{query:${inner}}}`;

// Держатель редактора: после присваивания в колбэке TS сузил бы `let` до null.
type Held = { editor: Editor | null };
const held = (): Held => ({ editor: null });

/** Открывает редактор N-го блока кнопкой «Настроить» на его виджете. */
async function openBlockEditor(index = 0): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('qb-configure').length).toBeGreaterThan(index));
  const button = screen.getAllByTestId('qb-configure')[index];
  if (button === undefined) throw new Error(`нет виджета №${index}`);
  fireEvent.click(button);
  return await screen.findByRole('dialog');
}

beforeEach(() => {
  hijack.query = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Виджет живёт NodeView'ом, а его модалка — в портале: крах в обработчике не роняет тест, а
// только код возврата прогона. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// --- виджет вместо текста ----------------------------------------------------------------

test('документ с {{query:…}} рисует ЖИВОЙ виджет, а не текст', async () => {
  // Обёртка с КОЛОНКИ 1 — блок; та же обёртка посреди строки прозы — текст (правило колонки,
  // Задача 2). Оба входа в одном документе: проверка идёт по ФОРМЕ документа и по наличию
  // виджета, а не по строке проекции — у абзаца с литералом проекция ровно та же самая, и
  // `toContain('{{query:…}}')` был бы зелен и при схлопывании блока в текст (Задача 7).
  const inner = ' aspect=orbis/task, status=inbox';
  const md = `${block(inner)}\n\nсм. ${block(' tags=x')} в строке`;
  const h = held();
  renderWithProviders(
    <BodyEditor
      doc={parseBody(md)}
      onChange={vi.fn()}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    lists({ [inner]: [{ id: 'a', title: 'Разобрать почту' }] }),
  );
  await waitFor(() => expect(h.editor).not.toBeNull());
  expect(h.editor?.getJSON().content?.map((n) => n.type)).toEqual(['queryBlock', 'paragraph']);

  // ЖИВОЙ значит «список приехал с сервера»: строка `qb-item` рисуется только ответом
  // entity.query, а строгий мок отвечает лишь на этот самый запрос.
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Разобрать почту');
  expect(screen.queryByTestId('qb-error')).toBeNull();
  // Литерал посреди строки виджетом не стал — виджет в документе ровно один.
  expect(screen.getAllByTestId('qb-count')).toHaveLength(1);
});

test('«Настроить» открывает редактор блока с ДОСЛОВНЫМ текстом запроса', async () => {
  // Атрибут ноды хранит внутренность обёртки как есть — с переносами и девятипробельными
  // отступами: тримленный текст в редакторе схлопнул бы сидированный блок при первом же
  // сохранении. Блок намеренно НЕразбираемый (`status=` без значения): у валидного
  // «Настроить» открывает форму, и текста запроса на экране не было бы вовсе.
  const inner = '\n  status=, tags=work,\n         limit=5\n';
  renderWithProviders(<BodyEditor doc={parseBody(block(inner))} onChange={vi.fn()} />, lists({}));
  const dialog = await openBlockEditor();
  expect(within(dialog).getByTestId('query-text-edit')).toHaveValue(inner);
});

// --- правка блока = правка атрибута ноды --------------------------------------------------

test('сохранение блока — правка АТРИБУТА ноды, а не подстроки по номеру', async () => {
  // Вместе с номером блока ушла и его оптимистичная блокировка («Блок изменился в другом
  // месте»): адресом стала сама нода, и адресовать нечего.
  const onChange = vi.fn();
  const h = held();
  const r = renderWithProviders(
    <BodyEditor
      doc={parseBody(block(' status=, tags=work'))}
      onChange={onChange}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    lists({ 'tags=home': [{ id: 'h', title: 'Дома' }] }),
  );
  const dialog = await openBlockEditor();
  fireEvent.change(within(dialog).getByTestId('query-text-edit'), {
    target: { value: 'tags=home' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));

  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const next = onChange.mock.calls.at(-1)?.[0] as { doc: { content?: { type: string }[] } };
  // Документ остался документом: блок не рассыпался в абзац с фигурными скобками.
  expect(next.doc.content?.map((n) => n.type)).toEqual(['queryBlock']);
  expect(serializeBody(next)).toContain('{{query:tags=home}}');
  expect(serializeBody(next)).not.toContain('tags=work');
  // И виджет живёт НОВЫМ атрибутом, а не своей застывшей копией: спрошен ровно новый запрос
  // (старый до сети не доходил вовсе — он не разбирается, и `enabled` у него false).
  // Проверка по самим вызовам, а не только по строке на экране: строгий мок отвечает лишь про
  // спрошенное, но при валидном СТАРОМ запросе «на экране появилось „Дома“» было бы правдой и
  // у виджета, который спрашивает старое, — щедрый мок сделал бы эти два случая неотличимыми.
  expect(await screen.findByTestId('qb-item')).toHaveTextContent('Дома');
  expect(
    r.calls
      .filter((c) => c.path === 'entity.query')
      .map((c) => (c.input as { query: string }).query),
  ).toEqual(['tags=home']);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('многострочный блок остаётся многострочным после правки соседнего абзаца', async () => {
  // Сиды хранят запрос с переносами и девятипробельными отступами, и сверяются байт-в-байт
  // отдельным тестом на сервере: схлопни редактор блок при правке соседнего текста — сид
  // переписался бы одной строкой от одного нажатия клавиши.
  const onChange = vi.fn();
  const h = held();
  renderWithProviders(
    <BodyEditor
      doc={parseBody(DAILY_PLANNING_BODY)}
      onChange={onChange}
      onReady={(e) => {
        h.editor = e;
      }}
    />,
    lists({}),
  );
  const area = (await screen.findByTestId('body-editor')).querySelector('[contenteditable]');
  await waitFor(() => expect(h.editor).not.toBeNull());
  // Все три блока сида — ЖИВЫЕ виджеты: без этого ассерта тест зелен и у редактора вовсе без
  // NodeView (переносы в атрибуте хранит схема, Задача 2, и они пережили бы что угодно).
  await waitFor(() => expect(screen.getAllByTestId('qb-count')).toHaveLength(3));
  h.editor?.commands.focus('start');
  // Набор адресован САМОМУ АБЗАЦУ, а не коробке редактора: клик по коробке jsdom разрешает
  // по геометрии, которой нет, и каретка однажды уложилась gap-курсором после блока
  // (тот же довод, что в editor.test.tsx).
  const firstParagraph = (area as HTMLElement).querySelector('p');
  await userEvent.type(firstParagraph as HTMLElement, '!');
  await waitFor(() => expect(onChange).toHaveBeenCalled());

  const out = serializeBody(onChange.mock.calls.at(-1)?.[0]);
  const blocks = DAILY_PLANNING_BODY.match(/\{\{query:[\s\S]*?\}\}/g) ?? [];
  expect(blocks).toHaveLength(3); // страж вакуумности: сверять действительно есть что
  for (const b of blocks) expect(out).toContain(b);
  // Правка ДОЕХАЛА — иначе «блоки целы» было бы правдой и у мёртвого редактора.
  expect(out).toContain('!');
  // И тело целиком байт-в-байт, а не только блоки: снятый набранный символ обязан вернуть
  // ровно исходный сид — вместе с пустыми строками между блоками и отступами внутри них.
  expect(out.replace('!', '')).toBe(DAILY_PLANNING_BODY);
});

// --- рубеж `}}` ---------------------------------------------------------------------------

test('запрос с `}}` не сохраняется: это конец ОБЁРТКИ, а не текст запроса', async () => {
  // `}}` — не ошибка грамматики (парсер `tags=a}}b` принимает молча), а конец обёртки:
  // блок закрылся бы на первом вхождении, хвост запроса уехал бы текстом заметки, а
  // `{{query:` в этом хвосте завёл бы ЛИШНИЙ блок.
  hijack.query = 'tags=a}}b';
  const onChange = vi.fn();
  const h = held();
  renderWithProviders(
    <>
      <BodyEditor
        doc={parseBody(block(' tags=work'))}
        onChange={onChange}
        onReady={(e) => {
          h.editor = e;
        }}
      />
      <Toaster />
    </>,
    lists({}),
  );
  await waitFor(() => expect(screen.getAllByTestId('qb-configure')).toHaveLength(1));
  fireEvent.click(screen.getByTestId('qb-configure'));
  fireEvent.click(await screen.findByTestId('hijack-save'));

  // Отказ ГРОМКИЙ: молча проглоченная правка — та же потеря, только без следа. Ожидание
  // тоста здесь заодно и прогрев перед отрицательным ассертом: к этому моменту сохранение
  // уже успело бы дойти до onChange, если бы дошло.
  await screen.findByText(/нельзя использовать/);
  await new Promise((r) => setTimeout(r, 50));
  expect(onChange).not.toHaveBeenCalled();
  expect(JSON.stringify(h.editor?.getJSON())).not.toContain('a}}b');
  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: этим же путём запрос БЕЗ `}}` сохраняется —
  // иначе ассерт выше зелен и у виджета, который не сохраняет вовсе.
  hijack.query = 'tags=home';
  fireEvent.click(screen.getByTestId('hijack-save'));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(serializeBody(onChange.mock.calls.at(-1)?.[0])).toContain('{{query:tags=home}}');
});

// --- модалка в портале --------------------------------------------------------------------

test('клик внутри модалки блока не уходит в редактор', async () => {
  // Долг Задачи 7 (DetailScreen.tsx:390-396). Замерено пробой, а не выведено рассуждением:
  //  1) клик по шапке модалки ДОХОДИТ до onClick предка редактора — Radix рисует её в
  //     портале, но React-события из портала всплывают по дереву REACT;
  //  2) в DOM шапка лежит ВНЕ поддерева виджета, и прежний список стража
  //     (`[data-query-widget]` и прочее) её пропускал: «СТРАЖ ПРОПУСТИЛ».
  //
  // Проверяется ПРОИЗВОДСТВЕННЫЙ список (isBodyGesture из EditorShell), а не его копия в
  // тесте: копия проходила бы и при развалившемся стороже. Дерево — не сам EditorShell,
  // потому что у него сегодня подмены не случилось бы по совпадению: к моменту, когда
  // модалку есть откуда открыть, обработчик уже снят вместе с первым кадром (замерено той
  // же пробой). Тест держит рубеж, а не совпадение.
  const verdicts: boolean[] = [];
  const last = () => verdicts.at(-1);
  renderWithProviders(
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: тот же жест мыши поверх текста, что в EditorShell
    <div
      data-testid="body-host"
      onClick={(e) => verdicts.push(isBodyGesture(e.target as HTMLElement))}
    >
      <BodyEditor doc={parseBody(block(' tags=work'))} onChange={vi.fn()} />
    </div>,
    lists({}),
  );

  // Счётчик в шапке виджета — ни ссылка, ни кнопка, ни поле: от подмены тела редактором его
  // спасает ТОЛЬКО признак `data-query-widget` на обёртке NodeView.
  fireEvent.click(await screen.findByTestId('qb-count'));
  expect(last()).toBe(false);

  const dialog = await openBlockEditor();
  fireEvent.click(within(dialog).getByRole('heading'));
  expect(last()).toBe(false);
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: клик по самому телу редактор ЗОВЁТ — иначе ассерты
  // выше зелены и у стража, который не пускает никого и никогда.
  fireEvent.click(screen.getByTestId('body-host'));
  expect(last()).toBe(true);
});

test('модалка блока не подменяет собой первый кадр EditorShell', async () => {
  // Сквозная проверка того же на настоящем экране: редактор встал по клику, модалка блока
  // открылась поверх него и клик внутри неё ничего не сломал и ничего не записал.
  const onChange = vi.fn();
  const md = block(' tags=work');
  vi.stubGlobal('requestIdleCallback', () => 1); // редактор встаёт только по клику
  renderWithProviders(
    <EditorShell doc={parseBody(md)} markdown={md} onChange={onChange} />,
    lists({}),
  );
  fireEvent.click(await screen.findByTestId('editor-preview'));
  await screen.findByTestId('body-editor');

  const dialog = await openBlockEditor();
  fireEvent.click(within(dialog).getByRole('heading'));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByTestId('body-editor')).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
