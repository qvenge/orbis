// Сиды живут здесь, а не в shared: тест сидов — единственная точка, где нужны оба мира,
// и импортировать server из shared было бы инверсией слоёв (ревью И17).
import { describe, expect, test } from 'bun:test';
import { canonicalizeBody, parseBody } from '@orbis/shared/doc';
import {
  ALL_TASKS_BODY,
  DAILY_PLANNING_BODY,
  HORIZON_LIFE_BODY,
  HORIZON_YEAR_BODY,
  ROUTINES_LIST_BODY,
  UPCOMING_BODY,
} from './smart-lists';

const SEEDS: Array<[string, string]> = [
  ['Daily Planning', DAILY_PLANNING_BODY],
  ['Upcoming', UPCOMING_BODY],
  ['All Tasks', ALL_TASKS_BODY],
  ['Горизонт «Год»', HORIZON_YEAR_BODY],
  ['Горизонт «Жизнь»', HORIZON_LIFE_BODY],
  ['Рутины', ROUTINES_LIST_BODY],
];

describe('сиды — канонические', () => {
  for (const [name, body] of SEEDS) {
    test(`${name}: канон равен телу байт-в-байт, raw нет`, () => {
      // «Байт-в-байт» остаётся приёмкой ДЛЯ СИДОВ — потому что они уже канон (вердикт Б1),
      // а не потому что конвертер обязан сохранять любую форму. Инвариант §3.3 PRD цел.
      expect(canonicalizeBody(body).body).toBe(body);
      expect(JSON.stringify(parseBody(body).doc)).not.toContain('rawBlock');
    });
  }
});
