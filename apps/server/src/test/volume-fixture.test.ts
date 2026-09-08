import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_CONTRACT_DEFS, BUDGET_DEF } from '@orbis/shared';
import { budgetContourOf } from '../budget/contour';
import { bindingTargetOf } from '../budget/binding';
import type { WireEntity } from '../executor/types';
import type { RegistrySnapshot } from '../registry/load';
import {
  buildVolumeWorld,
  VOLUME_CATEGORIES,
  VOLUME_ENTITIES,
  VOLUME_ENVELOPES,
  VOLUME_ENVELOPES_PER_MONTH,
  VOLUME_EVENTS,
  VOLUME_LAST_MONTH,
  VOLUME_MONTHS,
  VOLUME_OWNER_ID,
  VOLUME_PROBE_COUNT,
  VOLUME_PROBE_IDS,
  VOLUME_TASKS,
  VOLUME_TEMPLATES,
  VOLUME_TODAY,
  VOLUME_TXNS,
  type VolumeProbe,
  type VolumeWorld,
  volumeCategoryId,
  volumeCombination,
  volumeMonth,
  volumeProbeProps,
  volumeProbes,
} from './volume-fixture';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('корпус объёма: календарь и адреса', () => {
  test('двенадцать месяцев подряд, последний — VOLUME_LAST_MONTH', () => {
    const months = Array.from({ length: VOLUME_MONTHS }, (_, k) => volumeMonth(k));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-09');
    expect(months[11]).toBe(VOLUME_LAST_MONTH);
    expect(new Set(months).size).toBe(12);
    expect(() => volumeMonth(12)).toThrow(RangeError);
  });
  test('счёт — производная, а не второе число руками', () => {
    expect(VOLUME_ENVELOPES).toBe(VOLUME_ENVELOPES_PER_MONTH * VOLUME_MONTHS);
    expect(VOLUME_ENTITIES).toBe(32 + 480 + 200 + 20_000 + 2_000 + 1_000);
  });
  test('владелец и категории — детерминированные uuid', () => {
    expect(VOLUME_OWNER_ID).toMatch(UUID_RE);
    expect(volumeCategoryId(0)).toBe(volumeCategoryId(0));
    expect(volumeCategoryId(0)).not.toBe(volumeCategoryId(1));
  });
});

describe('мир корпуса: финансовый слой', () => {
  const world = buildVolumeWorld();
  const byAspect = (id: string) =>
    world.entities.filter((e) => (e.aspects as string[]).includes(id));

  test('32 категории и дерево category-parent на 18 рёбер (у ребёнка один родитель)', () => {
    expect(byAspect('orbis/category')).toHaveLength(VOLUME_CATEGORIES);
    const tree = world.relations.filter((r) => r.role === 'category-parent');
    expect(tree).toHaveLength(18);
    expect(new Set(tree.map((r) => r.targetId)).size).toBe(18);
  });
  test('480 конвертов: четвёрка (категория, валюта, период) уникальна, период — календарный месяц', () => {
    const envs = byAspect('orbis/budget');
    expect(envs).toHaveLength(VOLUME_ENVELOPES);
    const key = (e: (typeof envs)[number]) => {
      const p = e.props as Record<string, unknown>;
      return `${p['orbis/finance_category']}|${p['orbis/currency']}|${p['orbis/period_start']}|${p['orbis/period_end']}`;
    };
    expect(new Set(envs.map(key)).size).toBe(VOLUME_ENVELOPES);
    const august = envs.filter(
      (e) => (e.props as Record<string, unknown>)['orbis/period_start'] === '2026-08-01',
    );
    expect(august).toHaveLength(VOLUME_ENVELOPES_PER_MONTH);
    expect((august[0]?.props as Record<string, unknown>)['orbis/period_end']).toBe('2026-08-31');
  });
  test('форма после среза А: props/aspects, пустой query_refs, старых имён нет', () => {
    expect(world.entities.every((e) => e.ownerId === VOLUME_OWNER_ID)).toBe(true);
    expect(world.entities.every((e) => (e.queryRefs as string[]).length === 0)).toBe(true);
    expect(JSON.stringify(byAspect('orbis/budget')[0]?.props)).not.toContain('category_ref');
  });
});

