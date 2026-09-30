// apps/server/src/executor/body-stamp.ts
// Триггер `entities_body_stamp` (0026, спека скорости §8.1) — в памяти, для ВИРТУАЛЬНЫХ строк пачки (РП-17), и
// «действие тела до» записи журнала (§8.6 «Цепочка»).
//
// Колонки тела в базе ставит ТОЛЬКО триггер. Но пачка валидирует все операции до первой записи над виртуальными
// строками `{...current, ...patch}` (`BatchState`), и приращения триггера они не видят: вторая правка тела той же
// записи сверялась бы с устаревшей ревизией, и «тело + тело» в одной пачке прошло бы замок текста молча (Д-13).
// Поэтому пачка повторяет приращение здесь — тем же условием, что триггер, и только в памяти: в патч записи эти поля
// не попадают никогда (прямую запись колонок кодом запрещает сторож путей записи).
import { canonicalJson } from '@orbis/shared';
import type { entities } from '../db/schema';

type EntityRow = typeof entities.$inferSelect;
/** Патч записи — та же форма, что `EntityPatch` исполнителя. */
type EntityPatch = Partial<typeof entities.$inferInsert>;

/** Поля тела, по которым триггер решает «тело сменилось». */
type BodyFields = { body?: string; bodyDoc?: unknown };

/**
 * Сменит ли патч тело — ровно условие триггера: `OLD.body IS DISTINCT FROM NEW.body OR OLD.body_doc IS DISTINCT FROM
 * NEW.body_doc`. Документ сравнивается как jsonb, а не как строка: jsonb не хранит порядок ключей, и «тот же документ
 * с ключами в другом порядке» база изменением не считает (`canonicalJson` — та же мера, что у сверки реестров).
 */
export function bodyChanges(current: BodyFields, patch: BodyFields): boolean {
  if (patch.body !== undefined && patch.body !== current.body) return true;
  if (patch.bodyDoc === undefined) return false;
  const was = current.bodyDoc ?? null;
  const next = patch.bodyDoc ?? null;
  if (was === null || next === null) return was !== next;
  return canonicalJson(was) !== canonicalJson(next);
}

/**
 * Виртуальная строка ПОСЛЕ патча — с колонками тела, которые поставит триггер: при смене тела ревизия +1, действие —
 * объявленное транзакцией, время — момент операции; иначе колонки прежние. `bodyAction` — `ExecCtx.bodyAction`
 * (пусто у транзакций без журнала — так же, как в базе).
 */
export function stampVirtualBody(
  current: EntityRow,
  patch: EntityPatch,
  bodyAction: string | null,
  at: Date,
): EntityRow {
  const after = { ...current, ...patch } as EntityRow;
  if (!bodyChanges(current, patch)) return after;
  return {
    ...after,
    bodyRevision: current.bodyRevision + 1,
    bodyActionId: bodyAction,
    bodyChangedAt: at,
  };
}

/** Колонки тела СОЗДАННОЙ строки — как INSERT-ветка триггера: ревизия 1 при любом теле, в том числе пустом. */
export function createdBodyStamp(
  bodyAction: string | null,
  at: Date,
): Pick<EntityRow, 'bodyRevision' | 'bodyActionId' | 'bodyChangedAt'> {
  return { bodyRevision: 1, bodyActionId: bodyAction, bodyChangedAt: at };
}

/**
 * «Действие тела до» записи для журнала (§8.6): значение колонки ДО этого действия. Если колонка уже указывает на
 * объявленное действие, тело этой записи в ЭТОЙ ЖЕ транзакции уже меняли: правку или засев раньше в пачке — тогда их
 * ключ записан и побеждает (первый ключ, `collectBodyBefore`), — либо создание раньше в пачке. До создания записи не
 * было, и «до» — пусто: ссылка на само действие замкнула бы раскрутку цепочки (задача 10) на себя.
 */
export function bodyActionBefore(current: EntityRow, bodyAction: string | null): string | null {
  const was = current.bodyActionId ?? null;
  return bodyAction !== null && was === bodyAction ? null : was;
}
