// apps/server/src/llm/context.test.ts
// Интеграционные тесты buildContext (§7.1) против живой БД: слой 1 (тело промпта, дата
// владельца §Б7-6-1 и ai_instructions аспектов), слой 2 (память с капом и приоритетом
// §7.4), слой 3 (якорная сущность — только для треда сущности, 02 §2.2), слой 4
// (rolling-история CONTEXT_HISTORY_LIMIT, сжатие audit-сообщений без сырого JSON), а
// также порядок СОБРАННОГО канала: блок продолжений идёт последним (§Б7-6-2 — гард
// переехал сюда с текста промпта, v5.test.ts). Слой 5 — Task 9.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { and, eq, isNull } from 'drizzle-orm';
import {
  appDb,
  entityColumns,
  executeWithFixtureCategories as execute,
  freshUserId,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import { appendMessage } from '../chat/messages';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { aspectDefinitions, chatMessages, entities, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import {
  ANCHOR_BODY_PREVIEW,
  buildContext,
  CONTEXT_HISTORY_LIMIT,
  CONTINUATIONS_BLOCK,
  CONTINUATIONS_HEADING,
  MEMORY_BODY_PREVIEW,
  MEMORY_CAP,
  PROMPT_BODY,
  todaySection,
  toolResultMessage,
} from './context';
import { SYSTEM_PROMPT_V5 } from './prompts/v5';

requireEnv();

const { db, client } = appDb();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** memory-сущность напрямую (обычная entity с аспектом orbis/memory, §3.7). */
async function createMemory(
  ownerId: string,
  opts: {
    title: string;
    body?: string;
    kind: 'fact' | 'rule';
    scope?: string;
    archived?: boolean;
    updatedAt?: Date;
  },
): Promise<string> {
  const id = newId();
  await withIdentity(db, ownerId, async (tx) =>
    tx.insert(entities).values({
      id,
      ownerId,
      title: opts.title,
      body: opts.body ?? '',
      archived: opts.archived ?? false,
      ...(await entityColumns(
        tx,
        ownerId,
        {
          'orbis/memory_kind': opts.kind,
          ...(opts.scope ? { 'orbis/rule_scope': opts.scope } : {}),
        },
        ['orbis/memory'],
      )),
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    }),
  );
  return id;
}

/** Строки блока памяти в system (формат «— [rule|fact]…»). */
function memoryLines(system: string): string[] {
  return system.split('\n').filter((l) => l.startsWith('— ['));
}

describe('buildContext — слой 1: тело промпта + ai_instructions аспектов', () => {
  const user = freshUserId();

  // Пин был `startsWith(SYSTEM_PROMPT_V5)`. После §Б7-6-2 блок продолжений уехал в ХВОСТ
  // собранного канала, поэтому промпт лежит в канале двумя кусками и целиком в его начале
  // больше не стоит ПО ПОСТРОЕНИЮ. Начало канала пиннится телом промпта, целостность
  // текста — тем, что канал несёт оба куска и заканчивается вторым (тесты §Б7-6 ниже).
  test('канал начинается с PROMPT_BODY и содержит ai_instructions активных аспектов из БД', async () => {
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      return buildContext(tx, { ownerId: user, threadId });
    });
    expect(ctx.system.startsWith(PROMPT_BODY)).toBe(true);
    expect(ctx.system).toContain(CONTINUATIONS_BLOCK);
    // Инструкция builtin-аспекта — из реестра БД (сид), а не из констант кода
    const rows = await withIdentity(db, user, (tx) =>
      tx
        .select({ ai: aspectDefinitions.aiInstructions })
        .from(aspectDefinitions)
        .where(and(eq(aspectDefinitions.id, 'orbis/task'), isNull(aspectDefinitions.ownerId))),
    );
    const taskInstructions = rows[0]?.ai;
    if (!taskInstructions) throw new Error('builtin orbis/task не сидирован (bun run db:prepare)');
    expect(ctx.system).toContain('orbis/task');
    expect(ctx.system).toContain(taskInstructions);
  });
});

