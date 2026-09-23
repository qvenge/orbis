// apps/server/test/gate-b2.test.ts
// ГЕЙТ ВЕХИ I среза Б-2 (рамка §1, §А7-2): два доменных инварианта живут СТРОКАМИ СИДА каталога правил,
// код обоих снесён, тот же шаблон на аспекте владельца даёт то же поведение без строки кода под него, а
// строка с `enabled: false` инвариант выключает. Четыре утверждения ниже задача 0e завела помеченными
// (до задачи 4 все четыре были ложны); все четыре зазеленила задача 4 (строки сида + снос кода;
// сценарий 3 — паритетом с системным близнецом, хотя строки владельца движок обслуживал уже с задачи 3 —
// см. его комментарий), пометки сняла задача 5 — веха I закрыта, и теперь это обычные тесты: красный
// любой из них значит, что инвариант снова держит код или строка сида перестала его держать.
//
// ПОМЕТКА НИГДЕ НЕ НАЗВАНА ПОЛНЫМ ИМЕНЕМ в прозе: сторож «пометок вне списка нет» (`gate-c8-18.test.ts`)
// ищет это имя по `apps`/`packages`/`scripts`, и строка с ним сделала бы сторожа вечно красным.
// ТЕЛА СЦЕНАРИЕВ ОСТАЮТСЯ СИНХРОННЫМИ (ОВ-Б1-1), хотя пометок больше нет: Bun 1.2.7 соблюдает пометку
// только на синхронном теле (тест, вышедший в макрозадачу — любой поход в БД, — её игнорирует), а
// мутационная проверка сторожа пометок (задача 5, шаг 4) возвращает пометку именному сценарию, и на
// асинхронном теле она молча не сработала бы. Поэтому походы собраны в `beforeAll`, тела читают итог.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import type { RuleDefinitionInput } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { StructuredError } from '../src/errors';
import type { ExecuteRequest, ExecuteResult, WireEntity } from '../src/executor/types';
import {
  GATE_FIN_ASPECT,
  GATE_GREP_PATHSPEC,
  GATE_PLAIN_ASPECT,
  GATE_PROPS,
} from './fixtures/gate-aspects';
import {
  adminDb,
  appDb,
  type CustomAspectSpec,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from './helpers';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});

const owner = mintGraph();
const T0 = new Date('2026-07-04T10:00:00.000Z');
/** Цель ссылки встроенной траты: категорию под этим id заводит сам фикстурный исполнитель. */
const FIN_CATEGORY_REF = '019e4466-b2b2-7e07-b5d4-64be9721da51';
/** Встроенная трата БЕЗ `occurred_on`. Свойство в аспекте НЕобязательно (`builtin-aspects.ts:145`),
 *  поэтому запись проходит валидацию значений и упирается именно в доменный инвариант. */
const FIN_PROPS = {
  'orbis/amount': '340.00',
  'orbis/direction': 'expense',
  'orbis/finance_category': FIN_CATEGORY_REF,
};
/** Категория для ссылочного свойства `GATE_PROPS.finCategory`: в карте целей фикстурного исполнителя
 *  (`FIXTURE_REF_TARGET_ASPECT`) этого свойства нет — заводим руками. */
let ownCategoryId = '';

function req(tool: string, input: unknown): ExecuteRequest {
  return {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    clock: () => T0,
  };
}
const run = (tool: string, input: Record<string, unknown>) => execute(db, req(tool, input));
function entityOf(r: ExecuteResult): WireEntity {
  if (!r.ok) throw new Error(`ожидался успех исполнителя, пришёл отказ: ${JSON.stringify(r)}`);
  return r.results[0] as WireEntity;
}
function errorOf(r: ExecuteResult): StructuredError {
  if (r.ok) throw new Error('ожидался отказ исполнителя, пришёл успех');
  return r.error;
}
const mk = async (input: Record<string, unknown>): Promise<WireEntity> =>
  entityOf(await run('entity_create', { tags: [], ...input }));
const setProps = async (id: string, aspect: string, props: Record<string, unknown>) =>
  entityOf(await run('entity_update', { id, props, aspects: { attach: [aspect] } }));

/** Поход к исполнителю: ОШИБКА — тоже результат (образец — `collect` в `gate-c8-18.test.ts`).
 *  Свались `beforeAll` на одном сценарии — остальные перестали бы говорить каждый о своей причине. */
