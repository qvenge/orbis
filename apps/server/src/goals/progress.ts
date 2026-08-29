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
import {
  aspectsNamedInQueryAst,
  QUERY_TREE_DEPTH_CAP,
  type QueryAst,
  queryAstSchema,
  queryTreeExceedsDepth,
  resolveLegacyFieldId,
} from '@orbis/shared/query';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { decRatio } from '../budget/decimal';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { WireEntity } from '../executor/types';
import {
  type CompileCtx,
  compileCountAst,
  compileLatestAst,
  compileSumAst,
} from '../query/compile-ast';
import { queryContext } from '../query/context';
import { parseRegistryOf } from '../query/parse-text';

/**
 * Почему прогресс не посчитался. Один литерал был бы враньём разной степени:
 * пользователю нужно понимать, чинить ли ему запрос, имя поля или ждать движок.
 * - `array_field` — поле внутри JSONB-массива (`sets[].weight`): осознанное
 *   ограничение механизма целей (§12 п.6), а не поломка цели;
 * - `invalid_query` — `progress_source.query` хранит неразобранный блок `{text}` вместо
 *   дерева (§А5-2) или не скомпилировался структурно (`children_of=this` вне контекста);
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
const PROGRESS_SOURCE = 'orbis/progress_source';
const TARGET_VALUE = 'orbis/target_value';

/**
 * Источник прогресса в форме СВОЙСТВ (§А1-1): `orbis/progress_source` + `orbis/target_value`.
 *
 * Отдельный тип, а не `GoalAspect` из старых zod-схем, потому что запрос внутри — ДЕРЕВО
 * (§А5-2/Р12), а старая схема объявляет его строкой. Со снятием `schemas/aspects.ts`
 * (Задача 23) второго описания этой формы не останется вовсе.
 */
export interface GoalSource {
  progressSource: ProgressSource;
  targetValue: string;
}

export type ProgressSource = z.infer<typeof progressSourceSchema>;

/**
 * Запрос источника: ДЕРЕВО канона (§А5-2/Р12) либо НЕРАЗОБРАННЫЙ блок `{text}` — та же
 * пара веток, что стоит в json-схеме свойства `orbis/progress_source` (реестр).
 *
 * Вторая ветка не переживает расчёт: по ней `computeGoalProgress` отдаёт `invalid_query`,
 * то есть цель со старым текстом показывается владельцу С ОШИБКОЙ, как и раньше, а не
 * теряет полосу прогресса молча. Конвертера текста не заводится — база пересевается
 * (рулинг 23.08).
 *
 * ДАТА СМЕРТИ у ветки та же, что у её половины в реестре, и живёт она одним абзацем —
 * докблок `PROGRESS_QUERY_SCHEMA` (`packages/shared/src/registry/builtin-properties.ts`):
 * обе снимаются, когда `git grep translateProgressSource` и `git grep legacyAspectsPatch`
 * дают ноль ВЫЗЫВАЮЩИХ вне двух абзацев, формулирующих условие (там же названо, каких
 * именно, и почему считать надо «вне»). Второго списка условий здесь нет намеренно — он
 * разъехался бы с первым.
 */
const progressQuerySchema = z.union([
  queryAstSchema,
  z.object({ text: z.string().min(1) }).strict(),
]);

/**
 * Форма значения `orbis/progress_source` на ЧТЕНИИ. Дублирует json-схему реестра
 * (`builtin-properties.ts`), и это осознанно: реестр стоит на записи, а расчёт обязан
 * пережить строку, записанную мимо исполнителя (drift реестра, ручная правка) — fail-soft,
 * а не исключением.
 */
const progressSourceSchema = z.discriminatedUnion('aggregate', [
  z.object({ query: progressQuerySchema, aggregate: z.literal('count') }).strict(),
  z
    .object({
      query: progressQuerySchema,
      aggregate: z.enum(['sum', 'latest']),
      field: z.string().min(1),
    })
    .strict(),
]);

/**
 * Целевое число — decimal-строка строго > 0: сервер на неё делит, и ноль с минусом смысла
 * не имеют. Паттерн — тот же, что у `positiveDecimal` старой схемы (`schemas/aspects.ts`).
 */
const targetValueSchema = z
  .string()
  .regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'строго положительная decimal-строка');

