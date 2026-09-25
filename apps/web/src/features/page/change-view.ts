// Листовой сабпат, не баррель `@orbis/shared/doc`: модуль живёт в ленивом чанке меню ⋮, но
// листовой разбор и дешевле, и ровно тот, которым рендерер рисует результат.
import { type PageNode, parsePageText, type RecordBlockName } from '@orbis/shared/doc/page-grammar';
import { hasRenderedCards } from './render-plan';

/**
 * «Изменить вид только этой записи» — чистая часть (спека страниц 1а §8.4, Р-19).
 *
 * Текст шаблона, которым запись показана сейчас (своего или хоста), копируется в её тело, и запись
 * становится страницей. Судьба собственного текста записи — по трём случаям; молча не дописывается
 * и не убирается ничего (С1а-8):
 *  1. текста нет — только копия шаблона, БЕЗ строки `{{body}}`: на странице этот блок не работает и
 *     встал бы плашкой (§5.5; РП-29, Э-13);
 *  2. текст есть и шаблон показывает тело — текст встаёт на место `{{body}}`, остальное дословно;
 *  3. текст есть, а шаблон тело не показывает (намеренно) — «как раньше» и сохранность текста разом
 *     невозможны, решает владелец: убрать в закреплённую версию или показать внизу страницы.
 *     Тот же вопрос — когда тело показывается, но текст записи несёт блоки страницы
 *     (`{{/tab}}`, `{{tab: X}}` — вставкой или агентом) и на месте `{{body}}` сломал бы контейнер
 *     шаблона: вкладки ушли бы под плашку вместе с карточками, версиями и тредом. Молча применять
 *     такой случай 2 нельзя (С1а-8); `reason` говорит диалогу, какой из двух вопросов задать.
 *
 * Во всех трёх исходах копия несёт рисуемый `{{cards}}`: через шаблон запись показывала карточки
 * своих аспектов, не размещённые шаблоном, — гарантия хоста §8.3 дописывала их в конец любого
 * шаблона. Страница своим телом такой гарантии не имеет (дописывание — только шаблонам), и копия
 * шаблона владельца без `{{cards}}` потеряла бы их с экрана (финальное ревью, C1-I1).
 */
export type ChangeViewPlan =
  | { case: 1; body: string } // текста нет → копия шаблона
  | { case: 2; body: string } // текст на место {{body}}
  | {
      case: 3;
      reason: ChangeViewQuestion;
      hideAsVersion: string;
      showBelow: string;
    }; // текст есть, {{body}} нет (или текст сломал бы шаблон) → выбор владельца

/** Почему вопрос: шаблон тело не показывает — или текст записи на месте `{{body}}` сломал бы шаблон. */
export type ChangeViewQuestion = 'no-body' | 'breaks-template';

/** Подпись закреплённой версии, в которую уходит текст в случае 3 (§8.4, дословно). */
export const TEXT_BEFORE_VIEW_CHANGE = 'Текст до изменения вида';

/** Где в тексте шаблона стоит показываемый `{{body}}` и кто его соседи в той же части. */
interface BodySlot {
  start: number;
  end: number;
  before: PageNode | undefined;
  after: PageNode | undefined;
}

const lengthOf = (n: PageNode): number => (n.kind === 'text' ? n.text : n.raw).length;

/** Конец строки, начатой в `pos`, — вместе с её переносом. */
function lineEnd(src: string, pos: number): number {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.length : nl + 1;
}

/** Пропустить пустые строки с `pos`: препроход кладёт их между частями контейнера, не в дерево. */
function skipBlankLines(src: string, pos: number): number {
  let at = pos;
  while (at < src.length) {
    const end = lineEnd(src, at);
    if (src.slice(at, end).trim() !== '') break;
    at = end;
  }
  return at;
}

/**
 * Первый рисуемый `{{body}}` списка узлов, лежащего в исходнике с позиции `base`.
 *
 * Адрес считается по дереву препрохода, а не поиском строки: `{{body}}` в заборе кода — текст, в
 * сломанном контейнере — не рисуется, и поиск строки заменил бы не тот. Склейка `text`/`raw` узлов
 * одного списка воспроизводит их кусок исходника байт-в-байт (инвариант `parsePageText`), так что
 * адрес узла — сумма длин соседей слева. Внутри контейнера между частями стоят строки маркеров и
 * пустые строки, которых в дереве нет, — их проходит `slotInContainer`.
 */
function slotIn(src: string, nodes: readonly PageNode[], base: number): BodySlot | null {
  let pos = base;
  for (const [i, node] of nodes.entries()) {
    if (node.kind === 'record' && node.name === 'body') {
      return { start: pos, end: pos + node.raw.length, before: nodes[i - 1], after: nodes[i + 1] };
    }
    if (node.kind === 'columns' || node.kind === 'tabs') {
      const inner = slotInContainer(src, node, pos);
      if (inner !== null) return inner;
    }
    pos += lengthOf(node);
  }
  return null;
}

/**
 * Разобранный контейнер в исходнике: строка открытия; на каждую часть — пустые строки, строка
 * открытия части, её узлы, строка закрытия части; пустые строки и строка закрытия контейнера.
 * Маркер — всегда ровно одна целая строка (РП-6), поэтому шаги — по строкам.
 */
function slotInContainer(
  src: string,
  node: Extract<PageNode, { kind: 'columns' | 'tabs' }>,
  base: number,
): BodySlot | null {
  const parts = node.kind === 'columns' ? node.parts : node.parts.map((t) => t.children);
  let pos = lineEnd(src, base);
  for (const part of parts) {
    pos = lineEnd(src, skipBlankLines(src, pos));
    const inner = slotIn(src, part, pos);
    if (inner !== null) return inner;
    pos = lineEnd(src, pos + part.reduce((sum, n) => sum + lengthOf(n), 0));
  }
  return null;
}

