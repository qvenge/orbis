// apps/server/src/ai/escalation.test.ts
// Интеграционные тесты D3a (01-arch §7.8 «Эскалация в правило»): счётчик одинаковых
// исправлений НЕ хранится — считается сканом журнала за 30 дней; предложение приходит
// системным сообщением с карточкой memory_rule_suggestion. Реальная БД, реальный
// executor и реальный роутер (appRouter.createCaller) — моков нет.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { globalThreadId, memoryRuleSuggestionId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appendMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type {
  ActionRecord,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  WireEntity,
} from '../executor/types';
import { appRouter } from '../router';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import type { Card } from '../tools/registry';
import type { Context } from '../trpc';
import { JOURNAL_SCAN_LIMIT, maybeSuggestRule, scanFinancialUpdates } from './escalation';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function req(user: string, operations: ExecuteRequest['operations']): ExecuteRequest {
  return { actorUserId: user, actorKind: 'owner', source: 'ui', operations };
}

function ownerCaller(user: string) {
  const ctx: Context = { actorUserId: user, actorKind: 'owner', clientVersion: null, db };
  return appRouter.createCaller(ctx);
}

async function createEntity(user: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = ok(await execute(db, req(user, [{ tool: 'entity_create', input }]), { sink }));
  return r.results[0] as WireEntity;
}

async function createCategory(user: string, title: string): Promise<string> {
  const e = await createEntity(user, {
    title,
    tags: [],
    aspects: { 'orbis/category': { icon: '🍔' } },
  });
  return e.id;
}

/** Транзакция orbis/financial в категории categoryRef. */
async function createTxn(user: string, title: string, categoryRef: string): Promise<string> {
  const e = await createEntity(user, {
    title,
    tags: [],
    aspects: {
      'orbis/financial': {
        amount: '340.00',
        direction: 'expense',
        category_ref: categoryRef,
        occurred_on: '2026-07-20',
      },
    },
  });
  return e.id;
}

/** Рекатегоризация боевым путём владельца — та же процедура, что зовёт UI. */
async function recategorize(user: string, txnId: string, categoryRef: string): Promise<void> {
  await ownerCaller(user).entity.update({
    id: txnId,
    aspects: { 'orbis/financial': { category_ref: categoryRef } },
  });
}

/**
 * Минимальный контекст чат-транспорта: только те поля ToolCallCtx, без которых диспетчер
 * не работает. Боевой контекст ai.sendMessage несёт сверх этого threadId, clock и
 * entitlements (send-message.ts runToolCall) — на путь эскалации они не влияют, поэтому
 * здесь их нет.
 */
function chatCtx(user: string): ToolCallCtx {
  return { db, actorUserId: user, actorKind: 'ai', source: 'chat', explicitCommand: false };
}

/** Рекатегоризация путём модели: тот же диспетчер тулов, что зовёт ai.sendMessage. */
async function recategorizeViaChat(
  user: string,
  txnId: string,
  categoryRef: string,
): Promise<void> {
  const r = await dispatchTool(chatCtx(user), 'entity_update', {
    id: txnId,
    aspects: { 'orbis/financial': { category_ref: categoryRef } },
  });
  if (r.status !== 'ok') throw new Error(`dispatchTool: ${JSON.stringify(r)}`);
}

/** Рекатегоризация мимо роутера — когда тесту нужен actionId для прямого вызова. */
async function recategorizeRaw(user: string, txnId: string, categoryRef: string): Promise<string> {
  const input = { id: txnId, aspects: { 'orbis/financial': { category_ref: categoryRef } } };
  return ok(await execute(db, req(user, [{ tool: 'entity_update', input }]), { sink })).actionId;
}

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

/** Карточки заданного вида из глобального треда владельца (админ-DSN — RLS обходится). */
async function cardsOf(user: string, kind: string): Promise<Card[]> {
  const rows = await adminRows(
    sql`SELECT metadata FROM chat_messages WHERE thread_id = ${globalThreadId(user)}
        ORDER BY created_at, id`,
  );
  return rows
    .flatMap((r) => (r.metadata as { cards?: Card[] }).cards ?? [])
    .filter((c) => c.kind === kind);
}

