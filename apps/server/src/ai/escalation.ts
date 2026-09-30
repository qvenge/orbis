// apps/server/src/ai/escalation.ts
// Эскалация повторных исправлений категории в memory-правило (01-arch §7.8):
// «после ДВУХ одинаковых исправлений AI предлагает создать правило; счётчик
// одинаковых исправлений не хранится отдельным состоянием — он вычисляется сканом
// журнала действий за последние 30 дней».
//
// ГДЕ ЭТО ЖИВЁТ (решение K7). Пост-коммит хуков в executor'е нет и заводить их не
// требуется: execute() открывает собственный withIdentity-tx, поэтому «после коммита»
// — это просто вызов у вызывающего. maybeSuggestRule зовётся из роутера ПОСЛЕ
// успешного execute() и работает ОТДЕЛЬНОЙ транзакцией; её ошибка логируется и не
// пробрасывается (escalateAfterEntityUpdate), иначе провал скана откатил бы саму
// правку категории.
//
// ПОЧЕМУ ОТКАЗ — НОВОЕ СООБЩЕНИЕ (решение K4). chat_messages append-only (§4.6),
// metadata неизменяема — «пометки в metadata карточки» не существует как операции.
// Отказ пишется новым системным сообщением с карточкой memory_rule_declined, и
// подавление повтора идёт тем же 30-дневным сканом, что и подавление по уже
// отправленному предложению (зеркало rejectPending §7.10).
import {
  counterpartySimilarity,
  DUP_SIMILARITY_THRESHOLD,
  type GraphId,
  memoryRuleDeclinedId,
  memoryRuleSuggestionId,
  normalizeCounterparty,
} from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import {
  financialUpdatesSince,
  findAction,
  JOURNAL_SCAN_LIMIT,
  type JournalEntry,
} from '../executor/journal-read';
import type { ActionRecord } from '../executor/types';
import type { Identity } from '../identity';
import {
  CONTRACT_MONEY_MOVEMENT,
  formatRuleLabel,
  patternFromTransactionTitle,
  RULE_PATTERN,
  RULE_TARGET,
} from '../memory/rules';
import { memoryRulesWhere } from '../memory/select';
import type { CompileCtx } from '../query/compile-ast';
import { queryContext } from '../query/context';
import { refTargetMembershipSql } from '../registry/ref';
import type { Card } from '../tools/registry';

/**
 * ОСТАТОК C С НАЗВАННОЙ ГРАНИЦЕЙ (§С1-4, места Z2-89 и Z2-90; правило 5 «почему кодом»).
 *
 * Три якоря ниже и сшивка пар «было → стало» остаются РУКОПИСНЫМ кодом и после переноса
 * журнала на свойства. Граница у каждого своя и названа:
 *  • Z2-89, якоря: эскалация целиком — кандидат в рутину над тремя контрактами («деньги»,
 *    «категоризуемость», «память»). Пока контрактов нет (часть Б), список носителей
 *    выражать нечем, и литералы честнее выдуманной обобщённости;
 *  • Z2-90, сшивка: суждение «две одинаковые правки = намерение владельца» — эвристика, а
 *    не предикат. Языком запросов Q она не выражается (это не «какие сущности», а «что
 *    значит повтор»), правилом каталога — тоже: у правила нет входа «история журнала».
 *    За границей рода она и остаётся; V2 делает её правилом-данными (§Б4-3).
 *
 * Что реформа здесь ВСЁ-ТАКИ поменяла: адрес. Категория перестала быть полем внутри
 * аспект-ключа и стала свойством по id — эвристика читает её по новому адресу, оставаясь
 * той же эвристикой.
 */
/** Слитое свойство категории (§А8/В1): его объявляют и транзакция, и конверт. */
const FINANCE_CATEGORY = 'orbis/finance_category';
/** Окно скана журнала и окно подавления повторного предложения — §7.8, 30 дней. */
const WINDOW_DAYS = 30;
/** «После двух одинаковых исправлений» (§7.8), считая текущее. */
const MIN_CORRECTIONS = 2;

