/**
 * Встроенный словарь свойств v1 — таблица §А8 спеки «Реформа свойств» (строки 216–369).
 *
 * Счёт §А8: **73 доменных свойства** = 73 поля тринадцати аспектов − 3 слияния
 * (`financial.category_ref` + `budget.category_ref` → `orbis/finance_category`;
 * `currency` ×2 → `orbis/currency`; `grant_id` ×2 → `orbis/grant`) − 1 удаление
 * (`agent-run.project_id` — ручная денормализация, её заменяют `orbis/parent_project` и
 * `orbis/root_project`) + 4 новых (`parent_project`, `root_project`, `rule_pattern`,
 * `rule_target`; `rule_scope` — переименование `memory.scope`, не новое свойство).
 * Плюс **4 core-проекции** §А1-3 (`storage: 'core'`) — они в счёт словаря не входят: их
 * хранение осталось колонкой, реестр даёт им только единый адрес для Q-AST, CAS и подписи.
 *
 * Чего здесь НЕТ и почему: `orbis/project_id` §А8 удаляет; `orbis/date` и `orbis/weight` §А8
 * называет общими понятиями будущих модулей и прямо оговаривает — в v1 не сеются, потому что
 * «свойство без потребителя — сирота с первого дня».
 *
 * `rank` и `rank` вариантов select — ПОРЯДОК ОБЪЯВЛЕНИЯ, выведенный из позиции в массиве
 * (§А2-1: «Порядок объявления внутри „Свойств“ и в каталоге промпта»; §А2-2: «Порядок
 * сортировки — по rank объявления»). Он не пишется руками намеренно: разъехавшиеся между
 * собой порядок и номер — тот самый молчаливый дефект, из-за которого обязательный
 * `start_at` уже показывается в проде четвёртым (П3 §7.2).
 *
 * Каждая запись ПРОХОДИТ через `propertyDefinitionSchema` при загрузке модуля: словарь,
 * который сам не проходит собственную схему, до сида доехать не должен.
 */
import type { z } from 'zod';
import { type PropertyDefinition, propertyDefinitionSchema } from './property-type';
import type { SelectOption } from './types';

/** Встроенные поля одинаковы у всех 77 записей и проставляются ниже, а не руками. */
type PropertyEntry = Omit<
  z.input<typeof propertyDefinitionSchema>,
  'id' | 'ownerId' | 'key' | 'rank' | 'status'
> & { id: string };

/** Варианты select в порядке объявления; `rank` = позиция, см. шапку файла. */
function options(...items: readonly (readonly [string, string, string])[]): SelectOption[] {
  return items.map(([key, ru, en], index) => ({ key, label: { ru, en }, rank: index + 1 }));
}

// ─── JSON Schema вложенных объектов (§А2-2: вложенное — kind `json`, отдельных kind нет) ───

/**
 * ISO-момент внутри вложенного объекта. Ровно тот же текст, что у `timestampString`
 * (`schemas/aspects.ts:10-12`) и у ветки `timestamp` генератора схем: у четырёх полей
 * прогона (`proposal.decided_at`, `steps[].at`, `checkpoint.asked_at`, `reply.at`) момент
 * лежит НЕ отдельным свойством, а внутри json-значения, и словарь типов до него не
 * достаёт. Без этой строки перевод молча ослабил бы четыре поля до голой строки — golden
 * на валидных сущностях такого не видит, потому в корпусе на каждое из четырёх заведена
 * негативная фикстура («вчера»).
 */
const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';

/** `schedule.recurrence` — `aspects.ts:39-47`. */
const RECURRENCE_SCHEMA = {
  type: 'object',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    interval: { type: 'integer', minimum: 1 },
    byweekday: { type: 'array', items: { type: 'string' } },
    until: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
  required: ['freq', 'interval'],
  additionalProperties: false,
};

/**
 * `goal.progress_source` — `aspects.ts:131-142`. Дискриминируемый союз, а не объект с
 * `.refine`: правило «field обязателен для sum и latest» обязано дожить до ajv, который
 * валидирует по реестру. Внутренний `query` хранится Q-AST (Р12/§А5-2), поэтому здесь он
 * объект, а не строка; его форму сужает Задача 8 вместе с каноном Q-AST.
 */
const PROGRESS_SOURCE_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: { query: { type: 'object' }, aggregate: { const: 'count' } },
      required: ['query', 'aggregate'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        query: { type: 'object' },
        aggregate: { type: 'string', enum: ['sum', 'latest'] },
        field: { type: 'string', minLength: 1 },
      },
      required: ['query', 'aggregate', 'field'],
      additionalProperties: false,
    },
  ],
};

/** `agent-run.proposal` — `aspects.ts:234-254`. */
const RUN_PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    pending_id: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'superseded', 'stale'],
    },
    decided_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    mismatches: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          note: { type: 'string', maxLength: 500 },
        },
        required: ['property', 'note'],
        additionalProperties: false,
      },
    },
    edited_from: { type: 'string', format: 'uuid' },
  },
  required: ['pending_id', 'status'],
  additionalProperties: false,
};