describe('buildContext — §Б7-6: дата владельца и блок продолжений последним', () => {
  test('CONTINUATIONS_HEADING встречается в SYSTEM_PROMPT_V5 ровно один раз; PROMPT_BODY + CONTINUATIONS_BLOCK === SYSTEM_PROMPT_V5', () => {
    // Ровно один: split даёт две части только при единственном вхождении — иначе
    // PROMPT_BODY отрезался бы по ПЕРВОМУ, и часть текста уехала бы в хвост канала
    expect(SYSTEM_PROMPT_V5.split(CONTINUATIONS_HEADING)).toHaveLength(2);
    // Части ВЫЧИСЛЯЮТСЯ из константы, а не копируются текстом (РП-18: v5.ts правится только
    // новой версией) — конкатенация обязана давать исходный промпт побайтно
    expect(PROMPT_BODY + CONTINUATIONS_BLOCK).toBe(SYSTEM_PROMPT_V5);
    expect(CONTINUATIONS_BLOCK.startsWith(CONTINUATIONS_HEADING)).toBe(true);
    expect(PROMPT_BODY).not.toContain(CONTINUATIONS_HEADING);
  });

  test('todaySection: дата, день недели и зона владельца одной строкой', () => {
    expect(todaySection({ today: '2026-08-26', timeZone: 'Europe/Moscow' })).toBe(
      'Сегодня: 2026-08-26 (среда), таймзона владельца: Europe/Moscow.',
    );
  });

  test('канал несёт дату владельца в его таймзоне — после промпта, до инструкций аспектов', async () => {
    const user = freshUserId();
    await withIdentity(db, user, (tx) =>
      tx.insert(userSettings).values({ ownerId: user, timezone: 'Asia/Bangkok' }),
    );
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      // 18:30Z — это уже 01:30 СЛЕДУЮЩЕГО дня в Бангкоке: дата берётся в зоне владельца,
      // а не в UTC сервера, иначе «сегодня» модели расходится с «сегодня» пользователя
      return buildContext(tx, {
        ownerId: user,
        threadId,
        clock: () => new Date('2026-08-26T18:30:00Z'),
      });
    });
    const dateLine = 'Сегодня: 2026-08-27 (четверг), таймзона владельца: Asia/Bangkok.';
    expect(ctx.system).toContain(dateLine);
    // Позиция: сразу за телом промпта и выше инструкций аспектов
    expect(ctx.system.indexOf(dateLine)).toBe(PROMPT_BODY.length);
    expect(ctx.system.indexOf(dateLine)).toBeLessThan(
      ctx.system.indexOf('Инструкции активных аспектов:'),
    );
  });

  test('дата берётся в дефолтной зоне, когда строки user_settings ещё нет (онбординг не пройден)', async () => {
    const user = freshUserId();
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      return buildContext(tx, {
        ownerId: user,
        threadId,
        clock: () => new Date('2026-08-26T22:30:00Z'),
      });
    });
    // Europe/Moscow (UTC+3): 22:30Z — уже 01:30 следующего дня
    expect(ctx.system).toContain(
      'Сегодня: 2026-08-27 (четверг), таймзона владельца: Europe/Moscow.',
    );
  });

  test('блок продолжений — ПОСЛЕДНЯЯ секция собранного канала при непустых памяти и якоре', async () => {
    const user = freshUserId();
    await createMemory(user, { title: 'ПАМЯТЬ-ХВОСТ', kind: 'rule' });
    const anchorId = newId();
    await withIdentity(db, user, async (tx) =>
      tx.insert(entities).values({
        id: anchorId,
        ownerId: user,
        title: 'Якорь-хвост',
        body: 'тело якоря',
        ...(await entityColumns(tx, user, { 'orbis/task_status': 'in_progress' }, ['orbis/task'])),
      }),
    );
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureEntityThread(tx, user, anchorId);
      return buildContext(tx, { ownerId: user, threadId, anchorEntityId: anchorId });
    });

    // Случай не вырожденный: все четыре динамические секции в канале ЕСТЬ
    expect(ctx.system).toContain('Сегодня: ');
    expect(ctx.system).toContain('Инструкции активных аспектов:');
    expect(ctx.system).toContain('ПАМЯТЬ-ХВОСТ');
    expect(ctx.system).toContain(`id: ${anchorId}`);

    // …и все они ВЫШЕ блока продолжений, а он замыкает канал: инструкция «отдельной
    // последней строкой ответа» теряет силу примера, если после неё идёт ещё что-то
    const tail = ctx.system.indexOf(CONTINUATIONS_HEADING);
    expect(tail).toBeGreaterThan(ctx.system.indexOf('Сегодня: '));
    expect(tail).toBeGreaterThan(ctx.system.indexOf('Инструкции активных аспектов:'));
    expect(tail).toBeGreaterThan(ctx.system.indexOf('ПАМЯТЬ-ХВОСТ'));
    expect(tail).toBeGreaterThan(ctx.system.indexOf(`id: ${anchorId}`));
    expect(ctx.system.trimEnd().endsWith(CONTINUATIONS_BLOCK.trimEnd())).toBe(true);
  });
});

