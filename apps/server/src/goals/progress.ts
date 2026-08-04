// apps/server/src/goals/progress.ts
// Прогресс цели (01-architecture §11.3): аспект `orbis/goal` описывает ИСТОЧНИК —
// запрос грамматики §6.1 плюс агрегат, — а число считает сервер на каждом чтении.
// Материализованных агрегатов у нас нет (глобальное ограничение), `current_value`
// в аспекте — кэш по правилу 3 §10, и эта функция его не пишет: entity.get остаётся
// ЧТЕНИЕМ, единственный путь мутаций — executor.
//
// Три вещи, которые здесь важнее кода:
//
// 1. РАСЧЁТ FAIL-SOFT. Любая беда источника (запрос не разобрался, поле не нашлось,
//    поле нечисловое, `this` вне контекста, отказ самого SQL) отдаётся полем
//    `unsupported`, а НЕ исключением. Иначе цель со сломанным `progress_source`
//    становится сущностью, которую нельзя открыть, — а починить её можно только открыв.
//    Пустая выборка при этом НЕ отказ: это честный ноль (§6.4 «пустота ≠ ошибка»).
// 2. БЕЗ МАТЕРИАЛИЗАЦИИ ПОВТОРЯЮЩИХСЯ. Запрос исполняется напрямую, без
//    queryWithMaterialization (§5.4), потому что тот ПИШЕТ в граф — материализует
//    экземпляры повторяющихся, — а entity.get писать не должен. Следствие честное:
//    цель, чья выборка попадала бы на ещё не материализованные экземпляры
//    повторяющейся задачи/платежа, их не посчитает, пока их не материализует любой
//    другой путь (список, бюджет, повестка).
// 3. ДЕНЬГИ НЕ ХОДЯТ ЧЕРЕЗ FLOAT. `current`/`target` — decimal-строки от начала до
//    конца; агрегат считает SQL через `::numeric`, доля — decRatio на BigInt (§3.3).
import { type GoalAspect, goalAspectSchema, parseQuery } from '@orbis/shared';
import type { SQL } from 'drizzle-orm';
import { decRatio } from '../budget/decimal';
import type { Tx } from '../db/with-identity';
import type { WireEntity } from '../executor/types';
import {
  type CompileContext,
  compileCount,
  compileLatest,
  compileSum,
  QueryCompileError,
  QueryFieldError,
} from '../query/compile';
import { queryContext } from '../query/context';

/**
 * Почему прогресс не посчитался. Один литерал был бы враньём разной степени:
 * пользователю нужно понимать, чинить ли ему запрос, имя поля или ждать движок.
 * - `array_field` — поле внутри JSONB-массива (`sets[].weight`): осознанное
 *   ограничение механизма целей (§12 п.6), а не поломка цели;
 * - `invalid_query` — `progress_source.query` не разобрался грамматикой §6.1 или не
 *   скомпилировался структурно (например `children_of=this` вне контекста);
 * - `invalid_field` — поле агрегата не нашлось в каталоге, неоднозначно без `aspect=`
 *   или не числовое (для sum и latest набор типов один);
 * - `compute_failed` — расчёт сорвался уже ПОСЛЕ компиляции: либо запрос дошёл до БД и
 *   упал там (рассинхрон типа в реестре, таймаут), либо не разобралось значение на
 *   выходе агрегата (numeric NaN, непредставимая доля). Причину различают не ярлыком,
 *   а логом — оба места пишут `console.error` с разным текстом. Молчать нельзя.
 */
export type GoalProgressUnsupported =
  | 'array_field'
  | 'invalid_query'
  | 'invalid_field'
  | 'compute_failed';

/** Прогресс цели для UI: числа — строками, доля — производным числом для полосы. */
export interface GoalProgress {
  /** Достигнутое: сумма/счётчик/последнее значение. Пустая выборка — '0'. */
  current: string;
  /** Цель — `target_value` аспекта как есть (строго > 0 по схеме). */
  target: string;
  /** current / target для прогресс-бара. > 1 при перевыполнении, полосу режет UI. */
  ratio: number;
  /** Присутствует ТОЛЬКО когда посчитать не вышло: тихого нуля не бывает. */
  unsupported?: GoalProgressUnsupported;
}

const GOAL_ASPECT = 'orbis/goal';

/**
 * Ветка по наличию аспекта: сущность без `orbis/goal` не платит за расчёт НИ ОДНИМ
 * запросом — ни каталога, ни таймзоны, ни агрегата (доказано счётчиком запросов
 * драйвера в progress.test.ts). Аспект, не проходящий свою же схему (drift реестра,
 * правка мимо executor'а), прогресса не даёт, но и открыть сущность не мешает.
 * Вызывается ТОЛЬКО под withIdentity — изоляция целиком на RLS.
 */
