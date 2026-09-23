// apps/server/src/policy/assign-level.test.ts
// §С8-26: одиннадцать правил делегирования «дня мечты» (§Б4-5) дают ожидаемые уровни — приёмка
// ВЫРАЗИМОСТИ, а не подключения: живой конвейер §7.10 правил не знает (V2), и оценочная область
// `assignLevelOf` зовётся только отсюда. Пол понижения (Р-27) пиннится здесь же — он и есть та
// граница, которую правило владельца пробить не вправе.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  ASSIGN_LEVEL_RULES,
  type GraphId,
  RULE_LEVEL_TO_CONFIRMATION,
  type RuleLevel,
  ruleDefinitionSchema,
  TEST_IMPORT_ROUTINE_ID,
} from '@orbis/shared';
import {
  seedTestWorld,
  TEST_CALL_ASPECT,
  TEST_CONTACT_ASPECT,
  TEST_ROLE_PARTICIPANT,
} from '../../test/fixtures/test-seed';
import {
  appDb,
  freshGraph,
  personal,
  requireEnv,
  seedCustomAspect,
  seedCustomRole,
  truncateAll,
} from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import type { RelationFact } from '../expr/eval';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import { assertRule } from '../registry/rules';
import { entityEvalScope } from '../rules/scope';
import { type AssignLevelCall, assignLevelOf } from './assign-level';
import { type ConfirmationLevel, classifyToolCall, type ToolCallFacts } from './confirmation';
import { floorLevel, LEVEL_ORDER, stricter } from './floor';

requireEnv();
const { db, client } = appDb();
afterAll(async () => {
  await client.end();
});
/** Владелец мира §С8-26 — `freshGraph()` в хуке (Ф-Б2-9): модульный id без хука не рождает строку графа. */
let owner: GraphId;
let reg: RegistrySnapshot; // снимок с синтетическим сидом §С8-26
let regWithRules: RegistrySnapshot; // он же + тринадцать строк правил на носителях
let verdicts: Array<{ ok: true } | { ok: false; code: string; reason?: string }> = [];

/** Правила приёмки живут ФИКСТУРОЙ, а не сидом (Р-И-36): `test/*` в живой путь не идут. */
function withRules(base: RegistrySnapshot): RegistrySnapshot {
  const aspects = new Map(base.aspects);
  for (const { carrier, rule } of ASSIGN_LEVEL_RULES) {
    if (carrier.kind !== 'aspect') {
      throw new Error(`фикстура §С8-26: носитель ${carrier.kind} не предусмотрен`);
    }
    const row = aspects.get(carrier.id);
    if (row === undefined) throw new Error(`фикстура §С8-26: аспекта ${carrier.id} нет в снимке`);
    aspects.set(carrier.id, { ...row, rules: [...row.rules, ruleDefinitionSchema.parse(rule)] });
  }
  return { ...base, aspects };
}

beforeAll(async () => {
  await truncateAll();
  owner = await freshGraph();
  // Словарь приёмки — строки ВЛАДЕЛЬЦА, не сид: мир ссылается на них, и без них его не посеять
  // (тот же порядок, что у `test/test-seed.test.ts`).
  await seedCustomAspect(owner, TEST_CONTACT_ASPECT);
  await seedCustomAspect(owner, TEST_CALL_ASPECT);
  await seedCustomRole(owner, TEST_ROLE_PARTICIPANT);
  await seedTestWorld(owner);
  reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  regWithRules = withRules(reg);
  verdicts = ASSIGN_LEVEL_RULES.map(({ carrier, rule }) => {
    try {
      assertRule(rule, { reg: regWithRules, carrier, systemSeed: false });
      return { ok: true as const };
    } catch (e) {
      const { code, details } = e as { code?: unknown; details?: { reason?: unknown } };
      return details?.reason === undefined
        ? { ok: false as const, code: String(code) }
        : { ok: false as const, code: String(code), reason: String(details.reason) };
    }
  });
});

const FACTS = (over: Partial<ToolCallFacts> = {}): ToolCallFacts => ({
  tool: 'entity_update',
  kind: 'mutate',
  known: true,
  actorKind: 'ai',
  explicitCommand: false,
  archives: false,
  isBatch: false,
  grantsAutonomy: false,
  reconfigures: 'none',
  sensitivity: [],
  ...over,
});

