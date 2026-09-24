// Тест чистой части стенда §С8-30 (`scripts/probe-p3.ts`): индекс аспектов против полного каталога.
//
// Сам прогон тестом не покрывается и покрыт быть не может: он ходит в живого провайдера и меряет
// поведение модели. Но четыре вещи стенда — это правила, а не измерения, и разъехаться молча они
// не вправе, потому что по ним владелец решает судьбу индекса (откат, названный спекой реформы):
//   (а) сценарии говорят ключами ТЕКУЩЕГО реестра — ключ, снятый реформой, дал бы «провал» там,
//       где модель права, и откат индекса из-за опечатки стенда;
//   (б) вариант `catalog` отличается от `index` РОВНО секцией каталога — иначе сравнивались бы
//       два разных канала, а не индекс с каталогом;
//   (в) предикаты сценариев судят о трассе исполнителя, а не о тексте модели;
//   (г) «мерить нечем» — код 2, а не 1 и не 0.
//
// Прогоняется корневым `bun run test` (хвост `bun test scripts/`), как и тест пробы П4.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  budgetStatusResultSchema,
} from '@orbis/shared';
import { ASPECT_INDEX_HEADING, aspectIndexLines } from '../apps/server/src/llm/aspect-index.ts';
import type { RegistrySnapshot } from '../apps/server/src/registry/load.ts';
import { replay } from './probe-p3/runner.ts';
import { SCENARIOS } from './probe-p3/scenarios.ts';
import { catalogSection, isLocalDatabaseUrl, withCatalog } from './probe-p3/variants.ts';
import { BUDGET_STATUS, seedWorld } from './probe-p3/world.ts';
import { main, PARITY_TOLERANCE, parityVerdict, selectProvider } from './probe-p3.ts';

/**
 * Снимок из встроенных словарей — тех же, что кладёт сид. Аспекты вставлены В ОБРАТНОМ порядке:
 * в проде порядок строк снимка — алфавит id, а не rank, и снимок «как есть» делал бы проверку
 * порядка тавтологией (тот же приём, что у `llm/aspect-index.test.ts`).
 */
const REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map([...BUILTIN_ASPECT_DEFS].reverse().map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  subscriptions: new Map(),
  actions: new Map(BUILTIN_ACTION_DEFS.map((a) => [a.id, a])),
  ownerVersion: 0,
  systemVersion: 0,
};

const scenario = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`нет сценария ${id}`);
  return s;
};

// ---------------------------------------------------------------------------
// (а) сценарии и мир — ключами текущего реестра
// ---------------------------------------------------------------------------

