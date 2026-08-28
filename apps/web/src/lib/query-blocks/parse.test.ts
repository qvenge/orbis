import { OWNER_LOCALE } from '@orbis/shared/query';
import { expect, test } from 'vitest';
import { BUILTIN_WIRE_ASPECTS, BUILTIN_WIRE_REGISTRY } from '../../test/registry';
import { buildQueryRegistry, registryOf } from './catalog';
import { parseBlock } from './parse';

const registry = buildQueryRegistry(BUILTIN_WIRE_ASPECTS, BUILTIN_WIRE_REGISTRY);

test('buildQueryRegistry ключует каталог по id свойства, а тип берёт из реестра', () => {
  // Ключ каталога — id свойства (§А5-7: его несёт узел `{prop}`), а не имя поля аспекта.
  expect(registry.catalog.fields['orbis/task_status']).toBeDefined();
  expect(registry.catalog.fields.status).toBeUndefined();
  // Тип — из `PropertyType`, а не из паттерна JSON Schema: у `orbis/routine_at` это `time`,
  // которого в старом словаре типов не было вовсе (он приезжал строкой).
  expect(registry.catalog.fields['orbis/routine_at']?.[0]?.kind).toBe('time');
});

test('buildQueryRegistry собирает снимок разбора: свойства, аспекты, роли', () => {
  expect(registry.parse.properties.get('orbis/task_status')?.key).toBe('orbis/task_status');
  expect(registry.parse.aspects.get('orbis/task')?.key).toBe('orbis/task');
  expect(registry.parse.roles.get('dependency')?.key).toBe('dependency');
});

// Половина снимка — не реестр: без одного из словарей разбор врал бы `UNKNOWN_FIELD` там, где
// имя просто ещё не доехало, а сборка «как есть» уронила бы экран на `undefined.map`.
test('registryOf: неполный снимок даёт null, полный — реестр', () => {
  expect(
    registryOf(BUILTIN_WIRE_ASPECTS, { properties: BUILTIN_WIRE_REGISTRY.properties }),
  ).toBeNull();
  expect(registryOf(BUILTIN_WIRE_ASPECTS, { roles: BUILTIN_WIRE_REGISTRY.roles })).toBeNull();
  expect(registryOf(undefined, BUILTIN_WIRE_REGISTRY)).toBeNull();
  expect(registryOf(BUILTIN_WIRE_ASPECTS, BUILTIN_WIRE_REGISTRY)).not.toBeNull();
});

// Колонка `view_config` nullable, и `null` означает «аспект без раскладки карточки». Форме
// запроса она не нужна вовсе, а разбор строгой схемой на ней падал бы — и уронил бы весь
// экран: error boundary у приложения нет.
test('buildQueryRegistry переживает аспект без viewConfig', () => {
  const wire = BUILTIN_WIRE_ASPECTS.map((a) => ({ ...a, viewConfig: null }));
  expect(() => buildQueryRegistry(wire, BUILTIN_WIRE_REGISTRY)).not.toThrow();
});

test('parseBlock снимает обёртку и разбирает блок новой грамматикой', () => {
  const r = parseBlock('{{query:aspect=orbis/task, orbis/task_status=inbox}}', registry.parse);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.ast.filter).toEqual({
      and: [{ aspect: 'orbis/task' }, { prop: 'orbis/task_status', op: 'eq', value: 'inbox' }],
    });
  }
});

// Мост старой формы обязан работать и на клиенте: тела сидированных смарт-листов до Задачи 21
// написаны голыми именами полей, и без моста каждый такой блок краснел бы плашкой при живом
// ответе сервера (`entity.query` их исполняет).
test('parseBlock принимает СТАРУЮ форму текста через мост', () => {
  const r = parseBlock('{{query:aspect=orbis/task, status=inbox}}', registry.parse);
  expect(r.ok).toBe(true);
  // Мост отдаёт КАНОН: имя разрешено в id свойства реестра, а не оставлено голым.
  if (r.ok) {
    expect(r.ast.filter).toEqual({
      and: [{ aspect: 'orbis/task' }, { prop: 'orbis/task_status', op: 'eq', value: 'inbox' }],
    });
  }
});

test('parseBlock: неизвестное свойство → отказ с кодом и позицией, а не пустой список', () => {
  const r = parseBlock('{{query:orbis/task_statuz=done}}', registry.parse);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe('UNKNOWN_FIELD');
    expect(typeof r.error.position).toBe('number');
  }
});

test('parseBlock: конструкция без оператора → SYNTAX с позицией', () => {
  const r = parseBlock('{{query:foo}}', registry.parse);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe('SYNTAX');
});

// Локаль снимка — ОБЩАЯ с сервером (`OWNER_LOCALE` в `@orbis/shared/query`), а не своя: по
// ней резолвится закавыченная подпись (§А5-3б), и две локали означали бы текст, который
// клиент принимает, а сервер отвергает.
test('снимок разбора построен общей с сервером локалью и резолвит подпись', () => {
  expect(registry.parse.locale).toBe(OWNER_LOCALE);
  const r = parseBlock('{{query:aspect=orbis/task, "Состояние задачи"=inbox}}', registry.parse);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.ast.filter).toEqual({
      and: [{ aspect: 'orbis/task' }, { prop: 'orbis/task_status', op: 'eq', value: 'inbox' }],
    });
  }
});