describe('пол понижения §С2-1 (Р-27): три ряда таблицы и запрет по объекту', () => {
  test('порядок строгости — единственный, и он полон', () => {
    expect(LEVEL_ORDER).toEqual(['execute', 'preview', 'explicit-confirmation', 'forbidden']);
    expect(stricter('preview', 'execute')).toBe('preview');
    expect(stricter('explicit-confirmation', 'forbidden')).toBe('forbidden');
    expect(stricter('preview', 'preview')).toBe('preview');
  });
  test('ряды 1/4/6 дают пол, обычная мутация — не даёт', () => {
    expect(floorLevel(FACTS({ known: false }))).toBe('forbidden');
    expect(floorLevel(FACTS({ reconfigures: 'behavior-delta' }))).toBe('explicit-confirmation');
    expect(floorLevel(FACTS({ reconfigures: 'system-object' }))).toBe('explicit-confirmation');
    expect(floorLevel(FACTS({ grantsAutonomy: true }))).toBe('explicit-confirmation');
    // Владельцу автономию выдаёт он сам — ряд 6 по актору ветвится (`classifyToolCall`).
    expect(floorLevel(FACTS({ grantsAutonomy: true, actorKind: 'owner' }))).toBeNull();
    // Ряд 5 (масштаб) и ряд 3 (архивация) в пол НЕ входят: их правило понижать вправе (В-2).
    expect(floorLevel(FACTS({ isBatch: true, batchSize: 40 }))).toBeNull();
    expect(floorLevel(FACTS({ archives: true }))).toBeNull();
    expect(floorLevel(FACTS(), true)).toBe('forbidden');
  });
});

describe('§С8-26: одиннадцать правил делегирования проходят валидатор', () => {
  test('тринадцать строк на одиннадцать номеров — правила 8 и 10 разложены на два (Р-5)', () => {
    expect(ASSIGN_LEVEL_RULES.length).toBe(13);
    // Номер правила — без суффикса разложения ('8a' → '8'): мерка §С8-26 — одиннадцать НОМЕРОВ, а не строк.
    expect(new Set(ASSIGN_LEVEL_RULES.map((r) => r.n.replace(/[ab]$/, ''))).size).toBe(11);
  });
  test('каждая строка принята валидатором — без нового шаблона каталога', () => {
    for (const [i, v] of verdicts.entries()) {
      expect(v, `${ASSIGN_LEVEL_RULES[i]?.name}`).toEqual({ ok: true });
      expect(ASSIGN_LEVEL_RULES[i]?.rule.template).toBe('assign_level');
    }
  });
  // Отказ `RULE_LOWERING_UNSCOPED` (понижающее правило без `actor`, Р-27) пинит ВАЛИДАТОР
  // задачи 1 (`registry/rules.test.ts`) — второй копии того же утверждения здесь не заводится.
});

const ENV = 'env-1';
const CONTACT_FAMILY = 'c-family';
const CONTACT_COURIER = 'c-courier';
const CONTACT_BANK = 'c-bank';
const AGREEMENT = 'a-1';
/** Часы фиксированы: `core.updatedAt` уезжает в область как `{prop:'orbis/updated_at'}` (Р-И-3). */
const NOW = new Date('2026-09-16T10:00:00.000Z');
/** Читатель целей `deref` (§Б3-3): props цели плюс `tags` ядра — договор `ExprEvalScope.deref`. */
const TARGETS: Record<string, Record<string, unknown>> = {
  [CONTACT_FAMILY]: { 'test/contact_kind': 'person', 'test/known_contact': true, tags: ['семья'] },
  [CONTACT_COURIER]: { 'test/contact_kind': 'courier', 'test/known_contact': false, tags: [] },
  [CONTACT_BANK]: { 'test/contact_kind': 'bank', 'test/known_contact': true, tags: [] },
  [AGREEMENT]: { 'orbis/amount': '1000.00' },
};
const REMAINING = new Map([['envelope-binding', { remaining: '5000.00' }]]);
const BOUND: readonly RelationFact[] = [{ role: 'envelope-binding', sourceId: ENV, alive: true }];
const WITH_PARTICIPANT: readonly RelationFact[] = [
  { role: 'participant', sourceId: CONTACT_FAMILY, alive: true },
];