type Collected<T> = { ok: T } | { err: unknown };
async function collect<T>(fn: () => Promise<T>): Promise<Collected<T>> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { err };
  }
}
/** Развернуть собранное СИНХРОННО; ошибку перебрасывает КАК ЕСТЬ — причина провала обязана остаться
 *  настоящей (отказ БД, промах движка). */
function taken<T>(r: Collected<T> | undefined, what: string): T {
  if (r === undefined) throw new Error(`сбор «${what}» не выполнялся`);
  if ('err' in r) throw r.err;
  return r.ok;
}

let sysRequires: Collected<StructuredError>;
let sysTransition: Collected<{ done: WireEntity; back: WireEntity }>;

/** `requires_when` на аспекте владельца: расход обязан нести момент. Свойство-цель —
 *  `GATE_PROPS.finWhen` (timestamp, НЕ обязательное в аспекте): будь оно обязательным, запись
 *  отверг бы валидатор значений стадией 2, и тест зеленел бы, ничего не сказав о правиле. Ровно так
 *  же устроен и встроенный экземпляр: `orbis/occurred_on` в аспекте необязателен
 *  (`builtin-aspects.ts:143-145`). */
const RULE_OWN_REQUIRES_MOMENT: RuleDefinitionInput = {
  id: 'gate_own_requires_moment',
  template: 'requires_when',
  undo: 'check',
  when: { op: '=', args: [{ prop: GATE_PROPS.finDirection }, { const: 'out' }] },
  params: { property: GATE_PROPS.finWhen },
};
/** `on_enter_class` на аспекте владельца: вход слота `status` контракта завершаемости в класс `done`
 *  (вариант `closed` отображён в него привязкой `gate-aspects.ts:160-169`) ставит момент, уход снимает. */
const RULE_OWN_CLOSED_AT: RuleDefinitionInput = {
  id: 'gate_own_closed_at',
  template: 'on_enter_class',
  undo: 'check',
  params: {
    enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
    set: { property: GATE_PROPS.plainAt, value: { prop: 'orbis/updated_at' } },
    on_leave: { unset: [GATE_PROPS.plainAt] },
  },
};
const GATE_FIN_RULED: CustomAspectSpec = { ...GATE_FIN_ASPECT, rules: [RULE_OWN_REQUIRES_MOMENT] };
const GATE_PLAIN_RULED: CustomAspectSpec = { ...GATE_PLAIN_ASPECT, rules: [RULE_OWN_CLOSED_AT] };

let ownRules: Collected<{ refused: StructuredError; closed: WireEntity; reopened: WireEntity }>;

/**
 * Снимок колонки `rules` системной строки аспекта — ТЕКСТОМ jsonb, а не разобранным значением: текст
 * канонический, и запись его обратно (`restoreSystemRules`) возвращает строку ровно такой, какой её
 * положил сид, без круга через JS (числа, порядок ключей) и без лишних ключей.
 */
async function readSystemRules(aspectId: string): Promise<string> {
  const { db: adb, client: ac } = adminDb();
  try {
    const rows = (await adb.execute(sql`SELECT rules::text AS rules FROM aspect_definitions
      WHERE id = ${aspectId} AND graph_id IS NULL`)) as unknown as Array<{ rules: string }>;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) {
      throw new Error(`системной строки ${aspectId} нет — сид не прошёл`);
    }
    return row.rules;
  } finally {
    await ac.end();
  }
}
/**
 * Переписать колонку `rules` системной строки и сдвинуть системную версию реестра — иначе снимок
 * останется в процессном кеше на прежнем ключе (`registry/cache.ts`), и правку никто не увидит.
 * Версия двигается в ОБА направления: и на выключении, и на возврате.
 */
