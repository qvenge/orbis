// Wire-контракт подписки Agenda (§А5-5, §Б5-6): ОДИН вызов вместо трёх `entity.query`.
// Раскладка по дням и порядок внутри дня остаются клиентскими (Р-И-18) — сюда едет плоский
// список с тегом секции: дневная сетка зависит от таймзоны владельца, а тащить таймзону в
// контракт незачем — она приезжает полем ответа.
import { z } from 'zod';
import { entitySchema } from '../schemas/entity';

/** Потолок горизонта: дальше начинается Calendar view (§4.3, Future), а не Повестка. */
export const AGENDA_DAYS_MAX = 31;
export const agendaListInput = z
  .object({ days: z.number().int().min(1).max(AGENDA_DAYS_MAX).default(8) })
  .strict();
export const agendaRowSchema = z
  .object({
    entity: entitySchema,
    section: z.enum(['window', 'overdue']),
    /**
     * `window` — значение слота `moment` как есть (клиент считает по нему локальный день и
     * время); `overdue` — релевантная дата 'YYYY-MM-DD': минимум `deadline` и локального дня
     * `moment` (§Б5-6). Два вида в одном поле потому, что у секций разный масштаб — день
     * против момента, и приведение момента к дате убило бы колонку времени.
     */
    at: z.string().min(1),
    slot: z.enum(['moment', 'deadline']),
    allDay: z.boolean(),
  })
  .strict();
export const agendaListResultSchema = z
  .object({
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1),
    rows: z.array(agendaRowSchema),
    /** Упор в `limit` секции уходит наружу явно (урок C6: молча резать нельзя). */
    truncated: z.object({ window: z.boolean(), overdue: z.boolean() }).strict(),
  })
  .strict();
export type AgendaListInput = z.infer<typeof agendaListInput>;
export type AgendaRow = z.infer<typeof agendaRowSchema>;
export type AgendaListResult = z.infer<typeof agendaListResultSchema>;
