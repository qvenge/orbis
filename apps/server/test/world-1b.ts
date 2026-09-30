// apps/server/test/world-1b.ts
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  type GraphId,
  newId,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  etalonOf,
  LEGACY_ETALON_TEXTS,
  type SupplyEtalon,
  type SupplyKey,
  type SupplyKeyValue,
  UPCOMING_BODY,
} from '@orbis/shared/supply';
import { printPageRecord } from '@orbis/shared/supply/print';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import type { ExecuteRequest } from '../src/executor/types';
import { effectiveRegistry } from '../src/registry/cache';
import { setupGraph } from '../src/seed/setup-graph';
import { etalonHash } from '../src/supply/hash';
import { canonicalPageText, supplyRecordId } from '../src/supply/records';
import { personal } from './helpers';

/**
 * ГРАФ ФОРМЫ ПРОДА ПОСЛЕ СРЕЗА 1Б — вход прод-операции `migrate-1v` (задача 13 среза 1в).
 *
 * Зачем фикстура, а не нынешнее заведение графа: код 1в заводит граф с Повесткой и без Upcoming, а прод
 * заведён релизом 1б — с Upcoming в навигации хоста и прежним «Годом». Эталоны 1б, которые код 1в
 * изменил, — ЛИТЕРАЛАМИ ниже (Повестка на месте Upcoming, «Год» переписан); прочие берутся из кода, и то,
 * что фикстура держит ровно прод, даже когда код уйдёт дальше, закреплено отпечатками релиза 1б
 * (`ETALON_HASHES_1B`) — сдвиг кода покраснит их сверку, а не молча сдвинет фикстуру.
 */

/**
 * Тело «Года» релиза 1б ДОСЛОВНО (`git show ae3b710d:packages/shared/src/supply/lists.ts`): лестница
 * горизонтов ещё называет «Upcoming». 1в меняет одну фразу — «неделя и две — «Повестка»» (§6.4).
 */
export const HORIZON_YEAR_BODY_1B = `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

Лестница горизонтов целиком: день — список «Daily Planning», неделя и месяц — список «Upcoming», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.

{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}`;

/** Навигация оболочки хоста релиза 1б — по ключам (Upcoming третьей, Повестки нет). */
export const NAV_1B_KEYS = [
  'records',
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'routines',
] as const;

/**
 * Эталон кода по ключу — для тех, что между 1б и 1в не менялись: `git diff ae3b710d` по
 * `packages/shared/src/supply/{etalons,lists}.ts` меняет только Повестку/Upcoming, тело «Года» и навигацию
 * оболочки — они ниже литералами.
 */
const pageEtalon = (key: SupplyKey): SupplyEtalon => etalonOf(key);

/**
 * Эталоны релиза 1б в порядке кода 1б: шаблон, оболочка (навигация с Upcoming), «Домой», «Записи», шесть
 * списков — Upcoming на месте Повестки, «Год» с телом 1б. Остальные страницы между 1б и 1в не менялись —
 * берутся из кода; `upcoming` — снятый ключ, поэтому приведение типа (эталона кода у него нет).
 */
export const ETALONS_1B: readonly SupplyEtalon[] = [
  pageEtalon('host-template'),
  {
    ...(etalonOf('host-shell') as Extract<SupplyEtalon, { kind: 'app' }>),
    nav: NAV_1B_KEYS as unknown as readonly SupplyKey[],
  },
  pageEtalon('home'),
  pageEtalon('records'),
  pageEtalon('daily-planning'),
  {
    key: 'upcoming' as unknown as SupplyKey,
    kind: 'page',
    title: 'Upcoming',
    emoji: '🗓️',
    text: UPCOMING_BODY,
  },
  pageEtalon('all-tasks'),
  {
    ...(pageEtalon('horizon-year') as Extract<SupplyEtalon, { kind: 'page' | 'template' }>),
    text: HORIZON_YEAR_BODY_1B,
  },
  pageEtalon('horizon-life'),
  pageEtalon('routines'),
];