/** Источник цели целиком: обе половины обязательны, как и в §А8 у аспекта `orbis/goal`. */
const goalSourceSchema = z.object({
  progressSource: progressSourceSchema,
  targetValue: targetValueSchema,
});

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
 * Потолок различных ключей. Ключей столько, сколько различных пар «беда + цель» видел
 * процесс, — в норме единицы, но растёт это не только от числа сломанных целей: цель,
 * которую чинят наугад, оставляет по ключу на каждую испробованную поломку. Потолок
 * стоит и от этого, и от вырожденного случая (скрипт плодит битые цели пачкой) — иначе
 * Map рос бы, пока живёт процесс.
 *
 * Переполнение НЕ чистит счётчики. Чистка выключала бы дроссель ровно в шторм: 1200
 * различных сломанных целей по 10 кругов чтения дают при сбросе 12 000 строк — ровно
 * то, что было до дросселя, причём при честно удерживаемой тысяче ключей. Вместо этого
 * всё сверх потолка сваливается в ОДИН общий ключ (OVERFLOW_KEY): те же 1200×10 дают
 * ~1021 строку, и потолок остаётся потолком. Плата названа честно и в самой строке:
 * после переполнения отдельные цели в логе не различаются, поэтому такие строки
 * помечены — читателю видно, что дедуп загрубел, а не что отказов стало меньше.
 */
const MAX_TRACKED_FAILURES = 1000;

/** Общий ключ для всего, что не поместилось в потолок. */
const OVERFLOW_KEY = 'overflow';

/**
 * Разделитель частей ключа. Именно ЭКРАНОМ, а не байтом в исходнике: литеральный NUL
 * делает файл бинарным для grep («Binary file matches» вместо строки, а с -c — вообще
 * тишина), и поиск по коду перестаёт видеть весь файл целиком. Проверено на этом самом
 * файле. Ключ получается тот же, читаемость исходника — нет.
 */
const KEY_SEP = '\u0000';

/**
 * Печатает отказ ОДИН раз на ключ, дальше — только каждый сотый, счётчиком: шторм обязан
 * быть виден, но поток лога не должен расти линейно с числом чтений (сломанную цель
 * открывают снова и снова — её же чинят).
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, и оно прямо следует из отсутствия времени в ключе (почему времени
 * нет — в докблоке seenFailures: часы в тестах под запретом): дроссель не умеет отвечать
 * на вопрос «всё ещё сломано?». Счётчик монотонен и не остывает, поэтому цель, которую
 * починили, а она сломалась снова ТЕМ ЖЕ диагнозом, молчит до сотого чтения; и наоборот —
 * однажды напечатанная строка не стареет, по ней не отличить «беда была на прошлой неделе»
 * от «беда идёт прямо сейчас». Единственный признак продолжающейся беды — редкая строка
 * «повторов: N». Компромисс принят сознательно: за «не залить лог» платим тем, что лог
 * остаётся уликой для разбора по жалобе, а не монитором состояния.
 *
 * Ключ — «место + ДИАГНОЗ + цель», и обе добавки к месту неслучайны.
 * - Ярлыка отказа в ключе нет: `compute_failed` отдают два разных catch'а с разным
 *   диагнозом («агрегат не выполнился» vs «доля не посчиталась»), и ключ по ярлыку
 *   схлопнул бы их — второй отказ той же цели навсегда остался бы без своего текста.
 * - Одного МЕСТА мало: цикл починки («правлю поле → перечитываю») целиком живёт ВНУТРИ
 *   одного места `compile_field`. Без диагноза в ключе после замены `amountt` на
 *   `counterparty` последняя напечатанная строка продолжала бы называть уже исправленное
 *   поле, а на сотом повторе перепечаталась бы с «повторов: 100». Устаревший диагноз
 *   хуже отсутствующего: по нему чинят не то.
 *
 * `diag` кладут ТОЛЬКО там, где он стабилен при неизменной цели, — меняющийся диагноз
 * убил бы сам дедуп, ради которого всё и заведено. Разбивка по местам:
 * - `array_field` — имя поля: другого содержания у этого отказа нет;
 * - `parse` — сам неразобранный текст: другого содержания у этого отказа нет;
 * - `compile_field`, `compile_query` — текст ошибки компилятора: он называет поле и тип,
 *   своих меняющихся значений не несёт;
 * - `aspect_schema` — сообщение zod: чем именно аспект не подошёл схеме;
 * - `source_too_deep` — САМ КАП (`QUERY_TREE_DEPTH_CAP`): диагноз здесь один на все такие
 *   значения и по построению не меняется, а глубина отвергнутого дерева менялась бы от
 *   правки к правке и убила бы дедуп;
 * - `aggregate` — ВИД агрегата, а не текст ошибки БД: тот несёт значение сорвавшей
 *   строки («invalid input syntax for type numeric: "не число"»), а оно меняется от
 *   правки соседней сущности, к самой цели отношения не имеющей;
 * - `ratio` — БЕЗ диагноза: единственный его кандидат, `current`, у живой цели меняется
 *   каждое чтение, и дедуп там не сработал бы ни разу.
 *
 * `goalId` — `ctx.thisEntityId`, то есть сущность-хозяин query-блока. На боевом пути
 * (entity.get) это сама цель, но вообще это id ВЫЗЫВАЮЩЕГО контекста, а не обязательно
 * владелец аспекта: прямой вызов computeGoalProgress волен передать чужой контекст или
 * NULL. NULL-отказы делят один ключ на «место + диагноз», и это честно: без id цели
 * различать их всё равно нечем.
 */
