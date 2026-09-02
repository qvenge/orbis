// Интеграционные тесты реестра LLM/MCP-тулов (§9.2, §7.6): живая БД под withIdentity.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  askInput,
  attachAspectInput,
  attachToolName,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  batchExecuteInput,
  budgetStatusInput,
  checkpointInput,
  claimTaskInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  finishInput,
  myQueueInput,
  proposeInput,
  relationCreateInput,
  relationDeleteInput,
  runStepInput,
  X_ORBIS_TYPE,
} from '@orbis/shared';
import { parseQueryAst, toParseRegistry } from '@orbis/shared/query';
import { eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
// Эталон реестра тулов — ИСТОЧНИК счётчиков этого файла (РП-13): см. `registry-golden.test.ts`.
import TOOL_REGISTRY_GOLDEN from '../../test/golden/tool-registry.json';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { propertyCatalogInput } from './property-catalog';
import {
  AGENT_VERB_NAMES,
  ASK_TOOL,
  buildToolRegistry,
  importCsvStartInput,
  type OrbisToolDef,
  type RoutineRef,
  routineToolDefs,
  threadPostInput,
  undoLastInput,
  userQueryInput,
} from './registry';
import { REGISTRY_TOOL_NAMES } from './registry-tools';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();

/** Кастомный аспект userA: id с '/' И '-' — проверка нормализации имени тула (решение 3). */
const CUSTOM_ASPECT_ID = 'user/sleep-log';
/**
 * Схема `data` кастомного тула — теперь она СОБИРАЕТСЯ ИЗ РЕЕСТРА СВОЙСТВ (§А9-1), а не
 * берётся из колонки `aspect_definitions.schema`. Ожидание записано дословно и целиком:
 * имя параметра — `key` свойства (не локальная часть), описание — «подпись — смысл» локали,
 * копия типа едет аннотацией. Колонка `schema` при этом у фикстуры по-прежнему заполнена —
 * тем и ценно, что тул её больше НЕ читает.
 */
const CUSTOM_SCHEMA = {
  type: 'object',
  properties: {
    'user/hours': {
      type: 'number',
      [X_ORBIS_TYPE]: { kind: 'number' },
      description: 'hours — Поле hours (user/sleep-log)',
    },
  },
  required: ['user/hours'],
  additionalProperties: false,
};

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(userA, {
    key: CUSTOM_ASPECT_ID,
    label: { ru: 'Сон', en: 'Sleep Log' },
    description: { ru: 'Трекинг сна.', en: 'Sleep tracking.' },
    aiInstructions: 'Пиши часы сна числом.',
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
});

afterAll(async () => {
  await client.end();
});

function registryFor(userId: string): Promise<OrbisToolDef[]> {
  return withIdentity(db, userId, (tx) => buildToolRegistry(tx, userId));
}

function defOf(defs: OrbisToolDef[], name: string): OrbisToolDef {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`тул «${name}» не найден в реестре`);
  return def;
}

/** Операторы грамматики §6.1 — любой из них отличает запрос от прозы (см. тест ниже). */
const GRAMMAR_OPERATOR = /[=<>]/;

/** Образцы запросов из текста описания: фрагмент в ёлочках, внутри которого есть оператор. */
function grammarExamples(description: string): string[] {
  return [...description.matchAll(/«([^»]+)»/g)]
    .map((m) => m[1] as string)
    .filter((s) => GRAMMAR_OPERATOR.test(s));
}

const CORE_NAMES = [
  'entity_query',
  'entity_get',
  'entity_create',
  'entity_update',
  'relation_create',
  'relation_delete',
  'batch_execute',
  'user_query',
  'budget_status', // A6: read-агрегаты Budget (03-budget §4), доступен и MCP
  'property_catalog', // §А9-3: путь модели к свойствам без attach_*-тула; fullScopeOnly
  'import_csv_start', // C4c: вход в импорт из чата (03-budget §3.4), internalOnly
  'undo_last', // хвост V1 (Д-1): «отмени последнее» словами в чате (§7.8), internalOnly
] as const;

/**
 * Служебные аспекты (orbis/agent-run) attach_*-тула не получают — их правит только сервер.
 * Признак служебности берётся из ВСТРОЕННОГО РЕЕСТРА (колонка `service`, §А3-1), а не из
 * колонки `service` реестра: сервер отбирает по ней же, и список в тесте был бы вторым
 * мнением о том, что служебно.
 */