/**
 * Показываемый `{{body}}` шаблона; сверка вырезанного куска — страховка от адреса, съехавшего с
 * узла. Сверяет её тот же препроход, а не сравнение со строкой `{{body}}`: литерал маркера здесь был
 * бы второй копией правил (сторож `scripts/grammar-copies.test.ts`) и разошёлся бы с ней на первой
 * же допустимой вариации строки — хвостовых пробелах или `\r\n`.
 */
function bodySlot(template: string): BodySlot | null {
  const slot = slotIn(template, parsePageText(template), 0);
  if (slot === null) return null;
  const cut = parsePageText(template.slice(slot.start, slot.end)).filter(
    (n) => !(n.kind === 'text' && n.text.trim() === ''),
  );
  const [only] = cut;
  if (cut.length !== 1 || only?.kind !== 'record' || only.name !== 'body') {
    throw new Error('адрес {{body}} в шаблоне съехал с узла — замена испортила бы шаблон');
  }
  return slot;
}

const isText = (n: PageNode | undefined): n is Extract<PageNode, { kind: 'text' }> =>
  n?.kind === 'text' && n.text.trim() !== '';
/** Кусок текста уже кончается пустой строкой — отделять его от следующего не нужно. */
const endsWithBlankLine = (text: string) => /\n[ \t]*\r?\n[ \t]*$/.test(text);
/** Кусок текста уже начинается с пустой строки. */
const startsWithBlankLine = (text: string) => /^[ \t]*\r?\n/.test(text);

/**
 * Через шаблон текст вокруг `{{body}}` — отдельные куски, каждый рисуется своей разметкой. В одном
 * теле страницы они стали бы одним куском, и markdown склеил бы соседние строки в один абзац (или
 * продолжил бы список), то есть дал бы другой вид. Пустая строка на стыке держит куски врозь.
 */
const needsGapBefore = (slot: BodySlot) =>
  isText(slot.before) && !endsWithBlankLine(slot.before.text);
const needsGapAfter = (slot: BodySlot) =>
  isText(slot.after) && !startsWithBlankLine(slot.after.text);

/** Сломанные контейнеры верхнего уровня (`broken` бывает только там — `parsePageText`). */
const brokenCount = (text: string): number =>
  parsePageText(text).filter((n) => n.kind === 'broken').length;

const CARDS: RecordBlockName = 'cards';
/** Строка блока «все карточки» — печатью маркера по имени, а не литералом (одна копия правил). */
const CARDS_LINE = `{{${CARDS}}}\n`;

/**
 * Копия шаблона `base` с рисуемым `{{cards}}` — дописанным в её конец, до хвоста `rest`, который
 * встанет за копией (текст записи в «Показать внизу страницы»). Рисуемый ли — то же правило, что у
 * рендерера (`hasRenderedCards`): блок в заборе кода, в неуместном или сломанном месте не в счёт.
 * Смотрится весь результат, а не одна копия: `{{cards}}`, пришедший с текстом записи, на странице
 * тоже рисуется, и второй дал бы карточки дважды.
 */
function withCards(base: string, rest = ''): string {
  if (hasRenderedCards(parsePageText(base + rest), 'page')) return base;
  const gap = base === '' || base.endsWith('\n') ? '' : '\n';
  return `${base}${gap}${CARDS_LINE}`;
}

/** Вопрос владельцу над копией шаблона `base` (без строки `{{body}}`, если она была). */
function question(reason: ChangeViewQuestion, base: string, recordBody: string): ChangeViewPlan {
  const below = `\n\n${recordBody}`;
  return {
    case: 3,
    reason,
    hideAsVersion: withCards(base),
    showBelow: `${withCards(base, below).replace(/(?:\r?\n)+$/, '')}${below}`,
  };
}

export function changeViewPlan(templateText: string, recordBody: string): ChangeViewPlan {
  const slot = bodySlot(templateText);
  const head = slot === null ? templateText : templateText.slice(0, slot.start);
  const tail = slot === null ? '' : templateText.slice(slot.end);
  // Копия шаблона без строки `{{body}}` — на странице этот блок был бы плашкой (РП-29).
  const copy =
    slot === null
      ? templateText
      : head + (needsGapBefore(slot) && needsGapAfter(slot) ? '\n' : '') + tail;

  if (recordBody.trim() === '') return { case: 1, body: withCards(copy) };

  if (slot !== null) {
    // Строка `{{body}}` забирала свой перенос; без него текст слипся бы со строкой ниже — а она
    // бывает маркером (`{{/tab}}`), который после склейки перестал бы им быть.
    const ownLine = templateText.slice(slot.start, slot.end).endsWith('\n');
    const text = ownLine && !recordBody.endsWith('\n') ? `${recordBody}\n` : recordBody;
    const before = needsGapBefore(slot) ? '\n' : '';
    const after = needsGapAfter(slot) ? '\n' : '';
    const body = head + before + text + after + tail;
    // Текст записи со строками разметки страницы сломал бы контейнер шаблона вокруг `{{body}}` —
    // это уже не «как раньше», и решает владелец (докблок `ChangeViewPlan`).
    if (brokenCount(body) > brokenCount(templateText)) {
      return question('breaks-template', copy, recordBody);
    }
    return { case: 2, body: withCards(body) };
  }

  return question('no-body', templateText, recordBody);
}
