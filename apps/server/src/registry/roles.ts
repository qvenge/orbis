// apps/server/src/registry/roles.ts
//
// Эффективный реестр РОЛЕЙ для путей, у которых снимка (`loadRegistry`) на руках нет:
// сырые SQL-запросы бюджета, круга исполнителя и чтения backlinks (компилятор запросов
// в этом списке был до Задачи 9b — теперь он ходит по снимку `CompileCtx.reg`). Их вызывающие держат `tx` и не держат `RegistrySnapshot`, а тащить снимок
// через полтора десятка сигнатур значило бы грузить пять SELECT'ов определений на каждый
// такой вызов — цена, которой у чтения быть не должно.
//
// ПОЧЕМУ ДВА ИСПОЛНИТЕЛЯ ОДНОГО ПРАВИЛА (подзапрос здесь и Map в `loadRegistry`) И ПОЧЕМУ
// ЭТО НЕ ВТОРАЯ ПРАВДА. Правило разрешения коллизии одно: своя строка владельца ПЕРЕКРЫВАЕТ
// встроенную (`loadRegistry` добивается этого `ORDER BY owner_id NULLS FIRST` + перезаписью
// ключа Map, здесь — `DISTINCT ON (id) … ORDER BY owner_id DESC NULLS LAST`). Разъехаться
// они не могут молча: их равенство запиннено `roles.test.ts` на живой базе. Живут они рядом
// именно поэтому — правку одного видно из другого.
import { type SQL, sql } from 'drizzle-orm';
import type { RegistrySnapshot } from './load';

/**
 * Подзапрос «эффективные строки реестра ролей»: по одной на id, своя перекрывает встроенную.
 *
 * Собственного фильтра по владельцу здесь НЕТ: все вызывающие идут под `withIdentity`, и
 * скоуп даёт RLS (`read_builtin_or_own`). Под админским подключением подзапрос вернул бы
 * строки всех владельцев — поэтому в сиды и миграции он не годится, там снимок.
 */
export function effectiveRolesSql(): SQL {
  return sql`(SELECT DISTINCT ON (id) *
                FROM relation_role_definitions
               ORDER BY id, owner_id DESC NULLS LAST)`;
}

/**
 * Подзапрос «id иерархических ролей» (§А4-3): `subitem`, `ticket`, `run`, `category-parent`
 * во встроенном реестре. Именно ПОДЗАПРОС, а не константа: роль с `hierarchical: true`
 * заводится операциями реестра (Задача 15), и список, написанный в коде, её не увидел бы
 * (находка 15 ревью плана).
 *
 * `envelope-binding` сюда не входит — конверт не родитель транзакции, он её счётчик
 * (Ч10-С1). Читателям, которым нужно прежнее множество старой колонки `relation_type`
 * (агрегаты бюджета), нужен `LEGACY_PARENT_ROLES`, а не этот список.
 */
export function hierarchicalRolesSql(): SQL {
  return sql`SELECT id FROM ${effectiveRolesSql()} d WHERE d.hierarchical`;
}

/** Тот же список из готового снимка — для путей, которые снимок уже держат. */
export function hierarchicalRoles(reg: RegistrySnapshot): string[] {
  return [...reg.roles.values()].filter((r) => r.hierarchical).map((r) => r.id);
}
