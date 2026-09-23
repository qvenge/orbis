// apps/server/src/registry/invariants-golden.test.ts
// ПРИЁМКА §С8-1, ВТОРАЯ ПОЛОВИНА: golden-корпус «сущность → вердикт» ДОМЕННЫХ ИНВАРИАНТОВ (§А7-2).
// Реестровую половину (`validateEntityProps`) держит `validator-golden.test.ts`; здесь — инварианты,
// которые Б-2 переносит из кода в строки каталога правил: «не-шаблон `orbis/financial` обязан нести
// `occurred_on`» (+ его пара про `recurring`) и «вход задачи в `done` ставит `completed_at`, уход —
// снимает» (задача 4), а с задачи 14 — остальные §А7-2: условие гранта назначения, субъект прогона,
// форма правила памяти, умолчание валюты конверта и «чего ждём» (`waiting_for` только в ожидании).
// Каждая запись корпуса прогоняется ЖИВЫМ исполнителем (`execute`) с
// фиксированными часами, а вердикт СТАРОГО кода лежит рядом замороженным литералом `legacy*`.
//
// ПОЧЕМУ СТАРЫЙ ВЕРДИКТ ЗАМОРОЖЕН. Порядок §А7-2 — «тесты-близнецы и golden-корпус на старом и новом
// валидаторе ДО замены»: корпус снят старым кодом (`assertFinancialInvariant`, `applyTaskCompletion`)
// до первой правки инвариантов и записан литералом. Код снесён той же задачей — `legacy*` в дереве
// пересчитать нечем, и это намеренно: значение, которое нельзя пересчитать, нельзя и молча подогнать
// под новый результат. Записи, добавленные ревью после сноса, сняты тем же старым кодом, временно
// возвращённым из базы задачи (`c1d40fe`, сид без правил), — тот же прогон побайтно воспроизвёл
// замороженные `legacy*` прежних записей. Живой вердикт (`verdict`/`code`/`invariant`/`writes`) считается
// прогоном и обязан совпасть с записанным АБСОЛЮТНО — иначе два одинаково сломанных пути прошли бы
// приёмку вдвоём.
//
// ЗАПИСАННОЕ ЗНАЧЕНИЕ — ТОЖЕ ВЕРДИКТ (РЧ-4-2). Половина инвариантов — T-правило, и `ok` о нём не
// говорит ничего: запись обязана нести ещё и то, что исполнитель дописал МИМО входа. `writes` —
// `orbis/completed_at` (нормализован: равен штампу строки — `'$updatedAt'`, нет значения — `null`,
// иначе литерал) плюс сам штамп строки под ключом `$updatedAt` и свойства `watch` записи (`waiting_for`,
// `currency` — задача 14). Часы фиксированы (`T0`), id не пишутся; гранты — метками `$grant`.
//
// КАК ПЕРЕСДАВАТЬ. `legacy*` не трогается НИКОГДА — он про мёртвый код. Меняется только живой
// вердикт: посчитать прогоном, вписать и ОБЪЯСНИТЬ каждое расхождение со старым причиной из закрытого
// списка `EXPECTED_DIFFS` (с числом записей на причине). Числа состава (`CORPUS_SIZE`,
// `NEGATIVE_RECORDS`) двигаются тем же коммитом. Каждое НЕ перечисленное расхождение — дефект
// перевода инварианта в декларацию, а не повод дописать строку в список.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { attachToolName, canonicalJson, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import corpus from '../../test/golden/invariants-verdicts.json';
import {
  adminDb,
  appDb,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
  truncateAll,
} from '../../test/helpers';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../executor/types';
import { issuePatGrant, revokeGrant, verifyBearer } from '../oauth/grants';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

