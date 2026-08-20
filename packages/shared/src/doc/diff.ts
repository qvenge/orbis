import type { JSONContent } from '@tiptap/core';

/**
 * Блочный дифф тела записи со внутриблочным сравнением по словам. Владелец видит предложение
 * рутины РАЗЛИЧИЕМ, а не стеной нового текста, поэтому машину сравнения зовут обе стороны:
 * сервер — на показе предложения, клиент — на пересчёте в режиме правки.
 *
 * ФАЙЛ ЛИСТОВОЙ, И ЭТО ЗАКОН, А НЕ СТИЛЬ. Ни одного рантайм-импорта: `JSONContent` стирается
 * компилятором, а `verbatimModuleSyntax` (`tsconfig.base.json:10`) заставляет писать `import
 * type` явно — то есть листовость проверяет ещё и компилятор, не только тест-сосед.
 *
 * Импорт `./convert` или `./schema` ЗНАЧЕНИЕМ запрещён, и цена нарушения замерена, а не
 * выведена: ребро на конверсию тащит всю схему Tiptap в чанк экрана записи, **+156 кБ gzip**
 * (варианты A и C разведки веса), тогда как правильная цена этого модуля — **+0.85 кБ gzip**.
 * Мимо стражей: `scripts/check-lazy-chunks.ts` сверяет НАЛИЧИЕ чанков, а не их состав, и на
 * сломанной сборке печатает `ok` (проверено прогоном). Единственная автоматическая защита —
 * тест листовости в `diff.test.ts`.
 *
 * Ребро между модулями идёт ТОЛЬКО в сторону `convert.ts` → `diff.ts` (за `blockText`).
 * Обратное направление запрещено. Двух копий «что человек написал» не заводим: `convert.ts`
 * уже обжёгся на этом с `losesWord` — две копии предиката разошлись бы, и аудит корпуса
 * обещал бы одно, а конверсия делала другое.
 *
 * Чего этот модуль НЕ делает: не разбирает markdown и не канонизирует. Он работает уже с
 * деревьями. До-разборные потолки (байты и строки исходника) живут на сервере, у вызывающего:
 * замер говорит, что дорога не здесь — на худшем реальном теле корпуса (236 КБ, 567 единиц)
 * сопоставление блоков стоит 1.9 мс, а `canonicalizeBody` — 1567–1860 мс.
 */

/** Кусок внутриблочного сравнения: подряд идущие слова одной судьбы. */
export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/**
 * Единица показа — один блок документа в терминах правила развёртки (см. `flattenBlocks`).
 *
 * Заполнение полей: у `same` заполнены ОБА (`before === after`) — читателю не приходится гадать,
 * с какой стороны брать текст; у `removed` только `before`, у `added` только `after`;
 * у `changed` оба плюс `parts`, если внутриблочное сравнение было сделано.
 *
 * `parts` нет у `changed`, когда блок длиннее `maxBlockWords`: блок показывается заменённым
 * целиком. Инвариант, на который читатель вправе опираться: `parts` без `added`, склеенные
 * пробелом, дают ровно `before`; без `removed` — ровно `after`.
 *
 * Тип узла и его атрибуты в единицу НЕ едут, хотя в ключ сопоставления входят (см. `keyOf`).
 * Следствие честное и его надо знать: щелчок чекбоксом при том же тексте приезжает как
 * `changed`, у которого `before === after` и все `parts` — `same`. Различие есть, показать
 * его словами нечем; рисовать такую единицу как изменённую — работа читателя.
 */
export interface DiffUnit {
  kind: 'same' | 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  parts?: DiffPart[];
}

/**
 * Почему дифф не построен.
 * - `too_large` — единиц развёртки больше `maxBlocks` хотя бы с одной стороны;
 * - `rewritten` — правок больше бюджета, то есть тело переписано целиком.
 */
export type BodyDiffSkipReason = 'too_large' | 'rewritten';

export type BodyDiffResult = { units: DiffUnit[] } | { skipped: BodyDiffSkipReason };

export interface DiffLimits {
  /** Потолок ЕДИНИЦ развёртки на сторону. Проверяется до сопоставления. */
  maxBlocks: number;
  /** Потолок слов блока, при котором ещё считается внутриблочный дифф. */
  maxBlockWords: number;
  /** Бюджет числа правок Myers, доля от (N + M). */
  maxEditRatio: number;
}