async function writeSystemRules(
  aspectId: string,
  value: SQL,
  requiredRule?: string,
): Promise<void> {
  // `requiredRule` — строка обязана НЕСТИ это правило: иначе UPDATE не трогает ничего, и отказ говорит
  // причину словами, а не выключает несуществующее правило молча (тест 4 тогда красен «ни о чём»).
  const guard =
    requiredRule === undefined
      ? sql``
      : sql` AND rules @> jsonb_build_array(jsonb_build_object('id', ${requiredRule}::text))`;
  const { db: adb, client: ac } = adminDb();
  try {
    const rows = (await adb.execute(sql`UPDATE aspect_definitions SET rules = ${value}
      WHERE id = ${aspectId} AND graph_id IS NULL${guard} RETURNING id`)) as unknown as unknown[];
    if (rows.length !== 1) {
      throw new Error(
        requiredRule === undefined
          ? `системной строки ${aspectId} нет — сид не прошёл`
          : `правила ${requiredRule} в системной строке ${aspectId} нет — строка сида не доехала до базы (пересев: bun run db:prepare)`,
      );
    }
    await adb.execute(sql`UPDATE registry_system SET version = version + 1 WHERE id = 1`);
  } finally {
    await ac.end();
  }
}
/**
 * Выключить одно правило системной строки (`enabled: false`), остальные правила строки — как лежат.
 * `COALESCE`: у строки с `rules = '[]'` (так лежали строки между 0022 и сидом задачи 4) `jsonb_agg` по
 * пустому набору дал бы NULL — непрозрачный отказ NOT NULL вместо «правила нет» (его и так отсекает
 * `requiredRule`).
 */
const disableSystemRule = (aspectId: string, ruleId: string): Promise<void> =>
  writeSystemRules(
    aspectId,
    sql`COALESCE((SELECT jsonb_agg(
           CASE WHEN r->>'id' = ${ruleId} THEN jsonb_set(r, '{enabled}', 'false'::jsonb) ELSE r END)
         FROM jsonb_array_elements(rules) AS r), '[]'::jsonb)`,
    ruleId,
  );
/**
 * Вернуть системную строку к снимку `readSystemRules` КАК БЫЛА. Не «включить обратно»: `jsonb_set(…, true)`
 * оставил бы явный `enabled: true` там, где сид его не писал, и строка разошлась бы с сидом — сверка
 * дрейфа реестра и сид-тесты, идущие в том же процессе после этого файла, увидели бы чужую правку.
 */
const restoreSystemRules = (aspectId: string, snapshot: string): Promise<void> =>
  writeSystemRules(aspectId, sql`${snapshot}::jsonb`);
/** Попытка завести встроенную трату без `occurred_on`: `true` — инвариант молчит, `false` — отказал. */
const finAttempt = async (title: string): Promise<boolean> =>
  (await run('entity_create', { title, tags: [], props: FIN_PROPS, aspects: ['orbis/financial'] }))
    .ok;

let disabled: Collected<{ before: boolean; after: boolean; again: boolean }>;

beforeAll(async () => {
  await truncateAll();
  ownCategoryId = (await mk({ title: 'Категория гейта Б-2', aspects: ['orbis/category'] })).id;

  // Сценарий 1 — `requires_when` §А7-2: не-шаблон `orbis/financial` обязан нести `occurred_on`.
  sysRequires = await collect(async () =>
    errorOf(
      await run('entity_create', {
        title: 'Кофе гейта Б-2',
        tags: [],
        props: FIN_PROPS,
        aspects: ['orbis/financial'],
      }),
    ),
  );

  // Сценарий 2 — `on_enter_class` §А7-2: вход в done ставит `completed_at`, уход снимает.
  sysTransition = await collect(async () => {
    const t = await mk({
      title: 'Задача гейта Б-2',
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    });
    const done = await setProps(t.id, 'orbis/task', { 'orbis/task_status': 'done' });
    const back = await setProps(t.id, 'orbis/task', { 'orbis/task_status': 'planned' });
    return { done, back };
  });

  // Сценарий 3 — те же два шаблона на аспектах владельца. Сев ТОЖЕ внутри `collect`: упади он (так и
  // было до миграции 0022 — колонки `rules` не было), незавёрнутый `seedCustomAspect` уронил бы весь
  // файл вместе с контрольным тестом, а не один сценарий со своей причиной.
  const seeded = await collect(async () => {
    await seedCustomAspect(owner, GATE_FIN_RULED);
    await seedCustomAspect(owner, GATE_PLAIN_RULED);
  });
  ownRules = await collect(async () => {
    taken(seeded, 'сев аспектов владельца со строками правил');
    // Расход СО всеми обязательными полями аспекта, но БЕЗ `GATE_PROPS.finWhen` — упереться он
    // обязан в правило.
    const ownFin = {
      [GATE_PROPS.finAmount]: '340.00',
      [GATE_PROPS.finDirection]: 'out',
      [GATE_PROPS.finCategory]: ownCategoryId,
      [GATE_PROPS.finDate]: '2026-07-04',
    };
    const fin = GATE_FIN_RULED.key;
    const plain = GATE_PLAIN_RULED.key;
    const refused = errorOf(
      await run('entity_create', {
        title: 'Трата гейта Б-2',
        tags: [],
        aspects: [fin],
        props: ownFin,
      }),
    );
    const item = await mk({
      title: 'Дело гейта Б-2',
      aspects: [plain],
      props: { [GATE_PROPS.plainState]: 'open' },
    });
    const closed = await setProps(item.id, plain, { [GATE_PROPS.plainState]: 'closed' });
    const reopened = await setProps(item.id, plain, { [GATE_PROPS.plainState]: 'open' });
    return { refused, closed, reopened };
  });

  // Сценарий 4 — мутация гейта: системная строка правила с `enabled: false` выключает инвариант.
  disabled = await collect(async () => {
    const before = await finAttempt('Мутация гейта: до выключения');
    // Снимок ДО правки: вернуть строку обязаны ровно такой, какой её положил сид (см. `restoreSystemRules`).
    const snapshot = await readSystemRules('orbis/financial');
    let after: boolean;
    try {
      await disableSystemRule('orbis/financial', 'financial_requires_occurred_on');
      after = await finAttempt('Мутация гейта: строка выключена');
    } finally {
      // Возврат — в finally и ПОСЛЕ снимка, даже если выключение упало на полпути: строка одна на всю
      // локальную базу, и оставить её выключенной (или с чужим видом) значит уронить каждый следующий
      // сьют, который трогает финансы или сверяет реестр с сидом.
      await restoreSystemRules('orbis/financial', snapshot);
    }
    return { before, after, again: await finAttempt('Мутация гейта: строка возвращена') };
  });
});

