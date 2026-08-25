/**
 * Встроенные аспекты новой формы — решение §А3-1 спеки «Реформа свойств», состав полей —
 * таблица §А8.
 *
 * Аспект перестал быть владельцем полей и стал ИНТЕРПРЕТАЦИЕЙ (Р5): он ссылается на
 * свойства словаря и добавляет к ним ровно две вещи — обязательность и порядок. Отсюда и
 * слияния: `orbis/finance_category` носят и `financial`, и `budget`; `orbis/currency` — оба;
 * `orbis/grant` — `assignment` и `agent-run`. Одно свойство, один тип, разные носители.
 *
 * `aiInstructions`, `tagMappings` и `viewConfig` перенесены из `aspect-registry.ts` ДОСЛОВНО
 * и пиннятся тестом на равенство, пока старый реестр жив (он умирает Задачей 3). Копия, а не
 * импорт, намеренно: строка нового реестра должна быть самодостаточной — сид Задачи 3 пишет
 * в БД именно её, а старый файл к тому моменту уже исчезнет.
 *
 * Порядок `properties[]` и их `rank` — порядок строк таблицы §А8, он же порядок полей в
 * сегодняшних zod-схемах; `rank` аспекта — позиция в `BUILTIN_ASPECT_IDS`.
 */
import type { z } from 'zod';
import type { AspectId } from '../constants';
import { BUILTIN_ASPECT_IDS } from '../constants';
import { type AspectDefinition, aspectDefinitionSchema } from './property-type';

type AspectEntry = Omit<
  z.input<typeof aspectDefinitionSchema>,
  'id' | 'ownerId' | 'key' | 'rank' | 'properties' | 'implements'
> & {
  id: AspectId;
  /** [id свойства, обязательность в этом аспекте] в порядке строк таблицы §А8. */
  properties: readonly (readonly [string, boolean])[];
};

