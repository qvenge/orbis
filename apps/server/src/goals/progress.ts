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
//    конца, и наружу уезжают только они: агрегат считает SQL через `::numeric`, а
//    процент клиент выводит из тех же строк точным BigInt (§3.3). Числа с плавающей
//    точкой контракт этой функции не пересекают вовсе.
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
 *
 * Логируются ВСЕ четыре, а не один compute_failed. Ярлык уезжает клиенту, но клиент —
 * не тот, кто чинит: опечатку в поле цели разбирает владелец сервера по жалобе «полоса
 * пустая», и первое, что он делает, — смотрит лог. Три конфигурационных ярлыка молчали,
 * и разбор начинался с чтения аспекта в базе руками (см. logFailure ниже).
 */
export type GoalProgressUnsupported =
  | 'array_field'
  | 'invalid_query'
  | 'invalid_field'
  | 'compute_failed';

/**
 * Прогресс цели для UI: оба числа — decimal-строками, и ничего кроме них.
 *
 * Готовой доли в контракте НЕТ намеренно. Она здесь считается (см. второй try ниже —
 * это единственный способ поймать 'NaN' на выходе агрегата), но остаётся внутри: полосе
 * нужен процент, а `floor(ratio * 100)` на IEEE-754 врёт (0.29 * 100 = 28.999… → «28 %»),
 * поэтому клиент выводит его точным BigInt из тех же строк (GoalProgress.tsx, п. 3).
 * Число, которым нельзя пользоваться по назначению, на проводе — заготовка для этой
 * ошибки, а не удобство.
 */
export interface GoalProgress {
  /** Достигнутое: сумма/счётчик/последнее значение. Пустая выборка — '0'. */
  current: string;
  /** Цель — `target_value` аспекта как есть (строго > 0 по схеме). */
  target: string;
  /** Присутствует ТОЛЬКО когда посчитать не вышло: тихого нуля не бывает. */
  unsupported?: GoalProgressUnsupported;
}

const GOAL_ASPECT = 'orbis/goal';

/**
 * Счётчик уже показанных отказов — СТРОГО in-memory, и это ограничение, а не вкус.
 * progress.test.ts пинит счётчиком запросов драйвера ровно 6 запросов на обычную
 * сущность и 10 на цель; любое состояние в БД (таблица дедупа, advisory lock) добавило
 * бы к каждому чтению сломанной цели по запросу и уронило бы этот пин. Времени в ключе
 * тоже нет — окно «раз в N минут» сделало бы лог зависимым от системных часов, на
 * которые тесты проекта намеренно не полагаются.
 *
 * Плата за in-memory честная: счётчик живёт в процессе, при рестарте и в каждом воркере
 * отсчёт начинается заново. Для «не залить лог» этого достаточно, для точной статистики
 * отказов — нет; она и не задача лога.
 */
const seenFailures = new Map<string, number>();

/**
 * Потолок различных пар «место + цель». Ключей ровно столько, сколько СЛОМАННЫХ целей
 * в процессе, то есть в норме единицы; потолок стоит от вырожденного случая (скрипт
 * плодит битые цели пачкой) — иначе Map рос бы, пока живёт процесс. Переполнение
 * сбрасывает счётчики целиком: следующая порция отказов снова напечатается по разу —
 * это ровно то поведение, которого от лога и ждут, а не тихое молчание навсегда.
 */
const MAX_TRACKED_FAILURES = 1000;

/**
 * Печатает отказ ОДИН раз на пару «место в коде + цель», дальше — только каждый сотый,
 * счётчиком: шторм обязан быть виден, но поток лога не должен расти линейно с числом
 * чтений (сломанную цель открывают снова и снова — её же чинят).
 *
 * Ключ — МЕСТО лога плюс цель, а НЕ ярлык отказа. `compute_failed` отдают два разных
 * catch'а с разным диагнозом («агрегат не выполнился» vs «доля не посчиталась»), и ключ
 * по ярлыку схлопнул бы их в одну строку: второй отказ той же цели навсегда остался бы
 * без своего текста — при том что весь смысл двух catch'ей именно в различии текста.
 *
 * `goalId` — id самой цели (`ctx.thisEntityId`); NULL бывает только у прямых вызовов
 * computeGoalProgress мимо entity.get (тесты, будущие вызывающие) — такие отказы делят
 * один ключ на место, и это честно: без id цели различать их всё равно нечем.
 */
function logFailure(site: string, goalId: string | null, message: string, cause?: unknown): void {
  const key = `${site} ${goalId ?? ''}`;
  const seen = (seenFailures.get(key) ?? 0) + 1;
  if (seen === 1 && seenFailures.size >= MAX_TRACKED_FAILURES) seenFailures.clear();
  seenFailures.set(key, seen);
  const text = `[goals/progress] ${message}${goalId === null ? '' : ` (цель ${goalId})`}`;
  if (seen === 1) {
    if (cause === undefined) console.error(text);
    else console.error(text, cause);
  } else if (seen % 100 === 0) {
    console.error(`${text} — повторов: ${seen}`);
  }
}

