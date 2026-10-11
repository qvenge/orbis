// apps/server/src/seed/world.ts
// Мир владельца (02 §7.1, срез 1б §8.6): 12 категорий Финансов — ЧЕРЕЗ ИСПОЛНИТЕЛЯ, а не прямым
// INSERT'ом. Шесть списков, которые сеялись здесь до 1б, стали записями поставки хоста (§9.4): их вместе
// с шаблоном хоста, оболочкой, «Домой» и «Записями» заводит механизм `supply` отдельной пачкой
// (`seed/setup-graph.ts`) — свойства эталона пишет только он (флаг `writer`, задача 9).
//
// ПОЧЕМУ ЧЕРЕЗ ИСПОЛНИТЕЛЬ. Прямая вставка была точкой записи мимо валидатора: форма значений
// категорий не проходила ни стадию 2, ни гейт прав записи. Через `execute` `props`/`aspects` появляются у
// сида по построению — тем же кодом, что на любой правке владельца.
//
// ЗОВЁТСЯ ТОЛЬКО ПРИ ЗАВЕДЕНИИ ГРАФА (срез 1б §8.6, РП-15): на входе, где оболочка хоста уже есть,
// заведение не идёт вовсе — досевов нет (С1б-5). Проба по PK внутри остаётся ради ГОНКИ двух первых
// входов и ради повтора упавшего на полпути заведения: мир появляется целиком одной пачкой, а
// проигравшая гонку пачка распознаётся перепроверкой.
//
// ЖУРНАЛА У СЕВА НЕТ: синк не передаётся, `execute` берёт NOOP (решение 6 плана онбординга —
// «записи журнала при регистрации это шум в ленте»). Побочное следствие важнее ленты: сев не
// становится «последним действием», и `undo_last` не может снять мир владельца.
import { type GraphId, ORBIS_NAMESPACE } from '@orbis/shared';
import { SUPPLY_ETALONS } from '@orbis/shared/supply';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { Identity } from '../identity';
import { SEED_CATEGORIES } from './categories';

// Формулы seed-слагов — серверная деталь (НЕ в shared): id порождается от graph_id
// (workspace-scoped при введении workspace'ов, D11) и стабильного слага. uuid-библиотека
// принимает (name, namespace) — обратный порядок к нотации PRD uuidv5(NS, name).
export function seedCategoryId(graphId: GraphId, slug: string): string {
  return uuidv5(`${graphId.toLowerCase()}:seed-category:${slug}`, ORBIS_NAMESPACE);
}

export function seedSmartListId(graphId: GraphId, slug: string): string {
  return uuidv5(`${graphId.toLowerCase()}:seed-smartlist:${slug}`, ORBIS_NAMESPACE);
}

/**
 * Сколько записей составляют мир владельца без рутин: 12 категорий + десять записей поставки хоста
 * (шаблон, оболочка, «Домой», «Записи», шесть списков — §9.1).
 */
export const SEED_WORLD_SIZE = SEED_CATEGORIES.length + SUPPLY_ETALONS.length;

export interface SeedWorldResult {
  /** Сущности, созданные ЭТИМ вызовом. */
  created: number;
  /** Сущности, которые уже были (проба по PK). */
  skipped: number;
}

export interface SeedWorldDeps {
  clock?: () => Date;
}

/**
 * Механизм мутации, которым сеет мир (§А2-5).
 *
 * Вынесен константой, а не написан по месту, чтобы у пина было к чему привязаться: сегодня
 * выбор наблюдаем ТОЛЬКО через права записи (`SYSTEM_WRITABLE_MECHANISMS`), а ни одно из
 * четырёх сеемых свойств категории системным не помечено — значит подмена механизма в
 * вызове не ломает сегодня ни одного теста. Правило, на которое опирается сев, пиннится
 * поведенчески в `seed/onboarding.test.ts` («сев вправе писать системное свойство, а
 * механизм по умолчанию — нет»): первое же системное свойство в `SEED_CATEGORIES` упрётся
 * в `writeDenial` ровно там, где никто не смотрит.
 */
export const WORLD_SEED_MECHANISM = 'seed' as const;