const BUILTIN_ATTACH_NAMES = BUILTIN_ASPECT_DEFS.filter((a) => !a.service).map((a) =>
  attachToolName(a.key),
);

describe('buildToolRegistry: состав (§9.2 + §7.6)', () => {
  test('builtin-реестр (userB без кастомных): 13 core + 5 реестровых + 5 глаголов + orbis_propose + orbis_ask + 12 attach_* = 37', async () => {
    const defs = await registryFor(userB);
    const names = defs.map((d) => d.name);
    for (const name of CORE_NAMES) expect(names).toContain(name);
    expect(names).toContain('thread_post');
    for (const name of AGENT_VERB_NAMES) expect(names).toContain(name);
    // orbis_propose и orbis_ask — не глаголы исполнителя (в AGENT_VERB_NAMES их нет), а
    // тулы рутины: первый предлагает правку, второй задаёт нетерминальный вопрос (D42 ОЧ.5)
    expect(names).toContain('orbis_propose');
    expect(names).toContain('orbis_ask');
    // Пин присутствия и неизменности дефа на пути в реестр: сегодня `buildToolDefs` кладёт
    // в список ТОТ ЖЕ объект, и сравнение проходит тождественно — падать ему есть от чего
    // только в будущем, если сборка начнёт деф трансформировать (усечение описания и т. п.).
    // Подмену routineOnly на agentOnly ловит НЕ он, а пин agentOnly ниже.
    expect(defs.find((d) => d.name === 'orbis_ask')).toEqual(ASK_TOOL);
    for (const name of BUILTIN_ATTACH_NAMES) expect(names).toContain(name);
    // Счётчик — ПРОИЗВОДНЫЙ от эталона реестра тулов (`test/golden/tool-registry.json`):
    // эталон снят при чистом сиде и он же сторожит состав. Второе число, написанное здесь
    // руками, разошлось бы с ним молча — и «сколько тулов у модели» перестало бы иметь один
    // ответ. Что эталон вообще НЕ ПУСТ и что в нём именно 37 тулов, пиннит `registry-golden`.
    expect(defs.length).toBe(TOOL_REGISTRY_GOLDEN.length);
    // дублей имён нет
    expect(new Set(names).size).toBe(names.length);
  });

  test('служебный orbis/agent-run — БЕЗ attach_*-тула, остальные аспекты среза — с ним', async () => {
    // Прогон правит только сервер (С5/С7): без тула модель не создаст прогон мимо глаголов.
    const names = (await registryFor(userB)).map((d) => d.name);
    expect(names).not.toContain('attach_orbis_agent_run');
    expect(names).toContain('attach_orbis_project');
    expect(names).toContain('attach_orbis_repo');
    expect(names).toContain('attach_orbis_assignment');
  });

  test('имена тулов без «/» (и вообще только [a-z0-9_])', async () => {
    const defs = await registryFor(userA);
    for (const def of defs) {
      expect(def.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  test('kind: чтения — entity_query/entity_get/user_query/budget_status/property_catalog/import_csv_start, остальные — mutate', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      const expected = [
        'entity_query',
        'entity_get',
        'user_query',
        'budget_status',
        'property_catalog',
        'import_csv_start',
      ].includes(def.name)
        ? 'read'
        : 'mutate';
      expect({ name: def.name, kind: def.kind }).toEqual({ name: def.name, kind: expected });
    }
  });

  test('fullScopeOnly: true у property_catalog и пяти тулов реестра (§А9-4) — и ни у кого больше', async () => {
    // У каталога признак нужен именно потому, что тул ЧИТАЮЩИЙ: правило «чтения открыты
    // все» его бы пропустило, и `worker` получил бы карту поверхности владельца целиком.
    // У тулов реестра он отвечает на другой вопрос — кому этот тул вообще адресован:
    // мутации фону закрывает и `WORKER_SCOPE_TOOLS`, а устройство системы владельца —
    // не то, над чем фоновый исполнитель работает (§А9-4, РП-14).
    //
    // ЧЕСТНО О СИЛЕ ЭТОГО ПИНА: у пяти реестровых тулов флаг сегодня НЕ НЕСУЩИЙ — снятие
    // его не меняет ни списка, ни вызова (мутационная проба Задачи 15), потому что оба
    // гейта отказывают им уже по правилу «мутация не из `WORKER_SCOPE_TOOLS`». Это пин
    // ОБЪЯВЛЕНИЯ, а не поведения, и он станет несущим у первого ЧИТАЮЩЕГО тула реестра —
    // ровно как у `property_catalog`, где он несущий уже сейчас.
    const defs = await registryFor(userB);
    // Порядок — тот, в котором тулы стоят в реестре (`buildToolDefs`), и он наблюдаем:
    // по нему же снят эталон снимка.
    expect(defs.filter((d) => d.fullScopeOnly === true).map((d) => d.name)).toEqual([
      'property_catalog',
      'property_create',
      'property_update',
      'property_merge',
      'aspect_delta_set',
      'aspect_delta_remove',
    ]);
    expect(defOf(defs, 'property_catalog').kind).toBe('read');
    for (const name of REGISTRY_TOOL_NAMES) expect(defOf(defs, name).kind).toBe('mutate');
  });

  test('internalOnly: true только у user_query, import_csv_start и undo_last (§9.2: MCP не отдаются)', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      if (['user_query', 'import_csv_start', 'undo_last'].includes(def.name)) {
        expect(def.internalOnly).toBe(true);
      } else {
        expect(def.internalOnly).not.toBe(true);
      }
    }
  });

  test('agentOnly: true только у пяти глаголов исполнителя (§9.3); все они kind=mutate', async () => {
    // Глагол виден ТОЛЬКО вызову с грантом: чат такие дефы отсекает (send-message.ts),
    // dispatch держит вторую линию. Пометка на «обычном» туле закрыла бы его от чата молча.
    const defs = await registryFor(userB);
    const verbs = new Set<string>(AGENT_VERB_NAMES);
    for (const def of defs) {
      if (verbs.has(def.name)) {
        expect({ name: def.name, agentOnly: def.agentOnly, kind: def.kind }).toEqual({
          name: def.name,
          agentOnly: true,
          kind: 'mutate',
        });
      } else {
        expect({ name: def.name, agentOnly: def.agentOnly }).toEqual({
          name: def.name,
          agentOnly: undefined,
        });
      }
    }
  });

  test('entity_query: description содержит примеры грамматики §А5-3 (fix round Task 8)', async () => {
    // Модель не видит спецификацию §А5-3 — без примеров в description холодный резолв
    // category_ref (инструкция промпта v1) гарантированно бился бы о парсер
    const def = defOf(await registryFor(userB), 'entity_query');
    expect(def.description).toContain('aspect=orbis/category, search=Еда');
    expect(def.description).toContain(
      'aspect=orbis/task, orbis/task_status=!done&!cancelled, sortBy=orbis/updated_at:desc, limit=20',
    );
    // Синтаксис фильтра по списочному свойству неотличим от равенства: без образца модель
    // не догадается искать «такси» среди синонимов категории, а не в её названии.
    expect(def.description).toContain('aspect=orbis/category, orbis/aliases=такси');
  });

  test('entity_query: второй вход — дерево канона, и его схема уехала В тул целиком', async () => {
    // Провайдер (D29) не резолвит `$ref` за пределы документа тула: определение узла обязано
    // лежать в `$defs` САМОЙ схемы тула, иначе рекурсивная ветка приедет к нему битой.
    const def = defOf(await registryFor(userB), 'entity_query');
    const schema = def.inputJsonSchema;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(['ast', 'query']);
    expect((schema.$defs as Record<string, unknown>).node).toBeDefined();
    // Ровно один вход за вызов — тем же вердиктом, что даёт zod-envelope.
    expect(schema.oneOf).toEqual([{ required: ['query'] }, { required: ['ast'] }]);
    expect(entityQueryInput.safeParse({ query: 'tags=x', ast: { filter: null } }).success).toBe(
      false,
    );
    expect(entityQueryInput.safeParse({}).success).toBe(false);
    expect(entityQueryInput.safeParse({ ast: { filter: { tag: 'дом' } } }).success).toBe(true);
    // Ссылка внутри дерева осталась указателем ОТ КОРНЯ — иначе она указывала бы в пустоту.
    expect(JSON.stringify(props.ast)).toContain('#/$defs/node');
    // Метаданные отдельного документа внутрь чужой схемы не едут.
    expect(props.ast?.$schema).toBeUndefined();
  });

  // Пример — это то, ЧТО МОДЕЛЬ СКОПИРУЕТ. Непарсящийся образец хуже отсутствия примера:
  // модель уверенно повторит его и упрётся в отказ парсера, не поняв причины. Проверяем
  // все разом, вынимая их из description по кавычкам-ёлочкам, — новый пример не разъедется
  // с грамматикой молча.
  //
  // Запрос от прозы отличает ОПЕРАТОР, а не место в строке: ёлочки в этом файле — штатная
  // русская кавычка (у budget_status в описании стоит «что по бюджету?», у import_csv_start
  // — «импортируй выписку»), и брать подряд всё в ёлочках значило бы уронить тест на первой
  // же законной правке текста. Признак не зависит от того, где в описании стоит проза, —
  // привязка к маркеру «Примеры:» такой устойчивости не даёт.
  //
  // Операторов три (`=`, `>`, `<`), а не один: запрос без `=` грамматика принимает —
  // `amount>100` и `due<2026-01-01` разбираются и `=` не содержат. Признак по одному `=`
  // был бы дырой односторонней и тихой: пример из одних сравнений просто выпал бы из
  // проверки, а страховка на количество ниже этого не ловит — она считает то, что нашлось,
  // а не то, что должно было найтись. Обратная сторона: попади оператор в прозу — тест
  // упадёт на разборе, то есть громко, а не пропустит образец молча.
  test('entity_query: каждый пример из description разбирается парсером §6', async () => {
    // Отсев прозы проверяем синтетикой: в самом описании ёлочек-не-примеров сегодня нет,
    // и без этой строки правило «пример — это то, где есть оператор» осталось бы без теста.
    expect(
      grammarExamples('Смотри «что по бюджету?»: «tags=work» и «amount>100» — вот это запросы.'),
    ).toEqual(['tags=work', 'amount>100']);

    const def = defOf(await registryFor(userB), 'entity_query');
    const examples = grammarExamples(def.description);
    // Страховка от «регулярка перестала находить»: пустой список прошёл бы цикл молча.
    // Не равенство: четвёртый пример — законная правка, и она обязана попасть под ту же
    // проверку, а не уронить тест на счётчике.
    expect(examples.length).toBeGreaterThanOrEqual(3);
    // Разбор — каноном по реестру, и это единственный разбор, какой есть: переходный мост,
    // читавший старую форму, снят Задачей 21b. Пример, который канон не принимает, учил бы
    // модель языку, на котором сервер ей откажет. Реестр — встроенный, тот же, что кладёт сид.
    const reg = toParseRegistry(
      {
        properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
        aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
        roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
      },
      'ru',
    );
    for (const example of examples) {
      const r = parseQueryAst(example, reg);
      expect(r.ok ? null : `${example}: ${r.error.code} ${r.error.message}`).toBeNull();
    }
  });
});