/**
 * Потолок длины паттерна — защита JSONB, не бизнес-правило (та же конвенция, что у
 * `bank_txn_id: max(128)`). Паттерн приходит из заголовка транзакции, у которого верхней
 * границы нет, и ложится в append-only `chat_messages`, откуда его не удалить; дальше его
 * читает КАЖДЫЙ `alreadyOffered` на каждой рекатегоризации и считает по нему левенштейн.
 * Ограничение стоит с обеих сторон: на входе процедуры отказа и здесь, у генератора, —
 * иначе кнопка «Не надо» на длинной карточке отдавала бы 400 и карточка висела бы вечно.
 */
export const RULE_PATTERN_MAX = 128;

export interface SuggestRuleResult {
  suggested: boolean;
  /** Почему предложения нет — для диагностики и тестов; наружу (в UI) не уходит. */
  reason?: string;
}

interface Recategorization {
  entityId: string;
  from: string;
  to: string;
}

/** UTC-сутки записи — бакет ключа идемпотентности сообщений, не бизнес-«сегодня». */
function idDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Категория в полезной нагрузке ЖУРНАЛА (§А7-4): плоское свойство по id, а не поле внутри
 * аспект-ключа. Адрес один на обе половины записи — и на `operations`, и на `inverse`.
 */
function categoryOf(payload: Record<string, unknown>): string | undefined {
  const props = payload.props as Record<string, unknown> | undefined;
  const ref = props?.[FINANCE_CATEGORY];
  return typeof ref === 'string' ? ref : undefined;
}

/**
 * Та же категория, но во ВХОДЕ операции, а не в журнале. Адрес ОДИН — `props` (§А9-1).
 *
 * Форм тут было две, и вторая (старая карта `{аспект: {поле: …}}`) умерла вместе с
 * ПЕРЕВОДОМ ОТПРАВИТЕЛЕЙ: правку категории делают ровно два пути — web (переведён Задачей
 * 13c) и подтверждение CSV-импорта (переведено Задачей 18, `import/review.ts`), и оба шлют
 * `props`. Union старой карты в exec-надмножестве при этом ЖИВ до «Пересева мира» (РП-3):
 * его держат фикстуры сьютов, а не отправители. Ветка здесь снята именно поэтому — она
 * отвечала бы на форму, которой ни один живой вызов больше не присылает, и первый же тест
 * на ней подтверждал бы работоспособность мёртвого пути.
 */
function categoryInInput(input: Record<string, unknown>): string | undefined {
  return categoryOf(input);
}

/**
 * Пары (прежняя, новая) категории из ОДНОГО action журнала. Решение K5: одинаково
 * разбираются все три типа — 'entity_updated' (одна операция), 'batch' и 'action' (§Б6-4;
 * плоский operations, агрегированный inverse, entity_id=null); пары сшиваются по payload.id.
 * entity_create в batch отсеивается сам: его inverse — архивация, без свойств.
 * Опора на форму journal-payload'а executor'а (executor.ts prepareEntityUpdate): обе
 * половины записи — дельты состояний, и категория лежит в них плоским свойством (§А7-4).
 *
 * Категория, которой ДО правки не было, парой не становится: `from` остаётся undefined
 * (в inverse она приезжает списком `unset`, а не значением). Это то же поведение, что и
 * до реформы, и оно верное — «поставили категорию впервые» исправлением не является.
 */
function extractRecategorizations(action: EscalationAction): Recategorization[] {
  const before = new Map<string, string>();
  for (const op of action.inverse) {
    if (op.op !== 'entity_update') continue;
    const id = op.payload.id;
    const ref = categoryOf(op.payload);
    if (typeof id === 'string' && ref !== undefined) before.set(id, ref);
  }
  const out: Recategorization[] = [];
  for (const op of action.operations) {
    if (op.op !== 'entity_update') continue;
    const id = op.payload.id;
    if (typeof id !== 'string') continue;
    const to = categoryOf(op.payload);
    const from = before.get(id);
    if (to === undefined || from === undefined || from === to) continue;
    out.push({ entityId: id, from, to });
  }
  return out;
}

/**
 * Потолок выборки скана (K18 / урок C6) живёт у API журнала вместе с самим сканом; здесь — реэкспорт ради
 * теста эскалации, который меряет усечение.
 */
export { JOURNAL_SCAN_LIMIT };

/**
 * Что эскалация читает из записи журнала: id (исключить текущее действие) и обе половины правки. Структурный
 * тип, а не `ActionRecord`: действие приходит и записью API журнала (`JournalEntry`), и прежней формой.
 */
