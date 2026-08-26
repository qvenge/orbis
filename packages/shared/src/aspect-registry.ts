// packages/shared/src/aspect-registry.ts
//
// Два жильца одного файла, и это временно.
//
// 1) `BUILTIN_ASPECT_META` — метаданные аспектов СТАРОЙ формы (`name`/`namespace`/`icon`,
//    `description` строкой, `view_config.keyFields` ИМЕНАМИ ПОЛЕЙ аспекта). Новую форму
//    даёт `registry/builtin-aspects.ts` (`BUILTIN_ASPECT_DEFS`), и она уже сеется в БД
//    Задачей 3. Старая остаётся жить рядом ровно по той же причине, по которой остаётся
//    колонка `aspect_definitions.schema` (Р-24): её читатели — web-строки нативных полей
//    (`NativeRow.tsx`) и гейт llm-smoke — работают по СТАРОЙ форме данных сущности
//    (колонка `entities.aspects_legacy` как карта; до миграции 0015 она звалась `aspects`),
//    а она живёт до миграции 0017. Слить их в один
//    реэкспорт сейчас значило бы обессмыслить перекрёстную сверку старой и новой формы
//    (`registry/builtin.test.ts`) — она сравнивает именно две независимые записи.
//    Умирает вместе со старой формой (Задачи 4b/12/23).
//    tag_mappings — дословно PRD 01 §3.1–§3.7; ai_instructions — короткие правила
//    применения аспекта (попадают в описание attach_<aspect>-тулов, §7.6).
//
// 2) Сверка реестров с кодом (`diffBuiltinRegistries`) — она НОВОЙ формы и знает все шесть
//    таблиц (§А12-1 п.4). Живёт здесь, а не в `registry/`, потому что здесь же лежит
//    `canonicalJson`, без которого сверка jsonb невозможна.
import type { AspectId } from './constants';
import { BUILTIN_ASPECT_DEFS } from './registry/builtin-aspects';
import { BUILTIN_PROPERTY_META } from './registry/builtin-properties';
import { BUILTIN_RELATION_ROLE_META } from './registry/builtin-roles';
import { legacyAspectJsonSchema } from './schemas/aspects';

export interface BuiltinAspectMeta {
  id: AspectId;
  name: string;
  namespace: 'orbis';
  description: string;
  icon: string;
  aiInstructions: string;
  tagMappings: string[];
  viewConfig: { keyFields: string[] };
}