/**
 * ОТПЕЧАТКИ ЭТАЛОНОВ РЕЛИЗА 1Б — литералами (M-3 финального ревью B2b). Семь эталонов выше берутся из
 * ЖИВОГО кода (`pageEtalon`, `etalonOf`), а докблок файла обещает «ровно прод»: правка тела
 * `DAILY_PLANNING_BODY`, `ROUTINES_LIST_BODY` или шаблона хоста в этой ветке сдвинула бы фикстуру вместе с
 * кодом, и `migrate-1v.test.ts` проверял бы уже не прод-состояние. Числа сняты КОДОМ РЕЛИЗА 1Б, а не этим:
 * `git archive ae3b710d packages/shared apps/server/src/supply/hash.ts`, затем `etalonHash` тех лет над его
 * `SUPPLY_ETALONS` (sha256 кодовой формы: `printAppEtalon` / `printPageRecord`). Равенство `etalonHash(e)` у
 * каждого `ETALONS_1B` этим числам — тест `migrate-1v.test.ts` «фикстура 1б — отпечатки релиза».
 */
export const ETALON_HASHES_1B: Readonly<Record<string, string>> = {
  'host-template': '197e737993856a5c123160d536c23847bf2a038515caa181179ede9b19d500d4',
  'host-shell': '913e61f34397a6b85db0ccb02157ea20775bacadf6efd5a99a0c6bfdd8ced800',
  home: 'b5dde645338fae89aa6eadd88bee6d93048a3985fd00604f5fe3241d6dd3b5f3',
  records: '83ff6cba6a2fdf5219ee6f90e1461f4d3bb957ced5727524c83d594a7b40081c',
  'daily-planning': 'd17e7892b46a44622091e168a4d9ee7dd6857d2f5c98508f986fb6cdd097e3ef',
  upcoming: 'b91c7aa928355985cdb995c4c78cb0e9396d9a38ef5e95a7857ce7be24d9a5a8',
  'all-tasks': 'c553d69e740e9876a3143b5b214e9c46b9149d89dae0aadfabd4a36ca99de7a7',
  'horizon-year': 'b7b8a41e22829d52150fffecd5f95bd63bd22c55288af51288918b7c4f6acde6',
  'horizon-life': '0a574ad0c64cc24f60e91c68cf941d86551439d38a2b6898aa4e0ad7fb7d3845',
  routines: '3fa734d26c7a48cc20fa5c0ea10956caf0b551e9b1b6229b61d727cf060f1af6',
};

/** Эталон 1б по ключу (с `upcoming`). */
export function etalon1b(key: SupplyKeyValue): SupplyEtalon {
  const e = ETALONS_1B.find((x) => (x.key as string) === key);
  if (e === undefined) throw new Error(`эталона 1б с ключом «${key}» нет`);
  return e;
}

/**
 * Списки, которые перевод 1б (`migrate-1b`, прод 28.09) оставил на ПРЕЖНЕМ эталоне (R-39): их тела совпали
 * с `LEGACY_ETALON_TEXTS` — статус «как в поставке» прежней версии. «Рутины» прежнего текста не имеют.
 */
export const LEGACY_KEYS_1B: readonly SupplyKeyValue[] = [
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'horizon-life',
];

/**
 * Варианты графа:
 *  - `prod` — как его оставил прод 1б: пять списков (`LEGACY_KEYS_1B`) с телами и печатью ПРЕЖНИХ эталонов
 *    (как их записал перевод 1б после R-39, статус «как в поставке» прежней версии), оболочка — эталон 1б;
 *  - `etalon-1b` — списки на эталонах 1б (владелец принял обновления, либо граф заведён релизом 1б);
 *  - `edited` — `prod`, где Upcoming и «Год» правлены владельцем;
 *  - `declined` — `prod`, где владелец отказался («Оставить своё») от обновления «Года» до эталона 1б:
 *    `supply_declined` = отпечаток эталона 1б «Года» (единственный отказ, достижимый на проде);
 *  - `own-app` — `prod` плюс два своих приложения владельца: в одном Upcoming — домашняя, в другом — раздел
 *    навигации (каждая ветка признака ссылки видна отдельно, гейт m-1).
 */
export type World1bVariant = 'prod' | 'etalon-1b' | 'edited' | 'declined' | 'own-app';

export interface World1b {
  graph: GraphId;
  /** id своих приложений (`own-app`): [с домашней Upcoming, с разделом Upcoming]; иначе пусто. */
  ownAppIds: string[];
}

/** Правка тела владельцем — добавленная им строка (отличается от любого эталона). */
export const OWNER_LINE = 'Моя приписка владельца.';

