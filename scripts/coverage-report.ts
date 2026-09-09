#!/usr/bin/env bun
/**
 * Отчёт §С1-4 при закрытии Б-1 (приёмка §С8-14).
 *
 * Почему скриптом, а не разбором в леджере. §С8-14 требует сравнить три корзины с прогнозом
 * «≈ 445 / ≈ 180 / ≈ 17 из 642» и разобрать поимённо всё, что разошлось больше чем на 10 %.
 * Число, полученное разовым чтением таблиц глазами, проверить нельзя: черновой парс разведки
 * дал 643 строки и ≈688 «мест» — на 46 мест больше шапки спеки, — и разошёлся с ней методом,
 * а не арифметикой. Метод обязан лежать в репозитории и быть перезапускаемым.
 *
 * МЕТОД (он же — раздел «Метод» отчёта):
 *  1. Место = уникальный номер зоны из колонки «Z<k>-№№». Строка таблицы может нести несколько
 *     номеров («Z1-3, 4», «Z5-74–76») — это несколько мест; подпункты одного номера («86a…86f»)
 *     — ОДНО место (ревизия 3, Ф-14 леджера среза А, из-за чего счёт стал 642, а не 648).
 *  2. Род места = ВЕДУЩИЙ род клетки «Род»: первая пометка до `←`, `+` и запятой. Вторые
 *     вердикты двойной разметки в счёт мест не идут — иначе сумма перестаёт быть числом мест
 *     (сводки зон Z3 и Z4 считают именно пометки: 130 при 106 строках и 159 при 141).
 *  3. Место, названное несколькими строками, берёт род ПЕРВОЙ из них.
 *  4. Корзины: `B` → машинерия слоя B; `остаток C` → именованный остаток; остальные семь родов
 *     (Q, D, C, T, V, E, P) → данные, то есть «переехало в декларацию».
 *
 * Метод самопроверяем: у трёх зон из пяти сводка спеки считает тем же способом (Z1 — «по
 * основному роду места», Z2 — «по ведущему роду строки», Z5 — «по ведущему роду места»), и
 * тест сверяет счётчик парсера с их таблицами клетка в клетку. У Z3 и Z4 сводка объявляет
 * другой метод — там сверяется только неравенство «пометок больше, чем мест».
 *
 * Запуск: `bun scripts/coverage-report.ts` — markdown-отчёт в stdout, код 0 всегда.
 * Отчёт §С8-14 «срез не останавливает», поэтому падающего режима у скрипта НЕТ.
 */
export const SPEC_PATH = 'docs/superpowers/specs/2026-08-26-properties-reform-design.md';

export type Genus = 'Q' | 'D' | 'C' | 'T' | 'V' | 'E' | 'P' | 'B' | 'остаток C';
export type Basket = 'данные' | 'машинерия B' | 'остаток C';
export const GENUS_ORDER: readonly Genus[] = ['Q', 'D', 'C', 'T', 'V', 'E', 'P', 'B', 'остаток C'];

/** Счёт мест по зонам — шапка §С1-4 (спека:644). Пин: парсер обязан воспроизвести его. */
export const DECLARED_PLACES: Readonly<Record<string, number>> = {
  Z1: 112, Z2: 108, Z3: 100, Z4: 141, Z5: 181,
};
/** Прогноз §С8-14 (спека:1620): «по ведущему роду ≈ 445 / ≈ 180 / ≈ 17 из 642». */
export const FORECAST: Readonly<Record<Basket, number>> = {
  данные: 445, 'машинерия B': 180, 'остаток C': 17,
};
/** §С8-14: расхождение больше этой доли разбирается поимённо. */
export const DEVIATION_LIMIT = 0.1;

export function leadingGenus(cell: string): Genus {
  if (/^остаток C/.test(cell)) return 'остаток C';
  const m = /[QDCTVEPB]/.exec(cell);
  if (m === null) throw new Error(`coverage-report: род не распознан в клетке «${cell}»`);
  return m[0] as Genus;
}

export function basketOf(genus: Genus): Basket {
  if (genus === 'B') return 'машинерия B';
  if (genus === 'остаток C') return 'остаток C';
  return 'данные';
}

export function placeNumbers(cell: string): string[] {
  const t = cell.replace(/Z\d-/g, '').replace(/\s/g, '');
  const out: string[] = [];
  for (const part of t.split(',')) {
    const range = /^(\d+)[–—-](\d+)$/.exec(part);
    if (range !== null) {
      for (let k = Number(range[1]); k <= Number(range[2]); k += 1) out.push(String(k));
      continue;
    }
    const one = /^(\d+)[a-f]?$/.exec(part);
    if (one !== null) out.push(one[1] as string);
  }
  return out;
}

interface ZoneSlice { zone: string; table: string[]; summary: string[]; caption: string }

