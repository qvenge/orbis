// apps/server/src/executor/invariants.ts
// Доменные инварианты стадии 4 — всё ДО первой записи: те инварианты аспектов, которым нужна
// БД (живой грант в назначении, С4/С7), и запреты по объекту для источника `routine`.
// Чистые нормализации аспектов без обращения к БД живут в normalize.ts.
//
// Ролевой слой графа (идентичность ребра, `acyclic`, `target_max_incoming`, `created_by`,
// уникальность) переехал в `relations.ts` вместе с реформой §А4-3: там он один механизм с
// параметром из реестра, здесь был бы набором доменных правил с зашитыми значениями.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentGrants } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from './errors';
import type { EntityState } from './props';
import type { MutationSource } from './types';

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
 * Живой грант в назначении (С4/С7): `orbis/assignment` с `executor=agent` обязан указывать
 * на НЕОТОЗВАННЫЙ грант ВЛАДЕЛЬЦА сущности. Схема аспекта этого не выражает: `grant_id` лежит
 * в jsonb, внешнего ключа туда нет, а `.refine` зода исчезает при генерации JSON Schema — ajv
 * (стадия 2) проверяет только форму uuid. Поэтому связь «назначение → грант» держит executor,
 * и это единственное место, где она держится: обойти его нечем — мутации графа идут только
 * здесь.
 *
 * Проверяется в МОМЕНТ установки назначения, а не при каждой правке сущности: отзыв гранта
 * закрывает доступ агенту (verifyBearer), но не обязан замораживать уже назначенные тикеты —
 * иначе после отзыва их нельзя было бы даже переименовать. Вызывающая сторона зовёт эту
 * проверку ровно тогда, когда аспект назначения появляется или меняется.
 *
 * Чтение agent_grants идёт под `SET LOCAL ROLE authenticated` (withIdentity): политика
 * owner_owns_row показывает только строки владельца, но условие на owner_id всё равно
 * оставлено явным — оно же служит фильтром «грант чужой» на любых иных ролях.
 * Чужой и несуществующий грант неразличимы намеренно (единый NOT_FOUND, как у сущностей):
 * иначе назначение стало бы оракулом чужих grant_id.
 */
export async function assertAssignment(tx: Tx, ownerId: string, next: EntityState): Promise<void> {
  if (!next.aspects.includes('orbis/assignment')) return;
  const executor = next.props['orbis/executor'];
  const grantId = next.props['orbis/grant'];
  if (executor === 'agent') {
    if (typeof grantId !== 'string') {
      throw new ExecError('VALIDATION', 'назначение агенту требует grant_id', {
        aspect: 'orbis/assignment',
      });
    }
    const rows = await tx
      .select({ id: agentGrants.id })
      .from(agentGrants)
      .where(
        and(
          eq(agentGrants.id, grantId),
          eq(agentGrants.ownerId, ownerId),
          isNull(agentGrants.revokedAt),
        ),
      );
    if (rows.length === 0) {
      throw new ExecError('NOT_FOUND', 'грант исполнителя не найден или отозван', {
        grant_id: grantId,
      });
    }
  } else if (grantId !== undefined) {
    // executor=human с грантом — не «лишнее поле», а рассогласование: тикет читался бы как
    // назначенный агенту одним кодом и человеку другим.
    throw new ExecError('VALIDATION', 'grant_id допустим только при executor=agent', {
      aspect: 'orbis/assignment',
    });
  }
}

/**
 * Ровно один субъект у прогона (V1.4): `orbis/agent-run` несёт ЛИБО `grant_id` (прогон по
 * тикету, работает внешний исполнитель по гранту), ЛИБО `routine_id` (прогон рутины, его
 * породило расписание). Ни одного — прогон-сирота: непонятно, чьей истории он принадлежит и
 * чем откатывается. Оба — прогон читался бы как тикетный одним кодом (rollback по гранту,
 * очередь исполнителя) и как рутинный другим (бухгалтерия бакета, стоп-кран рутины).
 *
 * Схемой это не выражается: `oneOf` спрятал бы оба поля от каталога грамматики (он читает
 * `properties` верхнего уровня), а `.refine` зода исчезает при генерации JSON Schema — ajv
 * стадии 2 проверил бы только формат uuid. Поэтому правило живёт здесь, как и «живой грант в
 * назначении», и обойти его нечем: мутации графа идут только через executor.
 *
 * Функция чистая (БД не нужна) и МОЛЧИТ, когда аспекта прогона в итоговой карте нет: её
 * зовут на всех трёх путях появления аспектов, и правка тикета без прогона — не её дело.
 */
export function assertRunSubject(next: EntityState): void {
  if (!next.aspects.includes('orbis/agent-run')) return;
  // Стадия 2 (валидатор реестра) отрабатывает раньше на всех трёх путях, поэтому здесь поле
  // либо отсутствует, либо содержит uuid-строку: отдельная ветка на null была бы мёртвой.
  // `orbis/grant` слито с назначением (В1) — на прогоне оно и есть «субъект-грант».
  const subjects = [next.props['orbis/grant'], next.props['orbis/run_routine']].filter(
    (v) => v !== undefined,
  );
  if (subjects.length !== 1) {
    throw new ExecError(
      'VALIDATION',
      'у прогона должен быть ровно один субъект: grant_id или routine_id',
      { aspect: 'orbis/agent-run', reason: 'run_subject' },
    );
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
 * записи, рядом с `assertAssignment`. Это единственный рубеж, который нельзя обойти: гейт
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
