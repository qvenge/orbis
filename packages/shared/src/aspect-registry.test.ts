// Сверка реестров в БД с кодом — чистая половина стартовой проверки дрейфа (ловушка
// релиза, §А12-1 п.4). Серверная половина (чтение шести таблиц под ролью приложения)
// живёт в apps/server/src/db/registry-drift.test.ts.
import { expect, test } from 'bun:test';
import {
  canonicalJson,
  diffBuiltinRegistries,
  hasRegistryDrift,
  type RegistryDbRows,
  registryDriftIds,
  registryDriftReport,
} from './aspect-registry';
import { BUILTIN_ASPECT_IDS } from './constants';
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META, BUILTIN_RELATION_ROLE_META } from './registry';

/**
 * Реестры «как после свежего пересева» — эталон, от которого отходит каждый тест.
 * Ключи строк — имена КОЛОНОК (snake_case), ровно как их отдаёт SELECT сидера.
 */
function seeded(): RegistryDbRows {
  return {
    properties: BUILTIN_PROPERTY_META.map((p) => ({
      id: p.id,
      key: p.key,
      label: p.label,
      description: p.description,
      type: p.type,
      status: p.status,
      storage: p.storage,
      scope: p.scope,
      merged_into: p.mergedInto,
      module: p.module,
      rank: p.rank,
      flags: p.flags,
    })),
    aspects: BUILTIN_ASPECT_DEFS.map((a) => ({
      id: a.id,
      key: a.key,
      label: a.label,
      description: a.description,
      properties: a.properties,
      ai_instructions: a.aiInstructions,
      tag_mappings: a.tagMappings,
      implements: a.implements,
      view_config: a.viewConfig,
      module: a.module,
      service: a.service,
      rank: a.rank,
    })),
    roles: BUILTIN_RELATION_ROLE_META.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
      description: r.description,
      source_label: r.sourceLabel,
      target_label: r.targetLabel,
      hierarchical: r.hierarchical,
      constraints: r.constraints,
      symmetric: r.symmetric,
      module: r.module,
      rank: r.rank,
    })),
    contracts: [],
    subscriptions: [],
    actions: [],
  };
}

const EMPTY = { missing: [], drifted: [], extra: [] };

/**
 * `BUILTIN_ASPECT_DEFS` — МАССИВ, а не `Record<AspectId, …>`, поэтому забытая запись не
 * ловится typecheck'ом: аспект без строки не попадает ни в сид реестра, ни в attach_*-тулы,
 * ни в реестр UI — то есть приезжает полумёртвым молча. Прежде эту дыру закрывала сверка со
 * ВТОРЫМ реестром (`BUILTIN_ASPECT_META`), снятым «Пересевом мира»; теперь — прямой счёт.
 */
test('каждому BUILTIN_ASPECT_IDS соответствует ровно одна строка BUILTIN_ASPECT_DEFS', () => {
  const ids = BUILTIN_ASPECT_DEFS.map((a) => a.id);
  expect([...ids].sort()).toEqual([...BUILTIN_ASPECT_IDS].sort());
  expect(new Set(ids).size).toBe(ids.length); // дублей нет
});

