// apps/server/src/registry/deps-graph.test.ts
// Граф зависимостей реестра (§А3-5, §С1-3 п.10) — юнитом по снимку: БД тут не нужна, и её
// отсутствие — часть утверждения, что правила графа одни у сервера и у экрана (срез Б-3).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META } from '@orbis/shared';
import { ExecError } from '../errors';
import { assertAcyclicGraph, dependantsOf, dependencyGraph } from './deps-graph';
import type { RegistrySnapshot } from './load';

const OWNER = '00000000-0000-4000-8000-0000000000aa';

/** Снимок из встроенного словаря плюс переданные свои строки — как его отдал бы `load.ts`. */
function snapshot(
  extra: {
    properties?: Array<Record<string, unknown>>;
    aspects?: Array<Record<string, unknown>>;
  } = {},
): RegistrySnapshot {
  const properties = new Map(
    BUILTIN_PROPERTY_META.map((d) => [d.id, { ...d, ownerId: null } as never]),
  );
  const aspects = new Map(BUILTIN_ASPECT_DEFS.map((d) => [d.id, { ...d, ownerId: null } as never]));
  for (const p of extra.properties ?? []) properties.set(p.id as string, p as never);
  for (const a of extra.aspects ?? []) aspects.set(a.id as string, a as never);
  return { properties, aspects, roles: new Map(), ownerVersion: 1, systemVersion: 1 };
}

describe('dependencyGraph / dependantsOf (§А3-5)', () => {
  test('dependantsOf(orbis/task_status) содержит orbis/task и сохранённые запросы, где он упомянут', () => {
    const reg = snapshot();
    const goal = '11111111-1111-4111-8111-111111111111';
    const body = '22222222-2222-4222-8222-222222222222';
    const graph = dependencyGraph(reg, {
      queryRefs: new Map([
        // Источник прогресса цели держит ДЕРЕВО и называет свойство id'ом…
        [goal, ['orbis/task_status']],
        // …а блок `{{query:…}}` в теле — ТЕКСТ, и там то же свойство названо ключом.
        // Обе формы обязаны дать одного и того же зависящего.
        [body, ['orbis/task_status', 'orbis/due_date']],
      ]),
    });
    const dependants = dependantsOf(graph, 'orbis/task_status');
    expect(dependants).toContain('orbis/task');
    expect(dependants).toContain(goal);
    expect(dependants).toContain(body);
    // Ключ и id — одно свойство: второго узла для той же строки реестра быть не должно.
    expect(dependants.filter((d) => d === body)).toHaveLength(1);
    // Свойство, которого держатель не называл, зависимости не получает.
    expect(dependantsOf(graph, 'orbis/due_date')).toContain(body);
    expect(dependantsOf(graph, 'orbis/due_date')).not.toContain(goal);
  });

  test('scope и ref.target дают рёбра ОТ свойства к названному аспекту (одно направление)', () => {
    const reg = snapshot({
      properties: [
        {
          id: 'user/effort',
          ownerId: OWNER,
          key: 'user/effort',
          label: { ru: 'Усилие' },
          description: { ru: 'Сколько сил' },
          type: { kind: 'number' },
          status: 'active',
          storage: 'props',
          scope: { filter: { aspect: 'orbis/task' } },
          mergedInto: null,
          module: null,
          rank: 900,
          flags: {},
        },
      ],
    });
    const graph = dependencyGraph(reg, { queryRefs: new Map() });
    expect(graph.edges).toContainEqual({ from: 'user/effort', to: 'orbis/task', kind: 'scope' });
    // Ребро ровно одно и ровно в эту сторону: `dependantsOf(orbis/task)` называет свойство,
    // а `dependantsOf(user/effort)` про аспект не знает.
    expect(dependantsOf(graph, 'orbis/task')).toContain('user/effort');
    expect(dependantsOf(graph, 'user/effort')).not.toContain('orbis/task');
    // ref.target встроенного `orbis/rule_target` смотрит на аспект категории.
    expect(graph.edges).toContainEqual({
      from: 'orbis/rule_target',
      to: 'orbis/category',
      kind: 'ref.target',
    });
  });

  test('merged_into даёт ребро преемственности — по нему и ловится цикл указателей', () => {
    const reg = snapshot({
      properties: [
        {
          id: 'user/a',
          ownerId: OWNER,
          key: 'user/a',
          label: { ru: 'A' },
          description: { ru: 'A' },
          type: { kind: 'number' },
          status: 'deprecated',
          storage: 'props',
          scope: null,
          mergedInto: 'user/b',
          module: null,
          rank: 901,
          flags: {},
        },
        {
          id: 'user/b',
          ownerId: OWNER,
          key: 'user/b',
          label: { ru: 'B' },
          description: { ru: 'B' },
          type: { kind: 'number' },
          status: 'deprecated',
          storage: 'props',
          scope: null,
          mergedInto: 'user/a',
          module: null,
          rank: 902,
          flags: {},
        },
      ],
    });
    const graph = dependencyGraph(reg, { queryRefs: new Map() });
    expect(graph.edges).toContainEqual({ from: 'user/a', to: 'user/b', kind: 'merged_into' });
    let thrown: unknown;
    try {
      assertAcyclicGraph(graph);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ExecError);
    expect((thrown as ExecError).code).toBe('REGISTRY_CYCLE');
    // Путь в details — не украшение: без него отказ по графу в сотню рёбер нечитаем.
    expect((thrown as ExecError).details).toMatchObject({ cycle: expect.any(Array) });
  });

  test('встроенный реестр ацикличен — проверка не отказывает на здоровом графе', () => {
    expect(() =>
      assertAcyclicGraph(dependencyGraph(snapshot(), { queryRefs: new Map() })),
    ).not.toThrow();
  });

  test('имя держателя, которого нет в реестре, узлом не становится (опечатка ≠ зависимость)', () => {
    const holder = '33333333-3333-4333-8333-333333333333';
    const graph = dependencyGraph(snapshot(), {
      queryRefs: new Map([[holder, ['user/net-takogo']]]),
    });
    expect(dependantsOf(graph, 'user/net-takogo')).toEqual([]);
    expect(graph.edges.some((e) => e.from === holder)).toBe(false);
  });
});