type Verdict = 'ok' | 'reject';
interface GoldenRecord {
  name: string;
  /** Путь записи: одиночный create, пачка со связью, правка, навешивание аспекта. */
  shape: 'create' | 'batch' | 'update' | 'attach';
  /**
   * Аспекты записи. У `attach` — ОДИН аспект, который навешивается вторым ходом (первый ход заводит
   * запись без аспектов, со свойствами `props`).
   */
  aspects: string[];
  props: Record<string, unknown>;
  /** Второй ход для shape update (свойства правки) / attach (`data` тула). */
  patch?: Record<string, unknown>;
  /**
   * Связи. У `update` — существуют ДО второго хода (источник «template» заводит фикстура, ребро —
   * исполнитель механизмом `seed`: роль `instance-of` — `created_by: system`); у `batch` — объявлены
   * той же пачкой ПОСЛЕ `entity_create`. `sourceArchived` — шаблон-источник убран в архив до записи.
   * `deletedBy: 'batch'` — ребро снимает та же пачка, что пишет запись: у `batch` — после объявления
   * (создано и удалено пачкой), у `update` второй ход становится пачкой `[relation_delete, entity_update]`
   * (ребро из БД снято более ранней операцией пачки).
   */
  relations?: Array<{
    role: string;
    from: 'template';
    sourceArchived?: boolean;
    deletedBy?: 'batch';
  }>;
  /**
   * Аспекты ПЕРВОГО хода, когда они не те, что у записи: у `attach` по умолчанию `[]`, у `update` —
   * `aspects`. Нужны записи «повторное навешивание»: запись рождается с аспектом, фикстура его снимает.
   */
  firstAspects?: string[];
  /**
   * Правки исполнителем между первым и вторым ходом — входы `entity_update` без `id` (снять свойство,
   * снять аспект). Каждая обязана пройти: это обстановка, а не вердикт.
   */
  setup?: Array<Record<string, unknown>>;
  /** Поля второго хода `entity_update` сверх свойств и ядра — `aspects: {attach|detach}`. */
  update?: Record<string, unknown>;
  /**
   * Нарушитель, записанный ДО правила: после первого хода эти свойства снимаются у строки прямой
   * записью в БД (админ-DSN) — так в графе оказывается запись, которую исполнитель сегодня завести
   * не дал бы (импорт до инварианта, строка, заведённая при выключенном правиле).
   */
  rowWithout?: string[];
  /** Второй ход shape update — правка ЯДРА без свойств (`archived`/`title`), рулинг 3-4. */
  core?: { archived?: boolean; title?: string };
  /**
   * Нарушитель с ЛИШНИМ значением: после первого хода эти свойства кладутся строке прямой записью
   * (админ-DSN) — пара к `rowWithout` для инвариантов вида «свойство запрещено» (хвост, заведённый до
   * правила).
   */
  rowWith?: Record<string, unknown>;
  /**
   * Механизм обоих ходов записи. Прогон пишет глагол исполнителя (§А4-4): его свойства
   * `system_writable` (§А2-5), и владельческий механизм получил бы `COMPUTED_WRITE` раньше инварианта.
   */
  mechanism?: 'verb';
  /**
   * Свойства, которые исполнитель дописывает или снимает МИМО входа, сверх общего `completed_at`
   * (РЧ-4-2), — у ЭТОЙ записи: `waiting_for` (снятие уходом из ожидания), `currency` (умолчание
   * конверта). Список на запись, а не общий: общий добавил бы ключ в замороженные `legacyWrites`
   * прежних записей, а их трогать нельзя.
   */
  watch?: string[];
  /**
   * Код ПЕРВОГО нарушения стадии 2 (`details.violations[0].code`) — различает два `VALIDATION` с
   * разными причинами (граница типа против условия формы, РЧ-14-2). Сверяется только у записей, где
   * он снят старым кодом: прежние записи его не несут и не должны.
   */
  legacyViolation?: string;
  violation?: string;
  /** Замороженный вердикт СТАРОГО кода (снят шагом 2, пересчитать нечем). */
  legacyVerdict: Verdict;
  legacyCode?: string;
  legacyInvariant?: string;
  legacyWrites?: Record<string, string | null>;
  /** Живой вердикт: считается прогоном и обязан совпасть. */
  verdict: Verdict;
  code?: string;
  invariant?: string;
  writes?: Record<string, string | null>;
  expectedDiff?: string;
}

/** Исход одной записи — то, что прогон кладёт рядом с корпусом. */
interface Outcome {
  verdict: Verdict;
  code?: string;
  invariant?: string;
  writes?: Record<string, string | null>;
  violation?: string;
}

/**
 * Законные расхождения живого вердикта со старым — закрытый список; `records` — СКОЛЬКО записей стоит
 * на причине, точно (без числа из двух записей одну можно было бы молча вернуть к старому).
 */
