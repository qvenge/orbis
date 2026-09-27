// apps/server/src/supply/records.ts
// Записи поставки в графе (срез 1б §9.1): id записи по ключу эталона, печать эталона в этом графе и
// операции создания. Пишет их только механизм `supply` (флаг `writer` свойств эталона, задача 9) — здесь
// только ОПЕРАЦИИ; исполняет их вызывающий (сев графа задачи 12, «добавить» механизма поставки).
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  type GraphId,
  ORBIS_NAMESPACE,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import { SUPPLY_ETALONS, type SupplyEtalon, type SupplyKey } from '@orbis/shared/supply';
import { printAppProps, printPageRecord } from '@orbis/shared/supply/print';
import { v5 as uuidv5 } from 'uuid';
import { bodyFieldsFromMarkdown } from '../executor/body-fields';
import type { RegistrySnapshot } from '../registry/load';
import type { ExecOperation } from '../routines/propose';
import { seedSmartListId } from '../seed/world';
import { etalonHash } from './hash';

/** Ключи шести списков: у их записей id — прежние id сева (`seedSmartListId`), ссылки владельца на них живут. */
const LIST_KEYS: ReadonlySet<SupplyKey> = new Set([
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'horizon-life',
  'routines',
]);

/**
 * Детерминированный id записи поставки: списки — `seedSmartListId(graph, key)` (ключ = прежний слаг сева,
 * перевод данных задачи 13 находит прод-списки по нему); прочие — uuidv5 от `graph:supply:key`.
 */
export function supplyRecordId(graph: GraphId, key: SupplyKey): string {
  if (LIST_KEYS.has(key)) return seedSmartListId(graph, key);
  return uuidv5(`${graph.toLowerCase()}:supply:${key}`, ORBIS_NAMESPACE);
}

/**
 * Каноническое тело текста эталона в этом графе — ровно то, что положит в `body` исполнитель
 * (`bodyFieldsFromMarkdown`, как у сева списков): печать эталона в записи обязана совпасть с печатью
 * свежесозданной записи байт в байт, иначе «как в поставке» не наступило бы никогда.
 */
export function canonicalPageText(text: string, reg: RegistrySnapshot): string {
  return bodyFieldsFromMarkdown(text, reg).body;
}

/** Разрешение ключа эталона в id записи этого графа; `null` — записи нет (ссылку на неё не ставим). */
export type ResolveSupplyKey = (k: SupplyKey) => string | null;

/** Свойства места записи-приложения по эталону: ключи → id этого графа; ненайденные ключи пропускаются. */
export function appEtalonProps(
  e: Extract<SupplyEtalon, { kind: 'app' }>,
  resolve: ResolveSupplyKey,
): Record<string, unknown> {
  const home = resolve(e.home);
  const nav = e.nav.map(resolve).filter((id): id is string => id !== null);
  // Пустые значения не пишутся вовсе: пустая «Навигация» и её отсутствие — одно и то же место, а
  // печать записи обязана совпасть с печатью эталона байт в байт.
  return {
    ...(home !== null && { [APP_HOME]: home }),
    ...(nav.length > 0 && { [APP_NAV]: nav }),
    [APP_NAV_FORM]: e.navForm,
  };
}

/**
 * Печать эталона в этом графе (`orbis/supply_text`, РП-6): страница — с каноническим телом этого графа,
 * приложение — `printAppProps` с id, разрешёнными `resolve`.
 */
export function supplyTextOf(
  e: SupplyEtalon,
  reg: RegistrySnapshot,
  resolve: ResolveSupplyKey,
): string {
  return e.kind === 'app'
    ? printAppProps({ title: e.title, emoji: e.emoji, props: appEtalonProps(e, resolve) })
    : printPageRecord({ title: e.title, emoji: e.emoji, body: canonicalPageText(e.text, reg) });
}

/**
 * Операции создания записей поставки для ключей `keys`: страницы и шаблон — первыми, приложения — после
 * (ссылки оболочки на страницы той же пачки проверяются по итоговому состоянию, но так пачка и читается
 * естественно: сначала места, потом навигация по ним). Исполнять — механизмом `supply`.
 *
 * `resolve` отдаёт `null` для ключа без записи — ссылка на неё просто не ставится (новая оболочка в графе,
 * где владелец удалил раздел). `etalons` — эталоны кода; параметр ради инъекции в тестах.
 */
export function supplyCreateOps(
  graph: GraphId,
  keys: readonly SupplyKey[],
  resolve: ResolveSupplyKey,
  reg: RegistrySnapshot,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): ExecOperation[] {
  const wanted = keys.map((k) => {
    const e = etalons.find((x) => x.key === k);
    if (e === undefined) throw new Error(`эталона поставки с ключом «${k}» нет`);
    return e;
  });
  const ordered = [
    ...wanted.filter((e) => e.kind !== 'app'),
    ...wanted.filter((e) => e.kind === 'app'),
  ];
  return ordered.map((e): ExecOperation => {
    const supply = {
      [SUPPLY_KEY]: e.key,
      [SUPPLY_HASH]: etalonHash(e),
      [SUPPLY_TEXT]: supplyTextOf(e, reg, resolve),
    };
    const base = {
      id: supplyRecordId(graph, e.key),
      title: e.title,
      emoji: e.emoji,
      tags: [],
    };
    return e.kind === 'app'
      ? {
          tool: 'entity_create',
          input: {
            ...base,
            aspects: [APP_ASPECT, SUPPLY_ASPECT],
            props: { ...appEtalonProps(e, resolve), ...supply },
          },
        }
      : {
          tool: 'entity_create',
          input: { ...base, body: e.text, aspects: [PAGE_ASPECT, SUPPLY_ASPECT], props: supply },
        };
  });
}