/** Корень репозитория: `bun test` идёт из `apps/server`, а pathspec'ы git отсчитываются от cwd.
 *  `repoRoot`/`gitGrep` — тот же способ звать git из сьюта, что в `gate-c8-18.test.ts`; копия, а не
 *  импорт: импорт соседнего файла тестов зарегистрировал бы его тесты второй раз в этом прогоне. */
function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gate-b2: git rev-parse упал: ${r.stderr}`);
  return r.stdout.trim();
}
function gitGrep(pattern: string, pathspec: readonly string[]): string[] {
  const r = spawnSync('git', ['grep', '-n', '-a', '-P', '-e', pattern, '--', ...pathspec], {
    cwd: repoRoot(),
    encoding: 'utf8',
  });
  // 0 — есть совпадения, 1 — нет, >1 — ошибка (нет PCRE2). Ошибку нельзя принять за «чисто»:
  // молчащий гейт хуже отсутствующего (тот же разбор — `check-legacy-form.ts`, разбор кода выхода).
  if (r.status !== null && r.status > 1)
    throw new Error(`gate-b2: git grep код ${r.status}: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

// `GATE_B2_GREP_NAMES` (семь имён), `GATE_B2_GREP_PATTERN`, `GATE_B2_GREP_PATHSPEC`, `GATE_B2_GREP_ALLOWED`
// объявлены задачей 0e в конце ЭТОГО файла — здесь только правило комментария.
/** Где имена снесённого законны: сам гейт (он их НАЗЫВАЕТ — в этом его работа) и строки-комментарии,
 *  объясняющие снятое. Правило комментария — то же и по тому же доводу, что у `COMMENT_ONLY_LINE`
 *  (`scripts/check-legacy-form.ts`): объяснять удалённое надо ТАМ, ГДЕ ЕГО БОЛЬШЕ НЕТ, а запрет
 *  называть снятое по имени сделал бы докблоки лживыми. Имя, вернувшееся В КОД, маркер ловит. */
const COMMENT_ONLY_LINE = /^\s*(?:\/\/|\*|\/\*|--)/;

