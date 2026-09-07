// Снимки четырёх поверхностей (§С8-20, консервативность §С1-3 п.9). Жанр — как у
// `tools/registry-golden.test.ts`: эталон снимается ОДИН РАЗ на посчитанном руками мире и
// дальше ЗАЩИЩАЕТ. «Записать что вышло» запрещено — расхождение разбирается, а намеренная
// правка пересдаётся ОТДЕЛЬНЫМ движением с объяснением в коммите.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { canonicalJson } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import GOLDEN from '../../test/golden/surfaces.json';
import { appDb, requireEnv, truncateAll } from '../../test/helpers';
import {
  compareSnapshots,
  SNAPSHOT_SURFACES,
  SURFACE_OWNER_ID,
  SURFACE_SLUGS,
  SURFACE_STATES,
  SURFACE_TODAY,
  type SurfaceState,
  seedSurfaceWorld,
  snapshotSurfaces,
} from '../../test/surfaces';
import { withIdentity } from '../db/with-identity';

requireEnv();
const { db, client } = appDb();
// Счёт идёт ПОД ЛИЧНОСТЬЮ владельца: у роли подключения нет прямых грантов на `entities`
// (гранты выданы роли `authenticated` — `0001_rls_and_indexes.sql:97`), и голый
// `db.execute` отвечает `permission denied for table entities`. Заодно RLS скоупит счёт
// связей владельцем — «ровно одно ребро dependency» становится утверждением про ЕГО мир.
const countOf = async (q: ReturnType<typeof sql>): Promise<number> =>
  withIdentity(
    db,
    SURFACE_OWNER_ID,
    async (tx) => ((await tx.execute(q)) as unknown as { n: number }[])[0]?.n ?? -1,
  );

beforeAll(async () => {
  await truncateAll();
  await seedSurfaceWorld(SURFACE_OWNER_ID);
});
afterAll(async () => {
  await client.end();
});

