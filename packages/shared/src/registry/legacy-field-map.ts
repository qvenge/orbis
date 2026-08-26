/**
 * ПЕРЕХОДНАЯ карта «поле старого аспекта → свойство словаря» и перевод сущности старой
 * формы (`aspects: {id: {поле: значение}}`) в новую (`props: {id свойства: значение}`).
 *
 * Файл живёт ровно до Задачи 23: он нужен, пока в графе и в тестах есть данные старой
 * формы — golden-корпус приёмки §С8-1 прогоняет один и тот же вход двумя валидаторами, и
 * без этой карты «один и тот же вход» не выразить. Вместе с zod-схемами `schemas/aspects.ts`
 * он удаляется целиком (РП-3), поэтому здесь намеренно нет ни кеша, ни обобщений: код
 * с датой смерти не оптимизируют.
 *
 * Таблица ниже — рантайм-двойник снимка §А8, который держит `builtin.test.ts`. Копия
 * намеренна: снимок ДОКАЗЫВАЕТ перевод (он переписан из спеки руками и не выведен из
 * реализации), а эта карта его ИСПОЛНЯЕТ. Схождение двух сторожит тест полноты —
 * `value-schema.test.ts`: каждое поле каждой из тринадцати zod-схем обязано найтись здесь и
 * попасть в свой аспект `BUILTIN_ASPECT_DEFS`.
 *
 * Чего в карте нет: `orbis/agent-run.project_id` — §А8 это поле УДАЛЯЕТ (ручная
 * денормализация, её заменяют вычисляемые `orbis/parent_project`/`orbis/root_project`), и
 * `undefined` здесь — не пробел, а норматив: значение уезжает в `props` под заведомо
 * неизвестным id и получает честный отказ `UNKNOWN_PROPERTY`.
 */

/** Поля тринадцати аспектов в порядке строк §А8. */
const FIELD_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'orbis/schedule': {
    start_at: 'orbis/start_at',
    end_at: 'orbis/end_at',
    duration_min: 'orbis/duration_min',
    all_day: 'orbis/all_day',
    recurrence: 'orbis/recurrence',
    location: 'orbis/location',
    timezone: 'orbis/timezone',
  },
  'orbis/task': {
    status: 'orbis/task_status',
    priority: 'orbis/priority',
    due_date: 'orbis/due_date',
    completed_at: 'orbis/completed_at',
    effort_min: 'orbis/effort_min',
    waiting_for: 'orbis/waiting_for',
  },
  'orbis/financial': {
    amount: 'orbis/amount',
    currency: 'orbis/currency',
    direction: 'orbis/direction',
    category_ref: 'orbis/finance_category',
    occurred_on: 'orbis/occurred_on',
    planned: 'orbis/planned',
    recurring: 'orbis/recurring',
    payment_method: 'orbis/payment_method',
    counterparty: 'orbis/counterparty',
    bank_txn_id: 'orbis/bank_txn_id',
  },
  'orbis/note': { content_type: 'orbis/content_type', pinned: 'orbis/pinned' },
  'orbis/budget': {
    category_ref: 'orbis/finance_category',
    limit: 'orbis/limit',
    currency: 'orbis/currency',
    period_start: 'orbis/period_start',
    period_end: 'orbis/period_end',
    carryover: 'orbis/carryover',
  },
  'orbis/category': {
    icon: 'orbis/icon',
    color: 'orbis/color',
    aliases: 'orbis/aliases',
    spend_class: 'orbis/spend_class',
  },
  'orbis/memory': { kind: 'orbis/memory_kind', scope: 'orbis/rule_scope' },
  'orbis/goal': {
    progress_source: 'orbis/progress_source',
    target_value: 'orbis/target_value',
    current_value: 'orbis/current_value',
    unit: 'orbis/unit',
  },
  'orbis/project': { stage: 'orbis/project_stage' },
  'orbis/repo': { url: 'orbis/repo_url', default_branch: 'orbis/default_branch' },
  'orbis/assignment': {
    executor: 'orbis/executor',
    grant_id: 'orbis/grant',
    assignee: 'orbis/assignee',
    may_close: 'orbis/may_close',
  },
  'orbis/agent-run': {
    grant_id: 'orbis/grant',
    routine_id: 'orbis/run_routine',
    bucket: 'orbis/run_bucket',
    attempt: 'orbis/run_attempt',
    fail_note: 'orbis/fail_note',
    proposal: 'orbis/run_proposal',
    undecided: 'orbis/undecided',
    outcome: 'orbis/run_outcome',
    started_at: 'orbis/run_started_at',
    finished_at: 'orbis/run_finished_at',
    last_step_at: 'orbis/last_step_at',
    step_count: 'orbis/step_count',
    steps: 'orbis/run_steps',
    session_url: 'orbis/session_url',
    report: 'orbis/run_report',
    checkpoint: 'orbis/run_checkpoint',
    reply: 'orbis/run_reply',
    usage: 'orbis/run_usage',
    abandon_note: 'orbis/abandon_note',
  },
  'orbis/routine': {
    stage: 'orbis/routine_stage',
    at: 'orbis/routine_at',
    days: 'orbis/routine_days',
    mode: 'orbis/routine_mode',
    allowed_tools: 'orbis/allowed_tools',
  },
};