export async function goalProgressFor(
  tx: Tx,
  ownerId: string,
  entity: WireEntity,
): Promise<GoalProgress | undefined> {
  const raw = entity.aspects[GOAL_ASPECT];
  if (raw === undefined) return undefined;
  const goal = goalAspectSchema.safeParse(raw);
  if (!goal.success) return undefined;
  // `this` источника прогресса — сама цель: query-блок принадлежит ей (§6.1)
  const cctx = await queryContext(tx, ownerId, entity.id);
  return computeGoalProgress(tx, cctx, goal.data);
}

/**
 * Считает прогресс в УЖЕ ОТКРЫТОЙ транзакции вызывающего. Не `Db`: entity.get работает
 * внутри withIdentity, и второй `db.transaction` внутри живой транзакции истощал бы пул
 * соединений (тот же принцип, что в recurring/with-materialization.ts и budget/aggregates.ts).
 * `ownerId` не нужен вовсе: скомпилированный SQL owner-фильтра не содержит, изоляцию
 * даёт RLS через identity транзакции.
 */
export async function computeGoalProgress(
  tx: Tx,
  ctx: CompileContext,
  goal: GoalAspect,
): Promise<GoalProgress> {
  const target = goal.target_value;
  const src = goal.progress_source;
  const failed = (unsupported: GoalProgressUnsupported): GoalProgress => ({
    current: '0',
    target,
    ratio: 0,
    unsupported,
  });

  // Массив — СИНТАКСИЧЕСКИ, до компиляции (§12 п.6). Каталог типизирует любой массив
  // как строку, поэтому компилятор отверг бы `sets[].weight` как «поле не найдено» —
  // сообщением, неотличимым от опечатки. Осознанное ограничение обязано выглядеть
  // осознанным ограничением, а не опечаткой пользователя.
  if (src.aggregate !== 'count' && src.field.includes('[]')) return failed('array_field');

  const parsed = parseQuery(src.query, ctx.catalog);
  if (!parsed.ok) return failed('invalid_query');

  let compiled: SQL;
  try {
    compiled =
      src.aggregate === 'count'
        ? compileCount(parsed.ast, ctx)
        : src.aggregate === 'sum'
          ? compileSum(parsed.ast, ctx, src.field)
          : compileLatest(parsed.ast, ctx, src.field);
  } catch (e) {
    // QueryFieldError — подкласс QueryCompileError, порядок проверок значим
    if (e instanceof QueryFieldError) return failed('invalid_field');
    if (e instanceof QueryCompileError) return failed('invalid_query');
    throw e;
  }

  let current: string;
  try {
    // SAVEPOINT, а не голый try/catch: упавший statement в PostgreSQL переводит ВСЮ
    // транзакцию в aborted, и пойманная в JS ошибка всё равно убила бы entity.get на
    // COMMIT. tx.transaction на postgres-js — именно savepoint (то же соединение,
    // не вторая транзакция из пула): один лишний statement на цель, зато откат
    // касается только агрегата.
    current = await tx.transaction(async (sp) => {
      const rows = await sp.execute(compiled);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (src.aggregate === 'count') return String(row?.count ?? '0');
      // sum по пустой выборке — SQL NULL; latest без строк — вовсе нет строки.
      // И то и другое = «пока ноль», а не отказ (§6.4).
      const value = (src.aggregate === 'sum' ? row?.sum : row?.value) as string | null | undefined;
      return value ?? '0';
    });
  } catch (e) {
    // Молча гасить нельзя (конвенция fail-soft-catch сервера): без этой строки
    // `compute_failed` в проде недиагностируем, а программная ошибка в компиляте
    // выглядела бы как «просто не посчиталось» разом у ВСЕХ целей и без сигнала.
    console.error(`[goals/progress] агрегат ${src.aggregate} не выполнился:`, e);
    return failed('compute_failed');
  }

  // Доля — ОТДЕЛЬНЫМ try: она считается уже после БД, и её падение (numeric NaN на
  // выходе агрегата, неразбираемый target у вызывающего мимо схемы, непредставимая
  // доля) не имеет отношения к SQL. Общий catch приписал бы её базе — ярлык остался
  // бы тем же, но лог врал бы о причине, а лог здесь и есть весь диагноз.
  try {
    return { current, target, ratio: decRatio(current, target) };
  } catch (e) {
    console.error(
      `[goals/progress] доля не посчиталась (current='${current}', target='${target}'):`,
      e,
    );
    return failed('compute_failed');
  }
}