/** Action из журнала по id (metadata.actions[0] audit-сообщения). */
async function actionById(actionId: string): Promise<ActionRecord> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await adminRows(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const md = rows[0]?.metadata as { actions?: ActionRecord[] } | undefined;
  const action = md?.actions?.find((a) => a.id === actionId);
  if (!action) throw new Error(`action ${actionId} не найден в журнале`);
  return action;
}

async function categoryRefOf(txnId: string): Promise<string | undefined> {
  const rows = await adminRows(
    sql`SELECT aspects -> 'orbis/financial' ->> 'category_ref' AS ref
        FROM entities WHERE id = ${txnId}`,
  );
  return rows[0]?.ref as string | undefined;
}

/** Что прочитает скан журнала под личностью владельца (проба + потолок выборки). */
async function scanActions(user: string): Promise<ActionRecord[]> {
  return withIdentity(db, user, (tx) => scanFinancialUpdates(tx));
}

/** Владелец с двумя категориями: «Еда» (from) и «Развлечения» (to). */
async function freshOwner(): Promise<{ user: string; food: string; fun: string }> {
  const user = freshUserId();
  const food = await createCategory(user, 'Еда');
  const fun = await createCategory(user, 'Развлечения');
  return { user, food, fun };
}

/** Активное memory-правило «пятерочка → Развлечения» (scope=orbis/financial). */
async function createRule(user: string): Promise<WireEntity> {
  return createEntity(user, {
    title: 'пятерочка → Развлечения',
    tags: [],
    aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
  });
}