describe('buildContext — слой 2: память с капом и приоритетом (§7.4)', () => {
  const user = freshUserId();
  const base = Date.UTC(2026, 0, 10, 12, 0, 0);

  test(`кап ${MEMORY_CAP}, rule раньше fact, scoped раньше глобальных, archived исключена`, async () => {
    // archived — не должна попасть вовсе
    await createMemory(user, { title: 'ARCHIVED-MEM', kind: 'rule', archived: true });
    // scoped rule СТАРШЕ глобального rule по updated_at — но обязан идти первым (scope-приоритет)
    await createMemory(user, {
      title: 'RULE-SCOPED',
      kind: 'rule',
      scope: 'orbis/money-movement',
      body: 'бар → категория Развлечения',
      updatedAt: new Date(base - 1_000_000),
    });
    await createMemory(user, {
      title: 'RULE-GLOBAL',
      kind: 'rule',
      updatedAt: new Date(base - 500_000),
    });
    // 52 глобальных fact со строго возрастающим updated_at: FACT-00 — самый старый
    for (let i = 0; i < 52; i++) {
      const title = `FACT-${String(i).padStart(2, '0')}`;
      await createMemory(user, {
        title,
        kind: 'fact',
        updatedAt: new Date(base + i * 60_000),
      });
    }

    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      return buildContext(tx, { ownerId: user, threadId });
    });

    const lines = memoryLines(ctx.system);
    // Кап: 55 активных memory → ровно MEMORY_CAP строк
    expect(lines.length).toBe(MEMORY_CAP);
    // Приоритет: оба rule впереди, scoped — первым (несмотря на более старый updated_at)
    expect(lines[0]).toStartWith('— [rule][orbis/money-movement] RULE-SCOPED');
    expect(lines[1]).toStartWith('— [rule] RULE-GLOBAL');
    // fact сортируются updated_at desc: свежие в капе, старейшие вытеснены
    expect(ctx.system).toContain('FACT-51');
    expect(ctx.system).toContain('FACT-04');
    expect(ctx.system).not.toContain('FACT-03');
    expect(ctx.system).not.toContain('FACT-00');
    // archived не инжектится
    expect(ctx.system).not.toContain('ARCHIVED-MEM');
  });

  // ПРИЁМКА ЗАДАЧИ 18 (В7). Строка ПРАВИЛА в канале собирается ИЗ СВОЙСТВ при чтении:
  // образец — `orbis/rule_pattern`, правая часть — заголовок записи по ССЫЛКЕ
  // `orbis/rule_target`. До реформы правая часть была сохранённой СТРОКОЙ в заголовке
  // правила, и переименование категории делало её ложью — модель видела в памяти имя,
  // которого в графе уже нет, и предлагала владельцу несуществующую категорию.
  //
  // Сохранённая подпись здесь НАМЕРЕННО оставлена устаревшей («… → Еда»): пока она в
  // колонке лжёт, видно, что канал собран из свойств, а не взят из title.
  test('правило: подпись в канале собирается из свойств и переживает переименование категории', async () => {
    const user5 = freshUserId();
    const category = newId();
    const ruleId = newId();
    // Категорию заводит фикстурный помощник (обстановка, не предмет проверки), поэтому
    // здесь только правило; сразу после — переименование в «Еда», чтобы обе подписи
    // (сохранённая и собираемая) стартовали одинаковыми и расхождение стало наблюдаемым.
    const one = (input: Record<string, unknown>, tool = 'entity_create') => ({
      actorUserId: user5,
      actorKind: 'owner' as const,
      source: 'ui' as const,
      operations: [{ tool, input }],
    });
    const created = await execute(
      db,
      one({
        id: ruleId,
        title: 'пятерочка → Еда',
        tags: [],
        props: {
          'orbis/memory_kind': 'rule',
          'orbis/rule_scope': 'orbis/money-movement',
          'orbis/rule_pattern': 'пятерочка',
          'orbis/rule_target': category,
        },
        aspects: ['orbis/memory'],
      }),
    );
    expect(created.ok).toBe(true);
    expect((await execute(db, one({ id: category, title: 'Еда' }, 'entity_update'))).ok).toBe(true);

    const before = await withIdentity(db, user5, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user5);
      return buildContext(tx, { ownerId: user5, threadId });
    });
    expect(memoryLines(before.system)).toEqual(['— [rule][orbis/money-movement] пятерочка → Еда']);

    const renamed = await execute(db, one({ id: category, title: 'Продукты' }, 'entity_update'));
    expect(renamed.ok).toBe(true);
    const after = await withIdentity(db, user5, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user5);
      return buildContext(tx, { ownerId: user5, threadId });
    });
    expect(memoryLines(after.system)).toEqual([
      '— [rule][orbis/money-movement] пятерочка → Продукты',
    ]);
    // Правило ЖИВО, а сохранённая подпись в КОЛОНКЕ осталась прежней — именно её показал
    // бы канал, если бы читал `title`. Без этой половины тест не отличал бы «собрано из
    // свойств» от «title заодно переписался».
    const [stored] = await withIdentity(db, user5, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, ruleId)),
    );
    expect(stored?.title).toBe('пятерочка → Еда');
  });

  /**
   * ГРАНИЦА ТОГО ЖЕ ПРАВИЛА, и до этой пробы она держалась ОДНИМ ДОКБЛОКОМ: цель у правила
   * ЕСТЬ, но не разыменовывается (запись снесена). Подпись обязана остаться одним образцом,
   * а НЕ откатиться к сохранённому заголовку — тот несёт имя категории, которой в графе уже
   * нет, и откат к нему показал бы модели ровно то, что задача убирает.
   *
   * Предыдущая редакция `loadMemory` откатывалась к заголовку именно здесь; ни один тест
   * этого не ловил (`context.test.ts` был 25/0 в обе стороны).
   */
  test('правило со СНЕСЁННОЙ целью: подпись — один образец, а не устаревший заголовок', async () => {
    const user6 = freshUserId();
    const category = newId();
    const one = (input: Record<string, unknown>, tool = 'entity_create') => ({
      actorUserId: user6,
      actorKind: 'owner' as const,
      source: 'ui' as const,
      operations: [{ tool, input }],
    });
    const created = await execute(
      db,
      one({
        title: 'пятерочка → Еда',
        tags: [],
        props: {
          'orbis/memory_kind': 'rule',
          'orbis/rule_scope': 'orbis/money-movement',
          'orbis/rule_pattern': 'пятерочка',
          'orbis/rule_target': category,
        },
        aspects: ['orbis/memory'],
      }),
    );
    expect(created.ok).toBe(true);
    // Сносим цель ПРЯМЫМ SQL: через исполнителя ссылку не оборвать (валидатор целей не
    // даст), а строка, оставшаяся без цели, в графе владельца возможна — ровно этот случай
    // проба и описывает.
    await withIdentity(db, user6, (tx) => tx.delete(entities).where(eq(entities.id, category)));

    const ctx = await withIdentity(db, user6, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user6);
      return buildContext(tx, { ownerId: user6, threadId });
    });
    expect(memoryLines(ctx.system)).toEqual(['— [rule][orbis/money-movement] пятерочка']);
    // Именно НЕ заголовок: он в колонке цел и назвал бы снесённую категорию.
    expect(ctx.system).not.toContain('пятерочка → Еда');
  });

  test(`body памяти обрезается превью ${MEMORY_BODY_PREVIEW} символов`, async () => {
    const user2 = freshUserId();
    await createMemory(user2, {
      title: 'LONG-BODY',
      kind: 'fact',
      body: `${'б'.repeat(MEMORY_BODY_PREVIEW)}ХВОСТ-ЗА-КАПОМ`,
    });
    const ctx = await withIdentity(db, user2, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user2);
      return buildContext(tx, { ownerId: user2, threadId });
    });
    expect(ctx.system).toContain('б'.repeat(MEMORY_BODY_PREVIEW));
    expect(ctx.system).not.toContain('ХВОСТ-ЗА-КАПОМ');
  });

  test('многострочный body памяти схлопывается в одну строку списка', async () => {
    const user3 = freshUserId();
    await createMemory(user3, {
      title: 'MULTILINE',
      kind: 'fact',
      body: 'строка1\nстрока2\n\nстрока3',
    });
    const ctx = await withIdentity(db, user3, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user3);
      return buildContext(tx, { ownerId: user3, threadId });
    });
    // Формат слоя 2 — «одна memory = одна строка»: перевод строки в body ломал бы список
    expect(ctx.system).toContain('— [fact] MULTILINE: строка1 строка2 строка3');
  });

  test('превью не рвёт суррогатные пары: обрезка по code points (fix round)', async () => {
    const user4 = freshUserId();
    // 200-й code point — emoji (2 UTF-16 юнита): срез по юнитам оставил бы одиночный суррогат
    await createMemory(user4, {
      title: 'EMOJI-EDGE',
      kind: 'fact',
      body: `${'x'.repeat(MEMORY_BODY_PREVIEW - 1)}😀ХВОСТ-ЗА-КАПОМ`,
    });
    const ctx = await withIdentity(db, user4, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user4);
      return buildContext(tx, { ownerId: user4, threadId });
    });
    expect(ctx.system).toContain(`${'x'.repeat(MEMORY_BODY_PREVIEW - 1)}😀…`);
    expect(ctx.system).not.toContain('ХВОСТ-ЗА-КАПОМ');
    // с флагом u класс суррогатов матчит ТОЛЬКО одиночные (пара — один code point)
    expect(/[\uD800-\uDFFF]/u.test(ctx.system)).toBe(false);
  });
});

