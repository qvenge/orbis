// packages/shared/src/pages/day-groups.ts
// РАСКЛАДКА СТРОК ГРУППИРОВКИ ПО ДНЯМ (спека 1в §5.2, РП-11) — чистая функция: сервер выбирает
// строки блока SQL'ем (ключ записи `__key_at` и даты «когда» `__when_dates` — `contract-sql.ts`), а
// дни, выбор даты в дне и подробности колонки времени считает здесь, под тестом без базы.
//
// ПОЧЕМУ СЕРВЕР, А НЕ КЛИЕНТ (§5.2): день записи — день её ключа В ПОЯСЕ ВЛАДЕЛЬЦА. Браузер в другом
// поясе (поездка, UTC на рабочем компьютере) поставил бы задачу, закрытую в 23:40, во «вчера» или
// «завтра», а лента разошлась бы с тем, что видит агент. Клиент получает готовые группы и пояс ответа.
import type { BlockDayGroup, BlockGroupRow, BlockRowAt } from '../contracts/blocks';
import { addDays, daysInclusive } from '../date';
import { bindingIndexOf } from '../registry/bindings';
import type { RowRegistry } from '../registry/row';
import type { Entity } from '../schemas/entity';

/** Слоты значения «даты» контракта «когда» (§4.1) в порядке приоритета «какая дата поставила запись в день». */
const PRIORITY = ['done', 'moment', 'deadline'] as const;
type WhenSlot = (typeof PRIORITY)[number];

/** Период блока длиной до стольких дней показывает все дни, пустые — «свободно» (§5.2). */
export const DAY_GROUPS_FULL_PERIOD_DAYS = 31;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Строка выборки: запись, её ключ (§3.3, ISO; `null` — без даты) и даты «когда» (только у значения). */
export interface DayGroupInputRow {
  entity: Entity;
  keyAt: string | null;
  dates: ReadonlyArray<{ slot: WhenSlot; at: string; day: string; aspect: string }>;
}

/**
 * Поле группы: значение контракта (даты с приоритетом, подробности момента), адрес слота или
 * свойство (одна дата, `at.slot = null`). Нужно раскладке, чтобы найти СЫРОЕ значение той даты, что
 * поставила запись в день: `value` колонки — как значение лежит в свойстве (день или момент ISO).
 */
export type DayGroupField =
  | { kind: 'value'; contract: string }
  | { kind: 'slot'; contract: string; slot: string }
  | { kind: 'property'; propertyId: string };

/** День момента в поясе; дата без времени — как есть (она уже день владельца). */
function dayOf(value: string, fmt: Intl.DateTimeFormat): string {
  return DAY_RE.test(value) ? value : fmt.format(new Date(value));
}

/** «Без времени» внутри дня (§5.2): «весь день», срок, дата-факт — идут первыми. */
function untimed(at: BlockRowAt): boolean {
  return at.allDay || at.slot === 'deadline' || DAY_RE.test(at.value);
}

/**
 * Раскладка строк по дням. Вход — строки в порядке выборки (ключ, затем `sortBy` блока, затем `id`);
 * `period` — интервал условия `=T` на том же адресе (края токена, литерал дня, `range` с двумя краями),
 * `null` — условия нет или у интервала нет края.
 *
 * - День группы — день `keyAt` в поясе `timeZone`; строка без ключа — группа «Без даты» последней.
 * - Дата в дне — среди дат «когда» с этим днём по приоритету `done > moment > deadline` (одного слота —
 *   ранняя); у `moment` — `end` и «весь день» ТОЙ ЖЕ привязки (аспекта, поставившего момент).
 * - Внутри дня — сначала без времени (в порядке входа), затем по времени (равное — в порядке входа).
 * - Период до 31 дня — все его дни, пустые с `rows: []`; длиннее — только непустые. При обрезке
 *   лимитом (`more > 0`) дни после последней строки не рисуются «свободными»: их пустота не доказана.
 */