/**
 * 12 категорий владельца через исполнитель, ОДНОЙ пачкой, механизмом `seed`.
 *
 * ПАЧКА, А НЕ 12 ВЫЗОВОВ. `execute` с `operations.length > 1` требует `batchId`, и это не формальность:
 * пачка — одна транзакция и один атомарный исход. Наполовину засеянный набор категорий выглядит для
 * владельца как испорченный, а не как «сейчас досеется».
 *
 * `batchId` детерминирован от владельца: запись журнала пачки адресуется им (ключ `(graph_id, batch_id)`),
 * и случайный id при живом синке дал бы повтору вторую запись.
 *
 * ФИНАНСЫ ДОЛЖНЫ БЫТЬ ВКЛЮЧЕНЫ: аспект категории — Финансов, и при выключенных сев получил бы
 * `MODULE_DISABLED`. Маску перед севом снимает заведение графа (`setupGraph`, Д-1).
 */
export async function seedOwnerWorld(
  db: Db,
  who: Identity,
  deps: SeedWorldDeps = {},
): Promise<SeedWorldResult> {
  const clock = deps.clock ?? (() => new Date());
  const graphId = who.graph;

  const wanted = SEED_CATEGORIES.map((c) => ({
    id: seedCategoryId(graphId, c.slug),
    input: {
      title: c.title,
      tags: ['category'],
      aspects: ['orbis/category'],
      // Адрес значения — id свойства, а не имя поля старой карты: у категории свойства
      // объявлены аспектом `orbis/category` (`builtin-aspects.ts`). `spend_class` у
      // доходных ОТСУТСТВУЕТ, а не равен null (§3.6): ajv отверг бы null.
      props: {
        'orbis/icon': c.icon,
        'orbis/color': c.color,
        'orbis/aliases': [...c.aliases],
        ...(c.spendClass ? { 'orbis/spend_class': c.spendClass } : {}),
      } as Record<string, unknown>,
    },
  }));

  const missing = await missingIds(
    db,
    who,
    wanted.map((w) => w.id),
  );
  if (missing.size === 0) return { created: 0, skipped: wanted.length };

  const operations = wanted
    .filter((w) => missing.has(w.id))
    .map((w) => ({ tool: 'entity_create', input: { id: w.id, ...w.input } }));

  const r = await execute(db, {
    identity: who,
    actorKind: 'owner',
    source: 'system',
    // `source: 'system'` (а не `'routine'`) — чтобы не включился `assertRoutineUntouchable`;
    // механизм сева входит в `SYSTEM_WRITABLE_MECHANISMS`, то есть системные свойства
    // сеятелю доступны, а вычисляемые — нет (их у мира и не бывает).
    mechanism: WORLD_SEED_MECHANISM,
    batchId: worldBatchId(graphId),
    operations,
    clock,
  });
  if (!r.ok) {
    // ГОНКА ДВУХ ВКЛАДОК — единственный законный отказ здесь, и он проверяется, а не
    // предполагается. Обе увидели граф без оболочки хоста, обе пошли заводить; проигравшая
    // упирается в PK уже созданных сущностей. Перепроверка по PK отличает её от настоящей
    // поломки: мир на месте — значит сев состоялся, просто не этой транзакцией.
    const stillMissing = await missingIds(
      db,
      who,
      wanted.map((w) => w.id),
    );
    if (stillMissing.size === 0) return { created: 0, skipped: wanted.length };
    throw new Error(`сев мира владельца: ${r.error.code} ${r.error.message}`);
  }
  return { created: missing.size, skipped: wanted.length - missing.size };
}

/** batchId пачки сева — детерминированный: повтор не заводит второй записи журнала. */
function worldBatchId(graphId: GraphId): string {
  return uuidv5(`${graphId.toLowerCase()}:seed-world`, ORBIS_NAMESPACE);
}

/** Какие из перечисленных id ещё не существуют у владельца (одним запросом, под RLS; архивные — существуют). */
export async function missingIds(db: Db, who: Identity, ids: string[]): Promise<Set<string>> {
  const rows = (await withIdentity(db, who, (tx) =>
    tx.execute(sql`
      SELECT id::text AS id FROM entities
       WHERE graph_id = ${who.graph} AND id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`),
  )) as unknown as Array<{ id: string }>;
  const present = new Set(rows.map((r) => r.id));
  return new Set(ids.filter((id) => !present.has(id)));
}