describe('buildContext — слой 3: якорная сущность (02 §2.2)', () => {
  const user = freshUserId();

  async function createAnchor(): Promise<string> {
    const id = newId();
    await withIdentity(db, user, async (tx) =>
      tx.insert(entities).values({
        id,
        ownerId: user,
        title: 'Якорь-проект',
        tags: ['project', 'ai'],
        ...(await entityColumns(tx, user, { 'orbis/task_status': 'in_progress' }, ['orbis/task'])),
        body: `${'я'.repeat(ANCHOR_BODY_PREVIEW)}ОБРЕЗАННЫЙ-ХВОСТ`,
      }),
    );
    return id;
  }

  test('тред сущности: якорь в system — title, tags, аспекты, превью body 500', async () => {
    const anchorId = await createAnchor();
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureEntityThread(tx, user, anchorId);
      return buildContext(tx, { ownerId: user, threadId, anchorEntityId: anchorId });
    });
    expect(ctx.system).toContain('Якорная сущность');
    expect(ctx.system).toContain('Якорь-проект');
    expect(ctx.system).toContain(anchorId); // модель знает id якоря для тулов
    expect(ctx.system).toContain('project, ai');
    expect(ctx.system).toContain('orbis/task');
    expect(ctx.system).toContain('in_progress');
    expect(ctx.system).toContain('я'.repeat(ANCHOR_BODY_PREVIEW));
    expect(ctx.system).not.toContain('ОБРЕЗАННЫЙ-ХВОСТ');
  });

  test('превью body якоря режется по code points (граница 500, fix round)', async () => {
    const id = newId();
    await withIdentity(db, user, (tx) =>
      tx.insert(entities).values({
        id,
        ownerId: user,
        title: 'Якорь-эмодзи',
        body: `${'x'.repeat(ANCHOR_BODY_PREVIEW - 1)}🚀ОТРЕЗАННОЕ`,
      }),
    );
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureEntityThread(tx, user, id);
      return buildContext(tx, { ownerId: user, threadId, anchorEntityId: id });
    });
    expect(ctx.system).toContain(`${'x'.repeat(ANCHOR_BODY_PREVIEW - 1)}🚀…`);
    expect(ctx.system).not.toContain('ОТРЕЗАННОЕ');
    expect(/[\uD800-\uDFFF]/u.test(ctx.system)).toBe(false);
  });

  test('глобальный тред (без anchorEntityId): блока якоря нет', async () => {
    await createAnchor();
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      return buildContext(tx, { ownerId: user, threadId });
    });
    expect(ctx.system).not.toContain('Якорная сущность');
    expect(ctx.system).not.toContain('Якорь-проект');
  });

  test('история скоупнута тредом: сообщения глобального треда не текут в тред сущности (§7.3)', async () => {
    const anchorId = await createAnchor();
    const ctx = await withIdentity(db, user, async (tx) => {
      const globalId = await ensureGlobalThread(tx, user);
      await appendMessage(tx, {
        id: newId(),
        threadId: globalId,
        role: 'user',
        content: 'GLOBAL-ONLY-MSG',
      });
      const threadId = await ensureEntityThread(tx, user, anchorId);
      await appendMessage(tx, {
        id: newId(),
        threadId,
        role: 'user',
        content: 'ENTITY-THREAD-MSG',
      });
      return buildContext(tx, { ownerId: user, threadId, anchorEntityId: anchorId });
    });
    const contents = ctx.messages.map((m) => m.content);
    expect(contents).toContain('ENTITY-THREAD-MSG');
    expect(contents).not.toContain('GLOBAL-ONLY-MSG');
  });
});