describe('гейт вехи I: инвариант только декларацией', () => {
  // ЗЕЛЁНЫЙ И ДО, И ПОСЛЕ ВЕХИ I — сторож против тавтологии: пока сценарии ниже были помечены, снеси
  // задача 4 код, а строка сида промолчи, помеченные тесты остались бы красными (то есть «пройденными»),
  // и срез уехал бы с выключенными инвариантами. Здесь проверяется только то, что меняться НЕ должно:
  // отказ и штамп завершения есть — чьим бы механизмом они ни шли.
  test('контроль: инвариант держится — отказ по occurred_on и штамп завершения не пропали', () => {
    const e = taken(sysRequires, 'financial без occurred_on');
    expect(e.code).toBe('INVARIANT');
    expect((e.details as Record<string, unknown>).invariant).toBe('financial_requires_occurred_on');
    const { done, back } = taken(sysTransition, 'задача в done и обратно');
    expect(typeof done.props['orbis/completed_at']).toBe('string');
    expect('orbis/completed_at' in back.props).toBe(false);
  });

  // Греп-доказательство вехи I (задача 5) — СТОРОЖЕМ в сьюте, а не разовой командой: имя снесённого
  // кода, вернувшееся в код, краснит прогон с адресом строки. Тело синхронное, как у сценариев.
  test('кода под два инварианта §А7-2 в дереве нет: только гейт и объяснения снятого', () => {
    const hits = gitGrep(GATE_B2_GREP_PATTERN, [...GATE_B2_GREP_PATHSPEC]); // те же пути, что у команды 0e
    const offenders = hits.filter((line) => {
      const path = line.slice(0, line.indexOf(':'));
      if (GATE_B2_GREP_ALLOWED.includes(path)) return false;
      return !COMMENT_ONLY_LINE.test(line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1));
    });
    expect(offenders).toEqual([]);
    // Гейт обязан совпасть ВСЕГДА: пустой результат значил бы, что шаблон собран неверно и «ноль
    // совпадений» получен не потому, что кода нет.
    expect(hits.some((l) => l.startsWith('apps/server/test/gate-b2.test.ts:'))).toBe(true);
  });

  // Зазеленила задача 4 (строка `financial_requires_occurred_on` + снос `assertFinancialInvariant`). Ключ
  // `invariant` совпадал и до неё: по Р-К-1 id системной строки РАВЕН прежнему коду отказа, на нём и
  // сходятся близнецы. Красным тест делали три ключа, которых снятая функция не клала и положить не
  // могла: они описывают ДЕКЛАРАЦИЮ, и источник у них один — `assertConstraintRules` (§1.5). Теперь тест
  // держит именно это: отказ приходит из строки каталога, а не из ветки кода.
  test('1. requires_when строкой сида: отказ несёт шаблон, свойство и область правила', () => {
    const d = taken(sysRequires, 'financial без occurred_on').details as Record<string, unknown>;
    expect(d.invariant).toBe('financial_requires_occurred_on');
    expect(d.rule_template).toBe('requires_when');
    expect(d.property).toBe('orbis/occurred_on');
    expect(d.scope).toEqual({ aspect: 'orbis/financial' });
  });

  // Зазеленила задача 4 (строка `task_completed_at` + снос `applyTaskCompletion`). Значение правила —
  // `{prop:'orbis/updated_at'}` (Р-И-3/Р-К-2: «момент этой записи» выразим существующей core-проекцией,
  // `$now` в язык не заводится). Снятый код писал чистый `clock()`, а `updated_at` апдейта в тот же тик
  // равен `clock() + 1 мс` (докблок `monotonicUpdatedAt`) — до задачи 4 тест был красен ровно на этой
  // миллисекунде, и она была всей разницей между кодом и декларацией. Теперь равенство держит то, что
  // штамп ставит строка сида.
  test('2. on_enter_class строкой сида: completed_at равен updated_at записи, уход снимает', () => {
    const { done, back } = taken(sysTransition, 'задача в done и обратно');
    expect(done.props['orbis/completed_at']).toBe(done.updatedAt);
    expect('orbis/completed_at' in back.props).toBe(false);
  });

  // Зазеленила задача 4 — НЕ задача 3, хотя движок задачи 3 уже исполнял строки правил владельца
  // (C-правило даёт INVARIANT с `invariant` = id строки, T-правило ставит и снимает момент). Рамка §1
  // требует ТОТ ЖЕ отказ, что у системного близнеца, а системный отказ до задачи 4 шёл из кода
  // (`normalize.ts`) и нёс один ключ `invariant`: множества ключей `details` и `rule_template` у двух
  // отказов расходились, и паритет был ложен, пока строка сида не заменила код (Ф-Б2-13). До миграции
  // 0022 тест был красен ещё раньше — на самом севе: колонки `rules` не было. Теперь паритет держит
  // один источник обоих отказов — движок каталога. В этом и смысл гейта: аспект владельца получает
  // доменный инвариант ДЕКЛАРАЦИЕЙ, кода под `user/gate-*` нет.
  test('3. те же два шаблона на аспектах владельца работают без строки кода под них', () => {
    const { refused, closed, reopened } = taken(ownRules, 'аспекты владельца со строками правил');
    expect(refused.code).toBe('INVARIANT');
    const own = refused.details as Record<string, unknown>;
    const sys = taken(sysRequires, 'financial без occurred_on').details as Record<string, unknown>;
    expect(Object.keys(own).sort()).toEqual(Object.keys(sys).sort());
    expect(own.rule_template).toBe(sys.rule_template);
    expect((refused.details as Record<string, unknown>).invariant).toBe('gate_own_requires_moment');
    expect(closed.props[GATE_PROPS.plainAt]).toBe(closed.updatedAt);
    expect(GATE_PROPS.plainAt in reopened.props).toBe(false);
  });

  // Зазеленила задача 4. ГЛАВНАЯ мутационная проверка гейта: без неё «инвариант работает» доказывало бы
  // лишь то, что где-то есть код с тем же поведением. Выключили строку — пропал отказ, значит отказ и
  // правда читает строку, а не ветку кода.
  test('4. строка с enabled:false выключает инвариант, возврат включает обратно', () => {
    const { before, after, again } = taken(disabled, 'выключение системной строки правила');
    expect([before, after, again]).toEqual([false, true, false]);
  });
});