/**
 * Умолчания Развилки 6 плана Ш1. Числа выведены из корпуса РЕПОЗИТОРИЯ и синтетики, а не из
 * пользовательских тел (живых больших тел не существует) — они двигаются правкой этих констант,
 * и вызывающий вправе передать свои.
 *
 * `maxBlocks = 1000` — 1.8× от самого большого реального тела корпуса (567 единиц у
 * `docs/prd/01-architecture.md`, 236 КБ) и вдвое от бытового чеклиста в 64 КБ (521 единица).
 * Отсекает только вырожденные формы (пункт в 9 байт даёт 6059 единиц).
 *
 * `maxBlockWords = 400` — замер по 11 513 единицам корпуса: медиана 13 слов, p95 = 102,
 * p99 = 303, максимум 2667. Внутриблочный дифф квадратичен по словам и зовётся на КАЖДОЙ
 * спаренной замене, поэтому потолок здесь не про один блок, а про сумму по замене.
 *
 * `maxEditRatio = 0.3` — Myers `O(ND)` вырождается в `O(N²)` при D ~ N и на переписанном
 * целиком теле ПРОИГРЫВАЕТ наивному LCS (N = M = 4000, D = 8000: 584 мс против 155). А
 * «перегенерируй план дня целиком» — рядовой ход рутины, не авария.
 *
 * ИЗВЕСТНАЯ ЦЕНА доли БЕЗ НИЖНЕГО ПОРОГА (замерено на сидах прода, а не выведено): у доли нет
 * нижней ступеньки, поэтому МЕЛКОЕ тело на любую правку отвечает `skipped: 'rewritten'`.
 * Изменённый блок стоит D = 2, значит одна правка требует ≥ 4 единиц, две — ≥ 7, три — ≥ 10.
 * `UPCOMING_BODY`, `HORIZON_YEAR_BODY` и `ROUTINES_LIST_BODY` (по 3 единицы каждое) на правку
 * одной строки уже сегодня отвечают «тело переписано целиком», хотя переписана одна строка.
 * Число оставлено как предписано планом (Развилка 6); нижний порог — решение владельца, а не
 * имплементера, и он снимается заменой `maxD` на `Math.max(<порог>, доля·(N + M))`.
 */
export const DIFF_LIMITS_DEFAULT: DiffLimits = {
  maxBlocks: 1_000,
  maxBlockWords: 400,
  maxEditRatio: 0.3,
};

/**
 * Порог Дайса на мультимножестве слов, при котором удалённый и добавленный блоки считаются одним
 * изменённым. Замерено на 36 400 истинных и 23 835 ложных парах: у истинных пар p1 = 0.40,
 * медиана 0.935; у ложных p95 = 0.304. Порог 0.5 брать нельзя — он ломает короткие пункты
 * плана дня (FN 7.4 % на блоках ≤ 6 слов против 0.0 % у 0.4).
 */
const PAIR_MIN_DICE = 0.4;

/**
 * Окно спаривания внутри одной замены: своё место, потом ближайшие соседи. Ради случая «пункт
 * изменён, а соседний вставлен» — позиционное спаривание в лоб (R[0] ↔ A[0]) там ошибается
 * (замер: сосед даёт Дайс 0.118, настоящая пара — 0.889). Больше двух не берём: окно должно
 * оставаться предпочтением, а не поиском по всей замене.
 */
const PAIR_WINDOW_OFFSETS: readonly number[] = [0, 1, -1, 2, -2];

/**
 * Слово для меры похожести: буквы и цифры подряд, БЕЗ ограничения длины.
 *
 * Это СОЗНАТЕЛЬНОЕ расхождение с `WORD_RE` конверсии (`convert.ts`, предикат `losesWord`), где
 * стоит `{2,}`: там одиночные символы отброшены потому, что ими сорит разметка и проверка
 * потери слова срабатывала бы впустую. Здесь наоборот — одиночные цифры значимы: «18:00»
 * даёт `[18, 00, спорт]`, и без них перенос времени неотличим от чего угодно.
 *
 * Не «починка расхождения»: у двух регулярок разные задачи, и сведение их в одну сломает ту
 * или другую. Если следующему читателю захочется их объединить — сначала перечитать этот абзац.
 */
const SIMILARITY_WORD_RE = /[\p{L}\p{N}]+/gu;