describe('buildContext — слой 4: rolling-история (решение 6 плана)', () => {
  const user = freshUserId();

  test(`история обрезается до ${CONTEXT_HISTORY_LIMIT} ПОСЛЕДНИХ сообщений в хронологическом порядке`, async () => {
    const total = CONTEXT_HISTORY_LIMIT + 5; // 35
    const base = Date.UTC(2026, 5, 1, 9, 0, 0);
    await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      // Прямые INSERT с явным created_at — детерминированный порядок окна
      for (let i = 1; i <= total; i++) {
        await tx.insert(chatMessages).values({
          id: newId(),
          threadId,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `msg-${String(i).padStart(2, '0')}`,
          createdAt: new Date(base + i * 1000),
        });
      }
    });
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      return buildContext(tx, { ownerId: user, threadId });
    });
    // Окно — последние 30 из 35: msg-06..msg-35, НО msg-06 — assistant, а Anthropic
    // Messages API требует, чтобы messages начинались с user (fix round Task 8):
    // ведущие assistant отброшены → 29 сообщений, первое — msg-07 (user)
    expect(ctx.messages.length).toBe(CONTEXT_HISTORY_LIMIT - 1);
    expect(ctx.messages[0]?.content).toBe('msg-07');
    expect(ctx.messages[0]?.role).toBe('user');
    expect(ctx.messages.at(-1)?.content).toBe(`msg-${total}`);
    // Роли сохранены; system-роли в messages НЕТ (Task 7)
    expect(ctx.messages[1]?.role).toBe('assistant');
    expect(ctx.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  test('посты рутины/агента/AI в тред (role user, metadata.author_kind) помечаются автором в тексте, роль остаётся user; реплика владельца — без пометки (хвост финала)', async () => {
    // Пост в тред (thread_post) ложится role 'user' с author_kind у не-владельца — без пометки
    // чат-модель читала бы слова ночной рутины или внешнего агента как реплику владельца
    const who = freshUserId();
    const base = Date.UTC(2026, 5, 2, 9, 0, 0);
    const threadId = await withIdentity(db, who, async (tx) => {
      const id = await ensureGlobalThread(tx, who);
      const rows: Array<{ content: string; metadata: Record<string, unknown> }> = [
        { content: 'Посмотри мой план на день', metadata: {} },
        {
          content: 'Перенёс две задачи на сегодня',
          metadata: { author_kind: 'ai', routine_id: newId(), run_id: newId() },
        },
        {
          content: 'Ветка готова, тесты зелёные',
          metadata: { author_kind: 'agent', run_id: newId() },
        },
        { content: 'Заметка от меня в тред', metadata: { author_kind: 'ai' } },
      ];
      for (const [i, row] of rows.entries()) {
        await tx.insert(chatMessages).values({
          id: newId(),
          threadId: id,
          role: 'user',
          content: row.content,
          metadata: row.metadata,
          createdAt: new Date(base + (i + 1) * 1000),
        });
      }
      return id;
    });
    const ctx = await withIdentity(db, who, (tx) => buildContext(tx, { ownerId: who, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'Посмотри мой план на день' },
      { role: 'user', content: '[рутина]: Перенёс две задачи на сегодня' },
      { role: 'user', content: '[агент]: Ветка готова, тесты зелёные' },
      { role: 'user', content: '[AI]: Заметка от меня в тред' },
    ]);
  });
});

