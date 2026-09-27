import type { BlockResult } from '@orbis/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useBlockData } from '../../lib/query-blocks/batch';
import { type SearchGroup, searchBlockTexts } from './search-query';

/**
 * Задержка ввода: запрос и адрес — после паузы в наборе, а не на каждую букву. На слове из семи букв
 * без неё ушло бы семь пачек и семь замен адреса.
 */
export const SEARCH_DELAY_MS = 250;

/** Значение, догоняющее `value` после паузы `ms`. Первое значение — сразу (старт на `/search?q=…`). */
export function useDebounced<T>(value: T, ms: number = SEARCH_DELAY_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Строка ввода → тексты трёх групп после паузы в наборе; пустая строка — `null`. Вызывающий НЕ
 * монтирует хуки групп (`useSearchGroups`) при `null`: `useBlockData` отдал бы на пустой текст отказ
 * `EMPTY`, а поиск без строки — не отказ, а просто ничего.
 */
export function useSearchTexts(q: string): Record<SearchGroup, string> | null {
  return searchBlockTexts(useDebounced(q));
}

export type SearchGroupsData = Record<SearchGroup, UseQueryResult<BlockResult>>;

/**
 * Данные трёх групп — три `useBlockData` в ОДНОМ компоненте (С1б-16): их просьбы встают в очередь
 * собирателя в одном коммите и уходят одной пачкой `entity.blocks` (`lib/query-blocks/batch.tsx`).
 * Три `entity.query` были бы тремя запросами (в проде — одним HTTP, но тремя выборками без общего
 * потолка пачки и мимо кеша блоков, который гасит `invalidateGraph`).
 */
export function useSearchGroups(texts: Record<SearchGroup, string>): SearchGroupsData {
  const records = useBlockData(texts.records);
  const pages = useBlockData(texts.pages);
  const apps = useBlockData(texts.apps);
  return { records, pages, apps };
}