describe('мир корпуса: движения денег', () => {
  const world = buildVolumeWorld();
  const fin = world.entities.filter((e) => (e.aspects as string[]).includes('orbis/financial'));

  test('20 000 движений и 200 шаблонов; шаблон — с recurrence и БЕЗ start_at', () => {
    expect(fin).toHaveLength(VOLUME_TXNS + VOLUME_TEMPLATES);
    const templates = fin.filter((e) => (e.aspects as string[]).includes('orbis/schedule'));
    expect(templates).toHaveLength(VOLUME_TEMPLATES);
    for (const t of templates) {
      const p = t.props as Record<string, unknown>;
      expect(p['orbis/recurrence']).toEqual({ freq: 'monthly', interval: 1 });
      // без start_at материализация выходит на первом шаге (`recurring/materialize.ts:367-368`) —
      // корпус не переписывает сам себя между прогонами
      expect(p['orbis/start_at']).toBeUndefined();
    }
  });
  test('инстансы повторения: planned и строго ПОЗЖЕ VOLUME_TODAY (post-due остаётся no-op)', () => {
    const edges = world.relations.filter((r) => r.role === 'instance-of');
    expect(edges.length).toBeGreaterThan(700);
    expect(edges.length).toBeLessThan(900);
    expect(world.stats.instances).toBe(edges.length);
    const byId = new Map(world.entities.map((e) => [e.id as string, e]));
    for (const edge of edges) {
      const p = byId.get(edge.targetId as string)?.props as Record<string, unknown>;
      expect(p['orbis/planned']).toBe(true);
      expect(String(p['orbis/occurred_on']) > VOLUME_TODAY).toBe(true);
    }
  });
  test('валюта и доходы: 10 % USD, часть RUB — без поля (правило owner_default_if_absent)', () => {
    expect(world.stats.usd).toBeGreaterThan(1500);
    expect(world.stats.currencyImplicit).toBeGreaterThan(5000);
    expect(world.stats.income).toBeGreaterThan(1000);
  });
});

describe('мир корпуса: слой Agenda и итог', () => {
  const world = buildVolumeWorld();
  test('2000 задач: все шесть статусов, срок в окне ±60 дней вокруг VOLUME_TODAY', () => {
    const tasks = world.entities.filter((e) => (e.aspects as string[]).includes('orbis/task'));
    expect(tasks).toHaveLength(VOLUME_TASKS);
    expect(
      new Set(tasks.map((t) => (t.props as Record<string, unknown>)['orbis/task_status'])),
    ).toEqual(new Set(['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled']));
    const due = tasks.map((t) => String((t.props as Record<string, unknown>)['orbis/due_date']));
    expect(due.some((d) => d < VOLUME_TODAY)).toBe(true); // просрочено — есть
    expect(due.some((d) => d > VOLUME_TODAY)).toBe(true); // впереди — есть
  });
  test('1000 событий: schedule со start_at и БЕЗ recurrence — материализация их не берёт', () => {
    const events = world.entities.filter((e) => {
      const a = e.aspects as string[];
      return a.includes('orbis/schedule') && !a.includes('orbis/financial');
    });
    expect(events).toHaveLength(VOLUME_EVENTS);
    expect(
      events.every((e) => (e.props as Record<string, unknown>)['orbis/recurrence'] === undefined),
    ).toBe(true);
  });
  test('итог 23 712 строк; id уникальны; тройки рёбер уникальны (rel_uniq); мир детерминирован', () => {
    expect(world.entities).toHaveLength(VOLUME_ENTITIES);
    expect(new Set(world.entities.map((e) => e.id)).size).toBe(VOLUME_ENTITIES);
    const triples = world.relations.map((r) => `${r.sourceId}|${r.targetId}|${r.role}`);
    expect(new Set(triples).size).toBe(world.relations.length);
    const again = buildVolumeWorld();
    expect(again.stats).toEqual(world.stats);
    expect(again.entities.slice(0, 50)).toEqual(world.entities.slice(0, 50));
    // `.at(-1)` статически даёт `T | undefined`, а `toEqual` этого в аргументе не принимает:
    // хвост берётся индексом, длина которого только что проверена строкой выше.
    const lastOf = (w: VolumeWorld) =>
      w.entities[VOLUME_ENTITIES - 1] as VolumeWorld['entities'][number];
    expect(lastOf(again)).toEqual(lastOf(world));
  });
});