export function legacyFieldToProperty(aspectId: string, field: string): string | undefined {
  return FIELD_MAP[aspectId]?.[field];
}

/**
 * Обратный ход. Аспект в аргументах обязателен: три свойства слиты (§А8/В1), и без него
 * `orbis/finance_category` не выбрать между `financial.category_ref` и `budget.category_ref`.
 */
export function propertyToLegacyField(propertyId: string, aspectId: string): string | undefined {
  const fields = FIELD_MAP[aspectId];
  if (fields === undefined) return undefined;
  for (const [field, id] of Object.entries(fields)) {
    if (id === propertyId) return field;
  }
  return undefined;
}

/**
 * Имя, под которым в `props` уезжает поле без карты. Отдельная функция, а не литерал на
 * месте: имя должно быть ЧИТАЕМЫМ в отказе («неизвестное свойство orbis/project_id»), и
 * оно же — ловушка, если однажды совпадёт с настоящим id. Не совпадает: у тринадцати
 * аспектов нет полей `archived`/`title`/`created_at`/`updated_at` (единственные core-имена),
 * и это пиннит тест.
 */
function unmappedPropertyId(field: string): string {
  return `orbis/${field}`;
}

/**
 * Перевод форм значений, которые реформа поменяла ВНУТРИ (а не только переименовала).
 * Экспортируется, потому что тот же перевод обязан делать исполнитель на границе входа
 * (`executor/legacy-form.ts`): вторая копия правил разъехалась бы с этой при первой правке,
 * и вердикты golden-корпуса приёмки §С8-1 перестали бы отвечать за путь записи.
 *
 * 1. `progress_source.query` — строка грамматики стала Q-AST (§А5-2, Р12). Разбирать текст
 *    здесь нечем (парсер Q-AST — Задача 8), поэтому неразобранный запрос заворачивается в
 *    `{text}` — ровно ту форму, которую §А5-2 оставляет неразобранному блоку.
 * 2. `proposal.mismatches[]` — расхождение предусловия называлось парой «аспект + поле», а
 *    единица отката и предусловия стала СВОЙСТВОМ (§А7-3/§А7-4). Перевод идёт через ту же
 *    карту, что и всё остальное, — второго списка соответствий не заводится.
 *
 * Всё, что в эти две формы не укладывается, проходит НЕТРОНУТЫМ: отвергать кривое значение
 * должна схема, а не карта, иначе вердикты старого и нового валидатора разъедутся не там,
 * где реформа что-то решила, а там, где карта что-то додумала.
 */
export function translateLegacyValue(propertyId: string, value: unknown): unknown {
  if (propertyId === 'orbis/progress_source') return translateProgressSource(value);
  if (propertyId === 'orbis/run_proposal') return translateProposal(value);
  return value;
}

