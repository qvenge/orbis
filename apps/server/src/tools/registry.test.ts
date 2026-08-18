// Интеграционные тесты реестра LLM/MCP-тулов (§9.2, §7.6): живая БД под withIdentity.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  aspectJsonSchema,
  attachAspectInput,
  BUILTIN_ASPECT_IDS,
  batchExecuteInput,
  budgetStatusInput,
  buildFieldCatalog,
  checkpointInput,
  claimTaskInput,
  entityCreateInput,
  entityGetInput,
  entityQueryInput,
  entityUpdateInput,
  finishInput,
  myQueueInput,
  parseQuery,
  relationCreateInput,
  relationDeleteInput,
  runStepInput,
  SERVICE_ASPECT_IDS,
} from '@orbis/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { aspectDefinitions } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import {
  AGENT_VERB_NAMES,
  buildToolRegistry,
  importCsvStartInput,
  type OrbisToolDef,
  type RoutineRef,
  routineToolDefs,
  threadPostInput,
  userQueryInput,
} from './registry';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();

/** Кастомный аспект userA: id с '/' И '-' — проверка нормализации имени тула (решение 3). */
const CUSTOM_ASPECT_ID = 'user/sleep-log';
const CUSTOM_SCHEMA = {
  type: 'object',
  properties: { hours: { type: 'number' } },
  required: ['hours'],
  additionalProperties: false,
};

beforeAll(async () => {
  await truncateAll();
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.insert(aspectDefinitions).values({
      id: CUSTOM_ASPECT_ID,
      ownerId: userA,
      name: 'Sleep Log',
      namespace: 'user',
      description: 'Трекинг сна.',
      schema: CUSTOM_SCHEMA,
      aiInstructions: 'Пиши часы сна числом.',
      viewConfig: { keyFields: ['hours'] },
    });
  } finally {
    await adminClient.end();
  }
});

afterAll(async () => {
  await client.end();
});

function registryFor(userId: string): Promise<OrbisToolDef[]> {
  return withIdentity(db, userId, (tx) => buildToolRegistry(tx));
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
  'import_csv_start', // C4c: вход в импорт из чата (03-budget §3.4), internalOnly
] as const;

/** Служебные аспекты (orbis/agent-run) attach_*-тула не получают — их правит только сервер. */
const BUILTIN_ATTACH_NAMES = BUILTIN_ASPECT_IDS.filter(
  (id) => !(SERVICE_ASPECT_IDS as readonly string[]).includes(id),
).map((id) => `attach_${id.replaceAll('/', '_').replaceAll('-', '_')}`);

