// apps/server/src/executor/legacy-input-rejected.test.ts
// ПРИЁМКА §С8-10, пункт 13 «Пересева мира»: дверь за старой формой ВХОДА закрыта, и это
// проверяется, а не подразумевается.
//
// Почему отдельным файлом. Утверждение здесь ровно одно и оно про ГРАНИЦУ, а не про
// поведение какой-то операции: старая карта `{аспект: {поле: значение}}` больше не форма
// входа, и путь, приславший её, обязан получить внятный отказ, а не молча записать половину
// (или, хуже, ничего). Живи эта проверка внутри `props.test.ts`, она читалась бы как ещё
// один случай слияния — а это закрытая дверь, и её место видно.
//
// ДВЕ ПОЛОВИНЫ, И ВТОРАЯ НЕ УКРАШЕНИЕ:
//  1. ВХОД: `entity_create`/`entity_update`/`batch_execute` со старой картой → `VALIDATION`.
//     Отвечает контракт (`entityCreateExecInput`/`entityUpdateExecInput`), а не догадка
//     исполнителя: `aspects` объявлен списком строк либо `{attach, detach}`, и карта
//     объектов ему не подходит.
//  2. КОД: функции, которая эту карту разбирала, в дереве НЕТ. Без второй половины первая
//     оставалась бы обратимой одной строкой — вернуть union в контракт и получить
//     работающий вход обратно; с ней возвращать нечего.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from './executor';
import type { ExecuteRequest } from './types';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function req(tool: string, input: Record<string, unknown>): ExecuteRequest {
  return {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'chat',
    mechanism: 'user',
    operations: [{ tool, input }],
  };
}

/** Старая карта — та самая форма, которой писали до реформы: `{аспект: {поле: значение}}`. */
const LEGACY_MAP = { 'orbis/task': { status: 'inbox', priority: 'high' } };

test('entity_create со старой картой aspects → VALIDATION, строка не появляется', async () => {
  const id = newId();
  const r = await execute(
    db,
    req('entity_create', { id, title: 'Задача старой формой', tags: [], aspects: LEGACY_MAP }),
  );
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('старая карта не должна была пройти');
  expect(r.error.code).toBe('VALIDATION');

  // Отказ ДО записи, а не после половины: строки в графе нет вовсе.
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${id}`),
  );
  expect((rows[0] as { n: number }).n).toBe(0);
});

test('entity_update со старой картой aspects → VALIDATION', async () => {
  const id = newId();
  const created = await execute(
    db,
    req('entity_create', {
      id,
      title: 'Задача новой формой',
      tags: [],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    }),
  );
  expect(created.ok).toBe(true);

  const r = await execute(db, req('entity_update', { id, aspects: LEGACY_MAP }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('старая карта не должна была пройти');
  expect(r.error.code).toBe('VALIDATION');
});

test('detach старой формой (`{аспект: null}`) — тоже VALIDATION, а не молчаливый no-op', async () => {
  const id = newId();
  const created = await execute(
    db,
    req('entity_create', { id, title: 'Заметка', tags: [], aspects: ['orbis/note'] }),
  );
  expect(created.ok).toBe(true);

  // В старой форме `null` вместо объекта означал detach аспекта. Молчаливый no-op здесь был
  // бы худшим исходом: владелец думает, что снял аспект, а он на месте.
  const r = await execute(db, req('entity_update', { id, aspects: { 'orbis/note': null } }));
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('старая карта не должна была пройти');
  expect(r.error.code).toBe('VALIDATION');
});

test('в дереве нет ни `fromLegacyInput`, ни модуля `executor/legacy-form.ts`', async () => {
  // Греп по рабочему дереву, а не импорт: проверяется ОТСУТСТВИЕ, и `import` его не выразит
  // (несуществующий модуль просто не соберётся, и тест не запустится вовсе).
  const grep = Bun.spawnSync(
    [
      'git',
      'grep',
      '-l',
      '-P',
      '-e',
      '\\bfromLegacyInput\\b',
      '-e',
      'executor/legacy-form\\.ts',
      '--',
      'apps',
      'packages',
      'scripts',
      ':!scripts/check-legacy-form.ts',
      ':!scripts/legacy-aspects-map.test.ts',
      ':!apps/server/src/executor/legacy-input-rejected.test.ts',
    ],
    { cwd: `${import.meta.dir}/../../../..`, stdout: 'pipe', stderr: 'pipe' },
  );
  // git grep: 1 — совпадений нет (то, чего мы и ждём), 0 — нашлись, >1 — отказ окружения.
  if (grep.exitCode > 1) {
    throw new Error(`git grep вернул ${grep.exitCode}: ${new TextDecoder().decode(grep.stderr)}`);
  }
  expect(new TextDecoder().decode(grep.stdout).trim()).toBe('');
});