const ENTRIES: readonly AspectEntry[] = [
  {
    id: 'orbis/schedule',
    label: { ru: 'Расписание', en: 'Schedule' },
    description: {
      ru: 'Привязка сущности ко времени: событие, встреча, дедлайн по времени.',
      en: 'Binds an entity to time: an event, a meeting, a time-based deadline.',
    },
    properties: [
      ['orbis/start_at', true],
      ['orbis/end_at', false],
      ['orbis/duration_min', false],
      ['orbis/all_day', false],
      ['orbis/recurrence', false],
      ['orbis/location', false],
      ['orbis/timezone', false],
    ],
    aiInstructions:
      'Применяй, когда во вводе есть дата или время события. start_at обязателен (ISO 8601 с таймзоной пользователя). recurrence задаётся только на шаблоне повторения; инстансы порождает сервер.',
    tagMappings: ['schedule', 'event', 'meeting', 'appointment'],
    viewConfig: {
      keyFields: ['orbis/start_at', 'orbis/end_at', 'orbis/all_day'],
      icon: '📅',
    },
    module: 'planner',
    service: false,
  },
  {
    id: 'orbis/task',
    label: { ru: 'Задача', en: 'Task' },
    description: {
      ru: 'Задача: действие с состоянием, приоритетом и сроком.',
      en: 'A task: an action with a status, a priority and a due date.',
    },
    properties: [
      ['orbis/task_status', true],
      ['orbis/priority', false],
      ['orbis/due_date', false],
      ['orbis/completed_at', false],
      ['orbis/effort_min', false],
      ['orbis/waiting_for', false],
    ],
    aiInstructions:
      'Применяй к действиям. status по умолчанию inbox; явный срок → due_date (date, не timestamp). completed_at проставляет сервер при переходе в done — не передавай его сам.',
    tagMappings: ['task', 'todo', 'action', 'deadline'],
    viewConfig: {
      keyFields: ['orbis/task_status', 'orbis/due_date', 'orbis/priority'],
      icon: '✅',
    },
    module: 'planner',
    service: false,
  },
  {
    id: 'orbis/financial',
    label: { ru: 'Финансовая операция', en: 'Financial' },
    description: {
      ru: 'Финансовая операция: расход или доход.',
      en: 'A financial operation: an expense or an income.',
    },
    properties: [
      ['orbis/amount', true],
      ['orbis/currency', false],
      ['orbis/direction', true],
      ['orbis/finance_category', true],
      // Условная обязательность (§3.3) типом не выражается (В8): до правила `requires_when`
      // части Б её держит инвариант-код (§А7-2), потому в реестре поле необязательно.
      ['orbis/occurred_on', false],
      ['orbis/planned', false],
      ['orbis/recurring', false],
      ['orbis/payment_method', false],
      ['orbis/counterparty', false],
      ['orbis/bank_txn_id', false],
    ],
    aiInstructions:
      'amount — строка decimal (например "340.00"), всегда положительная; знак задаёт direction. category_ref — uuid категории-сущности: резолви по aliases категорий через entity_query. occurred_on — дата операции в таймзоне пользователя. bank_txn_id заполняется ТОЛЬКО импортом банковской выписки — никогда не выставляй его сам.',
    tagMappings: ['expense', 'income', 'payment', 'cost'],
    viewConfig: {
      keyFields: ['orbis/amount', 'orbis/direction', 'orbis/finance_category'],
      icon: '💸',
    },
    module: 'finance',
    service: false,
  },
  {
    id: 'orbis/note',
    label: { ru: 'Заметка', en: 'Note' },
    description: {
      ru: 'Маркер «главное назначение — текст»; содержимое живёт в body сущности.',
      en: 'A marker that the point of the entity is its text; the content lives in the entity body.',
    },
    properties: [
      ['orbis/content_type', false],
      ['orbis/pinned', false],
    ],
    aiInstructions:
      'Применяй, когда пользователь фиксирует мысль/заметку/документ. Текст кладётся в body сущности, не в поля аспекта.',
    tagMappings: ['note', 'thought', 'idea', 'journal'],
    viewConfig: { keyFields: ['orbis/content_type', 'orbis/pinned'], icon: '📝' },
    module: null, // ядро: заметка не выключается вместе с модулем (§Б8-2)
    service: false,
  },
  {
    id: 'orbis/budget',
    label: { ru: 'Конверт бюджета', en: 'Budget' },
    description: {
      ru: 'Конверт бюджета: лимит по категории на период.',
      en: 'A budget envelope: a per-category limit for a period.',
    },
    properties: [
      ['orbis/finance_category', true],
      ['orbis/limit', true],
      ['orbis/currency', false],
      ['orbis/period_start', true],
      ['orbis/period_end', true],
      ['orbis/carryover', false],
    ],
    aiInstructions:
      'Конверт на период: category_ref, limit (decimal-строка), period_start/period_end включительно. spent не хранится — вычисляется из транзакций-детей.',
    tagMappings: ['budget', 'envelope', 'limit'],
    viewConfig: {
      keyFields: ['orbis/limit', 'orbis/period_start', 'orbis/period_end'],
      icon: '✉️',
    },
    module: 'finance',
    service: false,
  },
  {
    id: 'orbis/category',
    label: { ru: 'Категория', en: 'Category' },
    description: {
      ru: 'Категория финансовых операций: иерархия, синонимы, правила.',
      en: 'A category of financial operations: hierarchy, aliases, rules.',
    },
    properties: [
      ['orbis/icon', false],
      ['orbis/color', false],
      ['orbis/aliases', false],
      ['orbis/spend_class', false],
    ],
    aiInstructions:
      'Категория — сущность, не строка. aliases — синонимы в нижнем регистре (рус+англ) для резолва ввода. Иерархия — через relation parent.',
    tagMappings: ['category'],
    viewConfig: {
      keyFields: ['orbis/icon', 'orbis/color', 'orbis/spend_class'],
      icon: '🏷️',
    },
    module: 'finance',
    service: false,
  },
  {
    id: 'orbis/memory',
    label: { ru: 'Память', en: 'Memory' },
    description: {
      ru: 'Память AI: факты о пользователе и правила обработки ввода.',
      en: 'AI memory: facts about the user and input-handling rules.',
    },
    properties: [
      ['orbis/memory_kind', true],
      ['orbis/rule_scope', false],
      // В7: паттерн и правая часть правила уезжают из `title` в свойства — класс
      // «записанное, но молча мёртвое правило» исчезает вместе с парсерами заголовка.
      ['orbis/rule_pattern', false],
      ['orbis/rule_target', false],
    ],
    aiInstructions:
      'kind=fact — знание о пользователе; kind=rule — правило обработки («бар → Развлечения»). scope — aspect-id домена, к которому правило привязано; пусто = глобально.',
    tagMappings: ['memory', 'preference', 'rule'],
    viewConfig: { keyFields: ['orbis/memory_kind', 'orbis/rule_scope'], icon: '🧠' },
    module: 'memory',
    service: false,
  },
  {
    id: 'orbis/goal',
    label: { ru: 'Цель', en: 'Goal' },
    description: {
      ru: 'Цель с измеримым прогрессом: целевое значение и запрос, из которого он считается.',
      en: 'A goal with measurable progress: a target value and the query it is computed from.',
    },
    properties: [
      ['orbis/progress_source', true],
      ['orbis/target_value', true],
      ['orbis/current_value', false],
      ['orbis/unit', false],
    ],
    aiInstructions:
      'Применяй, когда у намерения есть измеримая цель («накопить 300000», «прочитать 24 книги»). target_value — decimal-строка, строго больше нуля. progress_source описывает, ОТКУДА берётся факт: query — запрос §6.1 по сущностям, aggregate — count (считает сущности; field при нём ЗАПРЕЩЁН, не передавай его) либо sum/latest (field ОБЯЗАТЕЛЕН — имя поля аспекта, например amount). unit — непустая подпись единицы, если она есть. current_value считает сервер, обходя граф; никогда не задавай и не правь его сам.',
    tagMappings: ['goal'],
    viewConfig: {
      keyFields: ['orbis/target_value', 'orbis/current_value', 'orbis/unit'],
      icon: '🎯',
    },
    module: 'goals',
    service: false,
  },
  {
    id: 'orbis/project',
    label: { ru: 'Проект', en: 'Project' },
    description: {
      ru: 'Затея с жизненным циклом; тикеты — дочерние задачи',
      en: 'An endeavour with a life cycle; tickets are child tasks.',
    },
    properties: [['orbis/project_stage', true]],
    aiInstructions:
      'orbis/project — проект: затея с жизненным циклом (stage: active|paused|done). Тикеты проекта — ' +
      'дочерние сущности с orbis/task (relation parent от проекта к тикету). «Сделай A, B, C» в треде ' +
      'проекта = создать по тикету на пункт (status inbox), детьми проекта. Тело проекта с живыми ' +
      'блоками сервер засевает сам при пустом теле — не пиши его вручную. Кодовое (репозиторий, ' +
      'ветка) — в orbis/repo на той же сущности, не здесь.',
    tagMappings: ['project', 'проект'],
    viewConfig: { keyFields: ['orbis/project_stage'], icon: '📁' },
    module: 'ade',
    service: false,
  },
  {
    id: 'orbis/repo',
    label: { ru: 'Репозиторий', en: 'Repo' },
    description: {
      ru: 'Адрес репозитория и ветка по умолчанию',
      en: 'Repository address and default branch.',
    },
    properties: [
      ['orbis/repo_url', true],
      ['orbis/default_branch', true],
    ],
    aiInstructions:
      'orbis/repo — репозиторий код-проекта: url и default_branch. Ставится на ту же сущность, что ' +
      'orbis/project, только если проект — про код.',
    tagMappings: ['repo', 'репозиторий'],
    viewConfig: { keyFields: ['orbis/repo_url', 'orbis/default_branch'], icon: '🗂️' },
    module: 'ade',
    service: false,
  },
  {
    id: 'orbis/assignment',
    label: { ru: 'Исполнитель', en: 'Assignment' },
    description: {
      ru: 'Исполнитель тикета: человек или агент по гранту; may_close',
      en: 'The ticket executor: a human or an agent under a grant; may_close.',
    },
    properties: [
      ['orbis/executor', true],
      // Условная обязательность «executor=agent ⇒ grant» — инвариант-код части А (§А7-2).
      ['orbis/grant', false],
      ['orbis/assignee', false],
      ['orbis/may_close', false],
    ],
    aiInstructions:
      'orbis/assignment — исполнитель тикета. executor=agent требует grant_id — uuid доступа из ' +
      '«Настройки → Агенты»; его выставляет владелец (обычно кнопкой на экране тикета) — НИКОГДА не ' +
      'выдумывай uuid и не подставляй чужой. executor=human — assignee текстом. may_close (по ' +
      'умолчанию false) разрешает исполнителю закрывать тикет самому — включай только по прямой просьбе.',
    tagMappings: ['assignee', 'исполнитель'],
    viewConfig: { keyFields: ['orbis/executor', 'orbis/may_close'], icon: '🎯' },
    // Ядро-исполнитель, не ADE: назначение нужно и ADE, и рутинам, а «модуль требует
    // модуль» механизма не имеет (§Б8-2, В6).
    module: null,
    service: false,
  },
  {
    id: 'orbis/agent-run',
    label: { ru: 'Прогон агента', en: 'Agent run' },
    description: {
      ru: 'Служебная сущность прогона агента: шаги, исход, расход',
      en: 'Service entity of an agent run: steps, outcome, usage.',
    },
    properties: [
      ['orbis/grant', false],
      ['orbis/run_routine', false],
      ['orbis/run_bucket', false],
      ['orbis/run_attempt', false],
      ['orbis/fail_note', false],
      ['orbis/run_proposal', false],
      ['orbis/undecided', false],
      // §А8 удаляет `project_id`: ручную денормализацию заменяют вычисляемые
      // `orbis/parent_project` и `orbis/root_project`.
      ['orbis/run_outcome', true],
      ['orbis/run_started_at', true],
      ['orbis/run_finished_at', false],
      ['orbis/last_step_at', true],
      ['orbis/step_count', true],
      ['orbis/run_steps', true],
      ['orbis/session_url', false],
      ['orbis/run_report', false],
      ['orbis/run_checkpoint', false],
      ['orbis/run_reply', false],
      ['orbis/run_usage', false],
      ['orbis/abandon_note', false],
    ],
    aiInstructions:
      'orbis/agent-run — прогон исполнителя по тикету (дочерняя сущность тикета). Создаётся и ' +
      'обновляется ТОЛЬКО глаголами orbis_claim_task / orbis_run_step / orbis_checkpoint / ' +
      'orbis_finish; вручную не создавай и не правь. Служебный: в основных выдачах не показывается, ' +
      'запрашивай явно через aspect=orbis/agent-run.',
    tagMappings: [],
    viewConfig: { keyFields: ['orbis/run_outcome', 'orbis/step_count'], icon: '🤖' },
    module: null,
    // Р-П-5/§А5-6: признак служебности переехал сюда из константы `constants.ts` — компилятор
    // прячет служебное по колонке реестра, а не по списку в коде (сегодня их три копии).
    service: true,
  },
  {
    id: 'orbis/routine',
    label: { ru: 'Рутина', en: 'Routine' },
    description: {
      ru: 'Повторяющаяся работа внутреннего исполнителя: расписание, режим, права',
      en: 'Recurring work of the internal executor: schedule, mode, permissions.',
    },
    properties: [
      ['orbis/routine_stage', true],
      ['orbis/routine_at', true],
      ['orbis/routine_days', false],
      ['orbis/routine_mode', true],
      ['orbis/allowed_tools', false],
    ],
    aiInstructions:
      'orbis/routine — рутина: повторяющаяся работа внутреннего исполнителя. ЧТО делать — в ' +
      'теле сущности обычным текстом, в аспекте только расписание и права. at — локальное ' +
      'время владельца «ЧЧ:ММ» (07:00, не 7:00); days — дни недели mo|tu|we|th|fr|sa|su, без ' +
      'поля = каждый день. mode обязателен: propose — рутина ПРЕДЛАГАЕТ изменения владельцу ' +
      'на подтверждение, act — применяет их сама, и тогда перечисли allowed_tools (ровно те ' +
      'инструменты, что ей нужны). Без явной просьбы владельца действовать самостоятельно ' +
      'заводи рутину с mode: propose — act выдаётся только по его прямому слову. ' +
      'stage: active — рутина работает, paused — временно ' +
      'отключена; «выключи рутину» — это paused, а не удаление. Поле stage есть и у ' +
      'orbis/project, поэтому в entity_query всегда указывай aspect=orbis/routine.',
    tagMappings: ['routine', 'рутина'],
    viewConfig: {
      keyFields: ['orbis/routine_stage', 'orbis/routine_at', 'orbis/routine_mode'],
      icon: '⏰',
    },
    module: null, // ядро-исполнитель: рутины — субстрат D35 (§Б8-2)
    service: false,
  },
];

/** Тринадцать встроенных аспектов новой формы в порядке `BUILTIN_ASPECT_IDS`. */
export const BUILTIN_ASPECT_DEFS: readonly AspectDefinition[] = ENTRIES.map((entry, index) =>
  aspectDefinitionSchema.parse({
    ...entry,
    ownerId: null,
    key: entry.id, // у встроенных key = id (§А2-1); имя тула attach_* берётся из key (§А9-1)
    properties: entry.properties.map(([propertyId, required], order) => ({
      propertyId,
      required,
      rank: order + 1,
    })),
    implements: [], // §Б2 — часть Б
    rank: index + 1,
  }),
);

// Порядок записей обязан совпадать с нормативным списком: `rank` выводится из позиции.
if (ENTRIES.map((e) => e.id).join(',') !== BUILTIN_ASPECT_IDS.join(',')) {
  throw new Error('BUILTIN_ASPECT_DEFS разошёлся с BUILTIN_ASPECT_IDS');
}