/**
 * Контейнеры: сами единицами не считаются, единицы — их дети. Список из схемы
 * (`packages/shared/src/doc/schema.ts`, состав `DOC_EXTENSIONS`): три вида списков, таблица и
 * цитата. Цитата прозрачна насквозь — её блоки становятся единицами верхнего уровня.
 *
 * Единицы (всё остальное): `paragraph`, `heading`, `codeBlock`, `rawBlock`, `queryBlock`,
 * `horizontalRule`, `listItem`, `taskItem`, `tableRow`. Список ЗАКРЫТЫМ не делается намеренно:
 * нода-новичок схемы должна приезжать единицей сама собой, а не исчезать из диффа молча.
 */
const TRANSPARENT_KINDS: ReadonlySet<string> = new Set([
  'bulletList',
  'orderedList',
  'taskList',
  'table',
  'blockquote',
]);

/**
 * Инлайн-ноды схемы: у них нет своего блока, их текст принадлежит родителю. Список полный на
 * сегодня (`text`, `hardBreak`, `entityRef` — марки нодами не являются). Инлайн-нода-новичок,
 * забытая здесь, ничего не потеряет, но раскрошит абзац на куски и вставит лишние пробелы между
 * ними: `unitPieces` сочтёт её блоком.
 */
const INLINE_KINDS: ReadonlySet<string> = new Set(['text', 'hardBreak', 'entityRef']);

/**
 * Атрибуты, входящие в ключ сопоставления.
 *
 * Без них голый текст не различает ровно те правки, которые рутина и делает: щелчок чекбоксом
 * («План дня»), понижение заголовка, смена языка кодового блока — всё это приехало бы как
 * `same`, то есть самая вероятная правка оказалась бы невидимой.
 */
const KEY_ATTRS: Readonly<Record<string, readonly string[]>> = {
  heading: ['level'],
  taskItem: ['checked'],
  codeBlock: ['language'],
};

/** Блок в плоском виде: тип узла, ключ сопоставления и нормализованный текст для показа. */
export interface FlatBlock {
  kind: string;
  key: string;
  text: string;
}

/**
 * Всё, что человек написал в узле и его потомках: текст узлов, дословная разметка raw-блоков,
 * запрос смарт-листа. Единственная реализация этого правила на весь пакет — `convert.ts` берёт
 * её отсюда (направление ребра: convert → diff, обратное запрещено докблоком файла).
 *
 * ССЫЛКИ здесь НЕТ ни в каком виде, и обе половины этого — решения, а не упущение.
 *
 * ПОДПИСЬ не авторский текст, а вмороженный кеш заголовка (EntityChip показывает живой), и по
 * решению находки 2 сериализатор ОПУСКАЕТ подпись со скобкой — считать её пропажей значило бы
 * объявить поломкой собственную починку. Без этой оговорки чип с подписью «Задача ] хвост»
 * уводил весь документ в raw (замерено).
 *
 * ID убран как ИЗБЫТОЧНЫЙ и вредный: сверка ссылок в конверсии проверяет ровно то же и делает
 * это правильнее — она нечувствительна к регистру, а посимвольная сверка нет, поэтому
 * `[[entity:0F8F…]]` (разбор приводит id к нижнему регистру) считался пропажей и уводил
 * документ в raw (замерено, ре-ревью раунда 3).
 *
 * Куски склеиваются ВПРИТЫК, без разделителя: у конверсии это правило, и менять его нельзя —
 * она всё равно выбрасывает пробелы. Слова соседних блоков разводит развёртка (`unitPieces`),
 * а не эта функция.
 */
export function blockText(node: JSONContent): string {
  const out: string[] = [];
  collectText(node, out);
  return out.join('');
}

function collectText(node: JSONContent | undefined, out: string[]): void {
  if (!node) return;
  if (typeof node.text === 'string') out.push(node.text);
  const attrs = node.attrs ?? {};
  if (node.type === 'rawBlock' && typeof attrs.markdown === 'string') out.push(attrs.markdown);
  if (node.type === 'queryBlock' && typeof attrs.query === 'string') out.push(attrs.query);
  for (const child of node.content ?? []) collectText(child, out);
}

/** Пробелы схлопнуты: markdown вправе их переставлять, и считать это правкой нельзя. */
function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function keyOf(node: JSONContent, kind: string, text: string): string {
  const attrs = node.attrs ?? {};
  const significant = (KEY_ATTRS[kind] ?? [])
    .map((name) => `${name}=${String(attrs[name] ?? '')}`)
    .join(',');
  // Разделитель — перевод строки: нормализация схлопнула пробелы, поэтому в тексте единицы
  // его быть не может, и склейка полей не подделает чужой ключ (иначе абзац «heading 2»
  // сравнялся бы с заголовком того же текста).
  return `${kind}\n${significant}\n${text}`;
}