const EXPECTED_DIFFS: Record<string, { records: number }> = {
  // РЧ-3-3 (Р-К-12): присутствие значения — ОДНО правило на движок и интерпретатор, «не `undefined` и
  // не `null`»; им живёт и «свойство ещё не задано» у `on_enter_class.set`. Старый код спрашивал
  // `=== undefined`: явный `completed_at: null` во входе оставался в состоянии, и стадия 2 отвечала
  // `VALIDATION` (`TYPE`: момент обязан быть строкой). Правило видит `null` как «не задано» и ставит
  // штамп записи. Достижимо ТОЛЬКО явным `null` во входе и только у T-правил: они идут до стадии 2, а
  // C-правила — стадией 4, куда `null` не доезжает ни одним путём (записи «occurred_on: null» на
  // create, update и attach — `VALIDATION` у обоих). Прецедент той же семантики в старом коде —
  // подстановка валюты конверта «NULL → умолчание» до валидации. Две записи: create и update (рулинг
  // 4-1 гейта принял причину).
  T_SET_NULL_IS_ABSENT: { records: 2 },
  // Р-И-3 (Р-К-2): значение `on_enter_class` — `{prop:'orbis/updated_at'}`, штамп, который ляжет в
  // колонку этой же операцией; снятый код писал чистый `clock()`. В проде разницы нет (у живого хода
  // часов `monotonicUpdatedAt(now, prev) === now`); с поддельными часами правка и attach в тот же тик
  // дают штамп `T0+1ms` (§5.2). Create в done расхождения не даёт: у него штамп и есть `now`.
  COMPLETED_AT_IS_WRITE_STAMP: { records: 2 },
  // Р-И-14, Р-И-37 (рулинг 4-5): событие `on_enter_class` — ВХОД В КЛАСС, одинаковый на трёх путях;
  // класс считается по `entityClassOf` до и после записи. Повторное навешивание `orbis/task` на запись,
  // у которой `task_status: done` пережил снятие аспекта (Р9), а `completed_at` нет, — вход: до записи
  // привязки нет и класса нет, после — `done`; правило ставит штамп. Снятый код его не ставил по
  // признакам пути, а не по смыслу: у update закрыт гейт «патч тронул `task_status`», у attach —
  // `prevStatus === 'done'` по уцелевшему значению. Записи — update (`aspects.attach`) и
  // `attach_orbis_task`.
  ENTER_IS_CLASS_EVENT: { records: 2 },
  // Р-И-7 «БД ∪ виртуальные − удалённые», Р-К-46 (рулинг 4-6): итог пачки по рёбрам не содержит ребра,
  // которое пачка создала и сама же сняла, — после коммита его в графе нет. Старый узкий пре-пасс
  // (`instance-of`) удалённое пачкой не вычитал и легитимировал `recurring` ребром, которого не
  // осталось.
  BATCH_DELETE_SUBTRACTS_DECLARED: { records: 1 },
  // В-П-8 (в), задача 14: «вопрос вне ожидания» прежде был ЗАКОННОЙ записью — старый код инварианта не
  // держал вовсе, а три копии `unset` на выходах глаголов (`verbs.ts` `orbis_finish`, `sweep.ts`,
  // `routers/agent-run.ts`) подчищали хвост за собой. Теперь это отказ строки
  // `waiting_for_only_when_waiting`: новый вердикт СТРОЖЕ старого по самому вердикту (`ok` → `reject`).
  // Записи — тикет в работе с вопросом и вариант вне классов делегируемости (`cancelled`).
  WAITING_FOR_ONLY_WHEN_WAITING: { records: 2 },
  // В-П-8 (в): уход из класса `waiting` снимает вопрос ПРАВИЛОМ (`waiting_for`, `on_leave.unset`) на
  // любой записи, а не только в трёх глаголах сервера: правка владельца `waiting → planned` и
  // `waiting → done` прежде оставляла вопрос на записи (старый код этих путей не касался).
  WAITING_FOR_UNSET_ON_LEAVE: { records: 2 },
  // Перенос C-3 (вехи I): снятие аспекта `orbis/task` уходом из класса не считается (область правил —
  // аспект, именованный остаток `applyTransitionRules`), вопрос и статус переживают `detach` (Р9), а
  // повторное навешивание ПРАВКОЙ в статус вне ожидания — отказ той же записи: до записи привязки нет и
  // класса нет, ухода нет, и хвост доходит до `forbidden_when`. Прежде запись ложилась с хвостом.
  // Навешивание тулом `attach_orbis_task` расхождения не даёт — носитель заменяется целиком у обоих.
  WAITING_FOR_REATTACH_OUTSIDE_WAITING: { records: 1 },
  // Перенос задачи 3 (решение координатора (а)): C-правила зовутся на КАЖДОЙ правке свойств записи, а
  // не только когда патч тронул носитель, — нарушение, лёгшее в граф до правила (строка при выключенном
  // правиле, импорт, данные до среза), всплывает на первой же ПОСТОРОННЕЙ правке свойств. Старый код
  // спрашивал инвариант по признаку пути (`touched.includes('orbis/assignment')` у назначения), а хвоста
  // `waiting_for` не держал вовсе. Правка только ЯДРА (заголовок, архив) нарушения не поднимает: ей
  // достаются лишь правила, читающие изменённое ядро (рулинг 3-4).
  C_RULES_ON_EVERY_PROPS_EDIT: { records: 2 },
  // §4-Б-9 рамки, задача 14: снятый код субъекта прогона бросал ОДИН `VALIDATION reason:'run_subject'`
  // на обе половины XOR; каталог различает «нужен субъект» (`run_subject`) и «субъектов два»
  // (`run_subject_forbidden`) — `INVARIANT` стадии 4 с id правила.
  RUN_SUBJECT_SPLIT: { records: 2 },
  // §А7-2 ревизии 4 (наполовину), задача 14: снятый код назначения бросал `VALIDATION` на обе половины
  // условия над `props` («agent без гранта», «грант при не-agent»); теперь это строки каталога
  // `assignment_grant_required`/`_forbidden` — `INVARIANT` стадии 4. Живость гранта (`NOT_FOUND`)
  // расхождением НЕ является: она осталась кодом (`assertGrantAlive`), и запись «отозванный грант»
  // совпадает со старым вердиктом.
  ASSIGNMENT_GRANT_CONDITION: { records: 2 },
  // Задача 14: форма правила памяти была ВТОРЫМ списком стадии 2 (`VALIDATION`, нарушения
  // `RULE_WITHOUT_PATTERN`/`RULE_WITHOUT_TARGET`) и стала двумя строками каталога стадии 4
  // (`memory_rule_pattern`/`memory_rule_target` — `INVARIANT` с id правила). Третья запись — снятый
  // аспект памяти: область строк — признак в `props` (`scope: {property: 'orbis/memory_kind'}`), и
  // отказ остаётся отказом, как у снятого кода, смотревшего только на `props` (Р9).
  MEMORY_RULE_FORM: { records: 3 },
  // РЧ-14-2: пробельный образец остаётся `VALIDATION`, но нарушением ТИПА `orbis/rule_pattern`
  // (`minLength: 1`, `pattern: '\S'` — граница формы), а не `RULE_WITHOUT_PATTERN`: код тот же, имя
  // нарушения другое (`violation` записи).
  MEMORY_PATTERN_BLANK: { records: 1 },
};