type EscalationAction = Pick<ActionRecord, 'id' | 'operations' | 'inverse'>;

/**
 * Записи журнала владельца за 30 дней, чьё действие ПЕРЕНОСИЛО что-то в одну из названных
 * категорий — `journal-read.financialUpdatesSince` (РП-9). Отменённые действия и записи
 * отмены туда не попадают: «исправил → отменил → исправил» не должно считаться двумя
 * исправлениями.
 *
 * Проба — ПО ЗНАЧЕНИЮ категории и по `op:'entity_update'` (почему именно так — докблок
 * `financialUpdatesSince`). Значение известно и без журнала: `considerOne` считает только
 * исправления с ТОЙ ЖЕ парой категорий, что у текущего действия, поэтому список `to` — ровно
 * то, что скану и нужно. Окно — 30 дней от «сейчас» (§7.8).
 *
 * Экспортируется ради теста: проба — самая хрупкая часть эскалации, и «лишние
 * прочитанные строки» никак иначе не наблюдаемы.
 */
export async function scanFinancialUpdates(
  tx: Tx,
  graph: GraphId,
  toCategoryIds: readonly string[],
): Promise<JournalEntry[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return financialUpdatesSince(tx, graph, since, [...toCategoryIds]);
}

/**
 * Рекатегоризации журнала владельца за 30 дней В ТЕ ЖЕ категории, что и текущее действие,
 * кроме него самого.
 *
 * Сужение по `to` — не оптимизация, а условие индексируемости пробы (см. `scanFinancialUpdates`):
 * у containment'а нет предиката «ключ есть, значение любое». Оно же ничего не теряет:
 * `considerOne` берёт из журнала ровно те исправления, у которых пара категорий совпадает
 * с текущим, — всё остальное он отфильтровал бы и сам.
 */
async function journalRecategorizations(
  tx: Tx,
  graph: GraphId,
  action: EscalationAction,
  toCategoryIds: readonly string[],
): Promise<Recategorization[]> {
  const out: Recategorization[] = [];
  for (const found of await scanFinancialUpdates(tx, graph, toCategoryIds)) {
    if (found.id === action.id) continue;
    out.push(...extractRecategorizations(found));
  }
  return out;
}

/**
 * «Одинаковое исправление» — сравнение ТОЛЬКО по паттернам правила. На боевых форматах
 * выписки сырое сравнение не срабатывает именно в самом частом реальном случае (один
 * мерчант, разные числовые хвосты): ('ПЯТЕРОЧКА 843','ПЯТЕРОЧКА 999') = 0.769,
 * ('ЯНДЕКС.ТАКСИ 450','ЯНДЕКС.ТАКСИ 1200') = 0.824 — обе ниже порога 0.85, хотя
 * patternFromTransactionTitle у обеих сторон даёт ОДИН образец.
 *
 * Запасного пути по сырым заголовкам НЕТ (D5b п.1): он давал ложные пары через
 * containment — counterpartySimilarity('ПЯТЕРОЧКА 843','843') = 1.0 (общий токен «843»
 * — весь второй заголовок), то есть «843» и «ПЯТЕРОЧКА 843» считались одним и тем же
 * исправлением, и правило предлагалось по одной-единственной правке мерчанта. Сравнение
 * по паттернам самодостаточно: нормализация — сужение (общий паттерн переживает шум,
 * которого сырые строки не переживают), а исправление с пустым паттерном сюда не
 * доходит вовсе — его отсекает гейт empty_pattern.
 */
function sameCorrection(a: string, b: string): boolean {
  return (
    counterpartySimilarity(patternFromTransactionTitle(a), patternFromTransactionTitle(b)) >=
    DUP_SIMILARITY_THRESHOLD
  );
}

async function titleOf(tx: Tx, id: string): Promise<string | undefined> {
  const rows = await tx.select({ title: entities.title }).from(entities).where(eq(entities.id, id));
  return rows[0]?.title;
}