export const BUILTIN_ASPECT_META: BuiltinAspectMeta[] = [
  {
    id: 'orbis/schedule',
    name: 'Schedule',
    namespace: 'orbis',
    icon: '📅',
    description: 'Привязка сущности ко времени: событие, встреча, дедлайн по времени.',
    aiInstructions:
      'Применяй, когда во вводе есть дата или время события. start_at обязателен (ISO 8601 с таймзоной пользователя). recurrence задаётся только на шаблоне повторения; инстансы порождает сервер.',
    tagMappings: ['schedule', 'event', 'meeting', 'appointment'],
    viewConfig: { keyFields: ['start_at', 'end_at', 'all_day'] },
  },
  {
    id: 'orbis/task',
    name: 'Task',
    namespace: 'orbis',
    icon: '✅',
    description: 'Задача: действие с состоянием, приоритетом и сроком.',
    aiInstructions:
      'Применяй к действиям. status по умолчанию inbox; явный срок → due_date (date, не timestamp). completed_at проставляет сервер при переходе в done — не передавай его сам.',
    tagMappings: ['task', 'todo', 'action', 'deadline'],
    viewConfig: { keyFields: ['status', 'due_date', 'priority'] },
  },
  {
    id: 'orbis/financial',
    name: 'Financial',
    namespace: 'orbis',
    icon: '💸',
    description: 'Финансовая операция: расход или доход.',
    aiInstructions:
      'amount — строка decimal (например "340.00"), всегда положительная; знак задаёт direction. category_ref — uuid категории-сущности: резолви по aliases категорий через entity_query. occurred_on — дата операции в таймзоне пользователя. bank_txn_id заполняется ТОЛЬКО импортом банковской выписки — никогда не выставляй его сам.',
    tagMappings: ['expense', 'income', 'payment', 'cost'],
    viewConfig: { keyFields: ['amount', 'direction', 'category_ref'] },
  },
  {
    id: 'orbis/note',
    name: 'Note',
    namespace: 'orbis',
    icon: '📝',
    description: 'Маркер «главное назначение — текст»; содержимое живёт в body сущности.',
    aiInstructions:
      'Применяй, когда пользователь фиксирует мысль/заметку/документ. Текст кладётся в body сущности, не в поля аспекта.',
    tagMappings: ['note', 'thought', 'idea', 'journal'],
    viewConfig: { keyFields: ['content_type', 'pinned'] },
  },
  {
    id: 'orbis/budget',
    name: 'Budget',
    namespace: 'orbis',
    icon: '✉️',
    description: 'Конверт бюджета: лимит по категории на период.',
    aiInstructions:
      'Конверт на период: category_ref, limit (decimal-строка), period_start/period_end включительно. spent не хранится — вычисляется из транзакций-детей.',
    tagMappings: ['budget', 'envelope', 'limit'],
    viewConfig: { keyFields: ['limit', 'period_start', 'period_end'] },
  },
  {
    id: 'orbis/category',
    name: 'Category',
    namespace: 'orbis',
    icon: '🏷️',
    description: 'Категория финансовых операций: иерархия, синонимы, правила.',
    aiInstructions:
      'Категория — сущность, не строка. aliases — синонимы в нижнем регистре (рус+англ) для резолва ввода. Иерархия — через relation parent.',
    tagMappings: ['category'],
    viewConfig: { keyFields: ['icon', 'color', 'spend_class'] },
  },
  {
    id: 'orbis/memory',
    name: 'Memory',
    namespace: 'orbis',
    icon: '🧠',
    description: 'Память AI: факты о пользователе и правила обработки ввода.',
    aiInstructions:
      'kind=fact — знание о пользователе; kind=rule — правило обработки («бар → Развлечения»). scope — aspect-id домена, к которому правило привязано; пусто = глобально.',
    tagMappings: ['memory', 'preference', 'rule'],
    viewConfig: { keyFields: ['kind', 'scope'] },
  },
  {
    id: 'orbis/goal',
    name: 'Goal',
    namespace: 'orbis',
    icon: '🎯',
    description:
      'Цель с измеримым прогрессом: целевое значение и запрос, из которого он считается.',
    aiInstructions:
      'Применяй, когда у намерения есть измеримая цель («накопить 300000», «прочитать 24 книги»). target_value — decimal-строка, строго больше нуля. progress_source описывает, ОТКУДА берётся факт: query — запрос §6.1 по сущностям, aggregate — count (считает сущности; field при нём ЗАПРЕЩЁН, не передавай его) либо sum/latest (field ОБЯЗАТЕЛЕН — имя поля аспекта, например amount). unit — непустая подпись единицы, если она есть. current_value считает сервер, обходя граф; никогда не задавай и не правь его сам.',
    tagMappings: ['goal'],
    viewConfig: { keyFields: ['target_value', 'current_value', 'unit'] },
  },
  {
    id: 'orbis/project',
    name: 'Project',
    namespace: 'orbis',
    icon: '📁',
    description: 'Затея с жизненным циклом; тикеты — дочерние задачи',
    aiInstructions:
      'orbis/project — проект: затея с жизненным циклом (stage: active|paused|done). Тикеты проекта — ' +
      'дочерние сущности с orbis/task (relation parent от проекта к тикету). «Сделай A, B, C» в треде ' +
      'проекта = создать по тикету на пункт (status inbox), детьми проекта. Тело проекта с живыми ' +
      'блоками сервер засевает сам при пустом теле — не пиши его вручную. Кодовое (репозиторий, ' +
      'ветка) — в orbis/repo на той же сущности, не здесь.',
    tagMappings: ['project', 'проект'],
    viewConfig: { keyFields: ['stage'] },
  },
  {
    id: 'orbis/repo',
    name: 'Repo',
    namespace: 'orbis',
    icon: '🗂️',
    description: 'Адрес репозитория и ветка по умолчанию',
    aiInstructions:
      'orbis/repo — репозиторий код-проекта: url и default_branch. Ставится на ту же сущность, что ' +
      'orbis/project, только если проект — про код.',
    tagMappings: ['repo', 'репозиторий'],
    viewConfig: { keyFields: ['url', 'default_branch'] },
  },
  {
    id: 'orbis/assignment',
    name: 'Assignment',
    namespace: 'orbis',
    icon: '🎯',
    description: 'Исполнитель тикета: человек или агент по гранту; may_close',
    aiInstructions:
      'orbis/assignment — исполнитель тикета. executor=agent требует grant_id — uuid доступа из ' +
      '«Настройки → Агенты»; его выставляет владелец (обычно кнопкой на экране тикета) — НИКОГДА не ' +
      'выдумывай uuid и не подставляй чужой. executor=human — assignee текстом. may_close (по ' +
      'умолчанию false) разрешает исполнителю закрывать тикет самому — включай только по прямой просьбе.',
    tagMappings: ['assignee', 'исполнитель'],
    viewConfig: { keyFields: ['executor', 'may_close'] },
  },
  {
    id: 'orbis/agent-run',
    name: 'Agent run',
    namespace: 'orbis',
    icon: '🤖',
    description: 'Служебная сущность прогона агента: шаги, исход, расход',
    aiInstructions:
      'orbis/agent-run — прогон исполнителя по тикету (дочерняя сущность тикета). Создаётся и ' +
      'обновляется ТОЛЬКО глаголами orbis_claim_task / orbis_run_step / orbis_checkpoint / ' +
      'orbis_finish; вручную не создавай и не правь. Служебный: в основных выдачах не показывается, ' +
      'запрашивай явно через aspect=orbis/agent-run.',
    tagMappings: [],
    viewConfig: { keyFields: ['outcome', 'step_count'] },
  },
  {
    id: 'orbis/routine',
    name: 'Routine',
    namespace: 'orbis',
    // 🎯 занят назначением и целью: иконка отличает рутину в списках, а не пересказывает её
    icon: '⏰',
    description: 'Повторяющаяся работа внутреннего исполнителя: расписание, режим, права',
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
    viewConfig: { keyFields: ['stage', 'at', 'mode'] },
  },
];