describe('(а) сценарии П3 говорят ключами текущего реестра', () => {
  test('двенадцать сценариев таблицы П3 §3 — те же id, в том же порядке', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      'goal-sum',
      'goal-count',
      'one-entity-insurance',
      'date-task-and-schedule',
      'deadline-only',
      'budget-question',
      'afford',
      'tags-query',
      'taxi-category',
      'horizons',
      'routine-propose',
      'edit-existing',
    ]);
  });

  test('каждый литерал «orbis/…» в сценариях и мире — существующий ключ реестра', () => {
    // Скан ИСХОДНИКА, а не объявленного списка: предикат, читающий снятый реформой ключ
    // (`category_ref`, `progress_source` по старой карте), объявленный список не выдал бы.
    const known = new Set<string>([
      ...BUILTIN_PROPERTY_META.flatMap((p) => [p.id, p.key]),
      ...BUILTIN_ASPECT_DEFS.flatMap((a) => [a.id, a.key]),
      ...BUILTIN_CONTRACT_DEFS.flatMap((c) => [c.id, c.key]),
      ...BUILTIN_RELATION_ROLE_META.flatMap((r) => [r.id, r.key]),
    ]);
    const literals = new Set<string>();
    for (const file of ['scenarios.ts', 'world.ts']) {
      const text = readFileSync(join(import.meta.dir, 'probe-p3', file), 'utf8');
      for (const m of text.matchAll(/['"`](orbis\/[a-z0-9_-]+)['"`]/g)) {
        if (m[1] !== undefined) literals.add(m[1]);
      }
    }
    // Позитивный контроль: скан что-то нашёл, и именно то, на чём стоят сценарии целей и денег.
    for (const must of ['orbis/goal', 'orbis/progress_source', 'orbis/finance_category']) {
      expect(literals.has(must)).toBe(true);
    }
    expect([...literals].filter((k) => !known.has(k))).toEqual([]);
  });

  test('мир-заглушка проходит стадию 2 по встроенному реестру (иначе модель спорила бы с миром)', () => {
    // Сам мир пишется через `replay` — той же заглушкой, что судит модель: запись, которую
    // она отвергла бы у модели, не может лежать в мире молча.
    const world = seedWorld();
    const calls = [...world.values()].map((e) => ({
      name: 'entity_create',
      args: { id: e.id, title: e.title, tags: e.tags, aspects: e.aspects, props: e.props },
    }));
    const trace = replay(REG, calls, { world: new Map() });
    expect(trace.calls.filter((c) => c.error !== undefined).map((c) => c.error)).toEqual([]);
  });

  test('ответ budget_status заглушки — по действующему контракту тула', () => {
    expect(budgetStatusResultSchema.safeParse(BUDGET_STATUS).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (б) catalog = index + секция каталога, остальное побайтно равно
// ---------------------------------------------------------------------------

describe('(б) вариант catalog — прод-канал плюс секция каталога и ничего больше', () => {
  const indexSection = `${ASPECT_INDEX_HEADING}\n${aspectIndexLines(REG, []).join('\n')}`;
  // Две раскладки прод-каналов: у чата за индексом идёт блок продолжений, у рутины — якорь.
  const layouts: Record<string, string> = {
    чат: `ТЕЛО ПРОМПТА\n\nСегодня: 2026-08-25 (вторник).\n\n${indexSection}\n\nПродолжения разговора:\n- …`,
    рутина: `ПРОМПТ РУТИНЫ\n\nСегодня: 2026-08-25.\n\n${indexSection}\n\nРутина, которая сработала — работай по ней:\nid: x`,
    'индекс последним': `ТЕЛО\n\n${indexSection}`,
  };
  const section = catalogSection(REG, []);

  for (const [name, system] of Object.entries(layouts)) {
    test(`раскладка «${name}»: секция встаёт сразу за индексом, остальное нетронуто`, () => {
      const at = system.indexOf(indexSection) + indexSection.length;
      const catalog = withCatalog(system, section);
      expect(catalog).not.toBe(system);
      expect(catalog).toBe(`${system.slice(0, at)}\n\n${section}${system.slice(at)}`);
    });
  }

  test('канал без индекса — отказ, а не молчаливый «каталог» без индекса', () => {
    expect(() => withCatalog('ТЕЛО\n\nПродолжения разговора:', section)).toThrow();
  });

  test('каталог — по аспектам индекса в порядке rank, с полями и правилами', () => {
    const idsOf = (lines: string[]) =>
      lines
        .filter((l) => l.startsWith('- ') && l.includes(' — '))
        .map((l) => l.slice(2, l.indexOf(' — ')));
    // Тот же набор и порядок, что у индекса (служебные в индексе — строкой-границей, не пунктом).
    expect(idsOf(section.split('\n'))).toEqual(idsOf(aspectIndexLines(REG, [])));
    expect(section).toContain('orbis/progress_source*');
    expect(section).toContain('aggregate');
    expect(section).toContain(
      'orbis/task_status* enum inbox|planned|in_progress|waiting|done|cancelled',
    );
    // Правила аспекта — дословно из реестра (в полном каталоге П3 они стояли рядом с полями).
    const goal = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal');
    expect(section).toContain(`правила: ${goal?.aiInstructions}`);
    // Вычисляемое сервером свойство модели не предлагается ПОЛЕМ — как и в схеме attach_*-тула
    // (в правилах цели оно названо: «текущего значения в туле нет намеренно»).
    const lines = section.split('\n');
    const goalFields = lines[lines.findIndex((l) => l.startsWith('- orbis/goal —')) + 1];
    expect(goalFields).toStartWith('  поля: ');
    expect(goalFields).not.toContain('orbis/current_value');
  });

  test('маска модулей — та же, что у индекса: выключенные Финансы уходят из каталога', () => {
    expect(catalogSection(REG, ['finance'])).not.toContain('- orbis/financial —');
    expect(section).toContain('- orbis/financial —');
  });
});

// ---------------------------------------------------------------------------
// (в) предикаты сценариев — по трассе исполнителя
// ---------------------------------------------------------------------------

const GOAL = '66666666-6666-4666-8666-666666666666';
const createGoalEntity = { name: 'entity_create', args: { id: GOAL, title: 'Отпуск', tags: [] } };
const goalData = (source: Record<string, unknown>) => ({
  name: 'attach_orbis_goal',
  args: {
    entity_id: GOAL,
    data: { 'orbis/target_value': '300000', 'orbis/progress_source': source },
  },
});
const SUM_SAVINGS = {
  query: { filter: { and: [{ aspect: 'orbis/financial' }, { tag: 'savings' }] } },
  aggregate: 'sum',
  field: 'orbis/amount',
};

describe('(в) goal-sum судит по трассе, а не по тексту модели', () => {
  test('проходит на трассе с attach_orbis_goal (aggregate: sum, field)', () => {
    const verdict = scenario('goal-sum').check(
      replay(REG, [createGoalEntity, goalData(SUM_SAVINGS)]),
    );
    expect(verdict.fails).toEqual([]);
    expect(verdict.pass).toBe(true);
  });

  test('падает без attach_orbis_goal — сущность без цели', () => {
    const verdict = scenario('goal-sum').check(replay(REG, [createGoalEntity]));
    expect(verdict.pass).toBe(false);
  });

  test('падает, когда ветка latest вместо sum — запись законна, но это не та цель', () => {
    // Ветка latest тоже требует field, поэтому провал здесь — ровно про aggregate, а не про
    // отсутствие field (у ветки count он был бы вторым поводом и маскировал бы первый).
    const latest = { ...SUM_SAVINGS, aggregate: 'latest' };
    const trace = replay(REG, [createGoalEntity, goalData(latest)]);
    expect(trace.calls.map((c) => c.error)).toEqual([undefined, undefined]);
    const verdict = scenario('goal-sum').check(trace);
    expect(verdict.pass).toBe(false);
    expect(verdict.fails).toEqual(['aggregate=latest, ожидался sum']);
  });

  test('отказ стадии 2 виден в трассе: sum без field заглушка не записывает', () => {
    const noField = { query: SUM_SAVINGS.query, aggregate: 'sum' };
    const trace = replay(REG, [createGoalEntity, goalData(noField)]);
    expect(trace.calls[1]?.error).toContain('VALIDATION');
    expect(scenario('goal-sum').check(trace).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (г) «мерить нечем» — код 2
// ---------------------------------------------------------------------------

describe('(г) провайдера нет — замер не состоялся (код 2)', () => {
  test('явный ORBIS_LLM_PROVIDER без ключа — «unavailable» с именем ключа, а не исключение', () => {
    for (const name of ['openai', 'anthropic'] as const) {
      const choice = selectProvider({ ORBIS_LLM_PROVIDER: name });
      expect(choice.kind).toBe('unavailable');
      if (choice.kind === 'unavailable') expect(choice.reason).toContain('API_KEY');
    }
  });

  test('echo и «ключей нет вовсе» — тоже «unavailable»: echo не зовёт тулы', () => {
    expect(selectProvider({ ORBIS_LLM_PROVIDER: 'echo' }).kind).toBe('unavailable');
    expect(selectProvider({}).kind).toBe('unavailable');
  });

  test('ключ на месте — провайдер живой (позитивный контроль)', () => {
    expect(selectProvider({ ORBIS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-тест' }).kind).toBe(
      'live',
    );
  });

  test('живой прогон без провайдера — EXIT 2 до всякой БД', async () => {
    const code = await main(['--variant=index', '--out=/nonexistent/probe-p3'], {
      ORBIS_LLM_PROVIDER: 'openai',
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Вердикт паритета: код выхода — правило, а не измерение
// ---------------------------------------------------------------------------

describe('вердикт паритета (0 — паритет, 3 — регрессия, 2 — матрица неполна)', () => {
  const full = SCENARIOS.length * 3;
  test('индекс ниже каталога на допуск — ещё паритет; на допуск+1 — регрессия', () => {
    expect(
      parityVerdict({
        index: { pass: 32, runs: full },
        catalog: { pass: 32 + PARITY_TOLERANCE, runs: full },
      }).code,
    ).toBe(0);
    expect(
      parityVerdict({
        index: { pass: 31, runs: full },
        catalog: { pass: 32 + PARITY_TOLERANCE, runs: full },
      }).code,
    ).toBe(3);
  });

  test('индекс ЛУЧШЕ каталога — паритет, а не «расхождение»', () => {
    expect(
      parityVerdict({ index: { pass: 36, runs: full }, catalog: { pass: 20, runs: full } }).code,
    ).toBe(0);
  });

  test('неполная матрица — вердикта нет, код 2', () => {
    expect(
      parityVerdict({ index: { pass: 12, runs: 12 }, catalog: { pass: 36, runs: full } }).code,
    ).toBe(2);
  });
});

describe('стенд пишет своего владельца — только в локальную БД', () => {
  test('локальные адреса — да, прочие и пустой — нет', () => {
    expect(isLocalDatabaseUrl('postgresql://u:p@127.0.0.1:54322/postgres')).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://u:p@localhost:5432/postgres')).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toBe(false);
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl('не адрес')).toBe(false);
  });
});