/**
 * Ветка по наличию аспекта: сущность без `orbis/goal` не платит за расчёт НИ ОДНИМ
 * запросом — ни каталога, ни таймзоны, ни агрегата (доказано счётчиком запросов
 * драйвера в progress.test.ts). Аспект, не проходящий свою же схему (drift реестра,
 * правка мимо executor'а), прогресса не даёт, но и открыть сущность не мешает — и
 * оставляет строку в логе: наружу этот выход неотличим от «аспекта цели вовсе нет»
 * (обоим соответствует отсутствие прогресса), поэтому лог здесь — единственная улика.
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
  if (!goal.success) {
    logFailure(
      'aspect_schema',
      entity.id,
      `аспект ${GOAL_ASPECT} не проходит свою же схему — прогресса не будет`,
      goal.error,
    );
    return undefined;
  }
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
    unsupported,
  });

  // Массив — СИНТАКСИЧЕСКИ, до компиляции (§12 п.6). Каталог строит поля из top-level
  // `properties` схемы аспекта, поэтому пути внутрь элемента (`sets[].weight`) в нём нет
  // вовсе, а само поле-массив скаляров (тип `array`) числовым не считается — компилятор
  // отверг бы такое поле как «не разрешилось каталогом» или «тип не числовой», то есть
  // сообщением, неотличимым от опечатки. Осознанное ограничение обязано выглядеть
  // осознанным ограничением, а не опечаткой пользователя.
  if (src.aggregate !== 'count' && src.field.includes('[]')) {
    logFailure(
      'array_field',
      ctx.thisEntityId,
      `отказ array_field: поле '${src.field}' указывает внутрь JSONB-массива, механизм целей такие поля не считает (§12 п.6)`,
    );
    return failed('array_field');
  }

  const parsed = parseQuery(src.query, ctx.catalog);
  if (!parsed.ok) {
    logFailure(
      'parse',
      ctx.thisEntityId,
      `отказ invalid_query: запрос '${src.query}' не разобрался грамматикой §6.1 — ${parsed.error.message} (позиция ${parsed.error.position})`,
    );
    return failed('invalid_query');
  }

  let compiled: SQL;
  try {
    compiled =
      src.aggregate === 'count'
        ? compileCount(parsed.ast, ctx)
        : src.aggregate === 'sum'
          ? compileSum(parsed.ast, ctx, src.field)
          : compileLatest(parsed.ast, ctx, src.field);
  } catch (e) {
    // QueryFieldError — подкласс QueryCompileError, порядок проверок значим.
    // Сообщения компилятора уже человеческие и называют поле/тип — своего текста поверх
    // им не нужно, нужен только ярлык, по которому строку ищут в логе.
    if (e instanceof QueryFieldError) {
      logFailure('compile_field', ctx.thisEntityId, `отказ invalid_field: ${e.message}`);
      return failed('invalid_field');
    }
    if (e instanceof QueryCompileError) {
      logFailure(
        'compile_query',
        ctx.thisEntityId,
        `отказ invalid_query: запрос '${src.query}' не скомпилировался — ${e.message}`,
      );
      return failed('invalid_query');
    }
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
    logFailure(
      'aggregate',
      ctx.thisEntityId,
      `отказ compute_failed: агрегат ${src.aggregate} не выполнился`,
      e,
    );
    return failed('compute_failed');
  }

  // Доля — ОТДЕЛЬНЫМ try, и считается она РАДИ ПАДЕНИЯ, а не ради значения: decRatio
  // разбирает обе decimal-строки, и это единственное место, где ловится 'NaN' — законное
  // значение `numeric` в PostgreSQL, на котором SQL не падает (тест «NaN на выходе
  // агрегата»). Без этой проверки 'NaN' уехал бы клиенту строкой и полоса показала бы
  // невесть что вместо честного «посчитать не вышло».
  //
  // Почему свой try, а не общий с SQL: падение происходит уже после БД (numeric NaN,
  // неразбираемый target у вызывающего мимо схемы, непредставимая доля) и к базе
  // отношения не имеет. Общий catch приписал бы его базе — ярлык остался бы тем же,
  // но лог врал бы о причине, а лог здесь и есть весь диагноз.
  try {
    decRatio(current, target);
    return { current, target };
  } catch (e) {
    logFailure(
      'ratio',
      ctx.thisEntityId,
      `отказ compute_failed: доля не посчиталась (current='${current}', target='${target}')`,
      e,
    );
    return failed('compute_failed');
  }
}
