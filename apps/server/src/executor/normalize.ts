// apps/server/src/executor/normalize.ts
// Доменные нормализации стадии 4 (§2.1, §3.2, §3.3, §4.1, §9.2) — переписанные на `props`
// (§А7-2: доменные инварианты части А остаются кодом, но адресуют свойства по id).
//
// Слияние состояния отсюда УШЛО: `mergeAspects` заменил `applyPropsPatch` (props.ts) —
// единица слияния стала свойством, а не полем внутри аспект-ключа. Здесь остались ровно
// доменные правила, каждое из которых спрашивает у состояния две вещи: несёт ли сущность
// аспект (список `aspects[]`) и какое у неё значение свойства (`props` по id).
import { ExecError } from './errors';
import type { EntityState } from './props';

/**
 * Старая карта аспектов. Живёт до «Пересева мира»: её всё ещё читают CAS-предусловия
 * (старая форма над проекцией — Задача 5), бюджет-хук и карточки. Единица слияния — уже
 * свойство, поэтому здесь это тип ЧТЕНИЯ проекции, а не рабочая форма исполнителя.
 */
export type AspectData = Record<string, unknown>;
export type AspectsMap = Record<string, AspectData>;

/** Теги нормализуются в нижний регистр и дедуплицируются (порядок первого вхождения). */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.toLowerCase()))];
}

/** Инлайн-ссылки body: [[entity:uuid]] и [[entity:uuid|текст]] (§2.1). */
export const BODY_REFS_RE = /\[\[entity:([0-9a-f-]{36})(?:\|[^\]]*)?\]\]/gi;

/** body_refs извлекаются при каждом create/update, затрагивающем body; lowercase + dedupe. */
export function extractBodyRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(BODY_REFS_RE)) {
    const id = m[1];
    if (id) refs.add(id.toLowerCase());
  }
  return [...refs];
}

/**
 * Переходы `orbis/task_status` ↔ `orbis/completed_at` (§3.2) над РЕЗУЛЬТАТОМ слияния:
 * переход в done без переданной даты — проставить clock(); уход из done — очистить дату.
 * Мутирует `next.props`.
 *
 * Зовётся ровно тогда, когда патч ТРОНУЛ статус (и сущность несёт `orbis/task`). Прежний
 * гейт был «патч тронул аспект задачи»; он шире, но разницы не даёт: при неизменном статусе
 * оба условия перехода ложны по построению. Узкий гейт при этом честнее называет, от чего
 * зависит правило.
 */
export function applyTaskCompletion(prev: EntityState, next: EntityState, now: Date): void {
  const prevStatus = prev.props[TASK_STATUS];
  const nextStatus = next.props[TASK_STATUS];
  if (nextStatus === 'done' && prevStatus !== 'done' && next.props[COMPLETED_AT] === undefined) {
    next.props[COMPLETED_AT] = now.toISOString();
  }
  if (prevStatus === 'done' && nextStatus !== 'done') {
    delete next.props[COMPLETED_AT];
  }
}

/** id свойств, которые доменные нормализации адресуют по имени (§А8). */
export const TASK_STATUS = 'orbis/task_status';
export const COMPLETED_AT = 'orbis/completed_at';
const CARRYOVER = 'orbis/carryover';
const RECURRENCE = 'orbis/recurrence';
const RECURRING = 'orbis/recurring';
const OCCURRED_ON = 'orbis/occurred_on';

/**
 * Свойства, задающие ИДЕНТИЧНОСТЬ конверта (03-budget §2.1): по этой четвёрке он уникален,
 * по ней же его находят транзакции. Список тот же, что у `assertEnvelopeUnique`.
 */
const ENVELOPE_IDENTITY = [
  'orbis/finance_category',
  'orbis/currency',
  'orbis/period_start',
  'orbis/period_end',
] as const;

