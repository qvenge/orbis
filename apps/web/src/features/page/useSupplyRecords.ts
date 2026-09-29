import { SUPPLY_ASPECT, SUPPLY_KEY } from '@orbis/shared';
// Листовой сабпат, не корень пакета: экран записи тянет этот модуль эагерно (сторожа
// `check-lazy-chunks.ts` и `save.test.tsx`), а эталоны поставки — данные без тяжёлых импортов.
import { HOST_SHELL_KEY, SUPPLY_KEY_VALUES, type SupplyKeyValue } from '@orbis/shared/supply';
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import type { WireEntity } from '../entity-detail/record-host';

/**
 * Записи поставки хоста (срез 1б §9.1): записи с аспектом «поставка» по ключу эталона. Экран записи
 * читает отсюда шаблон хоста (§9.2); дальше — оболочка хоста, «Домой» и списки (задачи 19–23).
 *
 * Обычный `entity.query` текстом — под ОБЩИМ ключом, который гасит `invalidateGraph`: правка записи
 * поставки (настройкой, агентом, «Принять обновление») перечитает её везде. Архивные сервер по этому
 * запросу не отдаёт; фильтр ниже — страховка того же правила на клиенте: запись в архиве поставкой
 * не показывается (§9.2 гарантии — «в архиве → эталон из кода»).
 */
export const SUPPLY_RECORDS_QUERY = 'aspect=orbis/supply';

/**
 * Запись поставки ключа `key` — ОДНО определение на весь web (финал 1б, Fable M-3): запись НЕСЁТ
 * аспект «поставка» и ключ эталона. Снятый аспект — «выведено из поставки» (R-17): такая запись уже
 * не оболочка хоста ни для рамки (`useAppShell` — по записям этого хука), ни для меню и правила
 * открытия (`useApps.hostShell`); иначе рамка рисовалась бы по эталону, а «Настроить навигацию»
 * правила бы запись, чьей навигации на экране нет. Архив здесь не решается: он — дело читателя.
 */
export function isSupplyRecordOf(
  row: { aspects: readonly string[]; props: Readonly<Record<string, unknown>> },
  key: SupplyKeyValue,
): boolean {
  return row.aspects.includes(SUPPLY_ASPECT) && row.props[SUPPLY_KEY] === key;
}

/** Оболочка хоста — запись поставки `host-shell` (`isSupplyRecordOf`). */
export const isHostShellRow = (row: Parameters<typeof isSupplyRecordOf>[0]): boolean =>
  isSupplyRecordOf(row, HOST_SHELL_KEY);

/** Ключ записи поставки — любой допустимый: эталонов и снятых с поставки (1в §6.3, РП-10). */
const isSupplyKey = (v: unknown): v is SupplyKeyValue =>
  typeof v === 'string' && (SUPPLY_KEY_VALUES as readonly string[]).includes(v);

export interface SupplyRecords {
  /**
   * Живые записи по ключу; ключа нет — записи нет (не заведена, в архиве, выведена). Снятые с поставки
   * ключи (Upcoming 1б) — тоже здесь: запись живёт, и её узнают как запись поставки.
   */
  byKey: ReadonlyMap<SupplyKeyValue, WireEntity>;
  /**
   * `loading` — ответа ещё нет; `error` — не приехал. Уже приехавший ответ при отказе перечитывания
   * остаётся `ok`: последнее известное честнее эталона кода.
   */
  status: 'loading' | 'ok' | 'error';
}

const NO_ROWS: WireEntity[] = [];

export function useSupplyRecords(): SupplyRecords {
  const q = trpc.entity.query.useQuery({ query: SUPPLY_RECORDS_QUERY });
  const rows = q.data ?? NO_ROWS;
  const byKey = useMemo(() => {
    const out = new Map<SupplyKeyValue, WireEntity>();
    for (const row of rows) {
      if (row.archived) continue;
      const key = row.props[SUPPLY_KEY];
      // Живая запись на ключ одна (правило `unique_among` аспекта «поставка»); первая — на случай,
      // если данные, внесённые до правила, держат две.
      if (isSupplyKey(key) && isSupplyRecordOf(row, key) && !out.has(key)) out.set(key, row);
    }
    return out;
  }, [rows]);
  const status = q.data !== undefined ? 'ok' : q.isError ? 'error' : 'loading';
  // Один объект на одно состояние: показ шаблона хоста мемоизирован по нему.
  return useMemo(() => ({ byKey, status }), [byKey, status]);
}
