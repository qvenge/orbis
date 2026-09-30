// scripts/lab/summary.ts — сводка лабораторного прогона против целей §0.3 спеки скорости (РП-25).
import { readFileSync } from 'node:fs';

export interface LabSample {
  metric: string;
  kind?: string;
  cached?: boolean;
  durMs: number;
  repeat: number;
  note?: string;
}
export interface Stat {
  n: number;
  p50: number;
  p75: number;
  p95: number;
}
/** Ключ — «метрика|вид|кеш»: цели §0.3 различают повторный переход и переход из сети. */
export type LabSummary = Record<string, Stat>;

/** Линейная интерполяция между соседними рангами — та же формула, что `percentile_cont` в `ops.ts perf`. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export const keyOf = (s: Pick<LabSample, 'metric' | 'kind' | 'cached'>): string =>
  `${s.metric}|${s.kind ?? '-'}|${s.cached === undefined ? '-' : s.cached ? 'кеш' : 'сеть'}`;

export function summarize(samples: readonly LabSample[]): LabSummary {
  const groups = new Map<string, number[]>();
  for (const s of samples) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s.durMs]);
  const out: LabSummary = {};
  for (const [k, v] of groups) {
    const sorted = [...v].sort((a, b) => a - b);
    out[k] = {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    };
  }
  return out;
}

/** Цели §0.3 (p75) и ключи лаборатории. `base` — «не медленнее базы» (цель 5); `null` — лабораторией не мерится. */
export const GOALS: ReadonlyArray<{ goal: string; key: string | null; target: number | 'base' }> = [
  { goal: 'Повторный переход на открывавшийся экран', key: 'transition|repeat|кеш', target: 100 },
  { goal: 'Отклик действия (видимо)', key: 'action_visible|checkbox|-', target: 50 },
  { goal: 'Отклик действия (видимо)', key: 'action_visible|status|-', target: 50 },
  { goal: 'Отклик действия (видимо)', key: 'action_visible|create|-', target: 50 },
  { goal: 'Правка агента видна на открытом экране (< 2 с)', key: null, target: 2000 },
  { goal: 'Перезапуск: последние данные на экране', key: 'cold_start|warm|-', target: 1000 },
  { goal: 'Перезапуск без сети', key: 'cold_start|offline|-', target: 1000 },
  { goal: 'Экран не из кеша — не медленнее базы', key: 'transition|first|сеть', target: 'base' },
];

const fmt = (v: number | undefined) =>
  v === undefined || Number.isNaN(v) ? 'нет данных' : String(Math.round(v));

export function formatTable(base: LabSummary, other: LabSummary | null): string {
  const now = other ?? base;
  const lines = [
    '| Цель §0.3 | Метрика | Цель | База p75 | Сейчас p75 | Итог |',
    '|---|---|---|---|---|---|',
  ];
  for (const g of GOALS) {
    if (g.key === null) {
      lines.push(`| ${g.goal} | — | < ${g.target} мс | — | — | живая приёмка плана Б |`);
      continue;
    }
    const b = base[g.key]?.p75;
    const n = now[g.key]?.p75;
    const limit = g.target === 'base' ? b : g.target;
    const target = g.target === 'base' ? '≤ базы' : `< ${g.target} мс`;
    const ok =
      n === undefined || limit === undefined
        ? '—'
        : g.target === 'base'
          ? n <= limit
            ? 'да'
            : 'нет'
          : n < limit
            ? 'да'
            : 'нет';
    lines.push(
      `| ${g.goal} | ${g.key} | ${target} | ${fmt(b)} | ${n === undefined ? 'нет данных' : fmt(n)} | ${ok} |`,
    );
  }
  lines.push('', '| Метрика | n | p50 | p75 | p95 | база p75 |', '|---|---|---|---|---|---|');
  for (const [k, st] of Object.entries(now).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `| ${k} | ${st.n} | ${fmt(st.p50)} | ${fmt(st.p75)} | ${fmt(st.p95)} | ${fmt(base[k]?.p75)} |`,
    );
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const [basePath, otherPath] = process.argv.slice(2);
  if (basePath === undefined) {
    console.error('summary: bun scripts/lab/summary.ts <база.json> [<сравнение.json>]');
    process.exit(2);
  }
  const read = (p: string) =>
    summarize((JSON.parse(readFileSync(p, 'utf8')) as { samples: LabSample[] }).samples);
  console.log(formatTable(read(basePath), otherPath === undefined ? null : read(otherPath)));
}