/** `agent-run.steps` — элемент журнала шагов, `aspects.ts:193-201`. */
const RUN_STEP_SCHEMA = {
  type: 'object',
  properties: {
    seq: { type: 'integer', minimum: 1 },
    at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    external: { type: 'boolean' },
    action_id: { type: 'string', format: 'uuid' },
  },
  required: ['seq', 'at', 'summary', 'external'],
  additionalProperties: false,
};

/** `agent-run.checkpoint` — `aspects.ts:271-274`. */
const RUN_CHECKPOINT_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 4000 },
    asked_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
  },
  required: ['question', 'asked_at'],
  additionalProperties: false,
};

/** `agent-run.reply` — `aspects.ts:275-278`. */
const RUN_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    at: { type: 'string', pattern: TIMESTAMP_PATTERN },
  },
  required: ['text', 'at'],
  additionalProperties: false,
};

/** `agent-run.usage` — `aspects.ts:202-208`. */
const RUN_USAGE_SCHEMA = {
  type: 'object',
  properties: {
    input_tokens: { type: 'integer', minimum: 0 },
    output_tokens: { type: 'integer', minimum: 0 },
    cost_usd: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

const ENTRIES: readonly PropertyEntry[] = [
  // ─── orbis/schedule (модуль Планировщик) ───────────────────────────────────
  {
    id: 'orbis/start_at',
    label: { ru: 'Начало', en: 'Starts at' },
    description: { ru: 'Когда событие начинается', en: 'When the event begins' },
    type: { kind: 'timestamp' },
    module: 'planner',
  },
  {
    id: 'orbis/end_at',
    label: { ru: 'Окончание', en: 'Ends at' },
    description: { ru: 'Когда событие заканчивается', en: 'When the event ends' },
    type: { kind: 'timestamp' },
    module: 'planner',
  },
  {
    id: 'orbis/duration_min',
    label: { ru: 'Длительность, мин', en: 'Duration, min' },
    description: { ru: 'Сколько времени событие занимает', en: 'How long the event takes' },
    type: { kind: 'number', integer: true, min: 1 },
    module: 'planner',
  },
  {
    id: 'orbis/all_day',
    label: { ru: 'Весь день', en: 'All day' },
    description: {
      ru: 'Событие занимает день целиком, без часов',
      en: 'The event takes the whole day, with no hours',
    },
    type: { kind: 'boolean' },
    module: 'planner',
  },
  {
    id: 'orbis/recurrence',
    label: { ru: 'Повторение', en: 'Recurrence' },
    description: {
      ru: 'Правило, по которому событие повторяется',
      en: 'The rule by which the event repeats',
    },
    type: { kind: 'json', schema: RECURRENCE_SCHEMA },
    module: 'planner',
  },
  {
    id: 'orbis/location',
    label: { ru: 'Место', en: 'Location' },
    description: { ru: 'Где событие происходит', en: 'Where the event takes place' },
    type: { kind: 'text' },
    module: 'planner',
  },
  {
    id: 'orbis/timezone',
    label: { ru: 'Часовой пояс', en: 'Time zone' },
    description: {
      ru: 'В каком поясе прочитано время события',
      en: 'The zone in which the event time is read',
    },
    // Ужесточение §А8: сегодня это голая строка (`aspects.ts:49`), реестр требует имя IANA.
    type: { kind: 'text', format: 'iana-tz' },
    module: 'planner',
  },

  // ─── orbis/task (модуль Планировщик) ───────────────────────────────────────
  {
    id: 'orbis/task_status',
    label: { ru: 'Состояние задачи', en: 'Task status' },
    description: { ru: 'На каком шаге работа над задачей', en: 'What stage the work is at' },
    type: {
      kind: 'select',
      options: options(
        ['inbox', 'Входящие', 'Inbox'],
        ['planned', 'Запланирована', 'Planned'],
        ['in_progress', 'В работе', 'In progress'],
        ['waiting', 'Ожидает', 'Waiting'],
        ['done', 'Сделана', 'Done'],
        ['cancelled', 'Отменена', 'Cancelled'],
      ),
    },
    module: 'planner',
  },
  {
    id: 'orbis/priority',
    label: { ru: 'Приоритет', en: 'Priority' },
    description: {
      ru: 'Насколько задача важнее прочих',
      en: 'How much the task outranks the rest',
    },
    type: {
      kind: 'select',
      options: options(
        ['low', 'Низкий', 'Low'],
        ['medium', 'Средний', 'Medium'],
        ['high', 'Высокий', 'High'],
      ),
    },
    module: 'planner',
  },
  {
    id: 'orbis/due_date',
    label: { ru: 'Срок', en: 'Due date' },
    // §А8/Р11: срок ≠ начало — это разные факты, потому и разные свойства.
    description: {
      ru: 'К какому дню задача должна быть сделана',
      en: 'The day by which the task must be done',
    },
    type: { kind: 'date' },
    module: 'planner',
  },
  {
    id: 'orbis/completed_at',
    label: { ru: 'Когда завершена', en: 'Completed at' },
    description: {
      ru: 'Момент перехода задачи в закрытое состояние',
      en: 'The moment the task entered a closed state',
    },
    type: { kind: 'timestamp' },
    module: 'planner',
  },
  {
    id: 'orbis/effort_min',
    label: { ru: 'Трудоёмкость, мин', en: 'Effort, min' },
    description: {
      ru: 'Сколько времени задача, по оценке, потребует',
      en: 'How much time the task is estimated to take',
    },
    type: { kind: 'number', integer: true, min: 1 },
    module: 'planner',
  },
  {
    id: 'orbis/waiting_for',
    label: { ru: 'Ждём', en: 'Waiting for' },
    description: {
      ru: 'Чего или кого задача ждёт, чтобы сдвинуться',
      en: 'What or whom the task is waiting for to move on',
    },
    type: { kind: 'text' },
    module: 'planner',
  },

  // ─── orbis/financial (модуль Финансы) ──────────────────────────────────────
  {
    id: 'orbis/amount',
    label: { ru: 'Сумма', en: 'Amount' },
    description: {
      ru: 'Величина операции; знак задаёт направление, а не сама сумма',
      en: 'The size of the operation; the sign is carried by direction, not by the amount',
    },
    // В8: `exclusiveMin` вместо lookahead — схема экспортируема в RE2/Go (§А2-2).
    type: { kind: 'decimal', exclusiveMin: '0' },
    module: 'finance',
  },
  {
    id: 'orbis/currency',
    // Слито с `budget.currency` (В1). Отсутствие значения → валюта владельца: это правило
    // контракта money-movement (§Б1-2), одно вместо тринадцати копий в коде.
    label: { ru: 'Валюта', en: 'Currency' },
    description: {
      ru: 'В какой валюте выражены деньги записи',
      en: 'The currency the money on the record is expressed in',
    },
    type: { kind: 'text', format: 'currency', minLength: 3, maxLength: 3 },
    module: 'finance',
  },
  {
    id: 'orbis/direction',
    label: { ru: 'Направление', en: 'Direction' },
    description: { ru: 'Деньги приходят или уходят', en: 'Money comes in or goes out' },
    type: {
      kind: 'select',
      options: options(['income', 'Доход', 'Income'], ['expense', 'Расход', 'Expense']),
    },
    module: 'finance',
  },
  {
    id: 'orbis/finance_category',
    // Слито с `budget.category_ref` (В1); label и description — дословно из §А8.
    label: { ru: 'Категория', en: 'Category' },
    description: {
      ru: 'Категория доходов и расходов (модуль Финансы)',
      en: 'The income and expense category (Finance module)',
    },
    type: { kind: 'ref', target: { filter: { aspect: 'orbis/category' } } },
    module: 'finance',
  },
  {
    id: 'orbis/occurred_on',
    label: { ru: 'Дата операции', en: 'Occurred on' },
    description: { ru: 'День, когда операция случилась', en: 'The day the operation happened' },
    type: { kind: 'date' },
    module: 'finance',
  },
  {
    id: 'orbis/planned',
    label: { ru: 'Планируемая', en: 'Planned' },
    description: {
      ru: 'Операция ещё не случилась, а только намечена',
      en: 'The operation has not happened yet, it is only intended',
    },
    // В5: отсутствие = false = факт. Умолчание читается, а не пишется (РП-9).
    type: { kind: 'boolean', default: false },
    module: 'finance',
  },
  {
    id: 'orbis/recurring',
    label: { ru: 'Повторяющаяся', en: 'Recurring' },
    description: {
      ru: 'Запись — шаблон регулярной операции',
      en: 'The record is a template of a regular operation',
    },
    type: { kind: 'boolean' },
    module: 'finance',
  },
  {
    id: 'orbis/payment_method',
    label: { ru: 'Способ оплаты', en: 'Payment method' },
    description: { ru: 'Чем заплачено', en: 'What the payment was made with' },
    type: { kind: 'text' },
    module: 'finance',
  },
  {
    id: 'orbis/counterparty',
    label: { ru: 'Контрагент', en: 'Counterparty' },
    description: {
      ru: 'Кому заплачено или от кого получено',
      en: 'Who was paid or who paid',
    },
    type: { kind: 'text' },
    module: 'finance',
  },
  {
    id: 'orbis/bank_txn_id',
    label: { ru: 'Идентификатор операции банка', en: 'Bank transaction ID' },
    description: {
      ru: 'Тождество операции в выписке банка — по нему ловится повтор при импорте',
      en: 'Identity of the operation in the bank statement — repeats on import are caught by it',
    },
    // minLength — РП-8/Р-17: сегодня `min(1)` (`aspects.ts:78`), §А8 границу теряет молча.
    type: { kind: 'text', minLength: 1, maxLength: 128 },
    module: 'finance',
    flags: { system_writable: true }, // пишет только CSV-импорт (§А2-5, источник `import`)
  },

  // ─── orbis/note (ядро) ─────────────────────────────────────────────────────
  {
    id: 'orbis/content_type',
    label: { ru: 'Вид текста', en: 'Content type' },
    description: { ru: 'Как читать тело записи', en: 'How to read the body of the record' },
    type: {
      kind: 'select',
      options: options(
        ['markdown', 'Markdown', 'Markdown'],
        ['plain', 'Обычный текст', 'Plain text'],
        ['checklist', 'Чек-лист', 'Checklist'],
      ),
    },
  },
  {
    id: 'orbis/pinned',
    label: { ru: 'Закреплена', en: 'Pinned' },
    description: {
      ru: 'Запись держится наверху списков',
      en: 'The record is kept at the top of lists',
    },
    type: { kind: 'boolean' },
  },

  // ─── orbis/budget (модуль Финансы) ─────────────────────────────────────────
  {
    id: 'orbis/limit',
    // Reserved-слово грамматики снято В11: `orbis/limit>1000` однозначен по слэшу.
    label: { ru: 'Лимит', en: 'Limit' },
    description: {
      ru: 'Сколько по этой категории можно потратить за период',
      en: 'How much may be spent on this category within the period',
    },
    type: { kind: 'decimal', min: '0' },
    module: 'finance',
  },
  {
    id: 'orbis/period_start',
    label: { ru: 'Начало периода', en: 'Period start' },
    description: { ru: 'С какого дня конверт считает', en: 'From which day the envelope counts' },
    type: { kind: 'date' },
    module: 'finance',
  },
  {
    id: 'orbis/period_end',
    label: { ru: 'Конец периода', en: 'Period end' },
    description: {
      ru: 'По какой день конверт считает включительно',
      en: 'Through which day the envelope counts, inclusive',
    },
    type: { kind: 'date' },
    module: 'finance',
  },
  {
    id: 'orbis/carryover',
    label: { ru: 'Перенос остатка', en: 'Carryover' },
    description: {
      ru: 'Остаток прошлого периода, перенесённый в этот',
      en: 'The previous period remainder carried into this one',
    },
    // Знак значим: перерасход переносится минусом — потому границ нет.
    type: { kind: 'decimal' },
    module: 'finance',
    flags: { system_writable: true }, // пишет правило rollover (§А2-5, источник `rule`)
  },

  // ─── orbis/category (модуль Финансы) ───────────────────────────────────────
  {
    id: 'orbis/icon',
    label: { ru: 'Иконка', en: 'Icon' },
    description: { ru: 'Значок категории в списках', en: 'The category badge in lists' },
    type: { kind: 'text' },
    module: 'finance',
  },
  {
    id: 'orbis/color',
    label: { ru: 'Цвет', en: 'Color' },
    description: {
      ru: 'Цвет категории в списках и ведомостях',
      en: 'The category color in lists and reports',
    },
    // §А8: паттерн `#hex` — конфиг format, не отдельный kind и не свой pattern.
    type: { kind: 'text', format: 'color' },
    module: 'finance',
  },
  {
    id: 'orbis/aliases',
    label: { ru: 'Синонимы', en: 'Aliases' },
    description: {
      ru: 'Слова, по которым ввод узнаёт категорию',
      en: 'Words by which input recognises the category',
    },
    // maxItems: 50 — новое ужесточение §А8 (в коде капы нет, `aspects.ts:107`).
    type: { kind: 'text', cardinality: 'many', maxItems: 50 },
    module: 'finance',
  },
  {
    id: 'orbis/spend_class',
    label: { ru: 'Класс траты', en: 'Spend class' },
    description: {
      ru: 'Трата обязательная или та, от которой можно отказаться',
      en: 'The spend is mandatory or one that can be given up',
    },
    type: {
      kind: 'select',
      options: options(
        ['fixed', 'Обязательная', 'Fixed'],
        ['discretionary', 'Необязательная', 'Discretionary'],
      ),
    },
    module: 'finance',
  },

  // ─── orbis/memory (модуль Память; В7 — перевод правила в свойства) ─────────
  {
    id: 'orbis/memory_kind',
    label: { ru: 'Род записи', en: 'Record kind' },
    description: {
      ru: 'Запись памяти — факт о владельце или правило обработки ввода',
      en: 'A memory record is a fact about the owner or an input-handling rule',
    },
    type: {
      kind: 'select',
      options: options(['fact', 'Факт', 'Fact'], ['rule', 'Правило', 'Rule']),
    },
    module: 'memory',
  },
  {
    id: 'orbis/rule_scope',
    // Имя `rule_scope` — дословно из В7 (норматив), хотя запись применяется и к факту:
    // трение с Р11 «id называет смысл» названо вслух в §А8, переименование key дёшево (Р3).
    label: { ru: 'Область действия', en: 'Scope' },
    description: {
      ru: 'К какому понятию относится запись памяти',
      en: 'Which notion the memory record applies to',
    },
    // В3 инвентаря: было «id аспекта» строкой → стало ссылкой на контракт реестра.
    type: { kind: 'registry_ref', target: 'contract' },
    module: 'memory',
  },
  {
    id: 'orbis/rule_pattern',
    label: { ru: 'Образец', en: 'Pattern' },
    description: {
      ru: 'Текст, по которому правило узнаёт ввод',
      en: 'The text by which the rule recognises input',
    },
    // В7: паттерн правила уезжает из `title` в свойство — четыре парсера заголовка уходят.
    type: { kind: 'text' },
    module: 'memory',
  },
  {
    id: 'orbis/rule_target',
    label: { ru: 'Назначаемая категория', en: 'Assigned category' },
    description: {
      ru: 'Категория, которую правило подставляет при совпадении образца',
      en: 'The category the rule substitutes when the pattern matches',
    },
    type: { kind: 'ref', target: { filter: { aspect: 'orbis/category' } } },
    module: 'memory',
  },

  // ─── orbis/goal (модуль Цели) ──────────────────────────────────────────────
  {
    id: 'orbis/progress_source',
    label: { ru: 'Источник прогресса', en: 'Progress source' },
    description: {
      ru: 'Откуда берётся текущее значение цели',
      en: 'Where the current value of the goal comes from',
    },
    type: { kind: 'json', schema: PROGRESS_SOURCE_SCHEMA },
    module: 'goals',
  },
  {
    id: 'orbis/target_value',
    label: { ru: 'Целевое значение', en: 'Target value' },
    description: { ru: 'Число, к которому цель идёт', en: 'The number the goal is heading to' },
    // Строго > 0: сервер делит на него, считая долю прогресса.
    type: { kind: 'decimal', exclusiveMin: '0' },
    module: 'goals',
  },
  {
    id: 'orbis/current_value',
    label: { ru: 'Текущее значение', en: 'Current value' },
    description: {
      ru: 'Насколько цель продвинулась на сейчас',
      en: 'How far the goal has progressed as of now',
    },
    type: { kind: 'decimal', min: '0' },
    module: 'goals',
    // Кэш вычисления (правило 3 §10): пишет сервер, обходя граф; запись моделью — отказ.
    flags: { model_writable: false },
  },
  {
    id: 'orbis/unit',
    label: { ru: 'Единица', en: 'Unit' },
    description: {
      ru: 'В чём меряется прогресс цели',
      en: 'What the goal progress is measured in',
    },
    // minLength — РП-8/Р-17: сегодня `min(1)` (`aspects.ts:146`), пустая подпись уехала бы
    // хвостом за числом.
    type: { kind: 'text', minLength: 1 },
    module: 'goals',
  },

  // ─── orbis/project (модуль ADE) ────────────────────────────────────────────
  {
    id: 'orbis/project_stage',
    // Разные enum — разные факты (Р11): стадия проекта ≠ состояние задачи ≠ стадия рутины.
    label: { ru: 'Стадия проекта', en: 'Project stage' },
    description: {
      ru: 'Проект идёт, стоит на паузе или завершён',
      en: 'The project is running, paused or finished',
    },
    type: {
      kind: 'select',
      options: options(
        ['active', 'Активен', 'Active'],
        ['paused', 'На паузе', 'Paused'],
        ['done', 'Завершён', 'Done'],
      ),
    },
    module: 'ade',
  },

  // ─── orbis/repo (модуль ADE) ───────────────────────────────────────────────
  {
    id: 'orbis/repo_url',
    label: { ru: 'Адрес репозитория', en: 'Repository URL' },
    description: { ru: 'Где лежит код проекта', en: 'Where the project code lives' },
    // `format: url` — новое ужесточение §А8 (в коде сегодня только длина, `aspects.ts:160`);
    // minLength — РП-8/Р-17: там же `min(1)`.
    type: { kind: 'text', format: 'url', minLength: 1, maxLength: 512 },
    module: 'ade',
  },
  {
    id: 'orbis/default_branch',
    label: { ru: 'Ветка по умолчанию', en: 'Default branch' },
    description: {
      ru: 'С какой ветки исполнитель начинает работу',
      en: 'Which branch the executor starts the work from',
    },
    type: { kind: 'text', minLength: 1, maxLength: 128 },
    module: 'ade',
  },

  // ─── orbis/assignment (модуль ADE; механика) ───────────────────────────────
  {
    id: 'orbis/executor',
    label: { ru: 'Исполнитель', en: 'Executor' },
    description: {
      ru: 'Работу ведёт человек или агент',
      en: 'The work is carried out by a human or by an agent',
    },
    type: {
      kind: 'select',
      options: options(['human', 'Человек', 'Human'], ['agent', 'Агент', 'Agent']),
    },
    module: null,
  },
  {
    id: 'orbis/grant',
    // Слито с `agent-run.grant_id` (В1): одно свойство, разные сущности.
    //
    // system_writable здесь НЕ ставится, хотя §А8 пишет «все свойства orbis/agent-run —
    // system». Флаг живёт на свойстве, а свойство теперь общее: у назначения грант выдаёт
    // ВЛАДЕЛЕЦ кнопкой на экране тикета, то есть источником `tool`/`UI`, а гейт §А2-5
    // определён против источника — `system_writable: true` сделал бы назначение агента
    // невыполнимым (`COMPUTED_WRITE` на законный жест). Служебность прогона держат
    // остальные 18 его свойств и XOR-инвариант субъекта.
    label: { ru: 'Доступ агента', en: 'Agent grant' },
    description: {
      ru: 'Каким доступом владельца работает агент',
      en: 'Which owner grant the agent works under',
    },
    // kind `grant` (ref Р10): ссылка в `agent_grants`, проверка — существующий инвариант.
    type: { kind: 'grant' },
    // NULL: аспекты назначения и прогона — ядро-исполнитель, не модуль ADE (§Б8-2), а
    // выключение модуля уносит его свойства из создания (§Б8-3) — свойство ядра так
    // пропало бы вместе с чужим модулем.
    module: null,
  },
  {
    id: 'orbis/assignee',
    label: { ru: 'Кто делает', en: 'Assignee' },
    description: {
      ru: 'Имя человека, который взял работу',
      en: 'The name of the person who took the work',
    },
    // minLength — РП-8/Р-17 (`aspects.ts:171`). Участник-сущность (В7 видения) сделает это
    // свойство `ref` — named-future, форк типа (Ч3), не правка на месте.
    type: { kind: 'text', minLength: 1, maxLength: 200 },
    module: null,
  },
  {
    id: 'orbis/may_close',
    label: { ru: 'Может закрыть', en: 'May close' },
    description: {
      ru: 'Исполнителю разрешено закрыть работу самому',
      en: 'The executor is allowed to close the work themselves',
    },
    type: { kind: 'boolean', default: false },
    module: null,
  },

  // ─── orbis/agent-run (ядро-исполнитель; служебный) ─────────────────────────
  // Все свойства ниже — `system_writable`: их пишут только глаголы исполнителя (§А2-5,
  // источник `verb`), они вне `attach_*` и вне промпт-каталога (№33), но в query адресуемы.
  {
    id: 'orbis/run_routine',
    label: { ru: 'Рутина прогона', en: 'Run routine' },
    description: {
      ru: 'Рутина, чьё расписание породило прогон',
      en: 'The routine whose schedule spawned the run',
    },
    type: { kind: 'ref', target: { filter: { aspect: 'orbis/routine' } } },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_bucket',
    label: { ru: 'Слот расписания', en: 'Schedule slot' },
    description: {
      ru: 'Слот расписания, за который прогон отвечает',
      en: 'The schedule slot the run answers for',
    },
    // В8: «bucket — text + паттерн», а не отдельный kind. Паттерн внутри класса RE2.
    type: {
      kind: 'text',
      pattern: '^(\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d|manual:\\S+)$',
    },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_attempt',
    label: { ru: 'Попытка', en: 'Attempt' },
    description: { ru: 'Который по счёту заход на слот', en: 'Which attempt at the slot this is' },
    type: { kind: 'number', integer: true, min: 1 },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/fail_note',
    label: { ru: 'Причина срыва', en: 'Failure note' },
    description: { ru: 'Почему прогон кончился ничем', en: 'Why the run ended in nothing' },
    type: { kind: 'text', maxLength: 2000 },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_proposal',
    label: { ru: 'Предложение', en: 'Proposal' },
    description: {
      ru: 'Карточка изменений, ждущая слова владельца',
      en: 'The change card waiting for the owner word',
    },
    type: { kind: 'json', schema: RUN_PROPOSAL_SCHEMA },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/undecided',
    label: { ru: 'Есть нерешённое', en: 'Has undecided' },
    description: {
      ru: 'У прогона остались единицы пачки без решения владельца',
      en: 'The run has batch units the owner has not decided',
    },
    // Снятие флажка — запись `false`, а не удаление ключа: с приходом `has()` (§А5-1)
    // договорённость сохраняется ради стабильности уже сохранённых смарт-листов.
    type: { kind: 'boolean' },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_outcome',
    // Имя `outcome` ≠ `status`: третье поле «состояние» в словаре сделало бы `status=` без
    // `aspect=` неоднозначным (§3.15) — причина сохраняется и после В11.
    label: { ru: 'Исход прогона', en: 'Run outcome' },
    description: { ru: 'Чем прогон кончился', en: 'How the run ended' },
    type: {
      kind: 'select',
      options: options(
        ['running', 'Идёт', 'Running'],
        ['checkpoint', 'Вопрос владельцу', 'Checkpoint'],
        ['finished', 'Завершён', 'Finished'],
        ['abandoned', 'Брошен', 'Abandoned'],
        ['failed', 'Сорвался', 'Failed'],
        ['answered', 'Отвечен', 'Answered'],
        ['stale', 'Снят', 'Stale'],
      ),
    },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_started_at',
    // Старт прогона ≠ начало события ≠ срок задачи (Р11) — три разных факта.
    label: { ru: 'Начало прогона', en: 'Run started at' },
    description: {
      ru: 'Когда исполнитель взялся за работу',
      en: 'When the executor took up the work',
    },
    type: { kind: 'timestamp' },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_finished_at',
    label: { ru: 'Конец прогона', en: 'Run finished at' },
    description: { ru: 'Когда прогон перестал идти', en: 'When the run stopped running' },
    type: { kind: 'timestamp' },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/last_step_at',
    label: { ru: 'Последний шаг', en: 'Last step at' },
    description: {
      ru: 'Отметка живости: когда прогон в последний раз подавал признаки',
      en: 'Liveness mark: when the run last showed signs of life',
    },
    type: { kind: 'timestamp' },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/step_count',
    label: { ru: 'Шагов', en: 'Step count' },
    description: {
      ru: 'Сколько шагов исполнитель уже сделал',
      en: 'How many steps the executor has already made',
    },
    type: { kind: 'number', integer: true, min: 0 },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_steps',
    label: { ru: 'Шаги', en: 'Steps' },
    description: { ru: 'Что исполнитель делал по порядку', en: 'What the executor did, in order' },
    type: { kind: 'json', schema: RUN_STEP_SCHEMA, maxItems: 500 },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/session_url',
    label: { ru: 'Ссылка на сессию', en: 'Session URL' },
    description: {
      ru: 'Где смотреть работу исполнителя снаружи',
      en: 'Where to watch the executor work from outside',
    },
    type: { kind: 'text', format: 'url' },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_report',
    label: { ru: 'Отчёт', en: 'Report' },
    description: {
      ru: 'Что исполнитель сделал и что проверить',
      en: 'What the executor did and what to check',
    },
    type: { kind: 'text', maxLength: 20000 },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_checkpoint',
    label: { ru: 'Вопрос владельцу', en: 'Checkpoint' },
    description: {
      ru: 'Чего исполнитель не решает без владельца',
      en: 'What the executor will not decide without the owner',
    },
    type: { kind: 'json', schema: RUN_CHECKPOINT_SCHEMA },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_reply',
    label: { ru: 'Ответ владельца', en: 'Owner reply' },
    description: {
      ru: 'Что владелец ответил на вопрос прогона',
      en: 'What the owner answered to the run question',
    },
    type: { kind: 'json', schema: RUN_REPLY_SCHEMA },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/run_usage',
    label: { ru: 'Расход', en: 'Usage' },
    description: { ru: 'Во что прогон обошёлся', en: 'What the run cost' },
    type: { kind: 'json', schema: RUN_USAGE_SCHEMA },
    module: null,
    flags: { system_writable: true },
  },
  {
    id: 'orbis/abandon_note',
    label: { ru: 'Причина отказа', en: 'Abandon note' },
    description: {
      ru: 'Почему прогон брошен подметанием',
      en: 'Why the run was abandoned by the sweeper',
    },
    type: { kind: 'text', maxLength: 2000 },
    module: null,
    flags: { system_writable: true },
  },

  // ─── orbis/routine (ядро-исполнитель; механика) ────────────────────────────
  {
    id: 'orbis/routine_stage',
    label: { ru: 'Стадия рутины', en: 'Routine stage' },
    description: {
      ru: 'Рутина работает или временно отключена',
      en: 'The routine is working or is temporarily off',
    },
    type: {
      kind: 'select',
      options: options(['active', 'Активна', 'Active'], ['paused', 'На паузе', 'Paused']),
    },
    module: null,
  },
  {
    id: 'orbis/routine_at',
    label: { ru: 'Время запуска', en: 'Run time' },
    description: {
      ru: 'В котором часу рутина срабатывает по локальному времени владельца',
      en: 'At what time the routine fires in the owner local time',
    },
    // Новый kind `time` (В8) — ровно этот кейс его и потребовал.
    type: { kind: 'time' },
    module: null,
  },
  {
    id: 'orbis/routine_days',
    label: { ru: 'Дни недели', en: 'Weekdays' },
    description: {
      ru: 'По каким дням недели рутина срабатывает',
      en: 'On which weekdays the routine fires',
    },
    // minItems: 1 — как в коде (`aspects.ts:299`): пустой список означал бы «никогда»,
    // а «каждый день» выражается отсутствием значения.
    type: {
      kind: 'select',
      cardinality: 'many',
      minItems: 1,
      options: options(
        ['mo', 'Пн', 'Mon'],
        ['tu', 'Вт', 'Tue'],
        ['we', 'Ср', 'Wed'],
        ['th', 'Чт', 'Thu'],
        ['fr', 'Пт', 'Fri'],
        ['sa', 'Сб', 'Sat'],
        ['su', 'Вс', 'Sun'],
      ),
    },
    module: null,
  },
  {
    id: 'orbis/routine_mode',
    label: { ru: 'Режим', en: 'Mode' },
    description: {
      ru: 'Рутина предлагает изменения владельцу или применяет их сама',
      en: 'The routine proposes changes to the owner or applies them itself',
    },
    // Умолчания нет намеренно (V1.1): `act` раздавал бы право писать в граф молча,
    // `propose` — тихо разоружал бы уже заведённую act-рутину.
    type: {
      kind: 'select',
      options: options(['propose', 'Предлагает', 'Propose'], ['act', 'Действует', 'Act']),
    },
    module: null,
  },
  {
    id: 'orbis/allowed_tools',
    label: { ru: 'Разрешённые инструменты', en: 'Allowed tools' },
    description: {
      ru: 'Чем рутине позволено пользоваться',
      en: 'What the routine is allowed to use',
    },
    // minLength элемента — РП-8/Р-17 (`aspects.ts:303`).
    type: { kind: 'text', cardinality: 'many', minLength: 1, maxItems: 50 },
    module: null,
  },

  // ─── Новые свойства реформы (§А8) ──────────────────────────────────────────
  // Носителя-аспекта у них нет намеренно: это вычисляемые свойства проекции иерархии
  // (Ч9), они живут на любой сущности под проектом. Правило `nearest_ancestor` — Задача Б.
  {
    id: 'orbis/parent_project',
    label: { ru: 'Ближайший проект', en: 'Nearest project' },
    description: {
      ru: 'Проект, ближайший к записи вверх по иерархии',
      en: 'The project closest to the record up the hierarchy',
    },
    type: { kind: 'ref', target: { filter: { aspect: 'orbis/project' } } },
    module: 'ade',
    flags: { model_writable: false, computed: { rule: 'nearest_ancestor' } },
  },
  {
    id: 'orbis/root_project',
    label: { ru: 'Корневой проект', en: 'Root project' },
    description: {
      ru: 'Самый верхний проект над записью',
      en: 'The topmost project above the record',
    },
    type: { kind: 'ref', target: { filter: { aspect: 'orbis/project' } } },
    module: 'ade',
    flags: { model_writable: false, computed: { rule: 'nearest_ancestor' } },
  },

  // ─── Core-проекции §А1-3 (storage: 'core') ─────────────────────────────────
  // Хранение остаётся колонкой `entities`; реестр даёт единый адрес для Q-AST, предусловий
  // CAS и подписи. Псевдо-аспект `orbis/entity` и второй способ (`aspect===''`) уходят.
  // `flags` пусты намеренно: запись идёт не через `props`, а через путь ядра, и права на
  // неё решает он (Задача 9a), а не флаг свойства — иначе право оказалось бы в двух местах.
  {
    id: 'orbis/archived',
    label: { ru: 'В архиве', en: 'Archived' },
    description: {
      ru: 'Запись убрана из обычных выдач',
      en: 'The record is out of ordinary listings',
    },
    type: { kind: 'boolean' },
    storage: 'core',
  },
  {
    id: 'orbis/title',
    label: { ru: 'Заголовок', en: 'Title' },
    description: { ru: 'Как запись называется', en: 'What the record is called' },
    type: { kind: 'text' },
    storage: 'core',
  },
  {
    id: 'orbis/created_at',
    label: { ru: 'Создана', en: 'Created at' },
    description: { ru: 'Когда запись появилась', en: 'When the record appeared' },
    type: { kind: 'timestamp' },
    storage: 'core',
  },
  {
    id: 'orbis/updated_at',
    label: { ru: 'Изменена', en: 'Updated at' },
    description: {
      ru: 'Когда запись меняли в последний раз',
      en: 'When the record was last changed',
    },
    type: { kind: 'timestamp' },
    storage: 'core',
  },
];

/**
 * Встроенный словарь свойств: 73 доменных (`storage: 'props'`) + 4 core-проекции.
 * `key` встроенного изначально равен `id` (§А2-1), `owner_id` — NULL, статус — `active`.
 */
export const BUILTIN_PROPERTY_META: readonly PropertyDefinition[] = ENTRIES.map((entry, index) =>
  propertyDefinitionSchema.parse({
    ...entry,
    ownerId: null,
    key: entry.id,
    status: 'active',
    rank: index + 1,
  }),
);

/** Свойства ядра §А1-3: хранятся колонкой, адресуются как свойства. */
export const CORE_PROPERTY_IDS = [
  'orbis/archived',
  'orbis/title',
  'orbis/created_at',
  'orbis/updated_at',
] as const;
export type CorePropertyId = (typeof CORE_PROPERTY_IDS)[number];