describe('buildToolRegistry: attach_* из реестра аспектов (§7.6)', () => {
  test('attach_orbis_task: description = ai_instructions из БД', async () => {
    const defs = await registryFor(userB);
    const rows = await withIdentity(db, userB, (tx) =>
      tx
        .select({ ai: aspectDefinitions.aiInstructions })
        .from(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/task' AND ${isNull(aspectDefinitions.ownerId)}`,
        ),
    );
    const expected = rows[0]?.ai;
    expect(expected).toBeTruthy();
    expect(defOf(defs, 'attach_orbis_task').description).toBe(expected as string);
  });

  test('attach_orbis_task: параметры — key свойств по rank, required из ссылок аспекта, описание из локали (§А9-1)', async () => {
    const defs = await registryFor(userB);
    const schema = defOf(defs, 'attach_orbis_task').inputJsonSchema;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      'entity_id',
      'data',
    ]);
    const data = (schema.properties as Record<string, Record<string, unknown>>).data as Record<
      string,
      unknown
    >;
    // Имена параметров — namespaced key, порядок — rank ссылок аспекта (§Б7-3).
    expect(Object.keys(data.properties as Record<string, unknown>)).toEqual([
      'orbis/task_status',
      'orbis/priority',
      'orbis/due_date',
      'orbis/completed_at',
      'orbis/effort_min',
      'orbis/waiting_for',
    ]);
    expect(data.required).toEqual(['orbis/task_status']);
    expect(data.additionalProperties).toBe(false);
    const status = (data.properties as Record<string, Record<string, unknown>>)[
      'orbis/task_status'
    ];
    // enum по rank вариантов и описание «подпись — смысл» локали владельца плюс варианты.
    expect(status?.enum).toEqual([
      'inbox',
      'planned',
      'in_progress',
      'waiting',
      'done',
      'cancelled',
    ]);
    expect(status?.description).toBe(
      'Состояние задачи — На каком шаге работа над задачей (варианты: inbox|planned|in_progress|waiting|done|cancelled)',
    );
    expect((status?.[X_ORBIS_TYPE] as { kind?: string } | undefined)?.kind).toBe('select');
  });

  test('служебный аспект (колонка service) тула не получает — и это ЕДИНСТВЕННЫЙ такой', async () => {
    const names = (await registryFor(userB)).map((d) => d.name);
    const service = BUILTIN_ASPECT_DEFS.filter((a) => a.service);
    expect(service.map((a) => a.id)).toEqual(['orbis/agent-run']);
    for (const a of service) expect(names).not.toContain(attachToolName(a.key));
    for (const a of BUILTIN_ASPECT_DEFS.filter((x) => !x.service)) {
      expect(names).toContain(attachToolName(a.key));
    }
  });

  test('кастомный аспект userA: attach_user_sleep_log («/» и «-» → «_»), схема из БД; userB его не видит (RLS)', async () => {
    const defsA = await registryFor(userA);
    const def = defOf(defsA, 'attach_user_sleep_log');
    expect(def.kind).toBe('mutate');
    expect(def.description).toBe('Пиши часы сна числом.');
    expect((def.inputJsonSchema.properties as Record<string, unknown>).data).toEqual(CUSTOM_SCHEMA);
    expect(defsA.length).toBe(TOOL_REGISTRY_GOLDEN.length + 1);

    const defsB = await registryFor(userB);
    expect(defsB.some((d) => d.name === 'attach_user_sleep_log')).toBe(false);
  });
});