/**
 * Название категории — для ТЕКСТА предложения и генерируемой подписи правила. Связью
 * правила с категорией оно быть перестало (В7): связь — ссылка `orbis/rule_target` по id,
 * поэтому переименование категории правило больше не отвязывает, а подпись пересобирается
 * при чтении (`llm/context.ts`).
 *
 * «Что такое категория» здесь БОЛЬШЕ НЕ РЕШАЕТСЯ: множество берётся из `target` свойства
 * `orbis/finance_category` (§А6-1) — того самого, чью правку эскалация и разбирает. Прежде
 * рядом стоял свой предикат по аспекту, и это была вторая правда: расширь владелец цель
 * ссылки своей строкой реестра — запись прошла бы валидатором и молча не дала бы правила.
 *
 * ПОВЕДЕНИЕ ПРИ ЭТОМ ИЗМЕНИЛОСЬ, и в лучшую сторону: прежний предикат
 * `'orbis/category' = ANY(aspects)` архивность НЕ фильтровал, и исправление в УБРАННУЮ
 * категорию доходило до предложения правила — правило рождалось мёртвым, потому что
 * применять его было бы некуда. Множество цели даёт `NOT archived` умолчанием (§6.1), и
 * такое исправление теперь честно отсекается тем же `category_not_found`.
 *
 * `undefined` — «категорией не является либо невидима»: у эскалации это штатный исход
 * (`category_not_found`), а не отказ, поэтому проверка НЕ бросающая.
 */
async function categoryTitleOf(
  tx: Tx,
  compileCtx: () => Promise<CompileCtx>,
  id: string,
): Promise<string | undefined> {
  const ctx = await compileCtx();
  const def = ctx.reg.properties.get(FINANCE_CATEGORY);
  // Сломанный реестр не роняет пост-коммитный путь: правила просто не предлагаются.
  if (def === undefined || def.type.kind !== 'ref') return undefined;
  const rows = (await tx.execute(sql`
    SELECT title FROM entities
     WHERE id IN (${refTargetMembershipSql(def.type, [id], ctx)})`)) as unknown as Array<{
    title: string;
  }>;
  return rows[0]?.title;
}

async function titlesOf(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ title: entities.title })
    .from(entities)
    .where(inArray(entities.id, ids));
  return rows.map((r) => r.title);
}

/**
 * Активное (неархивное — §7.4) правило того же смысла уже есть. Эквивалентность — ПАРА
 * СВОЙСТВ (В7): тот же образец после normalizeCounterparty и ТА ЖЕ ЦЕЛЬ ПО ID.
 *
 * Сравнение цели по id, а не по названию, чинит два молчаливых расхождения сразу:
 * переименованная категория переставала быть «той же» (гейт не видел уже созданного
 * правила и предлагал его снова), а два одноимённых конверта были неразличимы.
 *
 * Нормализация применяется к ОБЕИМ сторонам: аргумент `pattern` приходит из
 * `patternFromTransactionTitle`, а `orbis/rule_pattern` — обычное текстовое свойство,
 * которое владелец вправе поправить руками в любом регистре.
 *
 * Отбор — общий селектор (`memory/select.ts`), а не своя копия предиката. Признак
 * носителя в нём обязателен по существу (Р9): снятие аспекта памяти НЕ уносит из `props`
 * ни `orbis/memory_kind`, ни `orbis/rule_scope`, и без аспекта уже снятое правило
 * продолжало бы глушить предложение нового.
 */
async function hasEquivalentRule(tx: Tx, pattern: string, targetId: string): Promise<boolean> {
  const rows = await tx
    .select({ props: entities.props })
    .from(entities)
    .where(memoryRulesWhere(CONTRACT_MONEY_MOVEMENT));
  const wanted = normalizeCounterparty(pattern);
  return rows.some((r) => {
    const props = r.props as Record<string, unknown>;
    if (props[RULE_TARGET] !== targetId) return false;
    const rulePattern = props[RULE_PATTERN];
    return typeof rulePattern === 'string' && normalizeCounterparty(rulePattern) === wanted;
  });
}

/** Карточка предложения/отказа в metadata сообщения — читаем её как чужой JSON. */
interface OfferCard {
  kind?: unknown;
  pattern?: unknown;
  fromCategoryId?: unknown;
  toCategoryId?: unknown;
}

/**
 * Точечная проба: карточка с ТОЧНО этим паттерном и этой парой категорий за 30 дней.
 * Containment по GIN + LIMIT 1 — выборка не усекается никогда, поэтому «уже спрашивали
 * ровно это» не может потеряться за объёмом журнала (D5b п.2). Постфильтра в JS нет и
 * не требуется: containment по массиву поэлементный, значит нашлась карточка, в которой
 * совпали ВСЕ четыре поля пробы.
 */
