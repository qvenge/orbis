import { getSchema, type JSONContent } from '@tiptap/core';
import { OrbisMarkdownManager } from './manager';
import { withCodeFences } from './nodes/code';
import { BODY_REF_RE } from './nodes/entity-ref';
import { DOC_EXTENSIONS } from './schema';
import { type BodyDoc, DOC_SCHEMA_VERSION } from './types';

// Менеджер тяжёлый в конструировании и не хранит состояния между вызовами — создаётся один раз.
// Проверено спайком: работает на Bun без DOM.
let manager: OrbisMarkdownManager | null = null;
function md(): OrbisMarkdownManager {
  manager ??= new OrbisMarkdownManager({ extensions: DOC_EXTENSIONS });
  return manager;
}

// Схема ProseMirror строится из тех же DOC_EXTENSIONS и тоже ОДИН РАЗ: построение стоит ~2.5 мс,
// сама проверка — единицы микросекунд (замерено), так что на горячем пути ощутима только сборка.
let schema: ReturnType<typeof getSchema> | null = null;
function pmSchema(): ReturnType<typeof getSchema> {
  schema ??= getSchema(DOC_EXTENSIONS);
  return schema;
}

function docOf(input: BodyDoc | JSONContent): JSONContent {
  return 'doc' in input && 'v' in input ? (input as BodyDoc).doc : (input as JSONContent);
}

/**
 * `withCodeFences` — не украшение: обёртку кодовой вставки менеджер спрашивает у марки ПОДСТАВНЫМ
 * содержимым и своего текста рисовальщику не показывает, поэтому длина разделителя считается
 * заранее и передаётся служебным атрибутом (см. nodes/code.ts). Вход не мутируется: копируются
 * только узлы по пути к таким маркам, а в БД едет исходный объект.
 */
export function serializeBody(input: BodyDoc | JSONContent): string {
  return md().serialize(withCodeFences(docOf(input)));
}

/**
 * «Непонятое» определяется НЕ сравнением строк, а по токенам marked (вердикт Б1, мера 3):
 * блочный или инлайн-токен, для которого в схеме нет обработчика, уводит В RAW ТОЛЬКО СВОЙ
 * БЛОК. Сравнение строк на этой роли проверяло каноничность, выдавая себя за проверку
 * целостности, — и валило в raw 47% живых тел (ревью Б1).
 */
const KNOWN_BLOCK = new Set([
  'paragraph',
  'heading',
  'list',
  // Свои токены: лексер менеджера отдаёт их наравне со штатными, и не будь их здесь, каждый
  // смарт-лист и каждая запись со ссылкой уезжали бы в raw.
  'queryBlock',
  // list_item — обязателен: элементы списка лежат в items и несут собственные tokens, и без
  // него КАЖДЫЙ список уходил в raw целиком (проверено пробой).
  'list_item',
  // Чеклист у лексера менеджера — СВОИ типы (их даёт markdown-спека @tiptap/extension-list),
  // а не list/list_item с токеном checkbox, как у голого marked. Без них чеклист уезжал в raw,
  // и приёмка «канон равен входу» это не ловила: raw отдаёт вход дословно.
  'taskList',
  'taskItem',
  'blockquote',
  'code',
  'table',
  'hr',
  'space',
  'text',
]);
const KNOWN_INLINE = new Set([
  'text',
  'em',
  'strong',
  'del',
  'codespan',
  'link',
  'br',
  'escape',
  'entityRef', // свой инлайн-токен, см. queryBlock выше
]);

type Cell = { tokens?: Tok[] };
type Tok = {
  type: string;
  raw: string;
  tokens?: Tok[];
  items?: Tok[];
  /** Вложенные блоки ПУНКТА ЧЕКЛИСТА — четвёртый контейнер, свой у `@tiptap/extension-list`.
   *  Не поле marked: у обычного `list_item` вложенное лежит в `tokens`. */
  nestedTokens?: Tok[];
  header?: Cell[];
  rows?: Cell[][];
};