describe('роли рёбер в реестре тулов (§А4-3/§А4-4)', () => {
  function roleSchemaOf(
    defs: OrbisToolDef[],
    tool: string,
  ): { enum: string[]; description: string } {
    const props = defOf(defs, tool).inputJsonSchema.properties as Record<string, unknown>;
    return props.role as { enum: string[]; description: string };
  }

  test('relation_create НЕ предлагает модели системные роли: гейт created_by и enum сходятся', async () => {
    // Иначе «положи трату в конверт Еда» → модель выбирает `envelope-binding` → отказ
    // ROLE_SYSTEM_ONLY, и тупик возникает на ровном месте, из подсказки самого реестра.
    const defs = await registryFor(userB);
    const offered = roleSchemaOf(defs, 'relation_create').enum;
    const systemOnly = BUILTIN_RELATION_ROLE_META.filter(
      (r) => r.constraints.created_by === 'system',
    ).map((r) => r.id);
    expect(systemOnly.length).toBeGreaterThan(0); // иначе тест был бы вакуумным
    for (const id of systemOnly) expect(offered).not.toContain(id);
    expect(offered).toEqual(
      BUILTIN_RELATION_ROLE_META.filter((r) => r.constraints.created_by !== 'system').map(
        (r) => r.id,
      ),
    );
  });

  test('relation_delete предлагает ВСЕ одиннадцать: гейт стоит только на создании', async () => {
    // Убрать привязку к конверту или ребро прогона владельцу никто не запрещает — иначе
    // собственный граф стало бы нечем разбирать.
    const defs = await registryFor(userB);
    expect(roleSchemaOf(defs, 'relation_delete').enum).toEqual(
      BUILTIN_RELATION_ROLE_META.map((r) => r.id),
    );
  });

  test('описание роли — из реестра: смысл и направление, а не голый список id', async () => {
    const defs = await registryFor(userB);
    const description = roleSchemaOf(defs, 'relation_create').description;
    const subitem = BUILTIN_RELATION_ROLE_META.find((r) => r.id === 'subitem');
    if (!subitem) throw new Error('роль subitem не найдена в реестре');
    expect(description).toContain(subitem.label.ru as string);
    expect(description).toContain(subitem.description.ru as string);
    expect(description).toContain(`${subitem.sourceLabel.ru} → ${subitem.targetLabel.ru}`);
  });
});