/**
 * ОБРАТНЫЙ ход перевода форм — для проекции `props` в старую карту (`aspects_legacy`).
 *
 * Инвертируется ровно то, что инвертируется ТОЧНО: обёртка неразобранного запроса
 * (`{text: строка}` → строка). Больше ничего: у `proposal.mismatches` обратной функции нет
 * (пара «аспект + поле» из id свойства не восстанавливается — слитые свойства и
 * псевдо-аспект `orbis/entity` дают несколько прообразов), и её писатель переведён на новую
 * форму вместо угадывания.
 *
 * Зачем инверсия вообще нужна, хотя §А5-2 объявляет Q-AST правдой: в срезе А старую карту
 * ЧИТАЮТ (прогресс цели разбирает `progress_source.query` своей zod-схемой, где запрос —
 * строка). Проекция, кладущая туда обёртку, молча выключила бы прогресс у каждой цели —
 * без единого отказа, потому что расчёт целей fail-soft по построению.
 */
export function untranslateLegacyValue(propertyId: string, value: unknown): unknown {
  if (propertyId !== 'orbis/progress_source') return value;
  if (!isPlainObject(value)) return value;
  const query = value.query;
  if (!isPlainObject(query)) return value;
  const keys = Object.keys(query);
  if (keys.length !== 1 || keys[0] !== 'text' || typeof query.text !== 'string') return value;
  return { ...value, query: query.text };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function translateProgressSource(value: unknown): unknown {
  if (!isPlainObject(value) || typeof value.query !== 'string') return value;
  return { ...value, query: { text: value.query } };
}

function translateProposal(value: unknown): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.mismatches)) return value;
  return {
    ...value,
    mismatches: value.mismatches.map((item) => {
      if (
        !isPlainObject(item) ||
        typeof item.aspect !== 'string' ||
        typeof item.field !== 'string'
      ) {
        return item;
      }
      const { aspect, field, ...rest } = item;
      return {
        property: legacyFieldToProperty(aspect, field) ?? unmappedPropertyId(field),
        ...rest,
      };
    }),
  };
}

export type LegacyAspects = Record<string, Record<string, unknown>>;

export type LegacyTranslation =
  | { ok: true; props: Record<string, unknown>; aspects: string[] }
  | { ok: false; conflict: { propertyId: string; values: unknown[] } };

/**
 * Сущность старой формы → `props` + список аспектов.
 *
 * Конфликт (В1): слитое свойство получило РАЗНЫЕ значения из двух аспектов — например
 * категория у `orbis/financial` и у `orbis/budget` на одной сущности. В плоской модели это
 * невыразимо, и правильный ответ — отказ, а НЕ «последний выиграл»: молча выбранное
 * значение — это потерянный факт владельца. Сравнение — по канонической записи значения:
 * все три слияния (`finance_category`, `currency`, `grant`) несут строковые тождества, где
 * текст и значение — одно и то же; сравнения decimal «по значению» (§А7-3) им не нужно.
 */
export function legacyAspectsToProps(aspects: LegacyAspects): LegacyTranslation {
  const props: Record<string, unknown> = {};
  const seen = new Map<string, string>(); // propertyId → канонический текст значения
  for (const [aspectId, data] of Object.entries(aspects)) {
    for (const [field, raw] of Object.entries(data)) {
      const propertyId = legacyFieldToProperty(aspectId, field) ?? unmappedPropertyId(field);
      const value = translateLegacyValue(propertyId, raw);
      const canonical = JSON.stringify(value) ?? 'undefined';
      const previous = seen.get(propertyId);
      if (previous !== undefined && previous !== canonical) {
        return { ok: false, conflict: { propertyId, values: [props[propertyId], value] } };
      }
      seen.set(propertyId, canonical);
      props[propertyId] = value;
    }
  }
  return { ok: true, props, aspects: Object.keys(aspects) };
}