/**
 * Сколько ячеек в строке таблицы GFM. Считается по СЫРОЙ строке, а не по токену: marked
 * обрезает `rows` до ширины шапки ещё в лексере (замерено — у строки `| один | ПОТЕРЯННЫЙ |`
 * под шапкой в одну колонку `rows[0].length === 1`), так что лишние ячейки в токене уже не
 * видны.
 *
 * Экранированная черта РАЗДЕЛИТЕЛЕМ здесь не считается — и это не упущение, а следствие: любая
 * таблица, где в ячейке есть `\|`, уже уходит в raw правилом выше (сериализатор таблицы черту
 * обратно не экранирует). Мутационная проверка это подтвердила: разбор экранирования в этом
 * счётчике не меняет исхода НИ НА ОДНОМ входе, потому что оба правила ведут в одно место.
 * Если правило про `\|` когда-нибудь снимут — сюда придётся вернуть разбор экранирования.
 */
function cellCount(line: string): number {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').length;
}

/**
 * Есть ли в таблице строка ШИРЕ шапки. Такая строка — тихая потеря авторского текста: GFM
 * обрезает лишние ячейки по ширине шапки, и слово исчезает НАВСЕГДА уже на первом разборе
 * (`| a |\n| --- |\n| один | ПОТЕРЯННЫЙ |` → канон `| a |\n| --- |\n| один |`). Оба стоп-крана
 * аудита на этом молчат по построению: они начинают отсчёт ПОСЛЕ первого разбора, а теряется
 * здесь именно на нём (ре-ревью раунда 3, замер подтверждён).
 *
 * Строка УЖЕ шапки сюда не входит намеренно — проверено пробой: недостающие ячейки дополняются
 * пустыми, ни один символ не теряется (`| 1 |` под шапкой в две колонки → `| 1 |  |`).
 * Уводить такие таблицы в raw значило бы ловить лишнее.
 */
function hasOverwideRow(token: Tok): boolean {
  const width = token.header?.length ?? 0;
  if (width === 0) return false;
  const lines = token.raw.split('\n').filter((l) => l.trim() !== '');
  // Первые две строки — шапка и разделитель; данные начинаются с третьей.
  return lines.slice(2).some((line) => cellCount(line) > width);
}

function blockIsKnown(token: Tok): boolean {
  if (!KNOWN_BLOCK.has(token.type)) return false;
  if (token.type === 'table' && hasOverwideRow(token)) return false;
  const walk = (toks: Tok[] | undefined): boolean =>
    (toks ?? []).every((t) => {
      // ВЛОЖЕННАЯ таблица проверяется теми же правилами, что и таблица верхнего уровня
      // (ре-ревью раунда 4). Без этой строки внутрь цитаты и пункта списка проходили ВСЕ ТРИ
      // правила сразу: рваная строка молча съедала слово, картинка в ячейке — адрес (а это
      // регресс уже сделанной починки, см. ниже), и лишь экранированная черта ловилась —
      // по совпадению, а не по устройству. Замерено на четырёх телах.
      if (t.type === 'table') return blockIsKnown(t);
      // Ссылка с ПУСТЫМ текстом уничтожает адрес: он живёт атрибутом, узел без текста
      // выбрасывается целиком (`[](url)` → канон ""), и ни один счётчик этого не видел.
      // Пустой текст — это именно `tokens: []`; `[ ](url)` сохраняет узел с пробелом и цел.
      if (t.type === 'link' && (t.tokens ?? []).length === 0) return false;
      // `nestedTokens` — вложенные блоки пункта ЧЕКЛИСТА, четвёртый контейнер сверх
      // tokens/items/ячеек. Без него абзац внутри `- [ ]` не осматривался: замерено, что
      // `- [ ] пункт\n\n  [](url)` терял адрес, а html-блок экранировался вместо ухода в raw,
      // — при том что тот же пункт нумерованного списка обходился правильно.
      if (t.nestedTokens && !walk(t.nestedTokens)) return false;
      if (t.items) return walk(t.items); // list → items → вложенные блоки
      if (t.tokens) return (KNOWN_BLOCK.has(t.type) || KNOWN_INLINE.has(t.type)) && walk(t.tokens);
      return KNOWN_INLINE.has(t.type) || KNOWN_BLOCK.has(t.type);
    });
  // Ячейки таблицы GFM лежат не в tokens/items, а в header/rows. Без их обхода таблица всегда
  // считалась «понятой», и картинка в ячейке молча пропадала при сериализации (проверено).
  const cells = [...(token.header ?? []), ...(token.rows ?? []).flat()];
  const cellIsKnown = (cell: Cell): boolean =>
    // Черта внутри ячейки — граница столбца, и обратно её сериализатор таблицы не экранирует:
    // `x \| y` при повторном разборе разваливается на две ячейки. Это единственное найденное
    // нарушение инварианта канона, и лечится оно так же, как картинка, — уходом в raw.
    !(cell.tokens ?? []).some((t) => t.raw.includes('|')) && walk(cell.tokens);
  if (!cells.every(cellIsKnown)) return false;
  // ОБА поля, а не `tokens ?? items` (ре-ревью раунда 5 — блокер). Замер токенов лексера:
  // у маркированного списка `tokens` ОТСУТСТВУЕТ, а у нумерованного и у чеклиста он ЕСТЬ И
  // ПУСТ. `[] ?? items` даёт `[]`, `every` по пустому массиву истинен — и всё поддерево
  // пункта не осматривалось ВОВСЕ. Мимо проходили разом все четыре правила: рваная строка
  // таблицы, картинка в ячейке, экранированная черта, ссылка с пустым текстом.
  //
  // Дыра была только у ВЕРХНЕУРОВНЕВОГО нумерованного списка и чеклиста — внутри цитаты или
  // маркированного пункта тот же список идёт другой веткой и обходился правильно. Именно
  // поэтому мои тесты раунда 4 её не увидели: они везде брали маркированный список, то есть
  // форму, которая работала СЛУЧАЙНО. `walk(undefined)` истинен, так что обе ветки безопасны.
  return walk(token.tokens) && walk(token.items);
}