/**
 * Состав — два числа точные (равенство, а не порог: молча выкинутая запись обязана красить приёмку).
 * Одиннадцать записей — таблица задачи 4 (по две на каждую ветку инварианта и по одной на путь записи
 * штампа); семь — переносы ревью задачи 3: пачка с ребром ЧУЖОЙ роли (общий пре-пасс по ролям
 * не должен легитимировать `recurring`), нарушитель под правкой ядра и под правкой свойства (C-правила
 * на `entity_update` — Ф-Б2-17, рулинг 3-4) и четыре пробы явного `null` на трёх путях записи (движок
 * считает `null` отсутствием, старый код — `=== undefined`); десять — фикс-раунд 1 гейта задачи 4:
 * ветки, эквивалентные старому коду только по чтению (`schedule` без `recurrence`, `recurring: false`,
 * снятие `orbis/schedule` правкой, ребро БД, снятое ранней операцией пачки, архивный источник
 * `instance-of`, явный `completed_at` при входе в `done`, `null` на update), повторное навешивание
 * `orbis/task` на двух путях (I-1) и ребро, созданное и снятое пачкой (I-2). `legacy*` новых записей
 * снят старым кодом (исходники `c1d40fe` и сид без правил) тем же прогоном, что воспроизвёл замороженные
 * `legacy*` первых восемнадцати побайтно.
 *
 * Двадцать восемь — задача 14 (остальные инварианты §А7-2): назначение (шесть — обе половины условия,
 * два законных позитива, отозванный грант, нарушитель под посторонней правкой), субъект прогона
 * (четыре), форма правила памяти (шесть — включая пробельный образец и снятый аспект памяти), умолчание
 * валюты конверта (три) и «чего ждём» (девять — включая снятие и повторное навешивание `orbis/task`).
 * `legacy*` сняты ЖИВЫМ старым кодом на базе задачи (`ce9f4d5`: код условия гранта, субъекта прогона,
 * формы правила памяти, умолчания валюты и три копии `unset` ещё в дереве) ДО первой правки
 * инвариантов — тем же прогоном, в котором прежние двадцать восемь записей совпали побайтно.
 */
