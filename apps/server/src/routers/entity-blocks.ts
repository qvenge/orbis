// apps/server/src/routers/entity-blocks.ts
// Исполнение пачки блоков страницы (`entity.blocks`, срез 1а, спека §6.3). Процедура в
// `routers/entity.ts` — только трансляция; вся механика пачки — здесь.
import {
  BLOCK_ROWS_CAP,
  type BlockError,
  type BlockResult,
  type EntityBlocksInput,
  type EntityBlocksResult,
} from '@orbis/shared';
// Листовой сабпат, не баррель `@orbis/shared/doc`: нужна одна строка, а не редактор документа.
import { EMPTY_QUERY_MESSAGE } from '@orbis/shared/doc/placement';
import type { QueryAst } from '@orbis/shared/query';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import type { Identity } from '../identity';
import {
  type CompileCtx,
  compileCountAst,
  compileLatestAst,
  compileQueryAst,
  compileSumAst,
} from '../query/compile-ast';
import { queryContext } from '../query/context';
import { parseQueryText } from '../query/parse-text';
import { materializationWindow, materializeInstances } from '../recurring/materialize';
import { materializeRuleOf } from '../rules/carriers';
import { toWireEntityFromSql } from '../wire';

/**
 * Свойство валюты суммированных записей (РП-20). Литерал, а не роль контракта: плитка суммы
 * страницы — не расчёт движения денег, ей нужна ровно та колонка, что пишет каталог правил
 * (`default_currency` кладёт умолчание в неё же).
 */
const CURRENCY_PROPERTY = 'orbis/currency';

type Window = { from: string; to: string };

/** Скомпилированный блок: SQL готов ДО первого обращения к базе. */
type Plan =
  | { kind: 'rows'; sql: SQL; countSql: SQL; limit: number }
  | { kind: 'count'; sql: SQL }
  | { kind: 'sum'; sql: SQL }
  | { kind: 'latest'; sql: SQL };

type Prepared =
  | { key: string; kind: 'failed'; result: BlockResult }
  | { key: string; kind: 'planned'; plan: Plan; window: Window | null };

/**
 * Отказ разбора/компиляции → ошибка блока в той же форме, что `queryErrorToTRPC` кладёт в
 * `cause` у `entity.query`: код причины из `details.reason`, позиция — где она есть. Не
 * `ExecError('VALIDATION')` — программная ошибка, и глотать её в «ошибку блока» нельзя.
 */
function compileFailure(e: unknown): BlockError {
  if (!(e instanceof ExecError) || e.code !== 'VALIDATION') throw e;
  const d = (e.details ?? {}) as { reason?: unknown; position?: unknown };
  return {
    code: typeof d.reason === 'string' ? d.reason : e.code,
    message: e.message,
    ...(typeof d.position === 'number' && { position: d.position }),
  };
}

/**
 * Разбор и компиляция одного блока — чисто, без SQL. Любой отказ остаётся отказом ЭТОГО блока.
 *
 * Пустой текст отсекается ДО разбора (Р-21-8): грамматика принимает его законным пустым
 * фильтром, а сервер такой фильтр не отсекает — блок «не настроен» вернул бы все записи
 * владельца. Текст ОБРЕЗАЕТСЯ по краям перед разбором — так же, как у плашки тела
 * (`doc/placement.ts`) и блока в web: иначе позиция ошибки разошлась бы с их позицией.
 */
function prepareBlock(
  block: EntityBlocksInput['blocks'][number],
  base: CompileCtx,
  params: Parameters<typeof materializationWindow>[2],
): Prepared {
  const text = block.text.trim();
  if (text === '') {
    return {
      key: block.key,
      kind: 'failed',
      result: { ok: false, error: { code: 'EMPTY', message: EMPTY_QUERY_MESSAGE } },
    };
  }
  const cctx: CompileCtx = { ...base, thisEntityId: block.thisEntityId ?? null };
  try {
    const ast = parseQueryText(text, cctx);
    return {
      key: block.key,
      kind: 'planned',
      plan: compileBlock(ast, cctx, block.limit),
      window: materializationWindow(ast, cctx.today, params),
    };
  } catch (e) {
    return { key: block.key, kind: 'failed', result: { ok: false, error: compileFailure(e) } };
  }
}

