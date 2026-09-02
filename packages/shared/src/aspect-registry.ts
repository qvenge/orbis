// packages/shared/src/aspect-registry.ts
//
// Сверка реестров с кодом (`diffBuiltinRegistries`): знает все шесть таблиц (§А12-1 п.4).
// Живёт здесь, а не в `registry/`, потому что здесь же лежит `canonicalJson`, без которого
// сверка jsonb невозможна.
//
// ВТОРОГО ЖИЛЬЦА БОЛЬШЕ НЕТ. До «Пересева мира» файл держал `BUILTIN_ASPECT_META` — второй,
// независимый реестр аспектов СТАРОЙ формы (`name`/`namespace`/`icon`, `description`
// строкой, `viewConfig.keyFields` ИМЕНАМИ ПОЛЕЙ). Он жил ради читателей старой формы
// данных, и все они переведены: подписи нативных полей web берёт из снимка реестра, а
// единственная форма встроенных аспектов — `BUILTIN_ASPECT_DEFS`
// (`registry/builtin-aspects.ts`). Перекрёстная сверка двух записей (`registry/builtin.test.ts`)
// ушла вместе со второй записью — сверять стало не с чем, и это цель, а не потеря.
import { BUILTIN_ASPECT_DEFS } from './registry/builtin-aspects';
import { BUILTIN_PROPERTY_META } from './registry/builtin-properties';
import { BUILTIN_RELATION_ROLE_META } from './registry/builtin-roles';

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
