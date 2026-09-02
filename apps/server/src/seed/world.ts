// apps/server/src/seed/world.ts
// Мир владельца (02 §7.1–§7.2): 12 категорий и 6 смарт-листов — ЧЕРЕЗ ИСПОЛНИТЕЛЯ, а не
// прямым INSERT'ом (обещание PRD «онбординг сеет 19 сущностей через исполнителя»).
//
// ПОЧЕМУ ЭТО НЕ КОСМЕТИКА. Прямая вставка была ШЕСТОЙ точкой записи тела мимо
// `bodyFieldsFromMarkdown`/валидатора, и цена у неё была разная в разных местах: категории
// писались проекцией старой карты (`rowFromLegacy`, снят Задачей 23), то есть форма их
// значений не проходила ни через стадию 2 валидатора, ни через гейт прав записи; у
// смарт-листов четыре колонки тела считались вручную. Через `execute` и то и другое считает
// один код — тот же, что на любой правке владельца, — и `props`/`aspects`, `body_doc`,
// `body_refs`, `query_refs` появляются у сида по построению, а не по копии формулы.
//
// ТРАНЗАКЦИЯ ОТДЕЛЬНАЯ И ДО СТРОКИ НАСТРОЕК (рулинг Р-17-1 + порядок ниже):
//  • `execute` принимает `Db` и открывает транзакцию САМ, на другом соединении. Вызвать его
//    внутри `seedOnboarding`, который держит `SELECT … FOR UPDATE` на строке настроек, —
//    это дедлок на первом заходе владельца, а не «медленно»;
//  • поэтому мир сеется ПЕРЕД онбордингом: строка `user_settings` — маркер «онбординг
//    прошёл», и она обязана появиться ПОСЛЕДНЕЙ. Упади сев мира на полпути — маркера нет,
//    и следующий заход досеет недостающее пробой по PK. Обратный порядок оставил бы
//    владельца с маркером и без мира навсегда.
//
// ИДЕМПОТЕНТНОСТЬ — ПРОБА ПО PK, А НЕ GUARD НАСТРОЕК (тот же довод, что у `seed/gardener.ts`):
// guard отвечает на вопрос «онбординг уже был?», а здесь нужен ответ на «эта сущность уже
// есть?». Разойтись они могут ровно на сценарии выше.
//
// ЧЕГО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ — не воскрешает удалённое. Её зовут ТОЛЬКО на первом севе
// (`seedOwner` спрашивает про строку настроек ДО транзакции онбординга): сид не отличает
// «никогда не было» от «владелец удалил осознанно», и общий проход «досеять всё, чего не
// хватает» вернул бы владельцу список, который он выбросил. Адресные досевы (горизонты E4,
// «Рутины» V1.9) остаются в `onboarding.ts` со своими наборами — см. их докблоки.
//
// ЖУРНАЛА У СЕВА НЕТ: синк не передаётся, `execute` берёт NOOP (решение 6 плана онбординга —
// «15 audit-сообщений при регистрации это шум в ленте»). Побочное следствие важнее ленты:
// сев не становится «последним действием», и `undo_last` не может снять мир владельца.
import { ORBIS_NAMESPACE } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { SEED_CATEGORIES } from './categories';
import { SEED_SMART_LISTS } from './smart-lists';

// Формулы seed-слагов — серверная деталь (НЕ в shared): id порождается от owner_id
// (workspace-scoped при введении workspace'ов, D11) и стабильного слага. uuid-библиотека
// принимает (name, namespace) — обратный порядок к нотации PRD uuidv5(NS, name).
export function seedCategoryId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-category:${slug}`, ORBIS_NAMESPACE);
}

export function seedSmartListId(ownerId: string, slug: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-smartlist:${slug}`, ORBIS_NAMESPACE);
}