describe('пробы сторожа Р-К-2', () => {
  const probes = volumeProbes();
  test('сто детерминированных движений; id совпадают с VOLUME_PROBE_IDS и не пересекают корпус', () => {
    expect(probes).toHaveLength(VOLUME_PROBE_COUNT);
    expect(probes.map((p) => p.id)).toEqual([...VOLUME_PROBE_IDS]);
    const corpus = new Set(buildVolumeWorld().entities.map((e) => e.id as string));
    expect(VOLUME_PROBE_IDS.some((id) => corpus.has(id))).toBe(false);
  });
  test('пробы покрывают обе ветки селектора и все три формы валюты', () => {
    expect(
      probes.some((p) => [volumeCategoryId(30), volumeCategoryId(31)].includes(p.categoryRef)),
    ).toBe(true);
    expect(probes.some((p) => p.currency === null)).toBe(true);
    expect(probes.some((p) => p.currency === 'USD')).toBe(true);
    expect(new Set(probes.map((p) => p.occurredOn.slice(0, 7))).size).toBe(VOLUME_MONTHS);
  });
  test('volumeCombination повторяет combinationOf: валюта по умолчанию, шаблон — null', () => {
    const p = probes.find((x) => x.currency === null) as VolumeProbe;
    expect(volumeCombination(volumeProbeProps(p), ['orbis/financial'])?.currency).toBe('RUB');
    expect(
      volumeCombination({ 'orbis/recurrence': { freq: 'monthly', interval: 1 } }, [
        'orbis/financial',
        'orbis/schedule',
      ]),
    ).toBeNull();
    expect(volumeCombination({}, ['orbis/task'])).toBeNull();
  });

  /**
   * Сторож Р-К-2 (Ф-Б1-13) против ОБОБЩЁННОГО хука, а не против литерала.
   *
   * Правило шаблона у сева (`volumeCombination`) и у хука (`bindingTargetOf`) — два разных
   * текста: сев пинился литералом `orbis/recurrence` под `orbis/schedule`, а хук читает его
   * из контура декларации. Разъедься они — оба сторожа остались бы зелёными порознь, а корпус
   * молча считал бы шаблон тратой. Здесь они сверяются напрямую и БЕЗ БД: контур собирается
   * из встроенных определений, `budgetContourOf` в базу не ходит.
   */
  test('Р-К-2: шаблонность у сева и у хука — одно правило (volumeCombination ⇔ bindingTargetOf)', () => {
    const reg = {
      aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
      contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    } as unknown as RegistrySnapshot;
    const contour = budgetContourOf(BUDGET_DEF, reg);
    const wire = (aspects: string[], props: Record<string, unknown>): WireEntity =>
      ({ id: VOLUME_PROBE_IDS[0] as string, aspects, props, archived: false }) as WireEntity;

    const p = probes.find((x) => x.currency === null) as VolumeProbe;
    const movement = wire(['orbis/financial'], volumeProbeProps(p));
    expect(volumeCombination(movement.props, movement.aspects) === null).toBe(
      bindingTargetOf(movement, contour)?.props === null,
    );
    expect(bindingTargetOf(movement, contour)?.props).not.toBeNull();

    const template = wire(
      ['orbis/financial', 'orbis/schedule'],
      { 'orbis/recurrence': { freq: 'monthly', interval: 1 } },
    );
    expect(volumeCombination(template.props, template.aspects) === null).toBe(
      bindingTargetOf(template, contour)?.props === null,
    );
    expect(bindingTargetOf(template, contour)?.props).toBeNull();
  });
});