describe('снимки поверхностей: консервативность §С1-3 п.9', () => {
  test('мир снимков засеян целиком: 18 сущностей и ребро dependency', async () => {
    expect(
      await countOf(
        sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${SURFACE_OWNER_ID}`,
      ),
    ).toBe(SURFACE_SLUGS.length);
    expect(
      await countOf(sql`SELECT count(*)::int AS n FROM relations WHERE role = 'dependency'`),
    ).toBe(1);
  });

  test('снимок Budget снимается на той же tx, что чтения графа', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const ov = snap.surfaces['finance/budget-overview'];
    expect(ov.alertCount).toBe(1);
    expect(ov.balance).toEqual({ income: '50000.00', expense: '10700.00', balance: '39300.00' });
    expect(ov.envelopes.map((e) => [e.category.title, e.spent, e.remaining, e.dailyPace])).toEqual([
      ['Еда', '9000.00', '1000.00', '100.00'],
      ['Транспорт', '1000.00', '4000.00', '400.00'],
    ]);
    expect(ov.unbudgeted).toEqual([
      { category: { id: '@cat-coffee', title: 'Кофе', icon: '☕' }, total: '700.00' },
    ]);
    expect(ov.comingUp).toEqual([]);
  });
  test('снимок Agenda — три текста useAgenda с клиентскими правилами §4.1/§4.2', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    expect(snap.surfaces['planner/agenda']).toEqual([
      // `@tpl-weekly` (08:00) выборкой возвращён и снят фильтром шаблона.
      { section: 'window', id: '@event-today', title: 'Событие сегодня', at: '2026-07-03' },
      // Слияние двух выборок: min(due_date '2026-07-02', локальный день start_at '2026-07-01').
      { section: 'overdue', id: '@task-open', title: 'Задача просроченная', at: '2026-07-01' },
    ]);
  });
  test('снимок строки — четыре элемента M14 §1.8, и excludeBlocked прячет ровно одну цель', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const rows = snap.surfaces['core/row'];
    expect(Object.keys(rows).length).toBe(SURFACE_SLUGS.length);
    // Полная форма — целиком, а не по полю: «поля нет» и «поле пусто» обязаны быть различимы,
    // иначе задача 7 могла бы потерять элемент, и эталон этого не заметил бы.
    expect(rows['@task-done']).toEqual({
      checkbox: { closed: true, cls: 'done' },
      date: { value: '2026-07-01', slot: 'deadline' },
      amount: null,
      progress: null,
      badges: [],
    });
    // Класс — не сырой статус: `planned` относится к классу `active` картой привязки задачи 2.
    // Бейдж важности — единственный бейдж мира (мир не содержит отменённой задачи).
    expect(rows['@task-blocked']).toEqual({
      checkbox: { closed: false, cls: 'active' },
      date: { value: '2026-07-10', slot: 'deadline' },
      amount: null,
      progress: null,
      badges: [{ kind: 'priority' }],
    });
    // Два аспекта на одной записи: срок СИЛЬНЕЕ момента — тот же порядок, что задаёт `slots` M14.
    expect(rows['@task-open']?.date).toEqual({ value: '2026-07-02', slot: 'deadline' });
    expect(rows['@mv-food-1']?.amount).toEqual({
      amount: '3000.00',
      direction: 'outflow',
      currency: 'RUB',
    });
    expect(rows['@mv-salary']?.amount?.direction).toBe('inflow');
    // У операции даты нет: `orbis/occurred_on` слотом контракта «Когда» не объявлен (§Б5-6).
    expect(rows['@mv-food-1']?.date).toBeNull();
    expect(rows['@event-today']?.date).toEqual({
      value: '2026-07-03T10:00:00+03:00',
      slot: 'moment',
    });
    // Категория: ни одного контракта M14 её аспект не реализует — все пять полей пусты.
    expect(rows['@cat-food']).toEqual({
      checkbox: null,
      date: null,
      amount: null,
      progress: null,
      badges: [],
    });
    const visible = snap.surfaces['core/exclude-blocked'];
    expect(visible).not.toContain('@task-blocked');
    expect(visible.length).toBe(SURFACE_SLUGS.length - 1);
  });
  test('в снимке нет ни сырых uuid, ни машинных отметок времени: сравнимы два прогона и два состояния', async () => {
    const a = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const b = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    expect(compareSnapshots(a, b)).toEqual([]);
    const text = canonicalJson(a.surfaces);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // Ловится РОВНО форма `createdAt`/`updatedAt` базы (UTC с миллисекундами), а не всякий ISO:
    // моменты мира (`2026-07-03T10:00:00+03:00`) — данные снимка и обязаны в нём стоять.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(text).not.toContain('<uuid>'); // ни одного id мимо словаря слагов
  });
  test('baseline равен эталону surfaces.json по canonicalJson', async () => {
    const snap = await snapshotSurfaces(db, SURFACE_OWNER_ID, 'baseline', SURFACE_TODAY);
    const golden = (GOLDEN as { states: Record<string, Record<string, unknown>> }).states.baseline;
    // Сначала по поверхностям: расхождение читается человеком, дифф двух больших JSON — нет.
    for (const surface of SNAPSHOT_SURFACES) {
      expect(`${surface}: ${canonicalJson(snap.surfaces[surface])}`).toBe(
        `${surface}: ${canonicalJson(golden?.[surface])}`,
      );
    }
    expect(canonicalJson(snap.surfaces)).toBe(canonicalJson(golden));
  });
  test('эталон держит ровно объявленные состояния и все четыре поверхности', () => {
    const states = Object.keys((GOLDEN as { states: Record<string, unknown> }).states);
    expect(states).toEqual(['baseline']); // задача 10 добавит 'custom-aspect', задача 18 — ещё два
    for (const state of states) {
      expect(SURFACE_STATES).toContain(state as SurfaceState);
      const payload = (GOLDEN as { states: Record<string, Record<string, unknown>> }).states[state];
      expect(Object.keys(payload ?? {}).sort()).toEqual([...SNAPSHOT_SURFACES].sort());
    }
  });
});