/**
 * Куски текста единицы: по куску на вложенный текстовый блок, чтобы слова соседних блоков не
 * слипались («Привет» + «Мир» = «ПриветМир» разрушило бы и слова, и меру похожести).
 *
 * Вложенные контейнеры (подсписок внутри пункта, таблица внутри цитаты) в текст единицы НЕ
 * входят — они откладываются в `nested` и разворачиваются в свои единицы следом за родителем.
 */
function unitPieces(node: JSONContent, nested: JSONContent[], out: string[]): void {
  const children = node.content ?? [];
  const hasBlockChild = children.some(
    (child) => typeof child.type === 'string' && !INLINE_KINDS.has(child.type),
  );
  if (!hasBlockChild) {
    // Лист схемы: абзац, заголовок, кодовый блок, horizontalRule, rawBlock, queryBlock —
    // у всех текст либо инлайновый, либо в атрибуте, и берётся целиком.
    out.push(blockText(node));
    return;
  }
  for (const child of children) {
    if (typeof child.type !== 'string') continue;
    if (TRANSPARENT_KINDS.has(child.type)) {
      nested.push(child);
      continue;
    }
    unitPieces(child, nested, out);
  }
}

/**
 * Развёртка документа в плоский список единиц (правило Р-3 разведки).
 *
 * Три из четырёх единиц, которые называет спека (пункт списка, строка таблицы), детьми `doc`
 * быть не могут — поэтому правило спуска задано явно, а не выведено из топ-уровня схемы.
 *
 * Порядок — документный: сначала сама единица, потом единицы её вложенных контейнеров.
 */
export function flattenBlocks(doc: JSONContent): FlatBlock[] {
  const out: FlatBlock[] = [];
  for (const child of doc.content ?? []) flattenInto(child, out);
  return out;
}

function flattenInto(node: JSONContent, out: FlatBlock[]): void {
  const kind = node.type;
  if (typeof kind !== 'string') return;
  if (TRANSPARENT_KINDS.has(kind)) {
    for (const child of node.content ?? []) flattenInto(child, out);
    return;
  }
  const nested: JSONContent[] = [];
  const pieces: string[] = [];
  unitPieces(node, nested, pieces);
  const text = normalizeText(pieces.join(' '));
  out.push({ kind, key: keyOf(node, kind, text), text });
  for (const child of nested) flattenInto(child, out);
}

/**
 * Главный вход: дифф двух ТЕЛ-ДОКУМЕНТОВ (`JSONContent` уровня `doc`; хранимую форму `BodyDoc`
 * вызывающий разворачивает сам — модуль о хранении не знает).
 */
export function diffBodyDocs(
  before: JSONContent,
  after: JSONContent,
  limits?: Partial<DiffLimits>,
): BodyDiffResult {
  const maxBlocks = limits?.maxBlocks ?? DIFF_LIMITS_DEFAULT.maxBlocks;
  const maxBlockWords = limits?.maxBlockWords ?? DIFF_LIMITS_DEFAULT.maxBlockWords;
  const maxEditRatio = limits?.maxEditRatio ?? DIFF_LIMITS_DEFAULT.maxEditRatio;

  const oldBlocks = flattenBlocks(before);
  const newBlocks = flattenBlocks(after);
  if (oldBlocks.length > maxBlocks || newBlocks.length > maxBlocks) {
    return { skipped: 'too_large' };
  }

  const maxD = Math.floor(maxEditRatio * (oldBlocks.length + newBlocks.length));
  const ops = myersOps(
    oldBlocks.map((b) => b.key),
    newBlocks.map((b) => b.key),
    maxD,
  );
  if (ops === null) return { skipped: 'rewritten' };

  const units: DiffUnit[] = [];
  let removed: FlatBlock[] = [];
  let added: FlatBlock[] = [];
  const flush = () => {
    if (removed.length === 0 && added.length === 0) return;
    units.push(...pairReplacement(removed, added, maxBlockWords));
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.kind === 'same') {
      flush();
      const text = at(oldBlocks, op.ai).text;
      units.push({ kind: 'same', before: text, after: text });
    } else if (op.kind === 'removed') {
      removed.push(at(oldBlocks, op.ai));
    } else {
      added.push(at(newBlocks, op.bi));
    }
  }
  flush();
  return { units };
}

