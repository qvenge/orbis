// apps/server/src/rules/page-rules.test.ts
// Правила аспекта «страница» (срез 1а §3.2) на боевом пути записи: две строки каталога Б-2
// (`page_wins_over_needs_template_for`, `page_wins_over_not_self`) и граница значения «Шаблон для»
// (`minItems: 1`). Через `execute()`, а не вызовом движка: предмет — РУБЕЖ записи, в частности то,
// что самоссылка отказывает ИМЕНОВАННЫМ инвариантом до эффектов ссылок, а не сырой ошибкой БД
// `rel_no_self` из зеркала `syncRefMirror`.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type GraphId,
  newId,
  PAGE_ASPECT,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
} from '@orbis/shared';
import { appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { execute } from '../executor/executor';
import type { ExecuteResult, WireEntity } from '../executor/types';

requireEnv();

const { db, client } = appDb();
beforeAll(async () => {
  await truncateAll();
});
afterAll(async () => {
  await client.end();
});

const T0 = new Date('2026-09-24T09:00:00.000Z');

function run(graph: GraphId, input: Record<string, unknown>): Promise<ExecuteResult> {
  return execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool: 'entity_create', input: { tags: [], aspects: [PAGE_ASPECT], ...input } }],
    clock: () => T0,
  });
}

function okId(r: ExecuteResult): string {
  if (!r.ok) throw new Error(`ожидался успех, получено ${JSON.stringify(r.error)}`);
  return (r.results[0] as WireEntity).id;
}

/** Отказ в форме «код/invariant-или-reason» — одна строка на сравнение, падение назовёт причину. */
function verdict(r: ExecuteResult): string {
  if (r.ok) return 'ok';
  const d = (r.error.details ?? {}) as { invariant?: string; reason?: string };
  return `${r.error.code}/${d.invariant ?? d.reason ?? '-'}`;
}

test('«Главнее, чем» без «Шаблон для» — INVARIANT page_wins_over_needs_template_for', async () => {
  const graph = await freshGraph();
  const other = okId(await run(graph, { title: 'Шаблон проекта' }));
  const bad = await run(graph, {
    title: 'Просто страница',
    props: { [TEMPLATE_WINS_OVER_PROPERTY]: [other] },
  });
  expect(verdict(bad)).toBe('INVARIANT/page_wins_over_needs_template_for');

  // Позитив той же формы: с непустым «Шаблон для» выбор законен.
  const good = await run(graph, {
    title: 'Второй шаблон проекта',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/project'], [TEMPLATE_WINS_OVER_PROPERTY]: [other] },
  });
  expect(verdict(good)).toBe('ok');
});

test('«Главнее, чем» со ссылкой на себя — INVARIANT page_wins_over_not_self, не сырая ошибка БД', async () => {
  const graph = await freshGraph();
  const self = newId();
  const bad = await run(graph, {
    id: self,
    title: 'Шаблон задачи',
    props: { [TEMPLATE_FOR_PROPERTY]: ['orbis/task'], [TEMPLATE_WINS_OVER_PROPERTY]: [self] },
  });
  expect(verdict(bad)).toBe('INVARIANT/page_wins_over_not_self');
});

test('«Шаблон для» пустым списком — отказ валидатора значений (minItems), а не молчаливое «присутствует»', async () => {
  const graph = await freshGraph();
  const bad = await run(graph, { title: 'Пустой шаблон', props: { [TEMPLATE_FOR_PROPERTY]: [] } });
  if (bad.ok) throw new Error('ожидался отказ, получен успех');
  expect(bad.error.code).toBe('VALIDATION');
  // Нарушение формы значения (ajv по `minItems`), а не правило каталога: код TYPE у свойства.
  const violations = (bad.error.details as { violations?: Array<Record<string, string>> })
    .violations;
  expect(violations?.map((v) => `${v.code}/${v.propertyId}`)).toEqual([
    `TYPE/${TEMPLATE_FOR_PROPERTY}`,
  ]);
  expect(violations?.[0]?.message).toContain('fewer than 1 items');
});

test('«Главнее, чем» при «Шаблон для» пустым списком — отказ: правило не обходится через []', async () => {
  // `present([])` истинно (Ф-1а-3): без `minItems: 1` у «Шаблон для» эта запись прошла бы мимо
  // правила `page_wins_over_needs_template_for` — отказ обязан быть.
  const graph = await freshGraph();
  const other = okId(await run(graph, { title: 'Шаблон проекта' }));
  const sneaky = await run(graph, {
    title: 'Шаблон ни для чего',
    props: { [TEMPLATE_FOR_PROPERTY]: [], [TEMPLATE_WINS_OVER_PROPERTY]: [other] },
  });
  expect(verdict(sneaky)).not.toBe('ok');
});