/**
 * Вид ответа — по проекции (§5.4): плитка → агрегат, иначе строки. Компилятор проекцию не
 * читает (задача 6), поэтому развилка стоит здесь.
 *
 * Строки: `limit` блока, иначе `limit` текста, иначе потолок; всё клампится до
 * `BLOCK_ROWS_CAP` (схема канона `limit` сверху не ограничивает). Выборка — `limit + 1`: лишняя
 * строка и есть признак «ещё N», и счётчик идёт вторым запросом ТОЛЬКО у переполненного блока.
 */
function compileBlock(ast: QueryAst, cctx: CompileCtx, blockLimit: number | undefined): Plan {
  if (ast.display === 'tile' && ast.aggregate !== undefined) {
    const agg = ast.aggregate;
    if (agg.fn === 'count') return { kind: 'count', sql: compileCountAst(ast, cctx) };
    if (agg.fn === 'sum') {
      return { kind: 'sum', sql: compileSumAst(ast, agg.field, cctx, CURRENCY_PROPERTY) };
    }
    return { kind: 'latest', sql: compileLatestAst(ast, agg.field, cctx) };
  }
  const limit = Math.min(blockLimit ?? ast.limit ?? BLOCK_ROWS_CAP, BLOCK_ROWS_CAP);
  return {
    kind: 'rows',
    sql: compileQueryAst({ ...ast, limit: limit + 1 }, cctx),
    countSql: compileCountAst(ast, cctx),
    limit,
  };
}

/** Объединение окон 'YYYY-MM-DD' (строки такой формы сравниваются как даты). */
function unionWindow(a: Window | null, b: Window | null): Window | null {
  if (a === null) return b;
  if (b === null) return a;
  return { from: b.from < a.from ? b.from : a.from, to: b.to > a.to ? b.to : a.to };
}

async function executePlan(sp: Tx, plan: Plan): Promise<BlockResult> {
  switch (plan.kind) {
    case 'rows': {
      const raw = [...(await sp.execute(plan.sql))] as Record<string, unknown>[];
      if (raw.length <= plan.limit) {
        return { ok: true, kind: 'rows', rows: raw.map(toWireEntityFromSql), more: 0 };
      }
      const counted = await sp.execute(plan.countSql);
      // Не меньше одной: лишняя строка уже увидена, а счётчик — отдельный statement и под
      // READ COMMITTED видит свой снимок; конкурентное удаление между ними не должно дать
      // «ещё 0» при обрезанной выдаче.
      const more = Math.max(1, Number(counted[0]?.count) - plan.limit);
      return {
        ok: true,
        kind: 'rows',
        rows: raw.slice(0, plan.limit).map(toWireEntityFromSql),
        more,
      };
    }
    case 'count': {
      const rows = await sp.execute(plan.sql);
      return { ok: true, kind: 'count', count: Number(rows[0]?.count) };
    }
    case 'sum': {
      const row = (await sp.execute(plan.sql))[0] as Record<string, unknown> | undefined;
      return {
        ok: true,
        kind: 'sum',
        // sum по пустой выборке — SQL NULL: плитка показывает ноль, а не отказ (как у целей).
        sum: (row?.sum as string | null | undefined) ?? '0',
        count: Number(row?.count ?? 0),
        currencies: (row?.currencies as string[] | undefined) ?? [],
      };
    }
    case 'latest': {
      const row = (await sp.execute(plan.sql))[0] as Record<string, unknown> | undefined;
      return { ok: true, kind: 'latest', value: (row?.value as string | null | undefined) ?? null };
    }
  }
}