async function offeredExactly(tx: Tx, pattern: string, rc: Recategorization): Promise<boolean> {
  const probe = (kind: string): string =>
    JSON.stringify({
      cards: [{ kind, pattern, fromCategoryId: rc.from, toCategoryId: rc.to }],
    });
  const rows = await tx.execute(
    sql`SELECT 1 AS ok FROM chat_messages
        WHERE created_at > now() - make_interval(days => ${WINDOW_DAYS})
          AND (metadata @> ${probe('memory_rule_suggestion')}::jsonb
               OR metadata @> ${probe('memory_rule_declined')}::jsonb)
        LIMIT 1`,
  );
  return rows[0] !== undefined;
}

/**
 * Предложение по этой паре категорий уже отправлено ИЛИ отклонено за 30 дней (K4).
 *
 * Два шага, и первый — точная проба выше. Сканирующий шаг ниже ограничен потолком
 * выборки, а направление усечения у него обратное скану журнала: не увидев старую
 * карточку, эскалация предложит ЛИШНЕЕ. Точная проба закрывает самый частый и самый
 * обидный случай такой ошибки — повтор ровно того предложения, от которого пользователь
 * уже отказался, — и стоит один индексный поиск с LIMIT 1.
 *
 * Второй шаг нужен потому, что паттерн сравнивается ПО СХОДСТВУ, а не точным
 * совпадением: иначе подавление обходится сменой паттерна — «пятерочка» и «пятерочка
 * мск» дали бы два предложения по одной паре категорий, а отказ по одному паттерну не
 * подавлял бы предложение по соседнему. Containment по GIN отбирает карточки нужной
 * пары (паттерна в пробе нет — точного равенства уже не требуется), похожесть
 * добирается в JS тем же критерием, что и «одинаковое исправление».
 *
 * Потолок выборки — тот же JOURNAL_SCAN_LIMIT, и берём СВЕЖИЕ: за 30 дней по одной паре
 * категорий карточек может быть лишь горстка — подавление гасит поток после первой.
 */