describe('buildContext — слой 4: сжатие audit/системных сообщений', () => {
  /** system-сообщение журнала в тред напрямую (формат journal.ts §7.8). */
  async function appendAudit(
    tx: Tx,
    threadId: string,
    opts: {
      type: string;
      entityId: string | null;
      actorUserId: string;
      actorKind: 'owner' | 'ai' | 'agent';
      source: string;
    },
  ): Promise<void> {
    await appendMessage(tx, {
      id: newId(),
      threadId,
      role: 'system',
      content: 'Создана сущность «Тестовая»',
      metadata: {
        actions: [
          {
            id: newId(),
            type: opts.type,
            entity_id: opts.entityId,
            actor_user_id: opts.actorUserId,
            actor_kind: opts.actorKind,
            source: opts.source,
            operations: [
              { op: 'entity_create', payload: { title: 'СЫРОЙ-PAYLOAD-НЕ-В-КОНТЕКСТ' } },
            ],
            inverse: [{ op: 'entity_update', payload: { archived: true } }],
          },
        ],
        cards: [{ tool: 'entity_create', entity_id: opts.entityId, title: 'Создана сущность' }],
      },
    });
  }

  test('audit своих действий (actor_kind=ai) → assistant с компактной строкой; сырой JSON не течёт', async () => {
    const user = freshUserId();
    const entityId = newId();
    // Реалистичная форма истории: audit всегда следует за user-репликой.
    // Отдельные tx — детерминированный created_at-порядок (transaction_timestamp)
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    await withIdentity(db, user, (tx) =>
      appendMessage(tx, { id: newId(), threadId, role: 'user', content: 'создай задачу' }),
    );
    await withIdentity(db, user, (tx) =>
      appendAudit(tx, threadId, {
        type: 'entity_created',
        entityId,
        actorUserId: user,
        actorKind: 'ai',
        source: 'chat',
      }),
    );
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'создай задачу' },
      { role: 'assistant', content: `[действие: entity_created ${entityId} (chat)]` },
    ]);
    const all = ctx.messages.map((m) => m.content).join('\n');
    expect(all).not.toContain('СЫРОЙ-PAYLOAD-НЕ-В-КОНТЕКСТ');
    expect(all).not.toContain('inverse');
    expect(all).not.toContain('{');
  });

  test('окно, начинающееся со сжатого ai-audit (assistant), обрезается до первого user (Anthropic API)', async () => {
    const user = freshUserId();
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    await withIdentity(db, user, (tx) =>
      appendAudit(tx, threadId, {
        type: 'entity_created',
        entityId: newId(),
        actorUserId: user,
        actorKind: 'ai',
        source: 'chat',
      }),
    );
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    // Единственное сообщение окна — assistant → отброшено; в реальном потоке Task 9
    // messages никогда не пусты: последним всегда идёт свежее user-сообщение
    expect(ctx.messages).toEqual([]);
  });

  test('audit действий агента (actor_kind=agent) → user с префиксом «[система]»', async () => {
    const user = freshUserId();
    const entityId = newId();
    const ctx = await withIdentity(db, user, async (tx) => {
      const threadId = await ensureGlobalThread(tx, user);
      await appendAudit(tx, threadId, {
        type: 'entity_updated',
        entityId,
        actorUserId: user,
        actorKind: 'agent',
        source: 'mcp',
      });
      return buildContext(tx, { ownerId: user, threadId });
    });
    expect(ctx.messages).toEqual([
      { role: 'user', content: `[система] [действие: entity_updated ${entityId} (mcp)]` },
    ]);
  });

  test('batch-audit без entity_id → компактная строка без id', async () => {
    const user = freshUserId();
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    // Предшествующий user — иначе ведущий assistant-audit отброшен инвариантом окна
    await withIdentity(db, user, (tx) =>
      appendMessage(tx, { id: newId(), threadId, role: 'user', content: 'заархивируй всё' }),
    );
    await withIdentity(db, user, (tx) =>
      appendAudit(tx, threadId, {
        type: 'batch',
        entityId: null,
        actorUserId: user,
        actorKind: 'ai',
        source: 'chat',
      }),
    );
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'заархивируй всё' },
      { role: 'assistant', content: '[действие: batch (chat)]' },
    ]);
  });

  test('недействийные system-сообщения (undo/pending/reject) → user «[система] <content>» без metadata', async () => {
    const user = freshUserId();
    const actionId = newId();
    const pendingId = newId();
    // Отдельные транзакции: created_at = transaction_timestamp(), в одном tx
    // оба сообщения получили бы одинаковое время — порядок стал бы зависеть от id
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    await withIdentity(db, user, (tx) =>
      appendMessage(tx, {
        id: newId(),
        threadId,
        role: 'system',
        content: `Отменено действие ${actionId}`,
        metadata: { type: 'undo', undoes: actionId },
      }),
    );
    await withIdentity(db, user, (tx) =>
      appendMessage(tx, {
        id: pendingId,
        threadId,
        role: 'system',
        content: 'Требует подтверждения: массовое изменение (11 операций)',
        metadata: {
          pending: {
            id: pendingId,
            tool: 'batch_execute',
            input: { batch_id: pendingId, operations: [{ tool: 'entity_update', input: {} }] },
            actor_kind: 'ai',
            source: 'chat',
            created_at: new Date().toISOString(),
          },
          cards: [{ kind: 'confirmation_card', mode: 'explicit', pendingId, summary: 'x' }],
        },
      }),
    );
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: `[система] Отменено действие ${actionId}` },
      {
        role: 'user',
        content: '[система] Требует подтверждения: массовое изменение (11 операций)',
      },
    ]);
    // metadata (payload pending) не попадает в контекст
    expect(ctx.messages.map((m) => m.content).join('\n')).not.toContain('batch_execute');
  });

  test(`скрытые system-строки не съедают rolling-окно: ${CONTEXT_HISTORY_LIMIT}+ инфраструктурных строк новее живого диалога, диалог всё ещё в истории (фильтр в SQL до limit)`, async () => {
    const user = freshUserId();
    const base = Date.UTC(2026, 5, 2, 9, 0, 0);
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    await withIdentity(db, user, async (tx) => {
      await tx.insert(chatMessages).values({
        id: newId(),
        threadId,
        role: 'user',
        content: 'живой вопрос',
        createdAt: new Date(base),
      });
      await tx.insert(chatMessages).values({
        id: newId(),
        threadId,
        role: 'assistant',
        content: 'живой ответ',
        createdAt: new Date(base + 1000),
      });
      // Плотный поток системного шума НОВЕЕ диалога: 30 batch-audit материализации
      // (source='system') + processing-маркер — фильтр ПОСЛЕ .limit(30) съедал бы
      // ими всё окно и модель теряла бы живой диалог
      for (let i = 0; i < CONTEXT_HISTORY_LIMIT; i++) {
        await tx.insert(chatMessages).values({
          id: newId(),
          threadId,
          role: 'system',
          content: `batch: операций — ${i + 1}`,
          metadata: {
            actions: [
              {
                id: newId(),
                type: 'batch',
                entity_id: null,
                actor_user_id: user,
                actor_kind: 'owner',
                source: 'system',
                operations: [],
                inverse: [],
              },
            ],
          },
          createdAt: new Date(base + 2000 + i * 1000),
        });
      }
      await tx.insert(chatMessages).values({
        id: newId(),
        threadId,
        role: 'system',
        content: '',
        metadata: { type: 'processing' },
        createdAt: new Date(base + 60_000),
      });
    });
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'живой вопрос' },
      { role: 'assistant', content: 'живой ответ' },
    ]);
  });

  test('audit системной материализации (source=system) не попадает в историю модели; ui-audit остаётся (fix round A3)', async () => {
    const user = freshUserId();
    const entityId = newId();
    // Отдельные транзакции — детерминированный created_at-порядок
    const threadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    await withIdentity(db, user, (tx) =>
      appendMessage(tx, { id: newId(), threadId, role: 'user', content: 'что на неделе?' }),
    );
    // Материализация recurring-инстансов (§5.4): batch-audit source='system' —
    // инфраструктурный шум на каждый пересчёт агенды, модель его видеть не должна
    await withIdentity(db, user, (tx) =>
      appendAudit(tx, threadId, {
        type: 'batch',
        entityId: null,
        actorUserId: user,
        actorKind: 'owner',
        source: 'system',
      }),
    );
    // Обычное действие владельца в UI — наблюдаемое событие среды, остаётся
    await withIdentity(db, user, (tx) =>
      appendAudit(tx, threadId, {
        type: 'entity_updated',
        entityId,
        actorUserId: user,
        actorKind: 'owner',
        source: 'ui',
      }),
    );
    const ctx = await withIdentity(db, user, (tx) => buildContext(tx, { ownerId: user, threadId }));
    expect(ctx.messages).toEqual([
      { role: 'user', content: 'что на неделе?' },
      { role: 'user', content: `[система] [действие: entity_updated ${entityId} (ui)]` },
    ]);
  });
});

describe('toolResultMessage — протокол tool-результатов MVP (для Task 9)', () => {
  test('user-сообщение формата «[tool_result:<имя>] <JSON>»', () => {
    expect(toolResultMessage('entity_query', { ok: true, count: 2 })).toEqual({
      role: 'user',
      content: '[tool_result:entity_query] {"ok":true,"count":2}',
    });
  });
});
