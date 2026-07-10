// apps/server/src/recurring/post-due.ts
// Переход planned→fact recurring-инстансов (03-budget §2.8, 01 §3.3, Task A5).
//
// В локальный день occurred_on (и позже — просроченные) системный batch снимает
// planned с неархивного recurring-инстанса; авто-привязку к конверту дописывает
// бюджет-хук executor'а (A4) В ТОТ ЖЕ action — Undo откатывает переход целиком.
// batch_id детерминирован инстансом (postFinancialBatchId): конкурентные вызовы
// с двух устройств сходятся к одному action по audit-PK (§7.8), повтор — replay;
// Undo перехода «липкий» — заново инстанс не постится, воля владельца уважается.
// Один batch на ОДИН инстанс: отказ по одному инстансу не валит остальные.
import { postFinancialBatchId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Один инстанс синка на модуль (как materialize.ts): состояния не хранит,
// audit-сообщение batch пишется тем же tx, что операции executor'а (§7.8).
const sink = makeChatJournalSink();

export interface PostDueDeps {
  db: Db;
  ownerId: string;
  /** «Сегодня» — локальная дата пользователя (user_settings.timezone), 'YYYY-MM-DD'. */
  today: string;
}

/**
 * Для каждого неархивного financial-инстанса с planned=true, occurred_on <= today —
 * системный batch: planned=false + привязка к конверту (§2.8). Только recurring-инстансы
 * (есть входящая derived_from); ручные planned-покупки НЕ трогает — их переводит явный
 * флоу §2.7; шаблоны без occurred_on не проходят фильтр по построению.
 * posted — число реально применённых переходов (replay не считается).
 */
export async function postDueInstances(deps: PostDueDeps): Promise<{ posted: number }> {
  const { db, ownerId, today } = deps;
  if (!DATE_RE.test(today)) {
    throw new RangeError(`Некорректная дата today (ожидается YYYY-MM-DD): "${today}"`);
  }

  // Фаза чтения (короткий tx под RLS): due-инстансы. occurred_on — 'YYYY-MM-DD',
  // лексикографическое сравнение = хронологическое (как в binding.ts). ORDER BY —
  // детерминированный порядок batch'ей.
  const due = await withIdentity(db, ownerId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT e.id FROM entities e
      WHERE e.owner_id = ${ownerId} AND NOT e.archived
        AND e.aspects->'orbis/financial'->>'planned' = 'true'
        AND e.aspects->'orbis/financial'->>'occurred_on' <= ${today}
        AND EXISTS (
          SELECT 1 FROM relations r
          WHERE r.target_id = e.id AND r.relation_type = 'derived_from'
        )
      ORDER BY e.aspects->'orbis/financial'->>'occurred_on', e.id
    `)) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  });

  let posted = 0;
  for (const id of due) {
    // Один batch на один инстанс, batch_id = uuidv5(NS, "post-financial:<id>") (01 §3.3).
    // Уже выполнявшийся (в т.ч. отменённый Undo) переход реплеится по audit-PK — не
    // применяется и в posted не входит.
    const r = await execute(
      db,
      {
        actorUserId: ownerId,
        actorKind: 'owner',
        source: 'system',
        operations: [
          {
            tool: 'entity_update',
            input: { id, aspects: { 'orbis/financial': { planned: false } } },
          },
        ],
        batchId: postFinancialBatchId(id),
      },
      { sink },
    );
    if (r.ok) {
      if (!r.idempotentReplay) posted++;
      continue;
    }
    // Структурированный отказ по одному инстансу (битые данные, INVARIANT) не имеет
    // права ронять переход остальных и запрос вызывающего — warn для диагностики
    console.warn(
      `[recurring/post-due] инстанс ${id} пропущен: отказ executor ${r.error.code} — ${r.error.message}`,
    );
  }
  return { posted };
}