async function run(
  db: Db,
  graph: GraphId,
  mechanism: ExecuteRequest['mechanism'],
  operations: ExecuteRequest['operations'],
): Promise<void> {
  // Без журнала (как сев прежнего онбординга и `legacy-world.ts`): фикстура — прошлое графа, а счёт
  // записей журнала — наблюдаемое операции, которую проверяют.
  const r = await execute(db, {
    identity: personal(graph),
    actorKind: 'owner',
    source: 'system',
    mechanism,
    batchId: newId(),
    operations,
  });
  if (!r.ok) throw new Error(`мир 1б: ${JSON.stringify(r.error)}`);
}

async function bodyRevisionOf(db: Db, graph: GraphId, id: string): Promise<number> {
  const rows = (await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT body_revision FROM entities WHERE id = ${id}::uuid`),
  )) as unknown as Array<{ body_revision: number }>;
  const r = rows[0];
  if (r === undefined) throw new Error(`мир 1б: записи ${id} нет`);
  return r.body_revision;
}

/** Завести граф `graph` в форме прода после 1б (вариант — выше). */
export async function seedWorld1b(
  db: Db,
  graph: GraphId,
  variant: World1bVariant = 'prod',
): Promise<World1b> {
  const who = personal(graph);
  // Путь заведения — ТОТ ЖЕ, что у релиза 1б: заведение графа с эталонами 1б (записи поставки создаёт
  // механизм `supply`, оболочка — последней). Рутины хоста — как в проде (садовник, «Перенос остатков»).
  await setupGraph(db, who, { etalons: ETALONS_1B });
  if (variant === 'etalon-1b') return { graph, ownAppIds: [] };

  // Перевод 1б положил в пять списков тела и печать ПРЕЖНИХ эталонов (R-39): отпечаток — прежнего
  // эталона (заголовок и эмодзи — эталона 1б), печать — с каноническим телом этого графа.
  const reg = await withIdentity(db, who, (tx) => effectiveRegistry(tx, graph));
  const ops: ExecuteRequest['operations'] = [];
  for (const key of LEGACY_KEYS_1B) {
    const e = etalon1b(key) as Extract<SupplyEtalon, { kind: 'page' | 'template' }>;
    const legacyText = LEGACY_ETALON_TEXTS[key];
    if (legacyText === undefined) throw new Error(`мир 1б: прежнего текста «${key}» нет`);
    const id = supplyRecordId(graph, key);
    ops.push({
      tool: 'entity_update',
      input: {
        id,
        expectedBodyRevision: await bodyRevisionOf(db, graph, id),
        body: legacyText,
        props: {
          [SUPPLY_HASH]: etalonHash({ ...e, text: legacyText }),
          [SUPPLY_TEXT]: printPageRecord({
            title: e.title,
            emoji: e.emoji,
            body: canonicalPageText(legacyText, reg),
          }),
        },
      },
    });
  }
  await run(db, graph, 'supply', ops);

  if (variant === 'edited') {
    // Правка владельца — обычным путём (механизм `user`): тело прежнее плюс его строка.
    for (const key of ['upcoming', 'horizon-year'] as const) {
      const id = supplyRecordId(graph, key);
      await run(db, graph, 'user', [
        {
          tool: 'entity_update',
          input: {
            id,
            expectedBodyRevision: await bodyRevisionOf(db, graph, id),
            body: `${LEGACY_ETALON_TEXTS[key]}\n\n${OWNER_LINE}`,
          },
        },
      ]);
    }
  }
  if (variant === 'declined') {
    await run(db, graph, 'supply', [
      {
        tool: 'entity_update',
        input: {
          id: supplyRecordId(graph, 'horizon-year'),
          props: { [SUPPLY_DECLINED]: etalonHash(etalon1b('horizon-year')) },
        },
      },
    ]);
  }
  if (variant === 'own-app') {
    const homeApp = newId();
    const navApp = newId();
    const upcoming = supplyRecordId(graph, 'upcoming');
    const daily = supplyRecordId(graph, 'daily-planning');
    await run(db, graph, 'user', [
      {
        tool: 'entity_create',
        input: {
          id: homeApp,
          title: 'Моя неделя',
          tags: [],
          aspects: [APP_ASPECT],
          props: { [APP_HOME]: upcoming, [APP_NAV]: [daily] },
        },
      },
      {
        tool: 'entity_create',
        input: {
          id: navApp,
          title: 'Мои планы',
          tags: [],
          aspects: [APP_ASPECT],
          props: { [APP_HOME]: daily, [APP_NAV]: [daily, upcoming] },
        },
      },
    ]);
    return { graph, ownAppIds: [homeApp, navApp] };
  }
  return { graph, ownAppIds: [] };
}