describe('эскалация повторных исправлений категории (§7.8)', () => {
  test('1. два одинаковых исправления за 30 дней → карточка memory_rule_suggestion', async () => {
    const { user, food, fun } = await freshOwner();
    const a = await createTxn(user, 'ПЯТЕРОЧКА 843', food);
    const b = await createTxn(user, 'Пятёрочка', food);

    await recategorize(user, a, fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]); // одного мало

    await recategorize(user, b, fun);
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards.length).toBe(1);
    expect(cards[0]).toEqual({
      kind: 'memory_rule_suggestion',
      ruleText: 'пятерочка → Развлечения',
      pattern: 'пятерочка',
      fromCategoryId: food,
      toCategoryId: fun,
      categoryTitle: 'Развлечения',
    });
  });

  test('2. одно исправление → предложения нет', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('3. исправления с разными counterparty (similarity < 0.85) не суммируются', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'OZON 100', food), fun);
    await recategorize(user, await createTxn(user, 'WILDBERRIES 200', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('4. активное эквивалентное правило уже есть → предложения нет', async () => {
    const { user, food, fun } = await freshOwner();
    await createRule(user);
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'Пятёрочка', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('5. архивное правило не подавляет (архивная память из контекста исключена, §7.4)', async () => {
    const { user, food, fun } = await freshOwner();
    const rule = await createRule(user);
    const archive = { id: rule.id, archived: true };
    ok(await execute(db, req(user, [{ tool: 'entity_update', input: archive }]), { sink }));
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'Пятёрочка', food), fun);
    expect((await cardsOf(user, 'memory_rule_suggestion')).length).toBe(1);
  });

  test('6. предложение не дублируется: третье такое же исправление второй карточки не пишет', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'Пятёрочка', food), fun);
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 12', food), fun);
    expect((await cardsOf(user, 'memory_rule_suggestion')).length).toBe(1);
  });

  test('7. отказ (карточка memory_rule_declined) подавляет предложение; повтор отказа идемпотентен', async () => {
    const { user, food, fun } = await freshOwner();
    // Отказ записан ДО предложений НАМЕРЕННО: иначе проверка неотличима от подавления
    // по уже отправленной карточке memory_rule_suggestion (обе — один 30-дневный скан)
    const pair = { pattern: 'пятерочка', fromCategoryId: food, toCategoryId: fun };
    expect(await ownerCaller(user).ai.declineMemoryRule(pair)).toEqual({ alreadyDeclined: false });
    expect(await cardsOf(user, 'memory_rule_declined')).toEqual([
      { kind: 'memory_rule_declined', ...pair },
    ]);

    // повторный отказ — то же детерминированное сообщение, второй карточки нет
    expect(await ownerCaller(user).ai.declineMemoryRule(pair)).toEqual({ alreadyDeclined: true });
    expect((await cardsOf(user, 'memory_rule_declined')).length).toBe(1);

    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'Пятёрочка', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('8. рекатегоризация внутри batch учитывается сканом (K5: type=batch, entity_id=null)', async () => {
    const { user, food, fun } = await freshOwner();
    const a = await createTxn(user, 'ПЯТЕРОЧКА 843', food);
    const b = await createTxn(user, 'Пятёрочка', food);
    // Первое исправление приезжает группой (импорт и rollover журналируются так же):
    // одно действие type='batch', entity_id=null, плоский operations
    ok(
      await execute(
        db,
        {
          ...req(user, [
            {
              tool: 'entity_update',
              input: { id: a, aspects: { 'orbis/financial': { category_ref: fun } } },
            },
            { tool: 'entity_create', input: { title: 'Попутная', tags: [] } },
          ]),
          batchId: newId(),
        },
        { sink },
      ),
    );
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);

    await recategorize(user, b, fun);
    expect((await cardsOf(user, 'memory_rule_suggestion')).length).toBe(1);
  });

  test('9. падение эскалации не откатывает саму правку категории (K7)', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    const b = await createTxn(user, 'Пятёрочка', food);

    // Занимаем PK будущего сообщения-предложения ЧУЖИМ сообщением: под RLS оно невидимо,
    // поэтому appendMessageIdempotent бросит CONFLICT внутри эскалации — реальный сбой
    // на последнем её шаге, уже после коммита правки категории
    const alien = freshUserId();
    const poisoned = memoryRuleSuggestionId({
      ownerId: user,
      pattern: 'пятерочка',
      fromCategoryId: food,
      toCategoryId: fun,
      date: new Date().toISOString().slice(0, 10),
    });
    await withIdentity(db, alien, async (tx) => {
      const threadId = await ensureGlobalThread(tx, alien);
      await appendMessage(tx, { id: poisoned, threadId, role: 'system', content: 'чужое' });
    });

    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const updated = await ownerCaller(user).entity.update({
        id: b,
        aspects: { 'orbis/financial': { category_ref: fun } },
      });
      expect(updated.id).toBe(b);
      // правка категории закоммичена, несмотря на сбой эскалации
      expect(await categoryRefOf(b)).toBe(fun);
      expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
      expect(spy.mock.calls.flat().map(String).join(' ')).toContain('[ai.escalation]');
    } finally {
      spy.mockRestore();
    }
  });

  test('10. не рекатегоризация (правка title) → выход без записи', async () => {
    const { user, food } = await freshOwner();
    const a = await createTxn(user, 'ПЯТЕРОЧКА 843', food);
    const r = ok(
      await execute(
        db,
        req(user, [{ tool: 'entity_update', input: { id: a, title: 'Пятёрочка' } }]),
        {
          sink,
        },
      ),
    );
    expect(
      await maybeSuggestRule({ db, ownerId: user, action: await actionById(r.actionId) }),
    ).toEqual({ suggested: false, reason: 'not_recategorization' });
  });

  test('11. паттерн из одних цифр и служебных токенов правилом не становится', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'SBOL 1234', food), fun);
    const actionId = await recategorizeRaw(user, await createTxn(user, 'SBOL 5678', food), fun);
    expect(
      await maybeSuggestRule({ db, ownerId: user, action: await actionById(actionId) }),
    ).toEqual({ suggested: false, reason: 'empty_pattern' });
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('12. отказ доступен только владельцу (ownerOnly, §9.3)', async () => {
    const { user, food, fun } = await freshOwner();
    const agent = appRouter.createCaller({
      actorUserId: user,
      actorKind: 'agent',
      clientVersion: null,
      db,
    });
    const e = await agent.ai
      .declineMemoryRule({ pattern: 'кофе', fromCategoryId: food, toCategoryId: fun })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect((e as { code?: string } | null)?.code).toBe('FORBIDDEN');
  });

  test('13. скан журнала не читает audit импорта: проба ограничена op=entity_update', async () => {
    const { user, food, fun } = await freshOwner();
    const txnInput = (title: string) => ({
      title,
      tags: [],
      aspects: {
        'orbis/financial': {
          amount: '340.00',
          direction: 'expense',
          category_ref: food,
          occurred_on: '2026-07-20',
        },
      },
    });
    // Импорт журналируется ОДНИМ action type='batch', в котором только entity_create, а
    // журнал entity_create несёт весь аспект в payload (executor.ts prepareEntityCreate).
    // Без op в пробе такой batch попадал под неё целиком — до 300 строк operations +
    // inverse + results, разбираемых синхронно внутри entity.update, ради нуля
    // рекатегоризаций
    ok(
      await execute(
        db,
        {
          ...req(user, [
            { tool: 'entity_create', input: txnInput('ПЯТЕРОЧКА 1') },
            { tool: 'entity_create', input: txnInput('ПЯТЕРОЧКА 2') },
          ]),
          batchId: newId(),
        },
        { sink },
      ),
    );
    expect(await scanActions(user)).toEqual([]);

    // а настоящее исправление категории скан по-прежнему видит
    const actionId = await recategorizeRaw(user, await createTxn(user, 'Пятёрочка', food), fun);
    expect((await scanActions(user)).map((a) => a.id)).toEqual([actionId]);
  });

  test('14. скан журнала ограничен потолком выборки и берёт свежие действия', async () => {
    const { user, food, fun } = await freshOwner();
    const extra = 3;
    // Форма audit-строки повторена руками: гнать 200+ рекатегоризаций через executor
    // ради проверки потолка незачем, а под пробу строка обязана попадать
    const made = Array.from({ length: JOURNAL_SCAN_LIMIT + extra }, (_, i) => {
      const actionId = newId();
      return {
        actionId,
        row: {
          id: newId(),
          threadId: globalThreadId(user),
          role: 'system',
          content: `псевдо-audit ${i}`,
          metadata: {
            actions: [
              {
                id: actionId,
                type: 'entity_updated',
                operations: [
                  {
                    op: 'entity_update',
                    payload: { id: fun, aspects: { 'orbis/financial': { category_ref: fun } } },
                  },
                ],
                inverse: [
                  {
                    op: 'entity_update',
                    payload: { id: fun, aspects: { 'orbis/financial': { category_ref: food } } },
                  },
                ],
              },
            ],
          },
          createdAt: new Date(Date.now() - i * 60_000), // i=0 — самое свежее
        },
      };
    });
    await withIdentity(db, user, async (tx) => {
      await ensureGlobalThread(tx, user);
      await tx.insert(chatMessages).values(made.map((m) => m.row));
    });

    const scanned = (await scanActions(user)).map((a) => a.id).sort();
    expect(scanned.length).toBe(JOURNAL_SCAN_LIMIT);
    // и это именно свежие: усечены ровно `extra` самых старых
    expect(scanned).toEqual(
      made
        .slice(0, JOURNAL_SCAN_LIMIT)
        .map((m) => m.actionId)
        .sort(),
    );
  });

  test('15. на отклонённой паре скан журнала не запускается (гейт подавления — раньше)', async () => {
    const { user, food, fun } = await freshOwner();
    const pair = { pattern: 'пятерочка', fromCategoryId: food, toCategoryId: fun };
    await ownerCaller(user).ai.declineMemoryRule(pair);
    const actionId = await recategorizeRaw(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    // Исправление ОДНО: если бы подавление проверялось после скана, ответом было бы
    // not_repeated — то есть журнал читался бы там, где ответ уже известен
    expect(
      await maybeSuggestRule({ db, ownerId: user, action: await actionById(actionId) }),
    ).toEqual({ suggested: false, reason: 'already_suggested' });
  });

  // --- D3a2 п.1: «одинаковое исправление» — по ПАТТЕРНАМ, а не по сырым заголовкам ---
  // Боевой формат выписки — один мерчант с разными числовыми хвостами; сырое сравнение
  // на нём не срабатывает (см. значения в комментариях), и правило не предлагалось бы
  // никогда именно в самом частом реальном случае.

  test('16. ПЯТЕРОЧКА 843 / ПЯТЕРОЧКА 999 — один паттерн, предложение приходит', async () => {
    const { user, food, fun } = await freshOwner();
    // counterpartySimilarity сырых заголовков = 0.769 < 0.85, паттернов — 1.0
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 999', food), fun);
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards.length).toBe(1);
    expect((cards[0] as { pattern: string }).pattern).toBe('пятерочка');
  });

  test('17. ЯНДЕКС.ТАКСИ 450 / ЯНДЕКС.ТАКСИ 1200 — один паттерн, предложение приходит', async () => {
    const { user, food, fun } = await freshOwner();
    // сырые = 0.824 < 0.85, паттерны «яндекс такси» = 1.0
    await recategorize(user, await createTxn(user, 'ЯНДЕКС.ТАКСИ 450', food), fun);
    await recategorize(user, await createTxn(user, 'ЯНДЕКС.ТАКСИ 1200', food), fun);
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards.length).toBe(1);
    expect((cards[0] as { pattern: string }).pattern).toBe('яндекс такси');
  });

  test('18. ПЯТЕРОЧКА 843 / WILDBERRIES 12 — разные мерчанты, предложения нет', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'WILDBERRIES 12', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  // --- D3a2 п.2: подавление повтора не обходится сменой паттерна ---

  test('19. предложение по «пятерочка» подавляет предложение по «пятерочка мск»', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    await recategorize(user, await createTxn(user, 'Пятёрочка', food), fun);
    const first = await cardsOf(user, 'memory_rule_suggestion');
    expect(first.length).toBe(1);

    // Соседний паттерн той же пары категорий: при подавлении по ТОЧНОМУ паттерну
    // сюда приезжала вторая карточка «пятерочка мск → Развлечения»
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА МСК 5', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual(first);
  });

  test('20. отказ по «пятерочка» подавляет предложение по «пятерочка мск»', async () => {
    const { user, food, fun } = await freshOwner();
    await ownerCaller(user).ai.declineMemoryRule({
      pattern: 'пятерочка',
      fromCategoryId: food,
      toCategoryId: fun,
    });
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА МСК 1', food), fun);
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА МСК 2', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  test('21. отказ по «пятерочка» не подавляет несвязанный паттерн той же пары', async () => {
    const { user, food, fun } = await freshOwner();
    await ownerCaller(user).ai.declineMemoryRule({
      pattern: 'пятерочка',
      fromCategoryId: food,
      toCategoryId: fun,
    });
    await recategorize(user, await createTxn(user, 'АЗБУКА ВКУСА 1', food), fun);
    await recategorize(user, await createTxn(user, 'АЗБУКА ВКУСА 2', food), fun);
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards.length).toBe(1);
    expect((cards[0] as { pattern: string }).pattern).toBe('азбука вкуса');
  });

  // --- D3a2 п.3: рекатегоризация из чата эскалируется наравне с UI ---

  test('22. рекатегоризация через диспетчер тулов дважды → предложение появилось', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorizeViaChat(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]); // одного мало

    await recategorizeViaChat(user, await createTxn(user, 'Пятёрочка', food), fun);
    const cards = await cardsOf(user, 'memory_rule_suggestion');
    expect(cards.length).toBe(1);
    expect((cards[0] as { ruleText: string }).ruleText).toBe('пятерочка → Развлечения');
  });

  test('23. падение эскалации не ломает ответ тула (чат-путь, K7)', async () => {
    const { user, food, fun } = await freshOwner();
    await recategorizeViaChat(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    const b = await createTxn(user, 'Пятёрочка', food);

    // Тот же приём, что в тесте 9: PK будущего сообщения-предложения занят ЧУЖИМ
    // сообщением (под RLS невидимо) → appendMessageIdempotent бросит CONFLICT уже
    // после коммита правки категории
    const alien = freshUserId();
    const poisoned = memoryRuleSuggestionId({
      ownerId: user,
      pattern: 'пятерочка',
      fromCategoryId: food,
      toCategoryId: fun,
      date: new Date().toISOString().slice(0, 10),
    });
    await withIdentity(db, alien, async (tx) => {
      const threadId = await ensureGlobalThread(tx, alien);
      await appendMessage(tx, { id: poisoned, threadId, role: 'system', content: 'чужое' });
    });

    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await dispatchTool(chatCtx(user), 'entity_update', {
        id: b,
        aspects: { 'orbis/financial': { category_ref: fun } },
      });
      expect(r.status).toBe('ok');
      expect(await categoryRefOf(b)).toBe(fun);
      expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
      expect(spy.mock.calls.flat().map(String).join(' ')).toContain('[ai.escalation]');
    } finally {
      spy.mockRestore();
    }
  });

  // --- D5b п.1: сравнение только по паттернам, запасного пути по сырым заголовкам нет ---

  test('24. «843» и «ПЯТЕРОЧКА 843» — не одно исправление (сырое containment даёт 1.0)', async () => {
    const { user, food, fun } = await freshOwner();
    // Порядок намеренный: «843» ПЕРВЫМ — на нём эскалация выходит по empty_pattern, и
    // вопрос «одинаковы ли исправления» решается на втором, у которого паттерн непустой.
    // counterpartySimilarity('ПЯТЕРОЧКА 843', '843') = 1.0 (containment по токену «843»),
    // а паттерны — «пятерочка» и '' — не совпадают ни при каком пороге.
    await recategorize(user, await createTxn(user, '843', food), fun);
    await recategorize(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    expect(await cardsOf(user, 'memory_rule_suggestion')).toEqual([]);
  });

  // --- D5b п.2: подавление не ошибается в сторону «предложить лишнее» ---

  test('25. карточка с ТОЧНЫМ паттерном подавляет предложение при любом объёме журнала', async () => {
    const { user, food, fun } = await freshOwner();
    const pair = { fromCategoryId: food, toCategoryId: fun };
    const offer = (pattern: string, minutesAgo: number) => ({
      id: newId(),
      threadId: globalThreadId(user),
      role: 'system',
      content: `псевдо-предложение ${pattern} ${minutesAgo}`,
      metadata: { cards: [{ kind: 'memory_rule_suggestion', pattern, ...pair }] },
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    // Карточка нужного паттерна — САМАЯ СТАРАЯ, а свежих карточек той же пары категорий
    // ровно потолок выборки: сканирующий путь до неё не доходит и предложил бы повтор
    // того, от чего пользователя уже спрашивали.
    const rows = [
      offer('пятерочка', JOURNAL_SCAN_LIMIT + 1),
      ...Array.from({ length: JOURNAL_SCAN_LIMIT }, (_, i) => offer('wildberries', i + 1)),
    ];
    await withIdentity(db, user, async (tx) => {
      await ensureGlobalThread(tx, user);
      await tx.insert(chatMessages).values(rows);
    });

    const actionId = await recategorizeRaw(user, await createTxn(user, 'ПЯТЕРОЧКА 843', food), fun);
    expect(
      await maybeSuggestRule({ db, ownerId: user, action: await actionById(actionId) }),
    ).toEqual({ suggested: false, reason: 'already_suggested' });
    // новой карточки не появилось: по «пятерочка» осталась ровно одна — засеянная
    const offers = await cardsOf(user, 'memory_rule_suggestion');
    expect(offers.filter((c) => (c as { pattern?: string }).pattern === 'пятерочка').length).toBe(
      1,
    );
  });
});
