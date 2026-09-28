import {
  APP_DISABLED,
  APP_OPENS_OVER,
  type AppInfo,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
} from '@orbis/shared';
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import type { WireEntity } from '../entity-detail/record-host';
import { isHostShellRow } from '../page/useSupplyRecords';

/**
 * Все записи-приложения графа (срез 1б §4.2, §5.2): живые, выключенные и архивные — правилу открытия
 * нужны и те, и другие (плашки «выключено», «в архиве» вместо «не найдено», Фокус ревью п. 3).
 *
 * Обычный `entity.query` текстом — под общим ключом, который гасит `invalidateGraph`: «Включить»,
 * «Открывать вместо», архив приложения (владельцем или агентом) перечитают список везде.
 */
export const APPS_QUERY = 'aspect=orbis/app, archived=any';

/**
 * Страницы с непустым «Домом» (§4.3) — для ярлыка «↗ Дом» у раздела чужого дома в листе разделов.
 * Узкий запрос, а не все страницы графа: в него попадают только страницы, уже поставленные в
 * приложения (обычно единицы), и размер не растёт с числом страниц (гейт 20, m-5). Страница с
 * пустым «Домом» — хоста; её лист узнаёт по навигации и домашней оболочки хоста (§4.3: не бездомные —
 * те, что стоят там). Спрашивает только открытый лист: холодному старту запрос не нужен (С1б-16).
 */
export const HOMED_PAGES_QUERY = 'aspect=orbis/page, has=orbis/home';

const NO_ROWS: WireEntity[] = [];

/** Приложение для правила открытия и его строка (эмодзи плиток, заголовок). */
export type AppRecord = AppInfo & { row: WireEntity };

export interface Apps {
  /** Приложения без оболочки хоста — вход правила открытия (`OpenInput.apps`) и плитки. */
  apps: readonly AppRecord[];
  byId: ReadonlyMap<string, AppRecord>;
  /**
   * Запись-оболочка хоста (живая, иначе архивная; с аспектом «поставка» — `isHostShellRow`):
   * `/a/<она>` и ссылка на неё — сам хост.
   */
  hostShell: WireEntity | null;
  /**
   * `loading` — списка ещё нет, и правило открытия не зовут: без списка любое приложение адреса
   * вышло бы «не найдено» (ложная `app-unknown`, carry задачи 20, Opus M-3).
   */
  status: 'loading' | 'ok' | 'error';
}

function infoOf(row: WireEntity): AppInfo {
  const key = row.props[SUPPLY_KEY];
  const over = row.props[APP_OPENS_OVER];
  return {
    id: row.id,
    // Ключ поставки — только у записи поставки (с аспектом, R-17): у выведенной он лишь след.
    supplyKey: typeof key === 'string' && row.aspects.includes(SUPPLY_ASPECT) ? key : null,
    title: row.title,
    disabled: row.props[APP_DISABLED] === true,
    archived: row.archived,
    opensOver: Array.isArray(over) ? over.filter((x): x is string => typeof x === 'string') : [],
    createdAt: row.createdAt,
  };
}

export function useApps(): Apps {
  const q = trpc.entity.query.useQuery({ query: APPS_QUERY });
  const rows = q.data ?? NO_ROWS;
  const status = q.data !== undefined ? 'ok' : q.isError ? 'error' : 'loading';
  return useMemo(() => {
    // Оболочка хоста — одним определением с рамкой (`isHostShellRow`, финал 1б Fable M-3).
    const shells = rows.filter(isHostShellRow);
    const own = rows.filter((r) => !isHostShellRow(r));
    const byId = new Map(own.map((r) => [r.id, { ...infoOf(r), row: r }]));
    return {
      apps: [...byId.values()],
      byId,
      hostShell: shells.find((r) => !r.archived) ?? shells[0] ?? null,
      status,
    };
  }, [rows, status]);
}