function rawNode(markdown: string): JSONContent {
  return { type: 'rawBlock', attrs: { markdown } };
}

/** Годятся ли разобранные узлы блока схеме. Вопрос задаётся ей самой — см. bodyDocError. */
function fitsSchema(nodes: JSONContent[]): boolean {
  return bodyDocError({ type: 'doc', content: nodes }) === undefined;
}

/** Слово — две и более буквы или цифры подряд. Одиночные символы отброшены намеренно: разметка
 *  ими сорит (маркеры, черта таблицы, скобки), и на них проверка срабатывала бы впустую. */
const WORD_RE = /[\p{L}\p{N}]{2,}/gu;

/** Имена HTML-сущностей — РАЗМЕТКА, а не проза: `&lt;` раскрывается в сам знак, и «lt» честно
 *  исчезает, ничего не теряя. Без вырезки проверка ловила бы это здоровое семейство. */
const ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;

/**
 * Пропало ли СЛОВО по дороге из `before` в `after`.
 *
 * Единственная реализация на весь пакет: ею пользуется и разбор (страховка ниже), и аудит
 * корпуса (`apps/server/src/db/audit-bodies.ts`). Две копии этого предиката разошлись бы, и
 * тогда аудит обещал бы одно, а конверсия делала другое.
 *
 * Множество, а не мультимножество: слово, потерявшее один из двух своих экземпляров, не
 * поднимет тревогу. Размен в сторону молчания сознательный — и он же оставляет слепыми
 * одиночный символ, чистую пунктуацию и эмодзи. Эти классы покрывает не он, а колонка
 * `body_before_doc` (обратимость конверсии).
 */
export function losesWord(before: string, after: string): boolean {
  const kept = new Set<string>();
  for (const m of after.toLowerCase().matchAll(WORD_RE)) kept.add(m[0]);
  for (const m of before.replace(ENTITY_RE, ' ').toLowerCase().matchAll(WORD_RE)) {
    if (!kept.has(m[0])) return true;
  }
  return false;
}

