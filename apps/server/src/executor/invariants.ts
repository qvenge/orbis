// apps/server/src/executor/invariants.ts
// Доменные инварианты стадии 4 — всё ДО первой записи: те инварианты аспектов, которым нужна
// БД (живой грант в назначении, С4/С7), и запреты по объекту для источника `routine`.
// Чистые нормализации аспектов без обращения к БД живут в normalize.ts.
//
// Ролевой слой графа (идентичность ребра, `acyclic`, `target_max_incoming`, `created_by`,
// уникальность) переехал в `relations.ts` вместе с реформой §А4-3: там он один механизм с
// параметром из реестра, здесь был бы набором доменных правил с зашитыми значениями.
import { type GraphId, isModuleEnabled } from '@orbis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentGrants } from '../db/schema';
import type { Tx } from '../db/with-identity';
import type { RegistrySnapshot } from '../registry/load';
import { ExecError } from './errors';
import type { EntityState } from './props';
import type { MutationMechanism, MutationSource } from './types';

/**
 * Титулы сущностей для человекочитаемых сообщений: виртуальные (созданные batch'ем) —
 * из titleOf, остальные — из БД (RLS показывает только свои — этого достаточно,
 * путь цикла состоит из собственных сущностей).
 */
export async function resolveEntityTitles(
  tx: Tx,
  ids: readonly string[],
  titleOf?: (id: string) => string | undefined,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const id of new Set(ids)) {
    const virtual = titleOf?.(id);
    if (virtual !== undefined) titles.set(id, virtual);
  }
  const missing = [...new Set(ids)].filter((id) => !titles.has(id));
  if (missing.length > 0) {
    const rows = (await tx.execute(
      sql`SELECT id, title FROM entities WHERE id IN (${sql.join(
        missing.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )) as unknown as Array<{ id: string; title: string }>;
    for (const row of rows) titles.set(row.id, row.title);
  }
  return titles;
}

/**
 * ЖИВОСТЬ ГРАНТА — ИМЕНОВАННЫЙ ОСТАТОК КОДОМ (Р-К-17, правило 5 §С1-4). Условие «какие значения
 * допустимы вместе» уехало в пару строк каталога (`assignment_grant_required`/`_forbidden`), а здесь
 * остался единственный вопрос, которого язык E не задаёт: существует ли названный грант и не отозван ли
 * он. Это ссылочный пречек (§А6-4), а не предикат над записью: `grant_id` лежит в jsonb, внешнего ключа
 * туда нет, и связь «назначение → грант» держит исполнитель — обойти его нечем, мутации графа идут
 * только здесь.
 *
 * Зовётся ровно тогда, когда назначение затронуто патчем: отзыв гранта закрывает доступ агенту
 * (verifyBearer), но не обязан замораживать уже назначенные тикеты — иначе после отзыва их нельзя было
 * бы даже переименовать.
 *
 * Чтение agent_grants идёт под `SET LOCAL ROLE authenticated` (withIdentity): политика
 * current_graph_select показывает только строки текущего графа, но условие на graph_id оставлено явным —
 * оно же служит фильтром «грант чужой» на любых иных ролях. Чужой и несуществующий грант неразличимы
 * намеренно (единый NOT_FOUND) — иначе назначение стало бы оракулом чужих grant_id.
 */
export async function assertGrantAlive(tx: Tx, graphId: GraphId, next: EntityState): Promise<void> {
  if (!next.aspects.includes('orbis/assignment')) return;
  if (next.props['orbis/executor'] !== 'agent') return;
  const grantId = next.props['orbis/grant'];
  // «Грант обязателен при executor=agent» — работа правила `assignment_grant_required`, и до сюда
  // запись без гранта не доходит; ветка оставлена нестрогой, чтобы порядок проверок был свободен.
  if (typeof grantId !== 'string') return;
  const rows = await tx
    .select({ id: agentGrants.id })
    .from(agentGrants)
    .where(
      and(
        eq(agentGrants.id, grantId),
        eq(agentGrants.graphId, graphId),
        isNull(agentGrants.revokedAt),
      ),
    );
  if (rows.length === 0) {
    throw new ExecError('NOT_FOUND', 'грант исполнителя не найден или отозван', {
      grant_id: grantId,
    });
  }
}

/**
 * Аспекты, которые сущность делают ОБЪЕКТОМ запрета для источника `routine`: рутина и
 * прогон. Один список на оба запрета (сущностный и связевый) — разойдясь, они открыли бы
 * обходной путь через связь.
 *
 * Экспортируется третьему потребителю — объектному пре-чеку диспатча (D42 ОЧ.4), который
 * отклоняет запрещённое ДО постановки в пачку решений. Свой список аспектов у пре-чека
 * разошёлся бы с этим молча, и в пачку однажды попала бы карточка, которую стадия 4
 * гарантированно убьёт на «Принять».
 */
export const ROUTINE_UNTOUCHABLE_OBJECTS = ['orbis/routine', 'orbis/agent-run'] as const;

function isUntouchableObject(aspects: readonly string[] | undefined): boolean {
  return aspects !== undefined && ROUTINE_UNTOUCHABLE_OBJECTS.some((id) => aspects.includes(id));
}

/**
 * Запрет по объекту для источника `routine` (V1.10, инвариант 6): рутина не меняет рутины и
 * прогоны и не раздаёт назначения. Запрет сформулирован по ОБЪЕКТУ, а не по глаголу: неважно,
 * каким тулом рутина дотянулась до `orbis/routine`, `orbis/agent-run` или `orbis/assignment` —
 * create, update, attach, связь — отказ один. Иначе рутина в режиме `act` могла бы расширить
 * себе белый список `allowed_tools`, снять паузу с себя или соседней рутины и завести
 * исполнителю новую работу: доверенность, выданную владельцем, нельзя переписывать её же
 * руками.
 *
 * Прогоны в списке — по той же причине (финальное ревью V1, A-1): рутина в `act` с
 * `entity_update` в белом списке знает свой `run_id` и без запрета могла бы подделать «ответ
 * владельца» (`reply` — его следующий прогон прочтёт как реплику человека), закрыть чужие
 * `failed`-прогоны и обойти стоп-кран (V1.12), завести соседней рутине фальшивый вопрос в
 * блок «Ждут ответа» или закрыть свой идущий прогон. Вся бухгалтерия прогона при этом идёт
 * источником `system` (Р-7), ответ владельца — `ui`, так что запрет ничего легитимного не
 * задевает.
 *
 * Точка проверки — стадия 4 executor'а, после чтения строки под `FOR UPDATE` и ДО первой
 * записи, рядом с `assertGrantAlive`. Это единственный рубеж, который нельзя обойти: гейт
 * режима в dispatch (V1.2) видит только имя тула, а `orbis_propose` — только форму
 * предложения; обе проверки — до конвейера, а мутации графа идут только здесь.
 *
 * Смотрит РОВНО на `source === 'routine'`. Создание прогона, его шаги, закрытие и связь
 * `parent` рутина→прогон — бухгалтерия источником `system` (Р-7), и инвариант на ней молчит.
 * Внутренний undo (§7.8) идёт тем же `system` — отдельного гейта `internalUndo` здесь
 * поэтому нет.
 *
 * @param before СПИСОК аспектов строки ДО операции (update/attach; у create строки ещё нет)
 * @param next список аспектов после операции
 * @param touched аспекты, которых операция касается (навешенные, снятые и объявляющие
 *   затронутое свойство — см. `touchedAspects`)
 */
export function assertRoutineUntouchable(
  source: MutationSource,
  args: { before?: readonly string[]; next: readonly string[]; touched: readonly string[] },
): void {
  if (source !== 'routine') return;
  // Рутина и прогон запрещены и как ОБЪЕКТ правки (сущность уже такова либо ею становится),
  // и как затронутый аспект: detach в `next` не виден, но в `touched` — да.
  const hitsObject =
    isUntouchableObject(args.before) ||
    isUntouchableObject(args.next) ||
    ROUTINE_UNTOUCHABLE_OBJECTS.some((id) => args.touched.includes(id));
  // Назначение — только по `touched`: рутина вправе править СВОЙ тикет (титул, статус),
  // но не переназначать его исполнителю.
  const hitsAssignment = args.touched.includes('orbis/assignment');
  if (!hitsObject && !hitsAssignment) return;
  throw routineUntouchableError();
}

/**
 * Запись в выключенный модуль (§Б8-3): создание и навешивание — нет, правка существующей
 * записи — да (данные не трогаются, скрытое ≠ удалённое). Отказ по ОБЪЕКТУ, как
 * COMPUTED_WRITE: повторять с другим значением бессмысленно — потому у `MODULE_DISABLED`
 * и стоит 403 в `TRPC_CODE_BY_EXEC`.
 *
 * `aspects` — только ДОБАВЛЯЕМЫЕ аспекты, а не итоговое состояние: иначе правка суммы
 * существующей транзакции ловилась бы вместе с созданием новой.
 *
 * `mechanism` — вторая ось того же вопроса «чья это запись»: см. ветку `materialize` ниже.
 */
export function assertModuleEnabled(
  reg: RegistrySnapshot,
  disabled: readonly string[],
  mechanism: MutationMechanism,
  aspects: readonly string[],
): void {
  if (disabled.length === 0) return; // общий путь — без единого обращения к реестру
  // МАТЕРИАЛИЗАЦИЯ — НЕ СОЗДАНИЕ (Ф-Б1-57а). Инстанс повторяющегося рождает сервер как
  // СЛЕДСТВИЕ уже существующего шаблона владельца, а не как новую его запись, и §Б8-3
  // запрещает второе, а не первое. Гейт на этом пути стоил бы буквы §С1-3 п.9: финансовый
  // recurring-шаблон при выключенных Финансах переставал бы материализоваться, каждая
  // выборка Повестки писала бы warn (`recurring/materialize.ts`, ветка «прочие отказы») и
  // молча теряла строки инстансов — то есть выключение одного модуля меняло бы результат
  // ЧУЖОЙ подписки. Ось отдельная от `internalUndo` намеренно: тот про откат своей же
  // записи, этот — про происхождение записи вообще. ЛЬГОТА ЕДИНСТВЕННАЯ: любой будущий
  // механизм (`MutationMechanism`, executor/types.ts) обязан быть отнесён к гейту ЯВНО —
  // по умолчанию он гейтится, и это правило, а не забывчивость (ре-ревью задачи 17).
  if (mechanism === 'materialize') return;
  for (const id of aspects) {
    const module = reg.aspects.get(id)?.module ?? null;
    if (isModuleEnabled(module, disabled)) continue;
    throw new ExecError(
      'MODULE_DISABLED',
      `модуль «${module}» выключен: аспект «${id}» не навешивается (§Б8-3)`,
      { module, aspect: id },
    );
  }
}

/**
 * Тот же запрет по объекту для связей (V1.10, инвариант 6): рутина не привязывает ничего к
 * рутине или прогону и не отвязывает от них. Достаточно ОДНОГО конца-объекта — направление
 * связи ничего не меняет: и `parent` рутина→сущность, и обратная правят граф вокруг рутины.
 *
 * `ends.source`/`ends.target` — списки аспектов обоих концов, прочитанные под `FOR UPDATE`
 * (`loadBothEndsForUpdate`): без замка проверка сверяла бы состояние, которое конкурент
 * успел бы поменять до записи.
 */
export function assertRoutineRelationUntouchable(
  source: MutationSource,
  ends: { source: readonly string[]; target: readonly string[] },
): void {
  if (source !== 'routine') return;
  if (!isUntouchableObject(ends.source) && !isUntouchableObject(ends.target)) return;
  throw routineUntouchableError();
}

/**
 * Единый отказ обоих запретов по объекту: код `FORBIDDEN_LEVEL` (§7.10 «forbidden» — не
 * INVARIANT: граф остался бы целостным, отказано именно источнику), причина в `details` —
 * потребитель различает её полем, а не разбором текста.
 *
 * Тем же отказом отвечает пре-чек диспатча (D42 ОЧ.4), поймавший запрещённую цель раньше
 * конвейера: на каком рубеже рутину остановили — её дело, а не вызывающего, и две разные
 * формулировки одного запрета читались бы как два разных правила.
 */
export function routineUntouchableError(): ExecError {
  return new ExecError(
    'FORBIDDEN_LEVEL',
    'рутина не может менять рутины, прогоны и назначения (V1.10)',
    { reason: 'routine_untouchable' },
  );
}