/**
 * Канонический JSON для сравнения схем: ключи объектов сортируются, порядок массивов
 * сохраняется — в JSON Schema он значим (`enum`, `required`).
 *
 * Зачем: jsonb в PostgreSQL НЕ хранит порядок ключей (сортирует их по длине и байтам),
 * поэтому наивный `JSON.stringify` объявил бы расхождением любую схему, прошедшую через БД.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/**
 * Пять реестров спеки (§А12-1 п.4) плюс таблица действий: сверка обязана знать все шесть,
 * иначе «drift знает все реестры» — полуправда. Порядок — порядок вывода в логе и в
 * `ops.ts check`.
 */
export const REGISTRY_KINDS = [
  'properties',
  'aspects',
  'roles',
  'contracts',
  'subscriptions',
  'actions',
] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

/**
 * Строка system-реестра, как её отдаёт SELECT: ключи — имена КОЛОНОК (snake_case).
 * Именно колонками названы поля в `what`, чтобы отчёт дрейфа указывал на то, что чинит
 * оператор (столбец таблицы), а не на имя поля в TypeScript.
 */
export type RegistryDbRow = { id: string } & Record<string, unknown>;

export interface RegistryKindDrift {
  /** Встроенные записи, которых в БД нет вовсе (релиз добавил — пересева не было). */
  missing: string[];
  /** Есть, но расходятся с кодом — и какие столбцы именно. */
  drifted: { id: string; what: string[] }[];
  /**
   * Лишние system-строки: в БД есть, в коде НЕТ (Р-23). Сегодняшняя сверка аспектов их не
   * видела вовсе, и удалённая из кода запись жила в проде молча — а по ней валидирует
   * исполнитель и её показывает каталог. Для `contracts`/`subscriptions`/`actions` в срезе А
   * ожидание — ПУСТО (§А12-1), поэтому там любая system-строка попадает сюда.
   */
  extra: string[];
}

