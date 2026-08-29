// apps/server/src/routers/registry.test.ts
// Тесты роутера registry (§А9-2): эффективный реестр владельца одним ответом и версия
// снимка, по которой клиент решает, перечитывать ли его. Против живой БД, caller как в бою.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { bumpOwnerRegistryVersion } from '../registry/version';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

const owner = freshUserId();
const a = callerFor(owner);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('registry.effective (§А9-2)', () => {
  test('владельцу без единой своей строки едут ВСЕ встроенные: 77 свойств, 13 аспектов, 11 ролей', async () => {
    const reg = await a.registry.effective();
    // Счёт литералами, а не длиной встроенных массивов: снимок §А8 нормативен, и «сколько
    // сид положил» здесь должно совпасть со «сколько спека назвала», а не с самим собой.
    expect(reg.properties.length).toBe(77);
    expect(reg.aspects.length).toBe(13);
    expect(reg.roles.length).toBe(11);
  });

  test('label и description едут ПОЛНЫМИ per-locale картами — локаль выбирает клиент', async () => {
    const reg = await a.registry.effective();
    const status = reg.properties.find((p) => p.id === 'orbis/task_status');
    // Обе локали в ОДНОМ ответе: свёртка на сервере означала бы новый запрос на каждую
    // смену языка, и это ровно та проверка, ради которой карта не сворачивается.
    expect(status?.label).toEqual({ ru: 'Состояние задачи', en: 'Task status' });
    expect(Object.keys(status?.description ?? {}).sort()).toEqual(['en', 'ru']);
    const task = reg.aspects.find((x) => x.id === 'orbis/task');
    expect(task?.label.ru).toBe('Задача');
    expect(task?.label.en).toBeDefined();
    const role = reg.roles.find((r) => r.id === 'subitem');
    expect(role?.label.ru).toBeDefined();
    expect(role?.label.en).toBeDefined();
  });

  test('версия — `<системная>.<владельца>`, и ту же строку отдаёт entity.get', async () => {
    const reg = await a.registry.effective();
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = (await admin.execute(
        sql`SELECT version FROM registry_system WHERE id = 1`,
      )) as unknown as Array<{ version: number }>;
      // Половина владельца у него нулевая: своих строк реестра нет, строки настроек тоже.
      expect(reg.version).toBe(`${rows[0]?.version}.0`);
    } finally {
      await adminClient.end();
    }

    // Тот же снимок — та же строка в ДРУГОМ ответе (§А10-1): несовпадение здесь означало бы
    // клиент, перечитывающий реестр на каждом открытии записи, и оба формата склейки
    // пришлось бы держать в голове.
    const id = newId();
    await a.entity.create({
      input: {
        id,
        title: 'Запись',
        tags: [],
        props: {
          'orbis/task_status': 'inbox',
        },
        aspects: ['orbis/task'],
      },
      source: 'quick_capture',
    });
    const got = await a.entity.get({ id });
    expect(got.registryVersion).toBe(reg.version);
  });

  test('своя строка реестра владельца ПЕРЕКРЫВАЕТ встроенную, а не добавляется рядом', async () => {
    // Форма ответа не предполагает «только встроенные»: пользовательские строки едут тем же
    // массивом. Проба — переопределением встроенного аспекта (тот же id, свой owner_id):
    // счёт аспектов обязан остаться прежним, а подпись — стать своей.
    const other = freshUserId();
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(sql`
        INSERT INTO aspect_definitions
          (id, owner_id, key, label, description, properties, ai_instructions, tag_mappings,
           view_config, module, service, rank)
        SELECT id, ${other}::uuid, key, '{"ru":"Дело","en":"Deed"}'::jsonb, description,
               properties, ai_instructions, tag_mappings, view_config, module, service, rank
          FROM aspect_definitions WHERE id = 'orbis/task' AND owner_id IS NULL`);
      await bumpOwnerRegistryVersion(admin, other); // мутация реестра двигает версию (§А10-1)
    } finally {
      await adminClient.end();
    }

    const reg = await callerFor(other).registry.effective();
    expect(reg.aspects.length).toBe(13);
    expect(reg.aspects.find((x) => x.id === 'orbis/task')?.label.ru).toBe('Дело');
    // А у соседа — по-прежнему встроенная: RLS скоупит выдачу владельцем.
    expect(
      (await a.registry.effective()).aspects.find((x) => x.id === 'orbis/task')?.label.ru,
    ).toBe('Задача');
  });
});

describe('registry.dependants: честные зависимости (§А3-5, §С1-3 п.10)', () => {
  const depOwner = freshUserId();
  const dep = callerFor(depOwner);

  test('ссылочное свойство, чья ЦЕЛЬ называет другое свойство, в ответе есть', async () => {
    // Единственный источник факта «свойство A стоит на свойстве B» — держатель рода
    // `registry`: собственные рёбра графа (`scope`, `ref.target`) ведут в АСПЕКТЫ, а не в
    // свойства. Отсеять его значит отвечать владельцу «на нём не стоит никто» ровно тогда,
    // когда на свойстве держится множество цели живой ссылки.
    const target = await dep.registry.createProperty({
      key: 'user/dep-target',
      label: { ru: 'Цель зависимости' },
      description: { ru: 'На него ссылаются' },
      type: { kind: 'number' },
      status: 'active',
    });
    const targetId = (target as { property: string }).property;
    const holder = await dep.registry.createProperty({
      key: 'user/dep-holder',
      label: { ru: 'Держатель ссылки' },
      description: { ru: 'Его цель фильтрует по dep-target' },
      type: {
        kind: 'ref',
        target: {
          filter: {
            and: [{ aspect: 'orbis/task' }, { prop: targetId, op: 'gt', value: 1 }],
          },
        },
      },
      status: 'active',
    });
    const holderId = (holder as { property: string }).property;

    const answer = await dep.registry.dependants({ property: 'user/dep-target' });
    expect(answer.property).toBe(targetId);
    expect(answer.dependants).toContain(holderId);
  });

  test('дельта аспекта в ответ НЕ едет строкой `registry_deltas` — только аспектом', async () => {
    // У держателя-дельты `id` — uuid строки настройки, владельцу нечем его истолковать; сама
    // зависимость приезжает ребром `aspect`, потому что дельта уже сложена в снимок.
    const prop = await dep.registry.createProperty({
      key: 'user/dep-in-delta',
      label: { ru: 'Под дельтой' },
      description: { ru: 'Добавлено к аспекту настройкой' },
      type: { kind: 'number' },
      status: 'active',
    });
    const propId = (prop as { property: string }).property;
    await dep.registry.setAspectDelta({
      aspect: 'orbis/note',
      delta: { properties: { add: [{ propertyId: propId, required: false, rank: 90 }] } },
    });
    const answer = await dep.registry.dependants({ property: propId });
    expect(answer.dependants).toEqual(['orbis/note']);
  });
});