/** Разрез спеки на зоны: таблица покрытия и её «Сводка (правило 5)». */
export function sliceZones(md: string): ZoneSlice[] {
  const out: ZoneSlice[] = [];
  let cur: ZoneSlice | null = null;
  let mode: 'table' | 'summary' | 'none' = 'none';
  for (const line of md.split('\n')) {
    const head = /^#### Покрытие (?:зоны )?(Z\d)/.exec(line);
    if (head !== null) {
      cur = { zone: head[1] as string, table: [], summary: [], caption: '' };
      out.push(cur);
      mode = 'table';
      continue;
    }
    if (/^#{2,6} /.test(line)) {
      // «Сводка» принадлежит текущей зоне; любой другой заголовок закрывает её целиком.
      mode = cur !== null && /^##### Сводка/.test(line) ? 'summary' : 'none';
      if (mode === 'none') cur = null;
      continue;
    }
    if (cur === null) continue;
    if (mode === 'table' && line.startsWith('|')) cur.table.push(line);
    if (mode === 'summary') {
      if (line.includes('Счётчик по родам')) cur.caption = line;
      if (line.startsWith('|')) cur.summary.push(line);
    }
  }
  return out;
}

/** Клетки строки таблицы; хвост после третьей колонки не разбирается — там свободный текст. */
function cells(line: string): string[] {
  return line.split('|').slice(1).map((s) => s.trim());
}
const isRule = (line: string): boolean => /^\|\s*[-:]+/.test(line);

export interface ZoneCoverage {
  zone: string; rows: number; places: number;
  byGenus: Record<Genus, number>; byBasket: Record<Basket, number>;
  residualLeading: string[]; residualAny: string[];
  declared: { leading: boolean; byGenus: Record<Genus, number> } | null;
}
export interface Coverage {
  zones: ZoneCoverage[]; places: number; byBasket: Record<Basket, number>; residualAny: string[];
}

const zeroGenus = (): Record<Genus, number> =>
  Object.fromEntries(GENUS_ORDER.map((g) => [g, 0])) as Record<Genus, number>;

/** Счётчик из «Сводки» зоны — и объявленный ею метод (сверять можно только «по ведущему роду»). */
function parseDeclared(slice: ZoneSlice): { leading: boolean; byGenus: Record<Genus, number> } | null {
  if (slice.summary.length === 0) return null;
  const byGenus = zeroGenus();
  for (const line of slice.summary) {
    if (isRule(line)) continue;
    const c = cells(line);
    const name = (c[0] ?? '').replace(/\*/g, '').trim();
    if (name === '' || name === 'Род' || name.startsWith('Итого')) continue;
    const n = Number((c[1] ?? '').replace(/\*/g, '').trim());
    if (!Number.isFinite(n)) continue;
    byGenus[leadingGenus(name)] += n;
  }
  return { leading: /ведущ|основн/.test(slice.caption), byGenus };
}

export function parseCoverage(md: string): Coverage {
  const zones: ZoneCoverage[] = [];
  for (const slice of sliceZones(md)) {
    const genusOf = new Map<string, Genus>();
    const anyResidual = new Set<string>();
    let rows = 0;
    for (const line of slice.table) {
      if (isRule(line)) continue;
      const c = cells(line);
      if ((c[2] ?? '') === 'Род') continue; // шапка таблицы зоны
      rows += 1;
      const genus = leadingGenus(c[2] as string);
      const mentionsResidual = /остаток C/.test(c[2] as string);
      for (const n of placeNumbers(c[1] as string)) {
        // Место, названное несколькими строками, берёт род ПЕРВОЙ из них (метод, п. 3).
        if (!genusOf.has(n)) genusOf.set(n, genus);
        if (mentionsResidual) anyResidual.add(n);
      }
    }
    const byGenus = zeroGenus();
    for (const g of genusOf.values()) byGenus[g] += 1;
    const byBasket: Record<Basket, number> = { данные: 0, 'машинерия B': 0, 'остаток C': 0 };
    for (const g of GENUS_ORDER) byBasket[basketOf(g)] += byGenus[g];
    zones.push({
      zone: slice.zone, rows, places: genusOf.size, byGenus, byBasket,
      residualLeading: [...genusOf.entries()].filter(([, g]) => g === 'остаток C').map(([n]) => `${slice.zone}-${n}`),
      residualAny: [...anyResidual].map((n) => `${slice.zone}-${n}`),
      declared: parseDeclared(slice),
    });
  }
  const byBasket: Record<Basket, number> = { данные: 0, 'машинерия B': 0, 'остаток C': 0 };
  for (const z of zones) for (const b of Object.keys(byBasket) as Basket[]) byBasket[b] += z.byBasket[b];
  return {
    zones,
    places: zones.reduce((a, z) => a + z.places, 0),
    byBasket,
    residualAny: zones.flatMap((z) => z.residualAny),
  };
}
