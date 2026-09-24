/**
 * Поиск абсолютной даты в фильтре (спека страниц §5.6): в блоке данных страницы или шаблона
 * абсолютная дата — ошибка блока с подсказкой относительного токена. Тип «дата» знает только
 * реестр (`date` | `timestamp`), поэтому проверка идёт по нему, а не по виду строки.
 */
import { expect, test } from 'bun:test';
import type { QueryAst } from './ast';
import { FIXTURE_PARSE_REGISTRY as REG } from './ast-fixtures';
import { absoluteDateIn, RELATIVE_DATE_TOKENS } from './dates';
import { parseQueryAst } from './parse-ast';

function parsed(text: string): QueryAst {
  const r = parseQueryAst(text, REG);
  if (!r.ok) throw new Error(`ожидался разбор, получен отказ ${r.error.code}: ${r.error.message}`);
  return r.ast;
}

test('RELATIVE_DATE_TOKENS — ровно четыре токена грамматики', () => {
  expect([...RELATIVE_DATE_TOKENS]).toEqual(['today', 'overdue', 'next_7d', 'after_7d']);
});

test('относительный токен — не абсолютная дата', () => {
  expect(absoluteDateIn(parsed('orbis/due_date=today'), REG)).toBeNull();
  expect(absoluteDateIn(parsed('orbis/due_date<=overdue'), REG)).toBeNull();
  expect(absoluteDateIn(parsed('aspect=orbis/task'), REG)).toBeNull();
  expect(absoluteDateIn({ filter: null }, REG)).toBeNull();
});

test('скаляр: включающая граница `<=` с датой', () => {
  expect(absoluteDateIn(parsed('orbis/due_date<=2026-01-01'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-01-01',
  });
  expect(absoluteDateIn(parsed('orbis/due_date!=2026-01-01'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-01-01',
  });
});

test('диапазон: первая абсолютная граница, токен в границе пропускается', () => {
  // core-проекция `orbis/created_at` (timestamp) — тоже дата.
  const range: QueryAst = {
    filter: {
      prop: 'orbis/created_at',
      op: 'range',
      value: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z' },
    },
  };
  expect(absoluteDateIn(range, REG)).toEqual({
    prop: 'orbis/created_at',
    value: '2026-06-01T00:00:00Z',
  });
  expect(absoluteDateIn(parsed('orbis/due_date=2026-06-01..2026-06-30'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-06-01',
  });
  // Нижняя граница — токен, верхняя — дата: ответ — верхняя.
  expect(absoluteDateIn(parsed('orbis/due_date=today..2026-06-30'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-06-30',
  });
  expect(absoluteDateIn(parsed('orbis/due_date=today..next_7d'), REG)).toBeNull();
});

test('список: смесь токена и даты — находится дата (и в |-форме, и в `in` тула)', () => {
  expect(absoluteDateIn(parsed('orbis/due_date=today|2026-01-01'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-01-01',
  });
  const viaTool: QueryAst = {
    filter: { prop: 'orbis/due_date', op: 'in', value: ['2026-01-01', '2026-01-02'] },
  };
  expect(absoluteDateIn(viaTool, REG)).toEqual({ prop: 'orbis/due_date', value: '2026-01-01' });
});

test('or/not/and обходятся на любой глубине', () => {
  expect(absoluteDateIn(parsed('aspect=orbis/task, orbis/due_date=!2026-01-01'), REG)).toEqual({
    prop: 'orbis/due_date',
    value: '2026-01-01',
  });
  const deep: QueryAst = {
    filter: {
      and: [
        { aspect: 'orbis/task' },
        {
          or: [
            { tag: 'дом' },
            { not: { prop: 'orbis/start_at', op: 'gt', value: '2026-01-01T09:00:00Z' } },
          ],
        },
      ],
    },
  };
  expect(absoluteDateIn(deep, REG)).toEqual({
    prop: 'orbis/start_at',
    value: '2026-01-01T09:00:00Z',
  });
});

test('не дата: has=, текстовое свойство со «строкой-датой», неизвестное свойство', () => {
  expect(absoluteDateIn(parsed('has=orbis/due_date'), REG)).toBeNull();
  // Свойство типа text (core `orbis/title`) со значением, похожим на дату, — это текст.
  expect(absoluteDateIn(parsed('orbis/title=2026-01-01'), REG)).toBeNull();
  // Ловушка эвристики: паттерн похож на момент, тип в реестре — text.
  expect(absoluteDateIn(parsed('user/timestamp_trap=2026-01-01T09:00'), REG)).toBeNull();
  // Свойства нет в реестре — «дата» ли оно, неизвестно; судить берётся только реестр.
  const unknown: QueryAst = { filter: { prop: 'user/nope', op: 'eq', value: '2026-01-01' } };
  expect(absoluteDateIn(unknown, REG)).toBeNull();
});