const CORPUS_SIZE = 56;
const NEGATIVE_RECORDS = 27;

// `as unknown` — TS выводит из литерального JSON союз объектов с `field?: undefined`, несравнимый с
// объявленной формой; форму и состав корпуса стережёт тест состава, а не компилятор.
const records = corpus.records as unknown as GoldenRecord[];

const owner = mintGraph();
const T0 = new Date('2026-07-04T10:00:00.000Z');
/** Цель ссылки `orbis/finance_category`: категорию под этим id заводит фикстурный исполнитель. */
const CATEGORY_REF = '019e4466-b4b4-7e07-b5d4-64be9721da51';
/** Шаблон повторения — источник рёбер `instance-of` (и чужой роли) в записях со связями. */
const TEMPLATE_PROPS = {
  'orbis/amount': '500.00',
  'orbis/direction': 'expense',
  'orbis/finance_category': CATEGORY_REF,
  'orbis/recurring': true,
  'orbis/start_at': '2026-07-01T10:00:00+03:00',
  'orbis/recurrence': { freq: 'monthly', interval: 1 },
};
/** Свойства, которые исполнитель дописывает МИМО входа (РЧ-4-2). */
const WRITTEN_PAST_INPUT = ['orbis/completed_at'] as const;

function req(operations: ExecuteRequest['operations'], over: Partial<ExecuteRequest> = {}) {
  return {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'fast_path',
    operations,
    clock: () => T0,
    ...over,
  } satisfies ExecuteRequest;
}
const run = (tool: string, input: unknown, over: Partial<ExecuteRequest> = {}) =>
  execute(db, req([{ tool, input }], over));
/** Ход фикстуры обязан пройти: его отказ — дефект обвязки, а не вердикт записи. */
function entityOf(r: ExecuteResult, what: string): WireEntity {
  if (!r.ok) throw new Error(`фикстура «${what}»: отказ ${JSON.stringify(r.error)}`);
  return r.results[0] as WireEntity;
}

/** Литерал записанного значения: равен штампу строки — `'$updatedAt'`, нет — `null`. */
function writesOf(e: WireEntity, watch: readonly string[] = []): Record<string, string | null> {
  const out: Record<string, string | null> = { $updatedAt: e.updatedAt };
  for (const propertyId of [...WRITTEN_PAST_INPUT, ...watch]) {
    const value = e.props[propertyId];
    out[propertyId] =
      value === undefined ? null : value === e.updatedAt ? '$updatedAt' : String(value);
  }
  return out;
}
/** Исход хода; `at` — номер операции пачки, чью запись читать (у одиночного хода — 0). */
function outcomeOf(r: ExecuteResult, at = 0, watch: readonly string[] = []): Outcome {
  if (r.ok) return { verdict: 'ok', writes: writesOf(r.results[at] as WireEntity, watch) };
  const details = (r.error.details ?? {}) as Record<string, unknown>;
  const invariant = typeof details.invariant === 'string' ? details.invariant : undefined;
  const first = Array.isArray(details.violations)
    ? (details.violations[0] as { code?: unknown } | undefined)
    : undefined;
  return {
    verdict: 'reject',
    code: r.error.code,
    ...(invariant !== undefined && { invariant }),
    ...(typeof first?.code === 'string' && { violation: first.code }),
  };
}

/**
 * Живые гранты владельца корпуса: `orbis/grant` назначения обязан указывать на НЕОТОЗВАННЫЙ грант
 * (`assertGrantAlive`, Р-К-17), и литерала uuid для него в корпусе быть не может. Записи несут метки
 * `"$grant"` (живой) и `"$revokedGrant"` (отозванный) — их подставляет `resolved` перед ходом.
 */