export type RegistryDrift = Record<RegistryKind, RegistryKindDrift>;
export type RegistryDbRows = Record<RegistryKind, RegistryDbRow[]>;

export function hasRegistryDrift(drift: RegistryDrift): boolean {
  return REGISTRY_KINDS.some((kind) => {
    const d = drift[kind];
    return d.missing.length > 0 || d.drifted.length > 0 || d.extra.length > 0;
  });
}

/** Плоский список id всех расхождений — тело поля `registryDrift` в `/health`. */
export function registryDriftIds(drift: RegistryDrift): string[] {
  const out: string[] = [];
  for (const kind of REGISTRY_KINDS) {
    const d = drift[kind];
    for (const id of d.missing) out.push(`${kind}:${id} нет`);
    for (const x of d.drifted) out.push(`${kind}:${x.id} ${x.what.join('+')}`);
    for (const id of d.extra) out.push(`${kind}:${id} лишний`);
  }
  return out;
}

/** Человекочитаемые строки лога: что именно разошлось. */
export function registryDriftReport(drift: RegistryDrift): string[] {
  const out: string[] = [];
  for (const kind of REGISTRY_KINDS) {
    const d = drift[kind];
    for (const id of d.missing) out.push(`  ✗ ${kind}/${id}: в реестре БД НЕТ`);
    for (const x of d.drifted) {
      out.push(`  ✗ ${kind}/${x.id}: расходится (${x.what.join(' + ')})`);
    }
    for (const id of d.extra) out.push(`  ✗ ${kind}/${id}: в БД ЕСТЬ, в коде НЕТ (лишняя)`);
  }
  return out;
}

/**
 * Ожидаемые значения столбцов встроенной строки. Сравнение идёт ПО СТОЛБЦАМ, а не по
 * склейке всей строки: оператору нужен ответ «что чинить», а «строка не та» им не является.
 *
 * Косметику здесь не отделяем от существенного (в отличие от старой сверки аспектов, где
 * сверялись только `schema` и `ai_instructions`): с реформой label/description — не
 * косметика, а данные, которые уезжают в описание параметра тула и в каталог промпта, то
 * есть управляют поведением модели ровно так же, как схема.
 */
function expectedProperties(): Map<string, Record<string, unknown>> {
  return new Map(
    BUILTIN_PROPERTY_META.map((p) => [
      p.id,
      {
        key: p.key,
        label: p.label,
        description: p.description,
        type: p.type,
        status: p.status,
        storage: p.storage,
        scope: p.scope,
        merged_into: p.mergedInto,
        module: p.module,
        rank: p.rank,
        flags: p.flags,
      },
    ]),
  );
}

function expectedAspects(): Map<string, Record<string, unknown>> {
  return new Map(
    BUILTIN_ASPECT_DEFS.map((a) => [
      a.id,
      {
        key: a.key,
        label: a.label,
        description: a.description,
        properties: a.properties,
        ai_instructions: a.aiInstructions,
        tag_mappings: a.tagMappings,
        implements: a.implements,
        view_config: a.viewConfig,
        module: a.module,
        service: a.service,
        rank: a.rank,
        // Колонка `schema` — носитель СТАРОЙ формы до миграции 0017 (Р-24), и она остаётся
        // в сверке: по ней валидирует исполнитель и из неё собирается `attach_*`-тул, то
        // есть ровно та ловушка релиза, ради которой сверка и заводилась.
        schema: legacyAspectJsonSchema(a.id as AspectId),
      },
    ]),
  );
}