/**
 * Воспроизводит ли разбор блока СВОЙ СОБСТВЕННЫЙ текст — ОБЩИЙ приём против целого семейства.
 *
 * Четыре круга ревью подряд находили новую форму одного и того же: разбор молча выбрасывает
 * узел, документ без него схеме годен, в raw блок не уходит, а оба крана аудита считают уже
 * ПОСЛЕ разбора, где обе стороны согласны. Последняя найденная форма — кодовая вставка внутри
 * списка глубины ≥ 2, когда внешний контейнер нумерованный (`ol > ul`, `ol > task`):
 *
 *   "1. Подготовка\n\n   - [ ] выложить ключ\n\n     ```\n     ssh deploy\n     ```"
 *   → канон "1. Подготовка\n  - [ ] выложить ключ"   вставка удалена ЦЕЛИКОМ, все краны в нуле
 *
 * Точечная починка каждой формы — игра, которую мы четыре раза проиграли. Здесь спрашивается
 * то же, что страховка записи спрашивает на другом конце: НЕ ПРОПАЛО ЛИ НАПИСАННОЕ. Единица
 * сравнения — слово, потому что сравнивать приходится РАЗМЕТКУ с текстом, а вся разметка
 * состоит из пунктуации и потому в счёт не идёт.
 *
 * Жадности не вносит: замерено на 41 здоровом теле (заголовки, списки всех видов и вложенностей,
 * таблицы, цитаты, ограды, сущности, ссылки, эмодзи, setext, отступный код) — потерь слов ноль.
 */
function blockKeepsItsWords(raw: string, parsed: JSONContent[]): boolean {
  return !losesWord(raw, serializeBody({ type: 'doc', content: parsed }));
}

function rawDoc(markdown: string): BodyDoc {
  return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [rawNode(markdown)] } };
}

/**
 * Пустое тело — это НЕ пустой документ: топ-узел схемы объявлен `block+`, и `content: []`
 * ProseMirror отвергает («Invalid content for node doc»). У каждой только что созданной
 * сущности body пуст, так что это самый частый случай, а не краевой. Пустой абзац сериализуется
 * в пустую строку, поэтому инвариант `body === serializeBody(body_doc)` цел (проверено).
 */
function emptyDoc(): BodyDoc {
  return { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content: [{ type: 'paragraph' }] } };
}

/**
 * Лексер берётся У МЕНЕДЖЕРА, а не собирается из голого `marked`: только в его экземпляре
 * зарегистрированы наши токенайзеры (`queryBlock`, `entityRef`). Из этого следует главное —
 * заборы кода и инлайн-код лексер разбирает РАНЬШЕ нашей грамматики, поэтому показанный в коде
 * пример `{{query:…}}` остаётся текстом. Прежний путь (вырезание сегментов регэкспом по сырому
 * тексту до лексера) про заборы не знал и рвал их пополам — найдено ревью.
 */
function lex(markdown: string): { tokens: Tok[]; hasRefDefs: boolean } {
  const instance = md().instance;
  const lexer = new instance.Lexer(instance.defaults);
  const tokens = lexer.lex(markdown) as unknown as Tok[];
  return { tokens, hasRefDefs: Object.keys(lexer.tokens.links ?? {}).length > 0 };
}