describe('парность zod-envelope ↔ рукописная JSON Schema (§9.2)', () => {
  /**
   * Объект внутри envelope: у `entity_query` схема обёрнута `.refine` («ровно одно из
   * query|ast», §А5-4), а у `ZodEffects` нет ни `.shape`, ни `.isOptional()` по ключам.
   * Разворачиваем до объекта, а не заводим вторую схему без правила: правило и форма
   * обязаны жить в одном месте, иначе парность проверялась бы у ДРУГОЙ схемы.
   */
  // biome-ignore lint/suspicious/noExplicitAny: доступ к .shape любого ZodObject
  const objectOf = (schema: z.ZodTypeAny): z.ZodObject<any> =>
    schema instanceof z.ZodEffects
      ? objectOf(schema.innerType() as z.ZodTypeAny)
      : // biome-ignore lint/suspicious/noExplicitAny: см. выше
        (schema as z.ZodObject<any>);

  const ZOD_BY_TOOL: Record<string, z.ZodTypeAny> = {
    entity_query: entityQueryInput,
    property_catalog: propertyCatalogInput,
    entity_get: entityGetInput,
    entity_create: entityCreateInput,
    entity_update: entityUpdateInput,
    relation_create: relationCreateInput,
    relation_delete: relationDeleteInput,
    batch_execute: batchExecuteInput,
    user_query: userQueryInput,
    budget_status: budgetStatusInput,
    thread_post: threadPostInput,
    import_csv_start: importCsvStartInput,
    undo_last: undoLastInput,
    // Глаголы исполнителя (§9.3): рукописная JSON Schema реестра ↔ envelope
    // @orbis/shared/contracts/agent-loop — рассинхрон падает здесь, а не у агента
    orbis_my_queue: myQueueInput,
    orbis_claim_task: claimTaskInput,
    orbis_run_step: runStepInput,
    orbis_checkpoint: checkpointInput,
    orbis_finish: finishInput,
    // Предложение рутины (V1.6) — тот же контракт парности, что у глаголов
    orbis_propose: proposeInput,
    // Вопрос пачки (D42 ОЧ.5). Запись сюда — РУЧНАЯ, и это единственная дыра теста:
    // он итерируется по карте, и забытый тул не проверяется молча
    orbis_ask: askInput,
  };

  test('каждый ключ zod-схемы есть в JSON Schema и наоборот; required = не-optional ключи zod', async () => {
    const defs = await registryFor(userB);
    for (const [tool, schema] of Object.entries(ZOD_BY_TOOL)) {
      const zodSchema = objectOf(schema);
      const jsonSchema = defOf(defs, tool).inputJsonSchema;
      const props = Object.keys(jsonSchema.properties as Record<string, unknown>).sort();
      const zodKeys = Object.keys(zodSchema.shape).sort();
      expect({ tool, keys: props }).toEqual({ tool, keys: zodKeys });

      const required = [...((jsonSchema.required as string[] | undefined) ?? [])].sort();
      const zodRequired = zodKeys.filter((k) => !zodSchema.shape[k].isOptional()).sort();
      expect({ tool, required }).toEqual({ tool, required: zodRequired });
      // strict-режим zod ↔ additionalProperties: false
      expect({ tool, ap: jsonSchema.additionalProperties }).toEqual({ tool, ap: false });
    }
  });

  test('attach_*: top-level ключи JSON Schema = ключи attachAspectInput (envelope §9.2)', async () => {
    const defs = await registryFor(userB);
    const zodKeys = Object.keys(attachAspectInput.shape).sort();
    for (const def of defs.filter((d) => d.name.startsWith('attach_'))) {
      const props = Object.keys(def.inputJsonSchema.properties as Record<string, unknown>).sort();
      expect({ tool: def.name, keys: props }).toEqual({ tool: def.name, keys: zodKeys });
    }
  });

  test('собственное определение перекрывает builtin при коллизии id (ORDER BY owner_id NULLS FIRST)', async () => {
    // Кастомный orbis/note userA поверх builtin: attach_orbis_note берёт описание кастомного
    const { db: admin, client: adminClient } = adminDb();
    try {
      await seedCustomAspect(userA, {
        key: 'orbis/note',
        label: { ru: 'Заметка (своя)', en: 'Note (custom)' },
        aiInstructions: 'Кастомная инструкция заметки.',
        properties: [],
      });
      const defs = await registryFor(userA);
      expect(defOf(defs, 'attach_orbis_note').description).toBe('Кастомная инструкция заметки.');
      // имя не задублировано
      expect(defs.filter((d) => d.name === 'attach_orbis_note').length).toBe(1);
    } finally {
      await admin
        .delete(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/note' AND ${eq(aspectDefinitions.ownerId, userA)}`,
        );
      await adminClient.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Реестр тулов рутины (V1.10): что видит модель прогона
// ---------------------------------------------------------------------------

describe('routineToolDefs: реестр прогона рутины (V1.10, рулинг В2)', () => {
  /** Ссылка на рутину без живых сущностей: правило смотрит только на режим и список. */
  const ref = (mode: 'propose' | 'act', allowed: string[] = []): RoutineRef => ({
    id: '019e4466-aaaa-7e07-b5d4-64be9721da51',
    runId: '019e4466-bbbb-7e07-b5d4-64be9721da52',
    mode,
    allowedTools: new Set(allowed),
  });

  test('propose: все чтения + база (orbis_checkpoint, orbis_ask) + orbis_propose; ни одной мутации сверх', async () => {
    const defs: OrbisToolDef[] = await registryFor(userB);
    const names = routineToolDefs(defs, ref('propose')).map((d) => d.name);

    for (const d of defs.filter((x) => x.kind === 'read')) expect(names).toContain(d.name);
    expect(names).toContain('orbis_checkpoint');
    // D42 ОЧ.5 (Б6 ревью): нетерминальный вопрос — в БАЗЕ рутины, а не рычаг режима act.
    // Довод базы («оставить рутину без выхода нельзя») на вопрос распространяется целиком
    expect(names).toContain('orbis_ask');
    expect(names).toContain('orbis_propose');
    // мутаций сверх базы и предложения нет — включая круг внешнего исполнителя
    const mutating = routineToolDefs(defs, ref('propose')).filter((d) => d.kind === 'mutate');
    expect(mutating.map((d) => d.name).sort()).toEqual([
      'orbis_ask',
      'orbis_checkpoint',
      'orbis_propose',
    ]);
  });

  test('act: РОВНО белый список сверх чтений и базы; orbis_propose уже не показывается', async () => {
    const defs = await registryFor(userB);
    const names = routineToolDefs(defs, ref('act', ['entity_update', 'thread_post'])).map(
      (d) => d.name,
    );
    const mutating = routineToolDefs(defs, ref('act', ['entity_update', 'thread_post']))
      .filter((d) => d.kind === 'mutate')
      .map((d) => d.name)
      .sort();
    expect(mutating).toEqual(['entity_update', 'orbis_ask', 'orbis_checkpoint', 'thread_post']);
    expect(names).toContain('entity_query');
    // Имя вне реестра в белом списке ничего не добавляет (fail-closed сверяет с дефами)
    expect(routineToolDefs(defs, ref('act', ['выдуманный_тул'])).map((d) => d.name)).not.toContain(
      'выдуманный_тул',
    );
  });

  test('batch_execute белым списком не открывается — ни в act, ни в propose', async () => {
    // Группа рутине неисполнима по уровню (§7.10: preview ≠ execute), а гейт режима
    // сверяет только внешнее имя вызова — вложенные операции белым списком не проверяются
    const defs = await registryFor(userB);
    for (const mode of ['propose', 'act'] as const) {
      const names = routineToolDefs(defs, ref(mode, ['batch_execute', 'entity_update'])).map(
        (d) => d.name,
      );
      expect(names).not.toContain('batch_execute');
    }
    // Отсечение точечное: соседнее имя того же белого списка на месте
    expect(
      routineToolDefs(defs, ref('act', ['batch_execute', 'entity_update'])).map((d) => d.name),
    ).toContain('entity_update');
  });

  test('undo_last белым списком не открывается — ни в act, ни в propose (ROUTINE_CLOSED_TOOLS)', async () => {
    // «Отмени последнее» снимает последнее видимое действие журнала ВЛАДЕЛЬЦА, чьё бы оно ни
    // было: фоновый прогон с таким рычагом затирал бы правки владельца (инвариант 7)
    const defs = await registryFor(userB);
    for (const mode of ['propose', 'act'] as const) {
      expect(
        routineToolDefs(defs, ref(mode, ['undo_last', 'entity_update'])).map((d) => d.name),
      ).not.toContain('undo_last');
    }
    expect(
      routineToolDefs(defs, ref('act', ['undo_last', 'entity_update'])).map((d) => d.name),
    ).toContain('entity_update');
  });

  test('круг внешнего исполнителя белым списком не открывается: act с [orbis_finish, entity_update] → без orbis_finish', async () => {
    // Шаги пишет и итог подводит РАННЕР (closeRoutineRun) напрямую, минуя dispatch:
    // модель, закрывшая прогон сама, обнулила бы его итог. Очередь и захват тикета —
    // грантовые по устройству, у прогона рутины нет ни того, ни другого (V1.5).
    const defs = await registryFor(userB);
    const names = routineToolDefs(defs, ref('act', ['orbis_finish', 'entity_update'])).map(
      (d) => d.name,
    );
    expect(names).not.toContain('orbis_finish');
    expect(names).toContain('entity_update');
    for (const closed of ['orbis_run_step', 'orbis_my_queue', 'orbis_claim_task']) {
      expect(routineToolDefs(defs, ref('act', [closed])).map((d) => d.name)).not.toContain(closed);
    }
    // Чекпойнт — исключение из того же круга: он остаётся рутине всегда (рулинг В2)
    expect(routineToolDefs(defs, ref('act')).map((d) => d.name)).toContain('orbis_checkpoint');
  });

  test('property_catalog рутине ДОСТУПЕН в обоих режимах: fullScopeOnly — про скоуп гранта, не про фон', async () => {
    // §А9-4 закрывает каталог фоновому ИСПОЛНИТЕЛЮ по гранту (`worker`), а рутина работает
    // над графом владельца от его имени и обязана его видеть — тот же довод, по которому
    // ей открыты все прочие чтения. `routineToolAllowed` признака не смотрит вовсе.
    const defs = await registryFor(userB);
    for (const mode of ['propose', 'act'] as const) {
      expect(routineToolDefs(defs, ref(mode)).map((d) => d.name)).toContain('property_catalog');
    }
  });

  test('тулы реестра рутине act ДОПУСТИМЫ по allowed_tools: fullScopeOnly — про скоуп гранта, не про фон', async () => {
    // `routineToolAllowed` признака не смотрит вовсе (тот же довод, что у property_catalog):
    // рутина работает над графом владельца от его имени. Что при этом СЛУЧИТСЯ с уровнем
    // подтверждения (§7.10: та же операция от рутины — отложенная единица пачки) — вопрос
    // Задачи 16; здесь пиннится только доступность по белому списку.
    const defs = await registryFor(userB);
    for (const name of REGISTRY_TOOL_NAMES) {
      expect(routineToolDefs(defs, ref('act', [name])).map((d) => d.name)).toContain(name);
      // Без записи в белом списке — недоступны: инвариант 5 V1 держится и для реестра.
      expect(routineToolDefs(defs, ref('act')).map((d) => d.name)).not.toContain(name);
      // В режиме propose мутации закрыты все, включая реестровые.
      expect(routineToolDefs(defs, ref('propose', [name])).map((d) => d.name)).not.toContain(name);
    }
  });

  test('act с пустым allowed_tools: рутина остаётся с чтениями и базой (чекпойнт + вопрос)', async () => {
    const defs = await registryFor(userB);
    const mutating = routineToolDefs(defs, ref('act'))
      .filter((d) => d.kind === 'mutate')
      .map((d) => d.name)
      .sort();
    expect(mutating).toEqual(['orbis_ask', 'orbis_checkpoint']);
  });
});