export function layoutDayGroups(input: {
  rows: readonly DayGroupInputRow[];
  more: number;
  timeZone: string;
  period: { start: string; end: string } | null;
  reg: RowRegistry;
  field: DayGroupField;
}): { groups: BlockDayGroup[]; more: number } {
  const { rows, more, timeZone, period, reg, field } = input;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone });
  const idx = bindingIndexOf(reg);

  /** Значение слота контракта привязки аспекта на записи: свойство или константа `fixed`. */
  const bound = (entity: Entity, aspect: string, contract: string, slot: string): unknown => {
    const at = idx.slotOf(aspect, contract, slot);
    if (at === undefined) return undefined;
    return 'prop' in at ? entity.props[at.prop] : at.fixed;
  };

  /** Одна дата без приоритета (свойство, адрес слота): сырое значение с днём группы, иначе ключ. */
  const single = (row: DayGroupInputRow, day: string, keyAt: string): BlockRowAt => {
    const raws =
      field.kind === 'property'
        ? [row.entity.props[field.propertyId]]
        : field.kind === 'slot'
          ? idx
              .byContract(field.contract)
              .filter((b) => row.entity.aspects.includes(b.aspectId))
              .map((b) => bound(row.entity, b.aspectId, field.contract, field.slot))
          : [];
    const own = raws
      .filter((v): v is string => typeof v === 'string' && dayOf(v, fmt) === day)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const value = own[0] ?? keyAt;
    return { slot: null, value, end: null, allDay: DAY_RE.test(value) };
  };

  /** Дата значения «когда» в дне по приоритету и подробности её привязки. */
  const chosen = (row: DayGroupInputRow, day: string, keyAt: string, contract: string) => {
    const inDay = row.dates.filter((x) => x.day === day);
    for (const slot of PRIORITY) {
      const pick = inDay
        .filter((x) => x.slot === slot)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
      if (pick === undefined) continue;
      const raw = bound(row.entity, pick.aspect, contract, slot);
      const value = typeof raw === 'string' ? raw : pick.at;
      if (slot !== 'moment') return { slot, value, end: null, allDay: false } satisfies BlockRowAt;
      const end = bound(row.entity, pick.aspect, contract, 'end');
      const allDay =
        DAY_RE.test(value) || bound(row.entity, pick.aspect, contract, 'all_day') === true;
      return { slot, value, end: typeof end === 'string' ? end : null, allDay };
    }
    // Ключ без даты в своём дне (быть не должно: ключ — одна из дат) — момент ключа, без слота.
    return { slot: null, value: keyAt, end: null, allDay: false } satisfies BlockRowAt;
  };

  const byDay = new Map<string, BlockGroupRow[]>();
  const noDate: BlockGroupRow[] = [];
  for (const row of rows) {
    if (row.keyAt === null) {
      noDate.push({ entity: row.entity, at: null });
      continue;
    }
    const day = dayOf(row.keyAt, fmt);
    const at =
      field.kind === 'value'
        ? chosen(row, day, row.keyAt, field.contract)
        : single(row, day, row.keyAt);
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [{ entity: row.entity, at }]);
    else list.push({ entity: row.entity, at });
  }

  const days = new Set(byDay.keys());
  if (period !== null && daysInclusive(period.start, period.end) <= DAY_GROUPS_FULL_PERIOD_DAYS) {
    // Обрезка лимитом: выборка идёт по ключу, и последний показанный день — граница доказанного.
    const lastShown = [...byDay.keys()].sort().at(-1);
    const end =
      more > 0 && noDate.length === 0 && lastShown !== undefined && lastShown < period.end
        ? lastShown
        : period.end;
    for (let d = period.start; d <= end; d = addDays(d, 1)) days.add(d);
  }

  const groups: BlockDayGroup[] = [...days].sort().map((day) => {
    const list = byDay.get(day) ?? [];
    // Стабильная сортировка: без времени — первыми в порядке входа, затем по моменту.
    const rowsOfDay = [...list].sort((a, b) => {
      const ua = untimed(a.at as BlockRowAt);
      const ub = untimed(b.at as BlockRowAt);
      if (ua || ub) return ua === ub ? 0 : ua ? -1 : 1;
      return Date.parse((a.at as BlockRowAt).value) - Date.parse((b.at as BlockRowAt).value);
    });
    return { day, rows: rowsOfDay };
  });
  if (noDate.length > 0) groups.push({ day: null, rows: noDate });
  return { groups, more };
}