export function parseBody(markdown: string): BodyDoc {
  if (markdown.trim() === '') return emptyDoc();
  try {
    const { tokens, hasRefDefs } = lex(markdown);
    if (hasRefDefs) {
      // Reference-определения marked складывает в lexer.tokens.links, и восстановить их форму
      // нечем — консервативно ВЕСЬ исходник дословно (ловит и сноски GFM из спайка).
      return rawDoc(markdown);
    }
    const content: JSONContent[] = [];
    for (const token of tokens) {
      if (token.type === 'space') continue;
      const raw = token.raw.replace(/\n+$/, '');
      // Второе условие — НЕПРИГОДНОСТЬ ПО СХЕМЕ, найдено пробой (в брифе ревью его нет).
      // «Знакомый токен» не значит «годный узел»: пустой пункт нумерованного списка (`1.`)
      // marked отдаёт без абзаца внутри, и парсер строил listItem с `content: []` — документ,
      // который отвергает СОБСТВЕННАЯ схема. serializeBody на нём БРОСАЛ TypeError из недр
      // @tiptap/markdown, а с ним бросала и canonicalizeBody: путь модели отвечал отказом,
      // а бэкфилл — который ошибку конверсии не глотает намеренно — обрывался на такой строке
      // вместе со всем оставшимся хвостом корпуса. Уводим блок в raw: текст цел до байта,
      // документ пригоден, канон становится неподвижной точкой.
      const parsed = blockIsKnown(token) ? (md().parse(raw).content ?? []) : null;
      // Третье условие — ОБЩИЙ приём против семейства «разбор молча выбросил узел»
      // (см. blockKeepsItsWords). Проверяется последним: оно дороже двух предыдущих, а
      // `serializeBody` внутри безопасен только на документе, уже прошедшем схему.
      if (
        parsed !== null &&
        (parsed.length === 0 || (fitsSchema(parsed) && blockKeepsItsWords(raw, parsed)))
      ) {
        content.push(...parsed);
      } else {
        content.push(rawNode(raw));
      }
    }
    return content.length > 0
      ? { v: DOC_SCHEMA_VERSION, doc: { type: 'doc', content } }
      : emptyDoc();
  } catch {
    // Парсер не справился вовсе — сохраняем дословно, не теряя ни байта.
    return rawDoc(markdown);
  }
}

/** Единственная форма, которой сервер пишет тело: body = КАНОН, не «как написала модель». */
export function canonicalizeBody(markdown: string): { doc: BodyDoc; body: string } {
  const doc = parseBody(markdown);
  return { doc, body: serializeBody(doc) };
}

/**
 * Всё, что человек написал: текст узлов, дословная разметка raw-блоков, запрос смарт-листа.
 * Пробелы выброшены — markdown вправе их переставлять (перевод строки в конце блока,
 * выравнивание таблицы, схлопывание пустых строк), и считать это пропажей нельзя.
 *
 * ССЫЛКИ здесь НЕТ ни в каком виде, и обе половины этого — решения, а не упущение.
 *
 * ПОДПИСЬ не авторский текст, а вмороженный кеш заголовка (EntityChip показывает живой), и по
 * решению находки 2 сериализатор ОПУСКАЕТ подпись со скобкой — считать её пропажей значило бы
 * объявить поломкой собственную починку. Без этой оговорки чип с подписью «Задача ] хвост»
 * уводил весь документ в raw (замерено).
 *
 * ID убран как ИЗБЫТОЧНЫЙ и вредный: сверка ссылок ниже проверяет ровно то же и делает это
 * правильнее — она нечувствительна к регистру, а посимвольная сверка нет, поэтому
 * `[[entity:0F8F…]]` (разбор приводит id к нижнему регистру) считался пропажей и уводил
 * документ в raw (замерено, ре-ревью раунда 3).
 */
function writtenText(node: JSONContent | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (typeof node.text === 'string') out.push(node.text);
  const attrs = node.attrs ?? {};
  if (node.type === 'rawBlock' && typeof attrs.markdown === 'string') out.push(attrs.markdown);
  if (node.type === 'queryBlock' && typeof attrs.query === 'string') out.push(attrs.query);
  for (const child of node.content ?? []) writtenText(child, out);
  return out;
}

const squash = (doc: JSONContent): string => writtenText(doc).join('').replace(/\s+/gu, '');

/**
 * Подпоследовательность, а не равенство: разметка вправе ДОБАВИТЬ символы (маркер списка,
 * экранирующий слэш), но не вправе ничего УБРАТЬ.
 *
 * Обе строки перебираются ПО КОДОВЫМ ЕДИНИЦАМ. Наивный `for…of` по стогу (кодовые ТОЧКИ) против
 * индексации иглы (кодовые единицы) давал катастрофический ложный результат: суррогатная пара
 * никогда не совпадала сама с собой, поэтому ЛЮБАЯ заметка с эмодзи считалась потерявшей текст
 * и уезжала в raw целиком. Поймано сплошной пробой, не типами.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Переживает ли документ обратный разбор своей проекции: не пропал ли текст и не пропали ли
 * ссылки. Ровно тот вопрос, ради которого заведена страховка записи, — см. bodyPairFromDoc.
 */