test('canonicalJson: порядок КЛЮЧЕЙ не значим (jsonb его не хранит)', () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test('canonicalJson: порядок МАССИВА значим (enum/required в JSON Schema)', () => {
  expect(canonicalJson({ required: ['a', 'b'] })).not.toBe(canonicalJson({ required: ['b', 'a'] }));
});

test('свежий пересев трёх реестров — расхождений нет, три пустых реестра тоже чисты', () => {
  const drift = diffBuiltinRegistries(seeded());
  expect(drift).toEqual({
    properties: EMPTY,
    aspects: EMPTY,
    roles: EMPTY,
    contracts: EMPTY,
    subscriptions: EMPTY,
    actions: EMPTY,
  });
  expect(hasRegistryDrift(drift)).toBe(false);
  expect(registryDriftIds(drift)).toEqual([]);
});

test('строка прошла через jsonb (ключи переставлены) — это НЕ дрейф', () => {
  // Ровно то, что делает PostgreSQL с jsonb: ключи возвращаются в своём порядке.
  const rows = seeded();
  rows.aspects = rows.aspects.map((r) => ({
    ...r,
    view_config: Object.fromEntries(
      Object.entries(r.view_config as Record<string, unknown>).reverse(),
    ) as unknown,
  }));
  expect(hasRegistryDrift(diffBuiltinRegistries(rows))).toBe(false);
});

test('свойства: нет строки — missing; разошёлся label — drifted с именем СТОЛБЦА', () => {
  const rows = seeded();
  rows.properties = rows.properties
    .filter((r) => r.id !== 'orbis/task_status')
    .map((r) => (r.id === 'orbis/due_date' ? { ...r, label: { ru: 'Не тот', en: 'Wrong' } } : r));
  const drift = diffBuiltinRegistries(rows);
  expect(drift.properties.missing).toEqual(['orbis/task_status']);
  expect(drift.properties.drifted).toEqual([{ id: 'orbis/due_date', what: ['label'] }]);
  expect(drift.properties.extra).toEqual([]);
  expect(hasRegistryDrift(drift)).toBe(true);
  expect(registryDriftIds(drift)).toEqual([
    'properties:orbis/task_status нет',
    'properties:orbis/due_date label',
  ]);
});

test('свойства: разошлись два столбца — названы оба, по алфавиту', () => {
  const rows = seeded();
  rows.properties = rows.properties.map((r) =>
    r.id === 'orbis/amount' ? { ...r, type: { kind: 'text' }, rank: 999 } : r,
  );
  expect(diffBuiltinRegistries(rows).properties.drifted).toEqual([
    { id: 'orbis/amount', what: ['rank', 'type'] },
  ]);
});

// Р-23: односторонняя сверка (только «в коде есть → ищем в БД») пропускала запись,
// удалённую из кода, — она продолжала валидировать данные в проде молча.
test('ЛИШНЯЯ system-строка — тоже дрейф (двусторонняя сверка, Р-23)', () => {
  const rows = seeded();
  rows.properties = [
    ...rows.properties,
    { id: 'orbis/zzz', key: 'orbis/zzz', label: {}, description: {}, type: {}, rank: 0 },
  ];
  const drift = diffBuiltinRegistries(rows);
  expect(drift.properties.extra).toEqual(['orbis/zzz']);
  expect(hasRegistryDrift(drift)).toBe(true);
  expect(registryDriftReport(drift)).toContain(
    '  ✗ properties/orbis/zzz: в БД ЕСТЬ, в коде НЕТ (лишняя)',
  );
});

test('аспекты: устарел набор properties — дрейф по имени столбца', () => {
  // Колонки `schema` у аспекта больше НЕТ (contract-миграция 0017): JSON Schema —
  // генерируемая производная реестра свойств (§А3-1). Прежде расхождение по ней и было
  // главной ловушкой релиза; теперь ту же роль играет сам набор ссылок на свойства.
  const rows = seeded();
  rows.aspects = rows.aspects.map((r) =>
    r.id === 'orbis/financial' ? { ...r, properties: [] } : r,
  );
  const drift = diffBuiltinRegistries(rows);
  expect(drift.aspects.drifted).toEqual([{ id: 'orbis/financial', what: ['properties'] }]);
  // Сводка обязана поднять расхождение ИМЕННО ЭТОГО реестра: без этих двух строк реестр,
  // выпавший из обхода `hasRegistryDrift`/`registryDriftIds`, дал бы зелёный /health при
  // красном поле в структуре — то есть ловушку, снятую молча.
  expect(hasRegistryDrift(drift)).toBe(true);
  expect(registryDriftIds(drift)).toEqual(['aspects:orbis/financial properties']);
});

test('аспекты: устарели ai_instructions — дрейф (они уезжают в описания attach_*-тулов)', () => {
  const rows = seeded();
  rows.aspects = rows.aspects.map((r) =>
    r.id === 'orbis/task' ? { ...r, ai_instructions: 'старый текст' } : r,
  );
  expect(diffBuiltinRegistries(rows).aspects.drifted).toEqual([
    { id: 'orbis/task', what: ['ai_instructions'] },
  ]);
});

test('роли: разошёлся source_label — дрейф с именем столбца (Ч10-С3)', () => {
  const rows = seeded();
  rows.roles = rows.roles.map((r) =>
    r.id === 'envelope-binding' ? { ...r, source_label: { ru: 'Родитель' } } : r,
  );
  const drift = diffBuiltinRegistries(rows);
  expect(drift.roles.drifted).toEqual([{ id: 'envelope-binding', what: ['source_label'] }]);
  expect(hasRegistryDrift(drift)).toBe(true);
  expect(registryDriftIds(drift)).toEqual(['roles:envelope-binding source_label']);
});

// §А12-1: контракты и подписки создаются срезом А ПУСТЫМИ, их сиды — первый акт Б-1.
// Строка, положенная раньше гейта П5, обязана быть видна как дрейф, а не как «уже готово».
test('контракты/подписки/действия: любая system-строка — extra (в срезе А они пусты)', () => {
  const rows = seeded();
  rows.contracts = [{ id: 'orbis/completable' }];
  rows.actions = [{ id: 'orbis/close' }];
  const drift = diffBuiltinRegistries(rows);
  expect(drift.contracts).toEqual({ missing: [], drifted: [], extra: ['orbis/completable'] });
  expect(drift.actions).toEqual({ missing: [], drifted: [], extra: ['orbis/close'] });
  expect(drift.subscriptions).toEqual(EMPTY);
  expect(hasRegistryDrift(drift)).toBe(true);
  expect(registryDriftIds(drift)).toEqual([
    'contracts:orbis/completable лишний',
    'actions:orbis/close лишний',
  ]);
});

test('registryDriftIds: плоский список для /health называет и реестр, и id', () => {
  const rows = seeded();
  rows.properties = rows.properties.filter((r) => r.id !== 'orbis/task_status');
  rows.subscriptions = [{ id: 'orbis/agenda' }];
  expect(registryDriftIds(diffBuiltinRegistries(rows))).toEqual([
    'properties:orbis/task_status нет',
    'subscriptions:orbis/agenda лишний',
  ]);
});

test('orbis/routine: ai_instructions называют умолчание автономии — без явной просьбы владельца mode: propose (V1, PRD 02 §3.4)', () => {
  // Умолчания в схеме нет намеренно (mode обязателен): предохранитель — указание модели
  // здесь плюс гейт explicit-confirmation на выдачу act (policy/confirmation.ts).
  const routine = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/routine');
  expect(routine?.aiInstructions).toContain('mode: propose');
  expect(routine?.aiInstructions).toContain('Без явной просьбы владельца');
});