/**
 * Греп-доказательство вехи I «кода под инвариант нет» — заготовка задачи 0e; исполняет его тест
 * «кода под два инварианта §А7-2 в дереве нет…» в describe выше (задача 5).
 *
 * Пути — САМ `GATE_GREP_PATHSPEC` (`fixtures/gate-aspects.ts`), а не его копия; он же —
 * подмножество `SEARCH_PATHSPEC` (`scripts/check-legacy-form.ts`). Списки обязаны совпадать, иначе
 * «доказано» задачей 5 и «проверено» сторожем Б-1 меряют разное, — поэтому совпадение держит ссылка, а
 * не аккуратность переписчика. Пути в команде ниже — развёртка той же ссылки для человека; тест читает
 * ссылку.
 *
 * Команда (из корня worktree):
 *   git grep -n -a -P -e 'assertFinancialInvariant|assertFinancial\b|applyTaskCompletion|financialRecurringNeedsDerivedFrom|hasScheduleRecurrence|hasIncomingDerivedFrom|declaredDerivedFromTargets' -- \
 *     'apps/server/src' 'apps/server/test' 'apps/server/perf' 'packages/shared/src' 'apps/web/src' 'scripts' ':!*.snap'
 *
 * До задачи 4 (веха 0) совпадения стояли и в коде — `apps/server/src/executor/{normalize,executor,props}.ts`.
 * После вехи I — только этот файл и строки-комментарии, объясняющие снятое (правило `COMMENT_ONLY_LINE`).
 */
/** Имена кода под инварианты §А7-2 — СЕМЬ (Р-К-50а): пять из каркаса плюс `assertFinancial\b` и
 *  `hasScheduleRecurrence`, которые сносит тот же коммит задачи 4; без них функция, вернувшаяся под
 *  коротким именем, гейтом не ловилась бы. `assertFinancial\b` не совпадает с
 *  `assertFinancialInvariant` (дальше буква), поэтому перечислены оба. */
export const GATE_B2_GREP_NAMES = [
  'assertFinancialInvariant',
  'assertFinancial\\b',
  'applyTaskCompletion',
  'financialRecurringNeedsDerivedFrom',
  'hasScheduleRecurrence',
  'hasIncomingDerivedFrom',
  'declaredDerivedFromTargets',
] as const;
export const GATE_B2_GREP_PATTERN = GATE_B2_GREP_NAMES.join('|');
export const GATE_B2_GREP_PATHSPEC: readonly string[] = GATE_GREP_PATHSPEC;
/** Тип — `readonly string[]`, как у `SEARCH_PATHSPEC`, а не кортеж литералов: задача 5 спрашивает
 *  `GATE_B2_GREP_ALLOWED.includes(path)` с `path: string`, и у кортежа это TS2345. */
export const GATE_B2_GREP_ALLOWED: readonly string[] = ['apps/server/test/gate-b2.test.ts'];
