// apps/server/src/executor/invariants.ts
// Доменные инварианты стадии 4 — всё ДО первой записи: те инварианты аспектов, которым нужна
// БД (живой грант в назначении, С4/С7), и запреты по объекту для источника `routine`.
// Чистые нормализации аспектов без обращения к БД живут в normalize.ts.
//
// Ролевой слой графа (идентичность ребра, `acyclic`, `target_max_incoming`, `created_by`,
// уникальность) переехал в `relations.ts` вместе с реформой §А4-3: там он один механизм с
// параметром из реестра, здесь был бы набором доменных правил с зашитыми значениями.
import { extensionName, type GraphId, isExtensionEnabled } from '@orbis/shared';
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
 * Запись в выключенное расширение (§Б8-3): создание и навешивание его аспекта — нет. Отказ по
 * ОБЪЕКТУ, как COMPUTED_WRITE: повторять с другим значением бессмысленно — потому у
 * `MODULE_DISABLED` и стоит 403 в `TRPC_CODE_BY_EXEC`.
 *
 * `aspects` — только ДОБАВЛЯЕМЫЕ аспекты, а не итоговое состояние: правку существующей записи
 * стережёт соседний гейт полей (`assertExtensionPropsWritable`), а этот — появление аспекта.
 * Появление аспекта на готовой записи (attach, `aspects.attach`) — то же создание его носителя,
 * поэтому причина одна на три пути: `create`.
 *
 * `mechanism` — вторая ось того же вопроса «чья это запись»: см. ветку `materialize` ниже.
 */
export function assertExtensionEnabled(
  reg: RegistrySnapshot,
  disabled: readonly string[],
  mechanism: MutationMechanism,
  aspects: readonly string[],
): void {
  if (disabled.length === 0) return; // общий путь — без единого обращения к реестру
  // МАТЕРИАЛИЗАЦИЯ — НЕ СОЗДАНИЕ (Ф-Б1-57а): инстанс повторяющегося рождает сервер как
  // СЛЕДСТВИЕ уже существующего шаблона владельца. С 1б (Р-23 п. 4.3) шаблон выключенного
  // расширения до исполнителя не доходит вовсе — его отсеивает фаза чтения материализации
  // (`recurring/materialize.ts`), без отказа и без warn. Льгота здесь осталась на одно окно —
  // гонку маски: выключение, случившееся между фазой чтения материализации и исполнителем, не
  // превращает уже отобранный шаблон в warn и отказ посреди выборки владельца; следующая выборка
  // его уже не отберёт. ЛЬГОТА ЕДИНСТВЕННАЯ: любой будущий механизм
  // (`MutationMechanism`, executor/types.ts) обязан быть отнесён к гейту ЯВНО — по умолчанию
  // он гейтится, и это правило, а не забывчивость (ре-ревью задачи 17). Post-due пишет тем же
  // механизмом, но закрыт СВОИМ гейтом в начале `postDueInstances` (Д-2): льгота по механизму
  // открыла бы ему правку плановых операций выключенных Финансов.
  if (mechanism === 'materialize') return;
  for (const id of aspects) {
    const module = reg.aspects.get(id)?.module ?? null;
    if (isExtensionEnabled(module, disabled)) continue;
    // Имя кода отказа и поле `module` деталей — провод (РП-10); текст говорит «расширение».
    // `extension` и `reason` — провод 1б (задачи 22–23 рисуют плашку по ним).
    throw new ExecError(
      'MODULE_DISABLED',
      `расширение «${extensionName(module ?? '')}» выключено: аспект «${id}» не навешивается (§Б8-3)`,
      { module, extension: module, aspect: id, reason: 'create' },
    );
  }
}