/** Сколько сущностей составляют мир владельца без садовника (12 категорий + 6 списков). */
export const SEED_WORLD_SIZE = SEED_CATEGORIES.length + SEED_SMART_LISTS.length;

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
 * Мир владельца через исполнитель: категории → смарт-листы, ОДНОЙ пачкой.
 *
 * ПАЧКА, А НЕ 18 ВЫЗОВОВ. `execute` с `operations.length > 1` требует `batchId`
 * (`executor.ts`), и это не формальность: пачка — одна транзакция и один атомарный исход.
 * Мир владельца обязан появиться целиком: наполовину засеянный набор категорий выглядит для
 * владельца как испорченный, а не как «сейчас досеется». Восемнадцать отдельных транзакций
 * дали бы восемнадцать точек частичного отказа и восемнадцать снимков реестра на пути
 * первого захода.
 *
 * `batchId` детерминирован от владельца: audit-сообщение пачки адресуется им
 * (`batchAuditMessageId`), и случайный id при живом синке дал бы повтору вторую запись.
 *
 * ПОРЯДОК ВНУТРИ ПАЧКИ значим для чтения журнала и для стабильности id в тестах: сначала
 * 12 категорий в порядке `SEED_CATEGORIES`, затем 6 списков в порядке `SEED_SMART_LISTS` —
 * ровно тот порядок, в котором их перечисляет 02 §7.1–§7.2.
 */
export async function seedOwnerWorld(
  db: Db,
  ownerId: string,
  deps: SeedWorldDeps = {},
): Promise<SeedWorldResult> {
  const clock = deps.clock ?? (() => new Date());

  const wanted = [
    ...SEED_CATEGORIES.map((c) => ({
      id: seedCategoryId(ownerId, c.slug),
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
    })),
    ...SEED_SMART_LISTS.map((s) => ({
      id: seedSmartListId(ownerId, s.slug),
      input: {
        title: s.title,
        emoji: s.emoji,
        // Тело уезжает ТЕКСТОМ: канон, документ, `body_refs` и `query_refs` считает
        // исполнитель тем же `bodyFieldsFromMarkdown`, что и на правке владельца. Сид
        // перестал быть точкой записи тела мимо общего кода (обещание PRD 02 §3.5 п.4).
        body: s.body,
        tags: ['smart-list'],
        props: {} as Record<string, unknown>,
      },
    })),
  ];

  const missing = await missingIds(
    db,
    ownerId,
    wanted.map((w) => w.id),
  );
  if (missing.size === 0) return { created: 0, skipped: wanted.length };

  const operations = wanted
    .filter((w) => missing.has(w.id))
    .map((w) => ({ tool: 'entity_create', input: { id: w.id, ...w.input } }));

  const r = await execute(db, {
    actorUserId: ownerId,
    actorKind: 'owner',
    source: 'system',
    // `source: 'system'` (а не `'routine'`) — чтобы не включился `assertRoutineUntouchable`;
    // `mechanism: 'seed'` входит в `SYSTEM_WRITABLE_MECHANISMS`, то есть системные свойства
    // сеятелю доступны, а вычисляемые — нет (их у мира и не бывает).
    mechanism: 'seed',
    batchId: worldBatchId(ownerId),
    operations,
    clock,
  });
  if (!r.ok) {
    // ГОНКА ДВУХ ВКЛАДОК — единственный законный отказ здесь, и он проверяется, а не
    // предполагается. Обе увидели владельца без строки настроек, обе пошли сеять; проигравшая
    // упирается в PK уже созданных сущностей. Перепроверка по PK отличает её от настоящей
    // поломки: мир на месте — значит сев состоялся, просто не этой транзакцией.
    const stillMissing = await missingIds(
      db,
      ownerId,
      wanted.map((w) => w.id),
    );
    if (stillMissing.size === 0) return { created: 0, skipped: wanted.length };
    throw new Error(`сев мира владельца: ${r.error.code} ${r.error.message}`);
  }
  return { created: missing.size, skipped: wanted.length - missing.size };
}

/** batchId пачки сева — детерминированный: повтор не заводит второго audit-сообщения. */
function worldBatchId(ownerId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:seed-world`, ORBIS_NAMESPACE);
}

/** Какие из перечисленных id ещё не существуют у владельца (одним запросом, под RLS). */
async function missingIds(db: Db, ownerId: string, ids: string[]): Promise<Set<string>> {
  const rows = (await withIdentity(db, ownerId, (tx) =>
    tx.execute(sql`
      SELECT id::text AS id FROM entities
       WHERE owner_id = ${ownerId} AND id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`),
  )) as unknown as Array<{ id: string }>;
  const present = new Set(rows.map((r) => r.id));
  return new Set(ids.filter((id) => !present.has(id)));
}