function logFailure(
  site: string,
  diag: string | null,
  goalId: string | null,
  message: string,
  cause?: unknown,
): void {
  const exact = `${site}${KEY_SEP}${diag ?? ''}${KEY_SEP}${goalId ?? ''}`;
  const overflowed = !seenFailures.has(exact) && seenFailures.size >= MAX_TRACKED_FAILURES;
  const key = overflowed ? OVERFLOW_KEY : exact;
  const seen = (seenFailures.get(key) ?? 0) + 1;
  seenFailures.set(key, seen);
  const where = goalId === null ? '' : ` (цель ${goalId})`;
  const mark = overflowed
    ? ` [дроссель переполнен: >${MAX_TRACKED_FAILURES} различных отказов, цели в логе больше не различаются]`
    : '';
  const text = `[goals/progress] ${message}${where}${mark}`;
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
  // Признак носителя (Р9): значения `orbis/progress_source` и `orbis/target_value`
  // остаются в `props` и после снятия аспекта цели, а старая карта теряла их вместе с ним.
  // Без признака полоса прогресса рисовалась бы у записи, целью быть переставшей.
  if (!entity.aspects.includes(GOAL_ASPECT)) return undefined;
  /**
   * ВХОД-ДЕРЕВА 3 (страховка чтения). СТРАХОВКА ГЛУБИНЫ ПЕРЕД РАЗБОРОМ — вторая половина
   * рулинга Р-13c-2.
   *
   * `progressSourceSchema` рекурсивна через `queryAstSchema` (`z.lazy`), и на достаточно
   * глубоком значении она не возвращает ошибку, а БРОСАЕТ `RangeError` — переполнение
   * стека, которое `safeParse` не ловит по построению (он ловит `ZodError`). Без этой
   * ветки такое значение отдавало бы 500 на КАЖДОМ `entity.get` цели, то есть fail-soft,
   * ради которого написан весь `logFailure` ниже, не срабатывал бы вовсе.
   *
   * Записать такое значение с этой задачи нельзя (гейт стоит в `validate-props.ts`), но
   * страховка нужна ровно потому, что путь записи — не единственный источник строки:
   * сид, миграция и правка jsonb руками идут мимо валидатора. Кап тот же, и меряется то же,
   * что там, — значение целиком.
   */
  const source = entity.props[PROGRESS_SOURCE];
  if (queryTreeExceedsDepth(source, QUERY_TREE_DEPTH_CAP)) {
    logFailure(
      'source_too_deep',
      String(QUERY_TREE_DEPTH_CAP),
      entity.id,
      `значение ${PROGRESS_SOURCE} вложено глубже ${QUERY_TREE_DEPTH_CAP} уровней — ` +
        'разбор такой формы переполняет стек, прогресса не будет',
    );
    return undefined;
  }
  const goal = goalSourceSchema.safeParse({
    progressSource: source,
    targetValue: entity.props[TARGET_VALUE],
  });
  if (!goal.success) {
    logFailure(
      'aspect_schema',
      goal.error.message,
      entity.id,
      `свойства аспекта ${GOAL_ASPECT} не проходят свою же форму — прогресса не будет`,
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
  ctx: CompileCtx,
  goal: GoalSource,
): Promise<GoalProgress> {
  const target = goal.targetValue;
  const src = goal.progressSource;
  // Сущность-хозяин query-блока: у `CompileCtx` поле НЕОБЯЗАТЕЛЬНОЕ («контекста нет»), а
  // журналу нужен один вид отсутствия — иначе строка лога отличалась бы от вызывающего.
  const goalId = ctx.thisEntityId ?? null;
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
      src.field,
      goalId,
      `отказ array_field: поле '${src.field}' указывает внутрь JSONB-массива, механизм целей такие поля не считает (§12 п.6)`,
    );
    return failed('array_field');
  }

  // `progress_source.query` ХРАНИТСЯ деревом (§А5-2/Р12): разбора текста здесь больше нет
  // вовсе. Осталась одна ветка — неразобранный блок `{text}`: так выглядит цель, чей
  // источник записан старой формой (переходная карта заворачивает текст именно в неё).
  // Считать по нему нечего, и молчать нельзя — владельцу нужен тот же `invalid_query`,
  // который он видел до реформы на непонятном запросе.
  // Ветка СНИМАЕТСЯ вместе со второй половиной `anyOf` в реестре — условие момента там же
  // (докблок `progressQuerySchema` выше ссылается на него одним адресом).
  if ('text' in src.query) {
    const text = src.query.text;
    logFailure(
      'parse',
      text,
      goalId,
      `отказ invalid_query: источник цели хранит неразобранный запрос '${text}', ` +
        'а не дерево (§А5-2) — конвертера старого текста нет, источник переписывается заново',
    );
    return failed('invalid_query');
  }
  const ast: QueryAst = src.query;

  // Имя поля агрегата резолвится ДО компиляции и своим ярлыком: у компилятора канона на
  // руках был бы только id, и «нет такого свойства» стало бы неотличимо от неизвестного id
  // внутри самого запроса — то есть `invalid_field` и `invalid_query` слились бы. Аспекты
  // самого запроса участвуют в резолве (как `aspectsInQuery` у старого компилятора): ими
  // автор цели разводит имя, которое носят несколько аспектов.
  let property = '';
  if (src.aggregate !== 'count') {
    const resolved = resolveLegacyFieldId(
      src.field,
      parseRegistryOf(ctx),
      aspectsNamedInQueryAst(ast),
    );
    if (resolved === undefined) {
      const message = `поле '${src.field}' не разрешилось реестром: нет такого свойства или оно неоднозначно`;
      logFailure('compile_field', message, goalId, `отказ invalid_field: ${message}`);
      return failed('invalid_field');
    }
    property = resolved;
  }

  let compiled: SQL;
  try {
    compiled =
      src.aggregate === 'count'
        ? compileCountAst(ast, ctx)
        : src.aggregate === 'sum'
          ? compileSumAst(ast, property, ctx)
          : compileLatestAst(ast, property, ctx);
  } catch (e) {
    if (!(e instanceof ExecError)) throw e;
    // Причина `FIELD` — отказ ПО ПОЛЮ АГРЕГАТА (тип не числовой), всё остальное — отказ по
    // самому запросу. Сообщения компилятора уже человеческие и называют свойство/тип —
    // своего текста поверх им не нужно, нужен только ярлык, по которому строку ищут в логе.
    if ((e.details as { reason?: unknown } | undefined)?.reason === 'FIELD') {
      logFailure('compile_field', e.message, goalId, `отказ invalid_field: ${e.message}`);
      return failed('invalid_field');
    }
    logFailure(
      'compile_query',
      e.message,
      goalId,
      `отказ invalid_query: запрос ${JSON.stringify(src.query)} не скомпилировался — ${e.message}`,
    );
    return failed('invalid_query');
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
      src.aggregate,
      goalId,
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
    // diag здесь NULL: единственный кандидат — `current`, а он у живой цели меняется
    // каждое чтение, и дедуп с ним не сработал бы ни разу (см. докблок logFailure).
    logFailure(
      'ratio',
      null,
      goalId,
      `отказ compute_failed: доля не посчиталась (current='${current}', target='${target}')`,
      e,
    );
    return failed('compute_failed');
  }
}