/** Индексы приходят из самого алгоритма и всегда в границах; `noUncheckedIndexedAccess` требует
 *  сказать это явно, а бросок вместо молчаливого `undefined` не даст ошибке уехать в показ. */
function at(list: readonly FlatBlock[], i: number): FlatBlock {
  const block = list[i];
  if (block === undefined) throw new Error(`дифф: блок ${i} вне списка длины ${list.length}`);
  return block;
}

/**
 * Спаривание удалённых и добавленных блоков ВНУТРИ одной замены (Ш1.10).
 *
 * Стоимость — `O(|R| · окно)`, то есть линейна: квадратичного перебора всех пар нет по
 * построению. Кандидат обязан совпасть ТИПОМ УЗЛА: иначе заголовок «Расписание» спарился бы с
 * пунктом «Расписание дня» по вложению 1.0 (замерено). Из того же решения следует, что чеклист,
 * переписанный маркированным списком, — замена, а не правка: `taskItem ≠ listItem`.
 *
 * Среди кандидатов берётся ЛУЧШИЙ ИЗ ПРИЕМЛЕМЫХ, а не «лучший по Дайсу с последующей проверкой»:
 * второй порядок терял бы настоящую пару, если у соседа Дайс выше, но сам он неприемлем
 * (у пары Дайс 0.30 при вложении 1.0, у соседа 0.35 без вложения). Отбор может только ДОБАВИТЬ
 * спаривание, ни одного не отнимая.
 */
function pairReplacement(
  removed: readonly FlatBlock[],
  added: readonly FlatBlock[],
  maxBlockWords: number,
): DiffUnit[] {
  const pairOf: number[] = removed.map(() => -1);
  const usedAdded = new Set<number>();
  for (let i = 0; i < removed.length; i += 1) {
    const source = at(removed, i);
    let bestJ = -1;
    let bestDice = -1;
    for (const offset of PAIR_WINDOW_OFFSETS) {
      const j = i + offset;
      if (j < 0 || j >= added.length || usedAdded.has(j)) continue;
      const candidate = at(added, j);
      if (candidate.kind !== source.kind) continue;
      const { dice, containment } = similarity(source.text, candidate.text);
      if (dice < PAIR_MIN_DICE && containment < 1) continue;
      if (dice > bestDice) {
        bestDice = dice;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      pairOf[i] = bestJ;
      usedAdded.add(bestJ);
    }
  }

  // Сборка в порядке ДОКУМЕНТА: добавленные блоки, вставленные перед парой, обязаны показаться
  // перед ней — ради случая «изменён пункт, а над ним вставлен новый».
  const out: DiffUnit[] = [];
  let j = 0;
  const drainAddedBefore = (stop: number) => {
    while (j < stop) {
      if (!usedAdded.has(j)) out.push({ kind: 'added', after: at(added, j).text });
      j += 1;
    }
  };
  for (let i = 0; i < removed.length; i += 1) {
    const source = at(removed, i);
    const p = pairOf[i] ?? -1;
    if (p < 0) {
      out.push({ kind: 'removed', before: source.text });
      continue;
    }
    drainAddedBefore(p);
    out.push(changedUnit(source.text, at(added, p).text, maxBlockWords));
    j = Math.max(j, p + 1);
  }
  drainAddedBefore(added.length);
  return out;
}

function changedUnit(before: string, after: string, maxBlockWords: number): DiffUnit {
  const beforeWords = splitTokens(before);
  const afterWords = splitTokens(after);
  if (beforeWords.length > maxBlockWords || afterWords.length > maxBlockWords) {
    // Блок длиннее потолка показывается заменённым целиком: внутриблочный LCS квадратичен по
    // словам, а таких пар в одной замене может быть много.
    return { kind: 'changed', before, after };
  }
  return { kind: 'changed', before, after, parts: wordParts(beforeWords, afterWords) };
}

/** Мера похожести двух блоков: Дайс на МУЛЬТИМНОЖЕСТВЕ слов и вложение меньшего в большее.
 *
 *  Вложение рядом с Дайсом не украшение, а починка его единственной дырки — дописанного хвоста
 *  к короткому блоку: «Спорт» → «Спорт — заменить на бассейн» даёт Дайс 0.25 при вложении 1.0.
 *  Правило «Дайс ≥ 0.4 ИЛИ вложение = 1.0» замерено: FN 0.04 % при FP 3.42 % (у одного Дайса
 *  FN 3.50 %). Мультимножество, а не множество: у множеств истинные пары начинаются с 0.25. */
function similarity(a: string, b: string): { dice: number; containment: number } {
  const wa = countWords(a);
  const wb = countWords(b);
  if (wa.total === 0 || wb.total === 0) return { dice: 0, containment: 0 };
  let shared = 0;
  for (const [word, count] of wa.counts) shared += Math.min(count, wb.counts.get(word) ?? 0);
  return {
    dice: (2 * shared) / (wa.total + wb.total),
    containment: shared / Math.min(wa.total, wb.total),
  };
}

function countWords(text: string): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const match of text.toLowerCase().matchAll(SIMILARITY_WORD_RE)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    total += 1;
  }
  return { counts, total };
}