interface Scenario {
  aspects: string[];
  props: Record<string, unknown>;
  relations?: readonly RelationFact[];
  aggVia?: typeof REMAINING;
  facts?: Partial<ToolCallFacts>;
  call?: Partial<AssignLevelCall>;
  level: ConfirmationLevel;
  floored?: boolean;
  candidates: number;
}
/** Порядок — ровно `ASSIGN_LEVEL_RULES`: сценарий i проверяет строку i (id правил не пишутся ни разу). */
const SCENARIOS: readonly Scenario[] = [
  // 1 «маму соединил сразу»: понижение с ряда масштаба — пачка звонков от AI.
  {
    aspects: ['test/call'],
    props: { 'test/caller': CONTACT_FAMILY },
    facts: { isBatch: true, batchSize: 12 },
    level: 'execute',
    candidates: 1,
  },
  // 2 «предоплата выше договорённой»: 3000 > 1000, но ниже порога правила 3 — кандидат ровно один.
  {
    aspects: ['test/call', 'orbis/financial'],
    props: {
      'test/caller': CONTACT_BANK,
      'test/agreement': AGREEMENT,
      'orbis/amount': '3000.00',
      'orbis/direction': 'expense',
    },
    level: 'explicit-confirmation',
    candidates: 1,
  },
  // 3 крупный расход: 15000 > 10000, ребра конверта нет.
  {
    aspects: ['orbis/financial'],
    props: { 'orbis/amount': '15000.00', 'orbis/direction': 'expense' },
    level: 'explicit-confirmation',
    candidates: 1,
  },
  // 4 «оплачено из конверта»: остаток 5000 ≥ 1200 → молча.
  {
    aspects: ['orbis/financial'],
    props: { 'orbis/amount': '1200.00', 'orbis/direction': 'expense' },
    relations: BOUND,
    aggVia: REMAINING,
    level: 'execute',
    candidates: 1,
  },
  // 5 «курьера — к консьержу».
  {
    aspects: ['test/call'],
    props: { 'test/caller': CONTACT_COURIER },
    level: 'execute',
    candidates: 1,
  },
  // 6 «банк записал и разметил»: фактов нет, актор — рутина импорта; пачка 40 понижается с ряда 5.
  {
    aspects: ['orbis/financial'],
    props: { 'orbis/amount': '300.00', 'orbis/direction': 'expense' },
    facts: { isBatch: true, batchSize: 40 },
    call: { source: 'routine', routineId: TEST_IMPORT_ROUTINE_ID },
    level: 'execute',
    candidates: 1,
  },
  // 7 «письма от твоего имени»: внешнее действие и знакомый контакт.
  {
    aspects: ['test/call'],
    props: { 'test/caller': CONTACT_BANK },
    facts: { sensitivity: ['external'] },
    level: 'preview',
    candidates: 1,
  },
  // 8a встреча без участников, 8b — с участниками (одна запись, разные рёбра).
  { aspects: ['orbis/schedule'], props: {}, level: 'execute', candidates: 1 },
  {
    aspects: ['orbis/schedule'],
    props: {},
    relations: WITH_PARTICIPANT,
    level: 'preview',
    candidates: 1,
  },
  // 9 «бюджет вечера»: внешнее и в пределах остатка — вместе с правилом 4 (молча) побеждает строгое.
  {
    aspects: ['orbis/financial'],
    props: { 'orbis/amount': '1200.00', 'orbis/direction': 'expense' },
    relations: BOUND,
    aggVia: REMAINING,
    facts: { sensitivity: ['external'] },
    level: 'preview',
    candidates: 2,
  },
  // 10a снятие замка владельцем: правило discuss, пол ряда 4 держит тот же уровень.
  {
    aspects: ['orbis/routine'],
    props: {},
    facts: {
      tool: 'aspect_delta_set',
      reconfigures: 'behavior-delta',
      sensitivity: ['changes_registry'],
      actorKind: 'owner',
    },
    call: { actorKind: 'owner', source: 'chat' },
    level: 'explicit-confirmation',
    candidates: 1,
  },
  // 10b то же от AI — «никогда».
  {
    aspects: ['orbis/routine'],
    props: {},
    facts: {
      tool: 'aspect_delta_set',
      reconfigures: 'behavior-delta',
      sensitivity: ['changes_registry'],
    },
    level: 'forbidden',
    candidates: 1,
  },
  // 11 «перенос срока моей задачи рутиной» (В-3).
  {
    aspects: ['orbis/task'],
    props: { 'orbis/due_date': '2026-10-01' },
    call: { source: 'routine', routineId: TEST_IMPORT_ROUTINE_ID, touched: ['orbis/due_date'] },
    level: 'preview',
    candidates: 1,
  },
];

function verdictOf(s: Scenario) {
  const facts = FACTS(s.facts);
  const call: AssignLevelCall = {
    actorKind: facts.actorKind,
    source: 'chat',
    touched: [],
    facts,
    tableLevel: classifyToolCall(facts),
    ...s.call,
  };
  const target = entityEvalScope({
    reg,
    state: { aspects: s.aspects, props: s.props },
    core: { id: 'target-1', title: 'Цель', archived: false, createdAt: NOW, updatedAt: NOW },
    today: '2026-09-16',
    timeZone: 'Asia/Bangkok',
    owner,
    relations: s.relations ?? [],
    aggVia: s.aggVia,
    deref: (id) => TARGETS[id] ?? null,
  });
  return { verdict: assignLevelOf(regWithRules, target, call), table: call.tableLevel };
}

