import { describe, expect, test } from 'bun:test';
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
  VOLUME_TASKS,
  VOLUME_TEMPLATES,
  VOLUME_TODAY,
  VOLUME_TXNS,
  type VolumeWorld,
  volumeCategoryId,
  volumeMonth,
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