/**
 * Токены внутриблочного диффа — куски между пробелами, а не слова `SIMILARITY_WORD_RE`.
 *
 * Разные задачи, разная нарезка: похожести нужны «18» и «00» по отдельности, а показу — целое
 * «18:00» одним куском, иначе двоеточие и запятые уехали бы в отдельные части. Текст блока уже
 * нормализован (пробелы схлопнуты), поэтому склейка частей через один пробел восстанавливает
 * сторону дословно — на этот инвариант читателю разрешено опираться.
 */
function splitTokens(text: string): string[] {
  return text === '' ? [] : text.split(' ');
}

/** Внутриблочное сравнение — наивный LCS по токенам. Наивный, а не Myers: обе стороны короче
 *  `maxBlockWords`, а на таких длинах разница алгоритмов тонет в накладных расходах. */
function wordParts(a: readonly string[], b: readonly string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text = `${last.text} ${text}`;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  // При РАВНЫХ путях (`>=`) первым идёт удалённое, а не добавленное: «было → стало» читается
  // в этом порядке, и приёмка 4 («10:00 → 14:00») ждёт именно его.
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push('same', a[i] ?? '');
      i += 1;
      j += 1;
    } else if (
      i < n &&
      (j >= m || (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    ) {
      push('removed', a[i] ?? '');
      i += 1;
    } else {
      push('added', b[j] ?? '');
      j += 1;
    }
  }
  return parts;
}

type EditOp =
  | { kind: 'same'; ai: number; bi: number }
  | { kind: 'removed'; ai: number }
  | { kind: 'added'; bi: number };

/**
 * Сопоставление блоков — Myers `O(ND)` по ключам, с ОТСЕЧКОЙ по числу правок.
 *
 * `null` означает «правок больше бюджета», и это не отказ, а правда: при D ~ N + M Myers
 * вырождается в квадрат и проигрывает наивному LCS (замер: N = M = 4000, D = 8000 — 584 мс
 * против 155), а тело с таким D и правда переписано целиком.
 *
 * След (`trace`) хранится СРЕЗАМИ по числу диагоналей шага, а не полными строками: при
 * `maxBlocks = 1000` и бюджете 0.3 полный след стоил бы ~9.6 МБ на один дифф, срезами — ~1.4 МБ.
 */
function myersOps(a: readonly string[], b: readonly string[], maxD: number): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const fromLeft = v[k - 1 + offset] ?? 0;
      const fromRight = v[k + 1 + offset] ?? 0;
      const down = k === -d || (k !== d && fromLeft < fromRight);
      let x = down ? fromRight : fromLeft + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], dEnd: number, n: number, m: number): EditOp[] {
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d -= 1) {
    // trace[d] — снимок ДО шага d, местная нумерация диагоналей смещена на d.
    const prev = trace[d] ?? new Int32Array(0);
    const k = x - y;
    const fromLeft = prev[k - 1 + d] ?? 0;
    const fromRight = prev[k + 1 + d] ?? 0;
    const down = k === -d || (k !== d && fromLeft < fromRight);
    const kPrev = down ? k + 1 : k - 1;
    const xStart = down ? fromRight : fromLeft;
    const yStart = xStart - kPrev;
    const xMid = down ? xStart : xStart + 1;
    while (x > xMid) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'same', ai: x, bi: y });
    }
    if (down) ops.push({ kind: 'added', bi: yStart });
    else ops.push({ kind: 'removed', ai: xStart });
    x = xStart;
    y = yStart;
  }
  while (x > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: 'same', ai: x, bi: y });
  }
  ops.reverse();
  return ops;
}