export function projectionKeepsEverything(
  input: BodyDoc | JSONContent,
  projection: string,
): boolean {
  const before = docOf(input);
  const after = parseBody(projection).doc;
  if (!isSubsequence(squash(before), squash(after))) return false;
  const kept = new Set(bodyRefsFromDoc(after));
  return bodyRefsFromDoc(before).every((ref) => kept.has(ref));
}

/**
 * Пара «документ + текст» для ЗАПИСИ ГОТОВОГО ДОКУМЕНТА (путь редактора).
 *
 * Зачем отдельная функция, а не голый `serializeBody`. Путь `bodyDoc` — единственный, который
 * кладёт в `body` результат сериализации МИНУЯ канонизацию: версия и структура проверяются,
 * а то, ради чего вся конструкция затеяна, — не проверялось вовсе (итоговое ревью, находка 3).
 * Ровно через этот шов проходили находки 1 и 2: несимметричный сериализатор клал в БД текст,
 * который при первой же пересборке давал ДРУГОЙ документ, а исходных байтов не оставалось нигде.
 *
 * ЧТО ИМЕННО СПРАШИВАЕТСЯ — и почему не «канон неподвижен». Первая редакция страховки требовала
 * `canonicalizeBody(body).body === body`, и это оказалось РЕГРЕССОМ (ре-ревью, Б1): markdown не
 * умеет выражать пустой абзац, поэтому у любого документа с пустой строкой — в конце, в начале,
 * между абзацами — проекция неподвижной точкой не является В ПРИНЦИПЕ. Страховка принимала
 * нормальное состояние за поломку и уводила живую заметку в один неправимый rawBlock на каждом
 * круге автосохранения. Замерено: 7 ложных срабатываний на 15 бытовых состояниях редактора.
 *
 * Замерена и предложенная замена «канон устойчив» (`canon(canon(body)) === canon(body)`): для
 * ЭТОГО места она не годится — пропускает 8 настоящих порч из 9, потому что здесь сравнение
 * начинается с УЖЕ испорченной проекции, а испорченная проекция обычно устойчива. (В аудите
 * корпуса, где отсчёт идёт от исходного `body`, тот же критерий работает — там он и стоит.)
 *
 * Спрашивается поэтому прямое: НЕ ПРОПАЛО ЛИ ЧТО-НИБУДЬ — ни один непробельный символ, ни одна
 * ссылка (projectionKeepsEverything). Измерено на тех же наборах: 0 ложных срабатываний на 15
 * бытовых состояниях, ловит 7 порч из 9.
 *
 * Что делает страховка при непрохождении:
 *  - НЕ отказывает. Отказ на этом пути терминален: автосохранение встало бы, и человек потерял
 *    бы возможность писать в живой документ — цена несоизмерима с поводом.
 *  - НЕ канонизирует текст. `canonicalizeBody` здесь и есть подозреваемый: именно он переписывает
 *    то, чего не понял. Текст уходит в БД БАЙТ В БАЙТ, как его напечатал документ.
 *  - Подменяет ДОКУМЕНТ на `rawBlock` с этим текстом — тот же приём, которым модуль спасает
 *    непонятое при разборе. `rawBlock` печатается дословно, поэтому пара
 *    `body === serializeBody(body_doc)` согласована при ЛЮБОМ сериализаторе, а порча становится
 *    видимой (блок рисуется дословно, MarkdownToggle предупреждает) вместо тихой.
 *
 * Чего страховка НЕ ловит и почему это принято: случаи, где текст и ссылки целы, а теряется
 * ОФОРМЛЕНИЕ (блок кода стал абзацем с той же строкой внутри; подпись ссылки обрезана, а
 * обрезок остался соседним текстом). Ужесточать нельзя: ровно это ужесточение и дало Б1 —
 * markdown нормализует оформление законно и постоянно. Остаток ловит аудит корпуса ПЕРЕД
 * необратимой конверсией, где ложная тревога стоит взгляда человека, а не живого документа.
 */