/**
 * Перенос остатка (`orbis/carryover`) не переживает смену идентичности конверта.
 *
 * Перенос — это «сколько осталось от ПРОШЛОГО периода ЭТОЙ категории», и он входит в
 * `effectiveLimit = limit + carryover` (03-budget §2.6, `budget/aggregates.ts:264`). Стоит
 * владельцу перенести конверт на новый период (или на другую категорию/валюту), и прежний
 * остаток перестаёт что-либо значить: он посчитан не про этот период. Оставить его значило
 * бы молча завысить лимит — и не отказом, который видно, а числом, которое врёт и в Overview,
 * и в подсказках модели.
 *
 * ПОЧЕМУ ПРАВИЛОМ, А НЕ ПРАВОМ ЗАПИСИ. Соблазн был решить это гейтом флагов: раз `carryover`
 * — `system_writable`, пусть замена носителя его и снимает, как снимала до реформы. Но гейт
 * отвечает на вопрос «вправе ли этот механизм трогать свойство», а здесь вопрос другой —
 * «осмысленно ли ещё это значение». Их разведение и есть суть §А2-5: право у свойства одно на
 * все пути, а смысл значения зависит от домена. Классифицировать служебные свойства на
 * «переживающие замену» и «нет» пришлось бы руками, вторым списком без опоры на реестр —
 * ровно та вторая копия знания, которую реформа и убирает.
 *
 * УСТАРЕВШИМ считается только тот перенос, которого патч НЕ КАСАЛСЯ. Тронул сам патч —
 * значит значение про НОВУЮ идентичность, и стирать его нельзя: продление конверта правкой
 * («сменить период и положить новый остаток» — 03-budget §3.5) законно и одним действием.
 * Признак — `touchedProperties` патча, а не сравнение значений: перенос мог совпасть с
 * прежним по числу, оставаясь новым по смыслу. Это же условие поглощает и создание конверта
 * правилом rollover: оно кладёт перенос своим же патчем.
 *
 * ЦЕНА, НАЗВАННАЯ ВСЛУХ: косвенно владелец может снять перенос двумя сменами идентичности
 * (сменить валюту и вернуть обратно — правило сработает на первом шаге); это законно по
 * 03-budget §3.5 (обнулять переносы — его право), а undo возвращает значение.
 *
 * Мутирует `next.props`. Внутренний undo его не зовёт: тот восстанавливает зафиксированное
 * состояние дословно, и «поправить» откат значило бы разойтись с журналом.
 */
export function dropStaleCarryover(
  prev: EntityState,
  next: EntityState,
  touched: ReadonlySet<string>,
): void {
  if (!next.aspects.includes('orbis/budget')) return;
  if (next.props[CARRYOVER] === undefined || touched.has(CARRYOVER)) return;
  const identityChanged = ENVELOPE_IDENTITY.some(
    (id) => !sameScalar(prev.props[id], next.props[id]),
  );
  if (identityChanged) delete next.props[CARRYOVER];
}

