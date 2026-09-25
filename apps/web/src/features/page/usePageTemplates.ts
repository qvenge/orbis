import { type TemplateCandidate, templatesFromRows } from '@orbis/shared';
import { useMemo } from 'react';
import { trpc } from '../../trpc';
import type { WireEntity } from '../entity-detail/record-host';

/**
 * Список шаблонов владельца (спека страниц 1а §4.2, §6.5; РП-14): страницы с непустым «Шаблон
 * для». Архивные сервер отбрасывает сам — запрос об архивности не высказывается.
 *
 * Обычный `entity.query` текстом — под ОБЩИМ ключом, который гасит `invalidateGraph`: любая правка
 * графа (в том числе «Шаблон для» и «Главнее, чем», в том числе агентом) перечитает список, а
 * своего ключа с ручной инвалидацией правка агентом не заметила бы вовсе.
 */
export const PAGE_TEMPLATES_QUERY = 'aspect=orbis/page, has=orbis/template_for';

const NO_ROWS: WireEntity[] = [];

export interface PageTemplates {
  /** Кандидаты выбора (§4.2): пустой «Шаблон для» — не шаблон, отброшен `templatesFromRows`. */
  templates: TemplateCandidate[];
  /** Строки списка: заголовок для плашек и тело шаблона для рендера (`entity.query` его несёт). */
  rows: WireEntity[];
  /**
   * `loading` — списка ещё нет; `error` — не приехал (экран показывает шаблон хоста с плашкой и
   * работает дальше, РП-14). Уже приехавший список при отказе перечитывания остаётся `ok`:
   * последний известный выбор честнее, чем шаблон хоста.
   */
  status: 'loading' | 'ok' | 'error';
}

export function usePageTemplates(): PageTemplates {
  const q = trpc.entity.query.useQuery({ query: PAGE_TEMPLATES_QUERY });
  const rows = q.data ?? NO_ROWS;
  const templates = useMemo(() => templatesFromRows(rows), [rows]);
  const status = q.data !== undefined ? 'ok' : q.isError ? 'error' : 'loading';
  // Один объект на одно состояние списка: выбор шаблона мемоизирован по нему.
  return useMemo(() => ({ templates, rows, status }), [templates, rows, status]);
}