function expectedRoles(): Map<string, Record<string, unknown>> {
  return new Map(
    BUILTIN_RELATION_ROLE_META.map((r) => [
      r.id,
      {
        key: r.key,
        label: r.label,
        description: r.description,
        source_label: r.sourceLabel,
        target_label: r.targetLabel,
        hierarchical: r.hierarchical,
        constraints: r.constraints,
        symmetric: r.symmetric,
        module: r.module,
        rank: r.rank,
      },
    ]),
  );
}

/**
 * Ожидание для реестров, которые срез А создаёт ПУСТЫМИ (§А12-1): контракты, подписки,
 * действия. Их сиды — первый акт среза Б-1 после гейта П5, и до него любая system-строка
 * здесь означает, что сид положили раньше времени, — это дрейф, а не «ещё не сеяли».
 */
const EMPTY_EXPECTATION = (): Map<string, Record<string, unknown>> => new Map();

const EXPECTATIONS: Record<RegistryKind, () => Map<string, Record<string, unknown>>> = {
  properties: expectedProperties,
  aspects: expectedAspects,
  roles: expectedRoles,
  contracts: EMPTY_EXPECTATION,
  subscriptions: EMPTY_EXPECTATION,
  actions: EMPTY_EXPECTATION,
};

function diffOne(
  expected: Map<string, Record<string, unknown>>,
  rows: RegistryDbRow[],
): RegistryKindDrift {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: RegistryKindDrift = { missing: [], drifted: [], extra: [] };
  for (const [id, exp] of expected) {
    const row = byId.get(id);
    if (row === undefined) {
      out.missing.push(id);
      continue;
    }
    // `?? null` с обеих сторон: NULL-столбец приезжает как null, необъявленное поле —
    // как undefined, и без выравнивания «module не задан» читалось бы расхождением.
    const what = Object.keys(exp)
      .filter((column) => canonicalJson(exp[column] ?? null) !== canonicalJson(row[column] ?? null))
      .sort();
    if (what.length > 0) out.drifted.push({ id, what });
  }
  for (const row of rows) if (!expected.has(row.id)) out.extra.push(row.id);
  return out;
}

/**
 * Расхождение system-строк реестров в БД с кодом — ловушка релиза (§А12-1 п.4).
 *
 * Сверка ДВУСТОРОННЯЯ (Р-23): «в коде есть, в БД нет» и «в БД есть, в коде нет» — оба
 * дрейф. Одностороннюю сверку аспектов это заменяет целиком: запись, удалённая из кода,
 * переставала попадаться на глаза, продолжая валидировать данные в проде.
 *
 * Ту же функцию зовут стартовая проверка сервера (`db/registry-drift.ts` → `/health`) и
 * ручная операция `bun scripts/ops.ts check`: второй реализации «что считать дрейфом» быть
 * не должно, иначе однажды они разойдутся в ответах.
 *
 * КАСТОМНЫЕ строки (`owner_id IS NOT NULL`) сюда не попадают вовсе — их отбирает SELECT
 * вызывающего: у пользовательских записей нет эталона в коде, и дрейфом они не бывают.
 */
export function diffBuiltinRegistries(rows: RegistryDbRows): RegistryDrift {
  return {
    properties: diffOne(EXPECTATIONS.properties(), rows.properties),
    aspects: diffOne(EXPECTATIONS.aspects(), rows.aspects),
    roles: diffOne(EXPECTATIONS.roles(), rows.roles),
    contracts: diffOne(EXPECTATIONS.contracts(), rows.contracts),
    subscriptions: diffOne(EXPECTATIONS.subscriptions(), rows.subscriptions),
    actions: diffOne(EXPECTATIONS.actions(), rows.actions),
  };
}