/**
 * Исполнение всех скомпилированных блоков ОДНОЙ транзакцией, каждый — под своим SAVEPOINT.
 *
 * SAVEPOINT, а не голый try/catch (изоляция §6.3, прецедент — `goals/progress.ts`): упавший
 * statement переводит всю транзакцию PostgreSQL в aborted, и пойманная в JS ошибка всё равно
 * погубила бы каждый следующий блок пачки. `tx.transaction` на postgres-js — именно savepoint
 * на том же соединении; цена — два statement на блок.
 */
async function executeAll(tx: Tx, prepared: Prepared[]): Promise<EntityBlocksResult> {
  const entries: [string, BlockResult][] = [];
  for (const p of prepared) {
    if (p.kind === 'failed') {
      entries.push([p.key, p.result]);
      continue;
    }
    try {
      entries.push([p.key, await tx.transaction((sp) => executePlan(sp, p.plan))]);
    } catch (e) {
      // Молча гасить нельзя (конвенция fail-soft сервера): без строки в журнале отказ
      // исполнения в проде недиагностируем. Наружу — без текста базы: он про колонки и касты,
      // а не про то, что владелец может поправить.
      console.error(`[entity.blocks] блок '${p.key}' не выполнился в базе`, e);
      entries.push([
        p.key,
        {
          ok: false,
          error: {
            code: 'EXECUTION',
            message:
              'запрос блока не выполнился в базе — вероятно, у части записей значение свойства не той формы',
          },
        },
      ]);
    }
  }
  // fromEntries, а не присваивание в литерал: ключ клиента `__proto__` станет своим полем
  // ответа, а не прототипом объекта.
  return { results: Object.fromEntries(entries) };
}

/**
 * Пачка блоков страницы (§6.3): до `BLOCKS_BATCH_CAP` блоков по ТЕКСТУ запроса.
 *
 * Фаза 1 — ОДНА транзакция под идентичностью владельца: контекст (реестр, таймзона) снимается
 * один раз, каждый блок разбирается и компилируется в свой try/catch (отказ — результат блока
 * без SQL), окна материализации собираются. Нет окон — все блоки исполняются той же
 * транзакцией. Есть — ОДНА материализация по объединению окон (от наименьшего `from` до
 * наибольшего `to`; окна пересекаются почти всегда, а лишние дни стоят меньше второго прохода
 * по шаблонам), затем фаза 2 — одна транзакция исполнения на все блоки.
 *
 * Материализация — МЕЖДУ транзакциями, как у `entity.query` (Э-4, `with-materialization.ts`):
 * исполнитель открывает собственные транзакции, и вложенность в живую держала бы второе
 * соединение пула. «Одна транзакция» спеки — одна транзакция ИСПОЛНЕНИЯ.
 */
export async function runBlocks(
  db: Db,
  identity: Identity,
  blocks: EntityBlocksInput['blocks'],
): Promise<EntityBlocksResult> {
  type Phase1 =
    | { kind: 'done'; result: EntityBlocksResult }
    | { kind: 'materialize'; window: Window; prepared: Prepared[]; today: string };
  const phase1 = await withIdentity(db, identity, async (tx): Promise<Phase1> => {
    const base = await queryContext(tx, identity.graph, null);
    // Триггеры и горизонт — из того же снимка, по которому блоки разобраны и исполнятся.
    const params = materializeRuleOf(base.reg).rule.params;
    const prepared = blocks.map((b) => prepareBlock(b, base, params));
    const window = prepared.reduce<Window | null>(
      (acc, p) => (p.kind === 'planned' ? unionWindow(acc, p.window) : acc),
      null,
    );
    if (window === null) return { kind: 'done', result: await executeAll(tx, prepared) };
    return { kind: 'materialize', window, prepared, today: base.today };
  });
  if (phase1.kind === 'done') return phase1.result;
  await materializeInstances({
    db,
    identity,
    from: phase1.window.from,
    to: phase1.window.to,
    today: phase1.today,
  });
  return withIdentity(db, identity, (tx) => executeAll(tx, phase1.prepared));
}
