// apps/server/src/test/overview-golden.ts
// Нормализатор и загрузчик снимка вывода движка Budget (`test/golden/budget-engine.json`) — эталона
// §С8-15 с тех пор, как второй реализации Overview нет (Р-32, В-10). Дом — `src/test/`, а не рядом с
// тестом: снимок читают ДВА сьюта — обычный (`subscriptions/budget-golden.test.ts`, половина
// `fixtures`) и перф-сьют корпуса (`perf/volume.test.ts`, половина `volume`), как и
// `volume-fixture.ts`. Не тест сам по себе.
import { createHash } from 'node:crypto';
import { type BudgetOverview, canonicalJson } from '@orbis/shared';
import GOLDEN from '../../test/golden/budget-engine.json';

/** Штампы времени и uuid — единственное, что в выводе движка не детерминировано: у юнит-фикстур
 *  владелец `mintGraph()`, у корпуса volume `created_at` ставит БД. Замена идёт по ПОРЯДКУ ПЕРВОЙ
 *  ВСТРЕЧИ при обходе, то есть порядок элементов списков остаётся значимым — он и сверяется. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_FIELDS = new Set(['createdAt', 'updatedAt']); // ровно два поля `entitySchema` (schemas/entity.ts:26-27)

export function normalizeOverview(value: unknown): unknown {
  const seen = new Map<string, string>();
  const walk = (v: unknown, field?: string): unknown => {
    if (typeof v === 'string') {
      if (field !== undefined && TS_FIELDS.has(field)) return '<ts>';
      if (!UUID_RE.test(v)) return v;
      const known = seen.get(v);
      if (known !== undefined) return known;
      const next = `uuid-${seen.size + 1}`;
      seen.set(v, next);
      return next;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return walk(value);
}

/**
 * Снимок месяца КОРПУСА: нормализованный Overview, в котором два списка (`comingUp`, `planned`)
 * лежат ОТПЕЧАТКОМ — числом строк и sha256 их канонической формы, — а всё остальное целиком.
 *
 * Почему не целиком (замер 23.09, корпус 20k): списки корпуса — 360 и 1063 полных строки на
 * месяц, окном месяца не режутся (`coming_up` — окно от «сегодня», `planned` — без окна) и потому
 * ОДИНАКОВЫ во всех двенадцати месяцах; целиком снимок весил бы 8,0 МБ в одну строку, из них
 * 7,7 МБ — двенадцать копий двух списков. Отпечаток сверяет их так же строго (любой байт
 * нормализованной формы меняет sha256), теряя только адрес расхождения; а адрес даёт половина
 * `fixtures` — там те же списки считает тот же `runList`, и хранятся они целиком. Конверты и
 * ведомости периода — то, ради чего корпус и заведён (§С8-15 «все 480 конвертов и все
 * ведомости»), — хранятся полностью.
 */
export function volumeSnapshotOf(ov: BudgetOverview): unknown {
  const n = normalizeOverview(ov) as Record<string, unknown>;
  const digest = (list: unknown) => ({
    count: (list as unknown[]).length,
    sha256: createHash('sha256').update(canonicalJson(list)).digest('hex'),
  });
  return { ...n, comingUp: digest(n.comingUp), planned: digest(n.planned) };
}

/** Форма файла снимка (§1.14): имя фикстуры → нормализованный Overview; месяц корпуса → его
 *  снимок (`volumeSnapshotOf`). */
export interface BudgetEngineGolden {
  fixtures: Record<string, unknown>;
  volume: Record<string, unknown>;
}

export const BUDGET_ENGINE_GOLDEN: BudgetEngineGolden = GOLDEN;