/**
 * ПОЛЯ ВЫКЛЮЧЕННОГО РАСШИРЕНИЯ — ТОЛЬКО ЧТЕНИЕ (§Б8-3 ревизия 7, Р-28 п. 3; перерешает прежнюю
 * редакцию «правка существующей записи разрешена» и рулинг Ф-34). Для ВСЕХ акторов — владельца в
 * интерфейсе, агента, MCP, пачки: гейт стоит в исполнителе, через который идёт каждая из этих
 * дорог. Проверяются свойства, которые патч РЕАЛЬНО меняет (`propsWrittenBy` исполнителя: `set`
 * всегда, `unset`/`replaced` — только при значении на записи; снятие отсутствующего — не запись),
 * и модуль свойства читается из его строки реестра — стандартные свойства ядра (сумма, валюта, направление, дата —
 * `module: null` с задачи 5) правятся как обычно, даже на записи с аспектом расширения.
 *
 * ЛЬГОТЫ — три, и каждая стоит по своей причине:
 *  • правила — СТРУКТУРНО: T-правила пишут в `state.props`, а не в `propsPatch`, и гейт их не
 *    видит по построению; движок предков (`executor/ancestors.ts`) пишет SQL мимо патча;
 *  • Undo — СТРУКТУРНО: вызов стоит внутри блока `internalUndo === undefined` (Ф-1б-18), откат
 *    восстанавливает своё же законно записанное состояние;
 *  • догонка материализации — механизмом `materialize`: инстанс ОТОБРАННОГО шаблона — следствие
 *    правила владельца, а не правка (Р-28 п. 4); шаблоны выключенного расширения отсеивает фаза
 *    чтения материализации, и льгота работает только на гонке маски (докблок
 *    `assertExtensionEnabled`). Post-due пишет тем же механизмом и закрыт своим гейтом (Д-2).
 *
 * СТРУКТУРНЫЕ СЛЕДСТВИЯ РАЗРЕШЁННОЙ ПРАВКИ ЯДРА (рулинг R-10) — того же рода, что T-правила, и
 * гейт их не глушит намеренно:
 *  • `dropStaleCarryover` (`executor/normalize.ts`) — снимает перенос остатка конверта
 *    (`orbis/carryover`, Финансы) в `state.props`, когда правка ядра (валюта — `module: null`)
 *    сменила идентичность конверта;
 *  • бюджет-хук A4 (`applyBudgetFollowUps`, механизм `hook`) — пишет рёбра `envelope-binding`
 *    (роль языка) и кэш `spent` при правке суммы, даты или архивности финансовой записи.
 * Почему не глушить: оба держат согласованность ведомости с данными, которые владелец вправе
 * править и при выключенных Финансах; заглушённые, они оставили бы перенос остатка чужой
 * идентичности и привязки к конвертам по старым датам — и включение не «вернуло бы всё», а
 * показало бы битую ведомость. Пишут они внутри действия владельца и в его журнале (Р-28 п. 4).
 * Движки-ИНИЦИАТОРЫ (материализация, post-due, рутины, импорт, перенос остатков) — наоборот, не
 * работают: у каждого свой гейт.
 *
 * Правило, а не забывчивость: прочие механизмы (`hook`, `rule`, `seed`, `verb`, `import`) гейтятся
 * по ПАТЧУ — перенос остатков (`rule`) и импорт (`import`) принадлежат выключенным Финансам и
 * писать их поля патчем не вправе; хук патчем полей не пишет (выше — только рёбра и кэш).
 *
 * Снятые аспекты (`removed`) — отдельная причина того же гейта: снять аспект выключенного
 * расширения нельзя (`reason: 'detach'`). Она проверяется РАНЬШЕ полей ради точности ответа:
 * патч, несущий и снятие аспекта, и `unset` его поля, называет владельцу то, что он сделал
 * первым делом, — снятие. Значения свойств `detach` сам НЕ снимает (Р9, `applyPropsPatch`).
 */
export function assertExtensionPropsWritable(
  reg: RegistrySnapshot,
  disabled: readonly string[],
  mechanism: MutationMechanism,
  touched: ReadonlySet<string>,
  removed: readonly string[] = [],
): void {
  if (disabled.length === 0) return; // общий путь — без единого обращения к реестру
  if (mechanism === 'materialize') return;
  for (const id of removed) {
    const module = reg.aspects.get(id)?.module ?? null;
    if (isExtensionEnabled(module, disabled)) continue;
    throw new ExecError(
      'MODULE_DISABLED',
      `расширение «${extensionName(module ?? '')}» выключено: аспект «${id}» не снимается, пока оно выключено (§Б8-3)`,
      { module, extension: module, aspect: id, reason: 'detach' },
    );
  }
  for (const id of touched) {
    const module = reg.properties.get(id)?.module ?? null;
    if (isExtensionEnabled(module, disabled)) continue;
    throw new ExecError(
      'MODULE_DISABLED',
      `поля расширения «${extensionName(module ?? '')}» только для чтения, пока оно выключено (§Б8-3)`,
      { module, extension: module, property: id, reason: 'read_only' },
    );
  }
}

