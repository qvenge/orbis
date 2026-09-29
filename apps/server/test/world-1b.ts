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
 * заведён релизом 1б — с Upcoming в навигации хоста и прежним «Годом». Эталоны 1б — ЛИТЕРАЛАМИ ниже: код
 * их больше не несёт (Повестка на месте Upcoming, «Год» переписан), а фикстура обязана держать ровно то,
 * что лежит в проде, даже когда код уйдёт дальше.
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
 *  - `own-app` — `prod` плюс своё приложение владельца, где Upcoming — домашняя и раздел навигации.
 */
export type World1bVariant = 'prod' | 'etalon-1b' | 'edited' | 'declined' | 'own-app';

export interface World1b {
  graph: GraphId;
  /** id своего приложения (`own-app`), иначе `null`. */
  ownAppId: string | null;
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

async function updatedAtOf(db: Db, graph: GraphId, id: string): Promise<string> {
  const rows = (await withIdentity(db, personal(graph), (tx) =>
    tx.execute(sql`SELECT updated_at FROM entities WHERE id = ${id}::uuid`),
  )) as unknown as Array<{ updated_at: Date | string }>;
  const r = rows[0];
  if (r === undefined) throw new Error(`мир 1б: записи ${id} нет`);
  return new Date(r.updated_at).toISOString();
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
  if (variant === 'etalon-1b') return { graph, ownAppId: null };

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
        expectedUpdatedAt: await updatedAtOf(db, graph, id),
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
            expectedUpdatedAt: await updatedAtOf(db, graph, id),
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
    const ownAppId = newId();
    const upcoming = supplyRecordId(graph, 'upcoming');
    await run(db, graph, 'user', [
      {
        tool: 'entity_create',
        input: {
          id: ownAppId,
          title: 'Моя неделя',
          tags: [],
          aspects: [APP_ASPECT],
          props: {
            [APP_HOME]: upcoming,
            [APP_NAV]: [upcoming, supplyRecordId(graph, 'daily-planning')],
          },
        },
      },
    ]);
    return { graph, ownAppId };
  }
  return { graph, ownAppId: null };
}
