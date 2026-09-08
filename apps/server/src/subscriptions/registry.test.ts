// apps/server/src/subscriptions/registry.test.ts
// Валидатор декларации подписки (§Б5-1, §Б5-2) и разрешение слота у сущности (§С8-21).
// Первые три describe — чистые: вход это готовый снимок реестра и литерал декларации, живая
// база к ответу ничего не добавляет. Четвёртый и пятый — против БД: конфликт слота живёт у
// СУЩНОСТИ, и собрать его можно только двумя настоящими привязками в реестре владельца.
import { afterAll, describe, expect, test } from 'bun:test';
import { AGENDA_DEF, BUDGET_DEF } from '@orbis/shared';
import { appDb, requireEnv } from '../../test/helpers';
import { exprSitesOf, rawValueRefs } from './registry';

requireEnv();

const { client } = appDb();

afterAll(async () => {
  await client.end();
});

describe('позиции языка E в декларации и сырые ссылки (§Б5-2)', () => {
  test('agenda: четыре позиции E с путями', () => {
    expect(exprSitesOf(AGENDA_DEF).map((s) => s.path)).toEqual([
      'show.window.from',
      'show.window.to',
      'overdue.before',
      'overdue.where',
    ]);
  });
  test('{prop} внутри where — сырая ссылка, её путь уезжает в пометку raw_value диффа Ш1', () => {
    const where = {
      op: 'and',
      args: [
        { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: ['active'] }] },
        { op: '!=', args: [{ prop: 'orbis/task_status' }, { const: 'waiting' }] },
      ],
    };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, where } } as never),
    ).toEqual(['overdue.where.args.1.args.0']);
  });
  test('deref по слоту сырой ссылкой НЕ считается: read — адрес свойства по построению', () => {
    const before = { deref: { slot: 'moment', read: 'orbis/title' } };
    expect(
      rawValueRefs({ ...AGENDA_DEF, overdue: { ...AGENDA_DEF.overdue, before } } as never),
    ).toEqual([]);
  });
  test('budget: позиции — фазы, формулы, where сумм и окна списков', () => {
    expect(exprSitesOf(BUDGET_DEF).map((s) => s.path)).toContain('aggregates.daily_pace.expr');
  });
});