/**
 * НАСТРОЙКА ОПРЕДЕЛЕНИЙ ВЫКЛЮЧЕННОГО РАСШИРЕНИЯ — ОТКАЗ (рулинг R-8; §Б8-3: «определения остаются
 * резолвимыми на чтение … создание нового — запрещено»; спека 1б §8.3 «только чтение для всех
 * акторов»). Операция реестра, ЦЕЛЬ которой — свойство или аспект выключенного расширения, пишет
 * его поле мимо трёх точек записи: слияние `property_merge` переносит значения в свойство
 * расширения прямо в строках записей, а правило, заведённое на его носитель или свойство, пишет
 * поле льготой правил на ближайшей правке ядра. Причина провода — `registry`.
 *
 * Классификация операций реестра (`registry/ops.ts`, дисп. исполнителя) — у вызывающих:
 *  • ГЕЙТ: `property_merge` (source и into), `property_update` (id), `aspect_delta_set` и
 *    `aspect_implements_set` (аспект), `rule_set` включённого правила (носитель и АДРЕСА ЗАПИСИ
 *    правила — `ruleWriteAddresses`; чтения не гейтятся), `subscription_set` (поверхность — свой отказ в `prepareSubscriptionSet`);
 *  • РАЗРЕШЕНО — снятие и отключение не пишут поля: `rule_remove`, `rule_set` с `enabled: false`,
 *    `aspect_delta_remove`, `aspect_implements_remove`, `subscription_remove`, `action_remove`,
 *    `contract_sets_delta_remove`;
 *  • НЕ ЦЕЛЬ расширения: `property_create`, `aspect_create` (свои строки владельца, `module: null`;
 *    свойство расширения в составе своего аспекта пишется только тулом записи — там его ловит
 *    гейт полей), `action_set` (своё действие; его шаги исполняются через исполнитель под гейтом
 *    полей), `contract_sets_delta_set` (контракты — язык, `module: null`);
 *  • ОТКАТЫ (`*_undo`, `*_restore`) — структурно мимо: вызывающие ставят гейт только вне
 *    внутреннего режима Undo, откат возвращает своё же законно записанное.
 *
 * Свойство адресуется и id, и ключом (тем же правилом, что граница тулов); не найденное в снимке —
 * своё, заведённое пачкой раньше, и расширению не принадлежит.
 */
export function assertRegistryTargetsEnabled(
  reg: RegistrySnapshot,
  disabled: readonly string[],
  operation: string,
  targets: { aspects?: readonly string[]; properties?: readonly string[] },
): void {
  if (disabled.length === 0) return;
  for (const id of targets.aspects ?? []) {
    const module = reg.aspects.get(id)?.module ?? null;
    if (isExtensionEnabled(module, disabled)) continue;
    throw new ExecError(
      'MODULE_DISABLED',
      `расширение «${extensionName(module ?? '')}» выключено: его аспект «${id}» не настраивается операцией «${operation}» (§Б8-3)`,
      { module, extension: module, aspect: id, operation, reason: 'registry' },
    );
  }
  for (const ref of targets.properties ?? []) {
    const def = reg.properties.get(ref) ?? [...reg.properties.values()].find((p) => p.key === ref);
    const module = def?.module ?? null;
    if (isExtensionEnabled(module, disabled)) continue;
    throw new ExecError(
      'MODULE_DISABLED',
      `расширение «${extensionName(module ?? '')}» выключено: его свойство «${def?.id ?? ref}» не настраивается операцией «${operation}» (§Б8-3)`,
      { module, extension: module, property: def?.id ?? ref, operation, reason: 'registry' },
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
