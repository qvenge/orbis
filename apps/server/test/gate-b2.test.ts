// apps/server/test/gate-b2.test.ts
// ГЕЙТ ВЕХИ I среза Б-2 (рамка §1, §А7-2): два доменных инварианта живут СТРОКАМИ СИДА каталога правил,
// код обоих снесён, тот же шаблон на аспекте владельца даёт то же поведение без строки кода под него, а
// строка с `enabled: false` инвариант выключает. Четыре утверждения ниже помечены и сегодня ложны; все
// четыре зеленит задача 4 (строки сида + снос кода), пометки снимает задача 5.
//
// ПОМЕТКА НИГДЕ НЕ НАЗВАНА ПОЛНЫМ ИМЕНЕМ в прозе: сторож «пометок вне списка нет» (`gate-c8-18.test.ts`)
// ищет это имя по `apps`/`packages`/`scripts`, и строка с ним сделала бы сторожа вечно красным.
// ТЕЛА ПОМЕЧЕННЫХ ТЕСТОВ СИНХРОННЫЕ (ОВ-Б1-1): Bun 1.2.7 игнорирует пометку, если тест вышел в
// макрозадачу (любой поход в БД — она), и ломаются ОБЕ половины гарантии — красный перестаёт
// поглощаться, зелёный перестаёт валить сьют. Поэтому походы собраны в `beforeAll`, тела читают итог.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { StructuredError } from '../src/errors';
import type { ExecuteOk, ExecuteRequest, WireEntity } from '../src/executor/types';
import {
  appDb,
  executeWithFixtureCategories as execute,
  mintGraph,
  personal,
  requireEnv,
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
function entityOf(r: { ok: boolean }): WireEntity {
  if (!r.ok) throw new Error(`ожидался успех исполнителя, пришёл отказ: ${JSON.stringify(r)}`);
  return (r as ExecuteOk).results[0] as WireEntity;
}
function errorOf(r: { ok: boolean }): StructuredError {
  if (r.ok) throw new Error('ожидался отказ исполнителя, пришёл успех');
  return (r as { error: StructuredError }).error;
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
});

describe('гейт вехи I: инвариант только декларацией', () => {
  // ЗЕЛЁНЫЙ И СЕГОДНЯ, И ПОСЛЕ ВЕХИ I — сторож против тавтологии: снеси задача 4 код, а строка сида
  // промолчи, четыре помеченных теста ниже остались бы красными (то есть «пройденными»), и срез уехал
  // бы с выключенными инвариантами. Здесь проверяется только то, что меняться НЕ должно.
  test('контроль: инвариант держится — отказ по occurred_on и штамп завершения не пропали', () => {
    const e = taken(sysRequires, 'financial без occurred_on');
    expect(e.code).toBe('INVARIANT');
    expect((e.details as Record<string, unknown>).invariant).toBe('financial_requires_occurred_on');
    const { done, back } = taken(sysTransition, 'задача в done и обратно');
    expect(typeof done.props['orbis/completed_at']).toBe('string');
    expect('orbis/completed_at' in back.props).toBe(false);
  });

  // Зеленит задача 4 (строка `financial_requires_occurred_on` + снос `assertFinancialInvariant`). Ключ
  // `invariant` совпадает и сегодня: по Р-К-1 id системной строки РАВЕН прежнему коду отказа, на нём и
  // сходятся близнецы. Красным тест делают три ключа, которых функция (`normalize.ts:162-166`) не кладёт
  // и положить не может: они описывают ДЕКЛАРАЦИЮ, и источник у них один — `assertConstraintRules` (§1.5).
  test.failing('1. requires_when строкой сида: отказ несёт шаблон, свойство и область правила', () => {
    const d = taken(sysRequires, 'financial без occurred_on').details as Record<string, unknown>;
    expect(d.invariant).toBe('financial_requires_occurred_on');
    expect(d.rule_template).toBe('requires_when');
    expect(d.property).toBe('orbis/occurred_on');
    expect(d.scope).toEqual({ aspect: 'orbis/financial' });
  });

  // Зеленит задача 4 (строка `task_completed_at` + снос `applyTaskCompletion`). Значение правила —
  // `{prop:'orbis/updated_at'}` (Р-И-3/Р-К-2: «момент этой записи» выразим существующей core-проекцией,
  // `$now` в язык не заводится). Сегодня код пишет чистый `clock()` (докблок `monotonicUpdatedAt`,
  // `executor.ts:1635-1639`), а `updated_at` апдейта в тот же тик равен `clock() + 1 мс` — тест красен
  // ровно на этой миллисекунде, и она и есть вся разница между кодом и декларацией.
  test.failing('2. on_enter_class строкой сида: completed_at равен updated_at записи, уход снимает', () => {
    const { done, back } = taken(sysTransition, 'задача в done и обратно');
    expect(done.props['orbis/completed_at']).toBe(done.updatedAt);
    expect('orbis/completed_at' in back.props).toBe(false);
  });
});