describe('§С8-26: одиннадцать правил дают ожидаемые уровни на синтетическом сиде', () => {
  test('сценариев столько же, сколько строк правил', () => {
    expect(SCENARIOS.length).toBe(ASSIGN_LEVEL_RULES.length);
  });
  test('каждая строка срабатывает на своей записи и даёт свой уровень', () => {
    for (const [i, s] of SCENARIOS.entries()) {
      const row = ASSIGN_LEVEL_RULES[i];
      const name = `${row?.n} ${row?.name}`;
      const { verdict } = verdictOf(s);
      expect(
        verdict.candidates.map((c) => c.rule),
        name,
      ).toContain(row?.rule.id);
      expect(verdict.candidates.length, name).toBe(s.candidates);
      expect(verdict.level, name).toBe(s.level);
      expect(verdict.floored, name).toBe(s.floored ?? false);
      // Уровень фикстуры = max(пол, правило) — формула §С8-26 дословно.
      expect(verdict.level, name).toBe(
        stricter(
          RULE_LEVEL_TO_CONFIRMATION[(ASSIGN_LEVEL_RULES[i]?.rule as { level: RuleLevel }).level],
          floorLevel(FACTS(s.facts)) ?? 'execute',
        ),
      );
    }
  });
  test('два правила на одной записи — побеждает СТРОГОЕ (В-2д)', () => {
    const { verdict } = verdictOf(SCENARIOS[9] as Scenario); // 9: вместе с правилом 4
    expect(verdict.candidates.map((c) => c.level).sort()).toEqual(['execute', 'preview']);
    expect(verdict.level).toBe('preview');
  });
  test('правило silent против каждого ряда пола — уровень ТАБЛИЦЫ, не правила', () => {
    const family = SCENARIOS[0] as Scenario; // единственное silent-правило без чувствительных фактов
    for (const over of [
      { known: false },
      { reconfigures: 'behavior-delta' as const },
      { grantsAutonomy: true },
    ]) {
      const { verdict, table } = verdictOf({ ...family, facts: { ...family.facts, ...over } });
      expect(verdict.level).toBe(table);
      expect(verdict.floored).toBe(true);
    }
    const banned = verdictOf({ ...family, call: { objectForbidden: true } });
    expect(banned.verdict.level).toBe('forbidden');
  });
  test('правила без сработавших — уровень таблицы, пустые кандидаты', () => {
    const { verdict } = verdictOf({
      aspects: ['orbis/note'],
      props: {},
      level: 'execute',
      candidates: 0,
    });
    expect(verdict).toEqual({ level: 'execute', candidates: [], floored: false });
  });
});

describe('граница В-2/Р-27: правила приёмки не уехали в живой путь', () => {
  // Греп из теста — образец `test/gate-c8-18.test.ts`: корень репозитория берётся у git, потому
  // что `bun test` идёт из `apps/server`, а pathspec отсчитывается от cwd. Видит ТОЛЬКО
  // отслеживаемые файлы (Ф-Б2-11) — новый вызывающий краснеет здесь после `git add`, то есть в CI.
  //
  // Ищется ИМПОРТ модуля и ВЫЗОВ функции, а не голое имя: имя законно стоит в комментариях, которые
  // эту границу и описывают (`floor.ts`, а `tools/dispatch.ts` называет его, объясняя, почему пол в
  // живом конвейере не складывается), — сторож по имени ловил бы собственное объяснение.
  test('живой конвейер §7.10 правил не знает: assignLevelOf зовут только приёмка и её тест', () => {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).stdout.trim();
    const r = spawnSync(
      'git',
      [
        'grep',
        '-l',
        '-E',
        '-e',
        'assignLevelOf *\\(',
        '-e',
        "/assign-level'",
        '--',
        'apps/server/src',
        'apps/web/src',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    // 0 — есть совпадения, 1 — нет, >1 — ошибка git: молчащий сторож хуже отсутствующего.
    expect(r.status === 0 || r.status === 1, r.stderr).toBe(true);
    expect(r.stdout.trim().split('\n').sort()).toEqual([
      'apps/server/src/policy/assign-level.test.ts',
      'apps/server/src/policy/assign-level.ts',
    ]);
  });
});