describe('buildToolRegistry: состав (§9.2 + §7.6)', () => {
  test('builtin-реестр (userB без кастомных): 11 core (с thread_post) + 5 глаголов + 12 attach_* = 28', async () => {
    const defs = await registryFor(userB);
    const names = defs.map((d) => d.name);
    for (const name of CORE_NAMES) expect(names).toContain(name);
    expect(names).toContain('thread_post');
    for (const name of AGENT_VERB_NAMES) expect(names).toContain(name);
    for (const name of BUILTIN_ATTACH_NAMES) expect(names).toContain(name);
    expect(defs.length).toBe(28);
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

  test('kind: entity_query/entity_get/user_query/budget_status/import_csv_start — read, остальные — mutate', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      const expected = [
        'entity_query',
        'entity_get',
        'user_query',
        'budget_status',
        'import_csv_start',
      ].includes(def.name)
        ? 'read'
        : 'mutate';
      expect(def.kind).toBe(expected);
    }
  });

  test('internalOnly: true только у user_query и import_csv_start (§9.2: MCP не отдаются)', async () => {
    const defs = await registryFor(userB);
    for (const def of defs) {
      if (def.name === 'user_query' || def.name === 'import_csv_start') {
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

  test('entity_query: description содержит примеры грамматики §6 (fix round Task 8)', async () => {
    // Модель не видит спецификацию §6 — без примеров в description холодный резолв
    // category_ref (инструкция промпта v1) гарантированно бился бы о парсер
    const def = defOf(await registryFor(userB), 'entity_query');
    expect(def.description).toContain('aspect=orbis/category, search=Еда');
    expect(def.description).toContain(
      'aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20',
    );
    // Синтаксис фильтра по полю-массиву неотличим от равенства: без образца модель не
    // догадается искать «такси» среди синонимов категории, а не в её названии.
    expect(def.description).toContain('aspect=orbis/category, aliases=такси');
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
    const catalog = buildFieldCatalog(
      BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
    );
    for (const example of examples) {
      const r = parseQuery(example, catalog);
      expect(r.ok ? null : `${example}: ${r.error.message}`).toBeNull();
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

  test('attach_orbis_task: inputJsonSchema = envelope {entity_id, data: <схема аспекта из БД>}', async () => {
    const defs = await registryFor(userB);
    const rows = await withIdentity(db, userB, (tx) =>
      tx
        .select({ schema: aspectDefinitions.schema })
        .from(aspectDefinitions)
        .where(
          sql`${aspectDefinitions.id} = 'orbis/task' AND ${isNull(aspectDefinitions.ownerId)}`,
        ),
    );
    expect(defOf(defs, 'attach_orbis_task').inputJsonSchema).toEqual({
      type: 'object',
      properties: {
        entity_id: { type: 'string', format: 'uuid' },
        data: rows[0]?.schema as Record<string, unknown>,
      },
      required: ['entity_id', 'data'],
      additionalProperties: false,
    });
  });

  test('кастомный аспект userA: attach_user_sleep_log («/» и «-» → «_»), схема из БД; userB его не видит (RLS)', async () => {
    const defsA = await registryFor(userA);
    const def = defOf(defsA, 'attach_user_sleep_log');
    expect(def.kind).toBe('mutate');
    expect(def.description).toBe('Пиши часы сна числом.');
    expect((def.inputJsonSchema.properties as Record<string, unknown>).data).toEqual(CUSTOM_SCHEMA);
    expect(defsA.length).toBe(29);

    const defsB = await registryFor(userB);
    expect(defsB.some((d) => d.name === 'attach_user_sleep_log')).toBe(false);
  });
});

describe('парность zod-envelope ↔ рукописная JSON Schema (§9.2)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: доступ к .shape любого ZodObject
  const ZOD_BY_TOOL: Record<string, z.ZodObject<any>> = {
    entity_query: entityQueryInput,
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
    // Глаголы исполнителя (§9.3): рукописная JSON Schema реестра ↔ envelope
    // @orbis/shared/contracts/agent-loop — рассинхрон падает здесь, а не у агента
    orbis_my_queue: myQueueInput,
    orbis_claim_task: claimTaskInput,
    orbis_run_step: runStepInput,
    orbis_checkpoint: checkpointInput,
    orbis_finish: finishInput,
  };

  test('каждый ключ zod-схемы есть в JSON Schema и наоборот; required = не-optional ключи zod', async () => {
    const defs = await registryFor(userB);
    for (const [tool, zodSchema] of Object.entries(ZOD_BY_TOOL)) {
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
      await admin.insert(aspectDefinitions).values({
        id: 'orbis/note',
        ownerId: userA,
        name: 'Note (custom)',
        namespace: 'orbis',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        aiInstructions: 'Кастомная инструкция заметки.',
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

  test('propose: все чтения + orbis_checkpoint + orbis_propose; ни одной мутации сверх', async () => {
    // orbis_propose дефом появится в Задаче 8 — правило обязано быть готово раньше,
    // иначе реестр раннера в день его появления молча оставит рутину без предложения
    const defs: OrbisToolDef[] = [
      ...(await registryFor(userB)),
      {
        name: 'orbis_propose',
        description: 'предложение',
        inputJsonSchema: {},
        kind: 'mutate',
        routineOnly: true,
      },
    ];
    const names = routineToolDefs(defs, ref('propose')).map((d) => d.name);

    for (const d of defs.filter((x) => x.kind === 'read')) expect(names).toContain(d.name);
    expect(names).toContain('orbis_checkpoint');
    expect(names).toContain('orbis_propose');
    // мутаций сверх базы и предложения нет — включая круг внешнего исполнителя
    const mutating = routineToolDefs(defs, ref('propose')).filter((d) => d.kind === 'mutate');
    expect(mutating.map((d) => d.name).sort()).toEqual(['orbis_checkpoint', 'orbis_propose']);
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
    expect(mutating).toEqual(['entity_update', 'orbis_checkpoint', 'thread_post']);
    expect(names).toContain('entity_query');
    // Имя вне реестра в белом списке ничего не добавляет (fail-closed сверяет с дефами)
    expect(routineToolDefs(defs, ref('act', ['выдуманный_тул'])).map((d) => d.name)).not.toContain(
      'выдуманный_тул',
    );
  });

  test('act с пустым allowed_tools: рутина остаётся с чтениями и чекпойнтом', async () => {
    const defs = await registryFor(userB);
    const mutating = routineToolDefs(defs, ref('act'))
      .filter((d) => d.kind === 'mutate')
      .map((d) => d.name);
    expect(mutating).toEqual(['orbis_checkpoint']);
  });
});
