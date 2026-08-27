// apps/server/src/registry/roles.test.ts
// Пин двух исполнителей ОДНОГО правила (см. шапку roles.ts): подзапрос `hierarchicalRolesSql`
// и снимок `hierarchicalRoles(reg)` обязаны давать один и тот же список — иначе бюджет,
// круг исполнителя и компилятор запросов начали бы ходить по разным множествам ролей.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  ROLE_CATEGORY_PARENT,
  ROLE_DEPENDENCY,
  ROLE_ENVELOPE_BINDING,
  ROLE_INSTANCE_OF,
  ROLE_MENTION,
  ROLE_RUN,
  ROLE_SUBITEM,
  ROLE_TICKET,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { loadRegistry } from './load';
import { hierarchicalRoles, hierarchicalRolesSql } from './roles';

requireEnv();

const { db, client } = appDb();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

async function fromSql(owner: string): Promise<string[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id FROM (${hierarchicalRolesSql()}) h ORDER BY id`),
  );
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}

test('иерархические роли: подзапрос и снимок реестра дают один список', async () => {
  const owner = freshUserId();
  const snapshot = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
  expect(await fromSql(owner)).toEqual(hierarchicalRoles(snapshot).sort());
  // Встроенный состав §А4-3: `envelope-binding` в семейство иерархии НЕ входит
  expect(await fromSql(owner)).toEqual(['category-parent', 'run', 'subitem', 'ticket']);
});

test('своя строка роли перекрывает встроенную: снятый признак иерархии виден обоим', async () => {
  const owner = freshUserId();
  // Реестровых операций ещё нет (Задача 15) — своя строка кладётся напрямую, как это
  // делает админский сид системных строк.
  await withIdentity(db, owner, (tx) =>
    tx.execute(sql`
      INSERT INTO relation_role_definitions
        (id, owner_id, key, label, description, source_label, target_label,
         hierarchical, constraints, "symmetric", module, rank)
      SELECT id, ${owner}::uuid, key, label, description, source_label, target_label,
             false, constraints, "symmetric", module, rank
        FROM relation_role_definitions WHERE id = 'subitem' AND owner_id IS NULL`),
  );
  const snapshot = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
  expect(hierarchicalRoles(snapshot).sort()).toEqual(['category-parent', 'run', 'ticket']);
  expect(await fromSql(owner)).toEqual(['category-parent', 'run', 'ticket']);
});

/**
 * ЯКОРЬ ПОИМЁННЫХ РОЛЕЙ (`@orbis/shared/constants`). `satisfies RelationRoleId` проверяет
 * только то, что константа — ОДНА ИЗ одиннадцати ролей; что она именно ТА, чьё имя носит,
 * не проверяет ничто: repoint `ROLE_RUN` на `subitem` собирается молча, а писатель и
 * читатель, взявшие одну константу, разъезжаются согласованно и сквозной тест этого не
 * видит (проверено мутациями G4/G5 ре-ревью).
 *
 * Независимый оракул здесь — РУССКАЯ ПОДПИСЬ роли из сида: она приходит из
 * `builtin-roles.ts` отдельным литералом и переживает переименование id. Читается из ЖИВОЙ
 * базы, поэтому заодно проверяет, что константа вообще резолвится в реестре владельца.
 */
test('каждая поимённая роль указывает на ту роль, чьё имя носит (подпись из сида)', async () => {
  const owner = freshUserId();
  const reg = await withIdentity(db, owner, (tx) => loadRegistry(tx, owner));
  const labelOf = (id: string): string | undefined => reg.roles.get(id)?.label.ru;
  expect(labelOf(ROLE_SUBITEM)).toBe('Подпункт');
  expect(labelOf(ROLE_TICKET)).toBe('Тикет');
  expect(labelOf(ROLE_INSTANCE_OF)).toBe('Экземпляр шаблона');
  expect(labelOf(ROLE_ENVELOPE_BINDING)).toBe('Привязка к конверту');
  expect(labelOf(ROLE_RUN)).toBe('Прогон');
  expect(labelOf(ROLE_CATEGORY_PARENT)).toBe('Родительская категория');
  expect(labelOf(ROLE_MENTION)).toBe('Упоминание');
  expect(labelOf(ROLE_DEPENDENCY)).toBe('Зависимость');
});