const GRANTS = { live: '', revoked: '' };
async function issueGrant(label: string): Promise<string> {
  const token = await issuePatGrant(db, { identity: personal(owner), label });
  const identity = await verifyBearer(db, token);
  if (identity === null) throw new Error(`грант «${label}» не выдан`);
  return identity.grantId;
}
function resolved<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll('"$grant"', JSON.stringify(GRANTS.live))
      .replaceAll('"$revokedGrant"', JSON.stringify(GRANTS.revoked)),
  ) as T;
}

async function template(name: string): Promise<string> {
  const created = await run('entity_create', {
    title: `Шаблон: ${name}`,
    tags: [],
    props: TEMPLATE_PROPS,
    aspects: ['orbis/financial', 'orbis/schedule'],
  });
  return entityOf(created, `шаблон для «${name}»`).id;
}

/** Источник ребра — в архив (правка ядра исполнителем): ребро живёт, источник не `alive`. */
async function archive(id: string, what: string): Promise<void> {
  entityOf(await run('entity_update', { id, archived: true }), `архив: ${what}`);
}

/** Строка без названных свойств — прямой записью (нарушитель, заведённый до правила). */
async function stripRow(entityId: string, propertyIds: readonly string[]): Promise<void> {
  const { db: adb, client: ac } = adminDb();
  try {
    for (const propertyId of propertyIds) {
      await adb.execute(
        sql`UPDATE entities SET props = props - ${propertyId}::text WHERE id = ${entityId}::uuid`,
      );
    }
  } finally {
    await ac.end();
  }
}

/** Строка с лишними свойствами — прямой записью (хвост, заведённый до правила). */
async function stuffRow(entityId: string, props: Record<string, unknown>): Promise<void> {
  const { db: adb, client: ac } = adminDb();
  try {
    await adb.execute(
      sql`UPDATE entities SET props = props || ${JSON.stringify(props)}::jsonb WHERE id = ${entityId}::uuid`,
    );
  } finally {
    await ac.end();
  }
}

/** Прогон одной записи по её пути; первый ход фикстуры обязан пройти. */
async function take(raw: GoldenRecord): Promise<Outcome> {
  const record = resolved(raw);
  const title = record.name;
  const watch = record.watch ?? [];
  /** Ход записи — механизмом записи (`mechanism`), если он назван; обвязка (шаблоны, рёбра) — своим. */
  const go = (tool: string, input: unknown) =>
    run(tool, input, record.mechanism === undefined ? {} : { mechanism: record.mechanism });
  if (record.shape === 'create') {
    return outcomeOf(
      await go('entity_create', {
        title,
        tags: [],
        props: record.props,
        aspects: record.aspects,
      }),
      0,
      watch,
    );
  }
  if (record.shape === 'batch') {
    const id = newId();
    const operations: ExecuteRequest['operations'] = [
      {
        tool: 'entity_create',
        input: { id, title, tags: [], props: record.props, aspects: record.aspects },
      },
    ];
    for (const rel of record.relations ?? []) {
      const edge = { source_id: await template(title), target_id: id, role: rel.role };
      if (rel.sourceArchived === true) await archive(edge.source_id, title);
      operations.push({ tool: 'relation_create', input: edge });
      if (rel.deletedBy === 'batch') operations.push({ tool: 'relation_delete', input: edge });
    }
    return outcomeOf(
      await execute(db, req(operations, { batchId: newId(), mechanism: 'seed', source: 'chat' })),
      0,
      watch,
    );
  }
  const first = entityOf(
    await go('entity_create', {
      title,
      tags: [],
      props: record.props,
      aspects: record.firstAspects ?? (record.shape === 'attach' ? [] : record.aspects),
    }),
    title,
  );
  for (const step of record.setup ?? []) {
    entityOf(await go('entity_update', { id: first.id, ...step }), `${title}: обстановка`);
  }
  /** Рёбра из БД, которые снимает сама пачка второго хода (`deletedBy: 'batch'`). */
  const deletedInBatch: Array<Record<string, string>> = [];
  for (const rel of record.relations ?? []) {
    const edge = { source_id: await template(title), target_id: first.id, role: rel.role };
    const linked = await run('relation_create', edge, { mechanism: 'seed' });
    if (!linked.ok) throw new Error(`фикстура «${title}»: ребро ${JSON.stringify(linked.error)}`);
    if (rel.sourceArchived === true) await archive(edge.source_id, title);
    if (rel.deletedBy === 'batch') deletedInBatch.push(edge);
  }
  if (record.rowWithout !== undefined) await stripRow(first.id, record.rowWithout);
  if (record.rowWith !== undefined) await stuffRow(first.id, record.rowWith);
  if (record.shape === 'attach') {
    const aspect = record.aspects[0];
    if (aspect === undefined || record.aspects.length !== 1) {
      throw new Error(`запись «${title}»: attach навешивает ровно один аспект`);
    }
    return outcomeOf(
      await go(attachToolName(aspect), { entity_id: first.id, data: record.patch ?? {} }),
      0,
      watch,
    );
  }
  const move = {
    id: first.id,
    ...(record.patch !== undefined && { props: record.patch }),
    ...record.core,
    ...record.update,
  };
  if (deletedInBatch.length === 0) return outcomeOf(await go('entity_update', move), 0, watch);
  const operations: ExecuteRequest['operations'] = [
    ...deletedInBatch.map((input) => ({ tool: 'relation_delete', input })),
    { tool: 'entity_update', input: move },
  ];
  return outcomeOf(
    await execute(db, req(operations, { batchId: newId(), mechanism: 'seed', source: 'chat' })),
    operations.length - 1,
    watch,
  );
}