async function alreadyOffered(tx: Tx, pattern: string, rc: Recategorization): Promise<boolean> {
  if (await offeredExactly(tx, pattern, rc)) return true;
  const probe = (kind: string): string =>
    JSON.stringify({ cards: [{ kind, fromCategoryId: rc.from, toCategoryId: rc.to }] });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages
        WHERE created_at > now() - make_interval(days => ${WINDOW_DAYS})
          AND (metadata @> ${probe('memory_rule_suggestion')}::jsonb
               OR metadata @> ${probe('memory_rule_declined')}::jsonb)
        ORDER BY created_at DESC
        LIMIT ${JOURNAL_SCAN_LIMIT}`,
  );
  for (const row of rows) {
    const cards = (row.metadata as { cards?: OfferCard[] }).cards ?? [];
    for (const card of cards) {
      if (card.kind !== 'memory_rule_suggestion' && card.kind !== 'memory_rule_declined') continue;
      if (card.fromCategoryId !== rc.from || card.toCategoryId !== rc.to) continue;
      if (typeof card.pattern !== 'string') continue;
      if (counterpartySimilarity(card.pattern, pattern) >= DUP_SIMILARITY_THRESHOLD) return true;
    }
  }
  return false;
}

async function considerOne(
  tx: Tx,
  graphId: GraphId,
  compileCtx: () => Promise<CompileCtx>,
  loadJournal: () => Promise<Recategorization[]>,
  rc: Recategorization,
): Promise<SuggestRuleResult> {
  const title = await titleOf(tx, rc.entityId);
  if (title === undefined) return { suggested: false, reason: 'entity_not_found' };
  const pattern = patternFromTransactionTitle(title);
  // «SBOL 1234» → пустой паттерн: правилом такое стать не может, и без этого гейта
  // две «пустые» строки дали бы counterpartySimilarity === 1 (normalize.ts §7)
  if (pattern === '') return { suggested: false, reason: 'empty_pattern' };
  // Длинный паттерн правилом не станет: он ушёл бы в неудаляемую строку журнала и
  // читался бы каждым последующим подавлением (см. RULE_PATTERN_MAX).
  if (pattern.length > RULE_PATTERN_MAX) return { suggested: false, reason: 'pattern_too_long' };
  const categoryTitle = await categoryTitleOf(tx, compileCtx, rc.to);
  if (categoryTitle === undefined) return { suggested: false, reason: 'category_not_found' };

  // Гейт подавления стоит ДО скана журнала намеренно: на уже предложенной или
  // отклонённой паре ответ известен из узкой пробы по GIN (карточки одной пары
  // категорий за 30 дней), и сканировать журнал незачем. Порядок влияет только на
  // reason (диагностика), не на исход.
  if (await alreadyOffered(tx, pattern, rc)) {
    return { suggested: false, reason: 'already_suggested' };
  }

  // «Одинаковое исправление» — та же пара категорий И похожий контрагент (sameCorrection:
  // ТОЛЬКО по паттернам правила, запасного пути по сырым заголовкам нет — D5b п.1).
  // Считаем по РАЗНЫМ сущностям: правки одной и той же транзакции туда-обратно —
  // сомнения пользователя, а не повторяющийся паттерн.
  const others = (await loadJournal()).filter(
    (c) => c.from === rc.from && c.to === rc.to && c.entityId !== rc.entityId,
  );
  const otherTitles = await titlesOf(tx, [...new Set(others.map((c) => c.entityId))]);
  const same = otherTitles.filter((t) => sameCorrection(title, t)).length;
  if (same + 1 < MIN_CORRECTIONS) return { suggested: false, reason: 'not_repeated' };

  if (await hasEquivalentRule(tx, pattern, rc.to)) {
    return { suggested: false, reason: 'rule_exists' };
  }

  const ruleText = formatRuleLabel(pattern, categoryTitle);
  // Решение K3: дискриминант карточки — kind. Поля обязаны дословно совпадать с
  // web-типом MemoryRuleSuggestionData (задача D3b) — union'ы намеренно не общие.
  const card: Card = {
    kind: 'memory_rule_suggestion',
    ruleText,
    pattern,
    fromCategoryId: rc.from,
    toCategoryId: rc.to,
    categoryTitle,
  };
  const threadId = await ensureGlobalThread(tx, graphId);
  await appendMessageIdempotent(tx, {
    id: memoryRuleSuggestionId({
      graphId,
      pattern,
      fromCategoryId: rc.from,
      toCategoryId: rc.to,
      date: idDate(),
    }),
    threadId,
    role: 'system',
    // «не первый раз», а не «второй»: после истечения 30-дневного окна подавления
    // предложение может прийти и на третье исправление — врать в тексте не будем
    content: `Вы уже не первый раз переносите это в «${categoryTitle}». Запомнить правило «${ruleText}»?`,
    metadata: { cards: [card] },
  });
  return { suggested: true };
}

/**
 * Вызывается ПОСЛЕ успешного execute() рекатегоризации (K7). Счётчик нигде не
 * хранится — считается сканом журнала за 30 дней (§7.8). Действие с несколькими
 * рекатегоризациями (batch) рассматривается по порядку до первого предложения:
 * одно системное сообщение на действие.
 */
export async function maybeSuggestRule(deps: {
  db: Db;
  identity: Identity;
  action: EscalationAction;
}): Promise<SuggestRuleResult> {
  const recats = extractRecategorizations(deps.action);
  if (recats.length === 0) return { suggested: false, reason: 'not_recategorization' };
  return withIdentity(deps.db, deps.identity, async (tx) => {
    // Скан журнала — один на ДЕЙСТВИЕ, а не на операцию: аргументы у всех итераций
    // одинаковы, а сам скан тянет до JOURNAL_SCAN_LIMIT строк JSONB. До этого «перенеси
    // эти 10 покупок из Еды в Развлечения» давал 10 одинаковых сканов подряд, синхронно,
    // до ответа модели. Лениво, а не безусловным подъёмом наверх: у одиночной
    // рекатегоризации с уже отправленным предложением скана не бывает вовсе (гейт
    // подавления стоит раньше), и подъём заставил бы платить за него на пустом месте.
    let journal: Recategorization[] | undefined;
    // Контекст компиляции — один на действие и ЛЕНИВЫЙ по той же причине, что и скан
    // журнала: он стоит загрузки реестров и настроек владельца, а до `categoryTitleOf`
    // доходят не все рекатегоризации (гейты паттерна отвечают раньше).
    let compiled: Promise<CompileCtx> | undefined;
    const compileCtx = (): Promise<CompileCtx> => {
      compiled ??= queryContext(tx, deps.identity.graph, null);
      return compiled;
    };
    const targets = recats.map((rc) => rc.to);
    const loadJournal = async (): Promise<Recategorization[]> => {
      journal ??= await journalRecategorizations(tx, deps.identity.graph, deps.action, targets);
      return journal;
    };
    let last: SuggestRuleResult = { suggested: false, reason: 'not_recategorization' };
    for (const rc of recats) {
      last = await considerOne(tx, deps.identity.graph, compileCtx, loadJournal, rc);
      if (last.suggested) return last;
    }
    return last;
  });
}

/** Операция мутации в форме, в которой её видит executor: имя тула + его input. */
interface MutationOp {
  tool: string;
  input: unknown;
}

/**
 * Дешёвый гейт вызова (DF п.1): хоть одна операция действия — entity_update, меняющий
 * категорию. Смотрим на ОПЕРАЦИИ, а не на имя тула: групповую рекатегоризацию план
 * требует слать одним batch_execute, и гейт по имени «entity_update» отсекал её целиком.
 * Читающая половина к батчу готова и без этого (extractRecategorizations разбирает плоский
 * operations действия type='batch').
 *
 * Читается ВХОД операции, а не журнал, поэтому и адрес здесь двойной — см. `categoryInInput`.
 */
function touchesCategoryRef(operations: readonly MutationOp[]): boolean {
  return operations.some((op) => {
    if (op.tool !== 'entity_update') return false;
    const input = op.input;
    if (typeof input !== 'object' || input === null) return false;
    return categoryInInput(input as Record<string, unknown>) !== undefined;
  });
}

/**
 * Точка вызова для роутера entity.update и диспатча тулов (K7): читает записанный
 * action и зовёт эскалацию отдельной транзакцией. Ошибка ЛОГИРУЕТСЯ и не
 * пробрасывается — правки уже закоммичены, и провал предложения не имеет права их
 * ронять. Дешёвый гейт по операциям: журнал читаем, только если действие трогало
 * category_ref, — entity.update зовётся на каждую правку заголовка/тега.
 */
export async function escalateAfterMutation(
  db: Db,
  args: { identity: Identity; actionId: string; operations: readonly MutationOp[] },
): Promise<void> {
  if (!touchesCategoryRef(args.operations)) return;
  try {
    const action = await withIdentity(db, args.identity, (tx) =>
      findAction(tx, args.identity.graph, args.actionId),
    );
    if (action) await maybeSuggestRule({ db, identity: args.identity, action });
  } catch (e) {
    console.error('[ai.escalation] предложение правила не записано:', e);
  }
}

/**
 * Отказ от предложения (кнопка «Не надо», D3b). Журнал append-only (§4.6) — карточка
 * предложения не правится, пишется НОВОЕ системное сообщение с карточкой
 * memory_rule_declined (K4). Идемпотентность — детерминированный PK по паре, паттерну
 * и дате: повтор в те же сутки возвращает исходное сообщение вместо второй карточки.
 */
export async function declineRuleSuggestion(
  db: Db,
  args: { identity: Identity; pattern: string; fromCategoryId: string; toCategoryId: string },
): Promise<{ alreadyDeclined: boolean }> {
  const card: Card = {
    kind: 'memory_rule_declined',
    pattern: args.pattern,
    fromCategoryId: args.fromCategoryId,
    toCategoryId: args.toCategoryId,
  };
  return withIdentity(db, args.identity, async (tx) => {
    const threadId = await ensureGlobalThread(tx, args.identity.graph);
    const { replayed } = await appendMessageIdempotent(tx, {
      id: memoryRuleDeclinedId({
        graphId: args.identity.graph,
        pattern: args.pattern,
        fromCategoryId: args.fromCategoryId,
        toCategoryId: args.toCategoryId,
        date: idDate(),
      }),
      threadId,
      role: 'system',
      content: 'Правило не создаём',
      metadata: { cards: [card] },
    });
    return { alreadyDeclined: replayed };
  });
}
