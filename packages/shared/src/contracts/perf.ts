// packages/shared/src/contracts/perf.ts
// Контракт полевых замеров ступени 0 (спека скорости §3.1–§3.2, §13.1): пачка `perf.report` от клиента владельца.
// СОДЕРЖИМОГО В ЗАМЕРЕ НЕТ — ни текстов, ни заголовков, ни id записей. Держат это схемы `.strict()` (лишний ключ —
// отказ, а не молчаливая обрезка) и маска процедуры: имена процедур tRPC без входа запроса (`entity.get,entity.query`).
import { z } from 'zod';

export const PERF_METRICS = [
  'cold_start_content',
  'cold_start_verified',
  'transition',
  'action_visible',
  'action_confirmed',
  'inp',
  'lcp',
  'request',
] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];
export const PERF_SCREENS = [
  'home',
  'record',
  'page',
  'section',
  'settings',
  'search',
  'other',
] as const;
export const PERF_ACTION_KINDS = ['checkbox', 'status', 'title', 'create', 'other'] as const;
export const perfSampleSchema = z
  .object({
    metric: z.enum(PERF_METRICS),
    screen: z.enum(PERF_SCREENS).optional(),
    kind: z.enum(PERF_ACTION_KINDS).optional(),
    procedure: z
      .string()
      .regex(/^[a-zA-Z.,]{1,200}$/)
      .optional(),
    durMs: z.number().nonnegative().max(600_000),
    serverMs: z.number().nonnegative().optional(),
    dbMs: z.number().nonnegative().optional(),
    device: z.enum(['mobile', 'desktop']),
    net: z.enum(['slow-2g', '2g', '3g', '4g']).optional(),
    cached: z.boolean().optional(),
    appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export const perfReportInput = z
  .object({ samples: z.array(perfSampleSchema).min(1).max(100) })
  .strict();
export interface PerfReportResult {
  accepted: number;
  dropped: number;
}

export type PerfScreen = (typeof PERF_SCREENS)[number];
export type PerfActionKind = (typeof PERF_ACTION_KINDS)[number];
export type PerfSample = z.infer<typeof perfSampleSchema>;