export function bodyPairFromDoc(input: BodyDoc): { doc: BodyDoc; body: string } {
  const body = serializeBody(input);
  return projectionKeepsEverything(input, body)
    ? { doc: input, body }
    : { doc: rawDoc(body), body };
}

/** Дерево ∪ регэксп по raw-блокам: backlinks не зависят от разбираемости тела (Б2).
 *  Код-блоки и inline-код — по-прежнему НЕ связь (Р7): они не raw, а честные ноды схемы. */
export function bodyRefsFromDoc(input: BodyDoc | JSONContent): string[] {
  const refs = new Set<string>();
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return;
    if (node.type === 'entityRef' && typeof node.attrs?.entityId === 'string') {
      refs.add(node.attrs.entityId.toLowerCase());
    }
    if (node.type === 'rawBlock' && typeof node.attrs?.markdown === 'string') {
      for (const m of node.attrs.markdown.matchAll(BODY_REF_RE)) {
        if (m[1]) refs.add(m[1].toLowerCase());
      }
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(docOf(input));
  return [...refs];
}

/**
 * Документ ли это по схеме Orbis? Возвращает ПРИЧИНУ непригодности или undefined.
 *
 * Единственная честная проверка структуры: спрашивает прямо у схемы, а не по косвенным следам.
 * Косвенный признак «проекция пуста» на этой роли не годится — в пустую строку законно
 * сериализуются пустой абзац, пустой ЗАГОЛОВОК, абзац с одним hardBreak и абзац из пробелов
 * (замерено), и перечислять «какие ноды бывают пустыми» бессмысленно: список неизвестен по
 * построению и будет отставать от схемы.
 *
 * Ловит: неизвестную ноду и марку, text-узел без `text` (и с пустым `text`), нарушенную
 * вложенность на ЛЮБОЙ глубине (`check()` рекурсивен) и пустой `content` у `doc` (топ-узел
 * объявлен `block+` — см. emptyDoc выше).
 *
 * ВАЖНО для вызывающего: это проверка, а НЕ нормализация. Обратно писать `node.toJSON()`
 * нельзя — он теряет незнакомые схеме атрибуты, а именно так живут блочные id (UniqueID
 * работает только в редакторе и в DOC_EXTENSIONS его нет). Проверено: `attrs.id` проходит
 * валидацию, но исчезает из `toJSON()`. Хранить нужно ВХОД.
 */
export function bodyDocError(input: BodyDoc | JSONContent): string | undefined {
  try {
    pmSchema()
      .nodeFromJSON(docOf(input) as never)
      .check();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Правило разрешения (Р1): что считать документом.
 *  1. форма верна и версия знакома → он;
 *  2. иначе (версия из будущего после отката релиза, битая форма, NULL) → пересборка из `body`.
 * Худший исход — потеря блочных id и части оформления, но НЕ текста.
 *
 * «Форма верна» спрашивается У СХЕМЫ (`bodyDocError`), а не по наличию полей. До итогового
 * ревью (находка 5) докблок обещал пересборку «при битой форме», а код смотрел лишь на тип,
 * наличие `v`/`doc` и версию: `{v: 1, doc: 'мусор'}` уезжал наружу как есть — и ронял редактор
 * на `nodeFromJSON`. Тесты подобранных форм разницы не показывали, потому что все битые формы
 * в них отсеивались ВЕРСИЕЙ.
 *
 * Цена — один `check()` на чтение с `include=bodyDoc`; схема строится один раз и кешируется,
 * сама проверка стоит единицы микросекунд (замерено). Чужие схеме атрибуты (блочные id
 * UniqueID) проверку проходят, и наружу отдаётся ВХОД, а не `toJSON()`, — см. bodyDocError.
 */
export function readBodyDoc(stored: unknown, fallbackMarkdown: string): BodyDoc {
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'v' in stored &&
    'doc' in stored &&
    (stored as BodyDoc).v === DOC_SCHEMA_VERSION &&
    bodyDocError(stored as BodyDoc) === undefined
  ) {
    return stored as BodyDoc;
  }
  return parseBody(fallbackMarkdown);
}