/** Значения идентичности конверта — скаляры (uuid, код валюты, даты); сравнение по канону. */
function sameScalar(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `orbis/recurrence` на сущности, НЕСУЩЕЙ `orbis/schedule`, — признак шаблона повторения
 * (§3.1). Аспект в условии обязателен, а не избыточен: значение свойства переживает снятие
 * аспекта (Р9), и без проверки списка снятое расписание продолжало бы делать транзакцию
 * шаблоном — то есть отвязывало бы её от конверта навсегда.
 */
function hasScheduleRecurrence(state: EntityState): boolean {
  if (!state.aspects.includes('orbis/schedule')) return false;
  const recurrence = state.props[RECURRENCE];
  return typeof recurrence === 'object' && recurrence !== null;
}

/**
 * true, если валидность зависит от входящей derived_from-связи (§3.3): `orbis/recurring`
 * без recurrence легален только на инстансе шаблона. Наличие связи резолвит вызывающая
 * сторона (executor) — БД плюс связи, создаваемые тем же batch.
 */
export function financialRecurringNeedsDerivedFrom(state: EntityState): boolean {
  if (!state.aspects.includes('orbis/financial')) return false;
  return state.props[RECURRING] === true && !hasScheduleRecurrence(state);
}

/**
 * Financial-инвариант §3.3 над ФИНАЛЬНЫМ состоянием сущности:
 * - `orbis/recurring` = true валиден при `orbis/recurrence` на той же сущности (шаблон)
 *   ИЛИ при входящей derived_from-связи (инстанс шаблона);
 * - не-шаблон обязан иметь `orbis/occurred_on`.
 *
 * Молчит, если сущность не несёт `orbis/financial`: инвариант — про транзакцию, а не про
 * значение суммы, оставшееся на записи после снятия аспекта (Р9).
 */
export function assertFinancialInvariant(state: EntityState, hasIncomingDerivedFrom = false): void {
  if (!state.aspects.includes('orbis/financial')) return;
  if (state.props[RECURRING] === true) {
    if (!hasScheduleRecurrence(state) && !hasIncomingDerivedFrom) {
      throw new ExecError(
        'INVARIANT',
        'orbis/financial.recurring=true валиден только на шаблоне с orbis/schedule.recurrence или на инстансе с входящей derived_from (§3.3)',
        { invariant: 'financial_recurring_requires_recurrence' },
      );
    }
  } else if (state.props[OCCURRED_ON] === undefined) {
    throw new ExecError(
      'INVARIANT',
      'orbis/financial без recurring обязан иметь occurred_on (§3.3)',
      { invariant: 'financial_requires_occurred_on' },
    );
  }
}

/**
 * «Вход несёт СВОЁ тело» — единственное место, где это решается для засева (С10).
 *
 * Пустая и пробельная СТРОКА телом не считается: канон схлопывает её в '', то есть автор
 * ничего не написал, а `body: ''` модель присылает сплошь и рядом (тул-контракт разрешает,
 * и приёмка 1 — проект, заведённый чатом через entity_create, — идёт ровно этим путём).
 * Считать её телом значило бы отдавать пустой проект вместо заготовки в самом частом сценарии.
 *
 * ДОКУМЕНТ во входе — тело ВСЕГДА, даже пустой: bodyDoc шлёт редактор (UI-путь), и там
 * пустой документ это результат осознанной правки — «я стёр всё», — а не отсутствие ввода.
 * Подменять её заготовкой было бы затиранием действия автора.
 */
export function hasBodyInInput(input: { body?: string; bodyDoc?: unknown }): boolean {
  return (input.body !== undefined && input.body.trim() !== '') || input.bodyDoc !== undefined;
}

/**
 * Пора ли засеять заготовку тела проекта (С10). Условия все четыре и все обязательны:
 * аспект orbis/project ПОЯВЛЯЕТСЯ (а не правится — иначе смена stage перезасевала бы тело),
 * тело сейчас пусто и своего тела вход не несёт (заготовка никогда не затирает написанное).
 *
 * Функция чистая и живёт здесь, а не в executor'е, ровно потому, что её три вызывающих
 * (create / update / attach) обязаны спрашивать ОДНО И ТО ЖЕ: «пустое тело» — это условие
 * поведения, а не деталь одной ветки.
 *
 * `currentBody` — тело ДО операции (у create — канон входа, то есть ''), `bodyInInput` —
 * признак «вход несёт СВОЁ тело», и считает его hasBodyInInput() выше: пустая строка телом НЕ
 * считается (её канон — то же самое пустое тело), пустой документ — считается.
 */
export function needsProjectSeed(
  prev: EntityState | undefined,
  next: EntityState,
  currentBody: string,
  bodyInInput: boolean,
): boolean {
  return (
    next.aspects.includes('orbis/project') &&
    prev?.aspects.includes('orbis/project') !== true &&
    currentBody.trim() === '' &&
    !bodyInInput
  );
}