const collected = new Map<string, Outcome>();
function taken(name: string): Outcome {
  const outcome = collected.get(name);
  if (outcome === undefined) throw new Error(`запись «${name}» не прогонялась`);
  return outcome;
}

beforeAll(async () => {
  await truncateAll();
  GRANTS.live = await issueGrant('корпус инвариантов: живой');
  GRANTS.revoked = await issueGrant('корпус инвариантов: отозванный');
  await revokeGrant(db, { graphId: owner, grantId: GRANTS.revoked });
  for (const record of records) collected.set(record.name, await take(record));
});

describe('golden «сущность → вердикт» доменных инвариантов (§А7-2, приёмка §С8-1)', () => {
  test('вердикт, код и записанные значения совпадают с корпусом; расхождения со старым — только перечисленные', () => {
    const wrong: string[] = [];
    for (const record of records) {
      const live = taken(record.name);
      if (
        `${live.verdict}/${live.code ?? ''}/${live.invariant ?? ''}` !==
        `${record.verdict}/${record.code ?? ''}/${record.invariant ?? ''}`
      ) {
        wrong.push(`${record.name}: живой ${live.verdict}/${live.code}/${live.invariant}`);
      }
      if (canonicalJson(live.writes ?? null) !== canonicalJson(record.writes ?? null)) {
        wrong.push(`${record.name}: записано ${canonicalJson(live.writes ?? null)}`);
      }
      // Код нарушения стадии 2 — только у записей, где его снял старый код (`legacyViolation`).
      const tracksViolation = record.legacyViolation !== undefined;
      if (tracksViolation && live.violation !== record.violation) {
        wrong.push(`${record.name}: нарушение ${live.violation ?? '-'}`);
      }
      const same =
        record.legacyVerdict === record.verdict &&
        record.legacyCode === record.code &&
        record.legacyInvariant === record.invariant &&
        (!tracksViolation || record.legacyViolation === record.violation) &&
        canonicalJson(record.legacyWrites ?? null) === canonicalJson(record.writes ?? null);
      if (!same && record.expectedDiff === undefined) {
        wrong.push(`${record.name}: расхождение без expectedDiff`);
      }
      if (same && record.expectedDiff !== undefined) {
        wrong.push(`${record.name}: expectedDiff при совпадении`);
      }
      if (record.expectedDiff !== undefined && EXPECTED_DIFFS[record.expectedDiff] === undefined) {
        wrong.push(`${record.name}: причина вне закрытого списка`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('состав корпуса точный: размер, отказы, уникальность имён и число записей на причине', () => {
    expect(records.length).toBe(CORPUS_SIZE);
    expect(records.filter((r) => r.verdict === 'reject').length).toBe(NEGATIVE_RECORDS);
    expect(new Set(records.map((r) => r.name)).size).toBe(CORPUS_SIZE);
    const perCause: Record<string, number> = {};
    for (const record of records) {
      if (record.expectedDiff === undefined) continue;
      perCause[record.expectedDiff] = (perCause[record.expectedDiff] ?? 0) + 1;
    }
    expect(perCause).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_DIFFS).map(([cause, d]) => [cause, d.records])),
    );
  });
});
