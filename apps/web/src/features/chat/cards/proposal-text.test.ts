// Подписи расхождений предложения (Ш1.3, §А7-3/§А7-4). Единица расхождения — СВОЙСТВО, и
// подпись ему даёт РЕЕСТР (§А9-2): без неё владелец читал бы «orbis/task_status: ожидали
// done» вместо «Задача · Состояние задачи: …».
//
// Реестр здесь НАСТОЯЩИЙ (`BUILTIN_REGISTRY`), а не выдуманный словарь: слова, которыми тест
// проверяет подписи, обязаны быть теми же, что увидит владелец.
import { describe, expect, test } from 'vitest';
import { lookupOf } from '../../../lib/registry/labels';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import {
  BODY_MISMATCH_TEXT,
  divergenceRows,
  noteKey,
  noteText,
  propertyLabel,
} from './proposal-text';

const reg = lookupOf(BUILTIN_REGISTRY);
/** Реестр ещё не приехал: подписи обязаны деградировать, а не исчезать. */
const empty = lookupOf(undefined);

describe('noteText: обе формы расхождения на прогоне', () => {
  test('новая форма (свойство) читается теми же словами, что и прежняя пара', () => {
    const byProperty = noteText(reg, {
      property: 'orbis/task_status',
      note: 'ожидали inbox, сейчас done',
    });
    const byPair = noteText(reg, {
      aspect: 'orbis/task',
      field: 'status',
      note: 'ожидали inbox, сейчас done',
    });
    expect(byProperty).toBe('Задача · Состояние задачи: ожидали inbox, сейчас done');
    // Формы две, строка одна: владелец не должен видеть разницы между прогонами до и после
    expect(byProperty).toBe(byPair);
  });

  test('расхождение ТЕЛА сохраняет свой текст в обеих формах', () => {
    expect(noteText(reg, { property: 'orbis/body', note: 'тело изменено' })).toBe(
      BODY_MISMATCH_TEXT,
    );
    expect(noteText(reg, { aspect: '', field: 'body', note: 'тело изменено' })).toBe(
      BODY_MISMATCH_TEXT,
    );
  });

  test('core-проекция подписана без выдуманного носителя: аспекта у неё нет (§А1-3)', () => {
    // Псевдо-аспект `orbis/entity` снят Задачей 5, и подставлять core-свойству носителя
    // больше нечем: ни один аспект реестра не держит `orbis/archived` в своём `properties[]`.
    // Подпись — одно имя свойства, ровно как у строк отложенной единицы.
    expect(noteText(reg, { property: 'orbis/archived', note: 'ожидали false, сейчас true' })).toBe(
      'В архиве: ожидали false, сейчас true',
    );
    expect(propertyLabel(reg, 'orbis/archived')).toBe('В архиве');
    expect(propertyLabel(reg, 'orbis/task_status')).toBe('Задача · Состояние задачи');
  });

  test('носитель берётся из реестра, а не из переходной карты старой формы', () => {
    // `orbis/finance_category` слит из двух полей (В1) и лежит в ДВУХ аспектах — берётся
    // первый по порядку реестра. Проба именно на слитом: карта старой формы вернула бы для
    // него пару по первому попавшемуся аспекту, а реестр отвечает своим порядком `rank`.
    const carriers = BUILTIN_REGISTRY.aspects.filter((a) =>
      a.properties.some((r) => r.propertyId === 'orbis/finance_category'),
    );
    expect(carriers.length).toBeGreaterThan(1);
    expect(propertyLabel(reg, 'orbis/finance_category')).toBe(
      `${carriers[0]?.label.ru} · Категория`,
    );
  });

  test('своё свойство владельца деградирует честно: локальное имя, а не сырой id', () => {
    expect(noteText(reg, { property: 'user/часы', note: 'изменилось' })).toBe('часы: изменилось');
  });

  test('реестр ещё не приехал — подпись сырая, но строка на месте', () => {
    // Пустой снимок и отсутствие подписи — разные вещи: строка расхождения обязана
    // показаться в любом случае, иначе «Устарело» встало бы над пустотой.
    expect(noteText(empty, { property: 'orbis/task_status', note: 'ожидали inbox' })).toBe(
      'task_status: ожидали inbox',
    );
  });

  test('ключ строки списка — свойство: обе формы дают ОДИН ключ', () => {
    expect(noteKey({ property: 'orbis/task_status', note: '' })).toBe('orbis/task_status');
    expect(noteKey({ aspect: 'orbis/task', field: 'status', note: '' })).toBe('orbis/task_status');
  });
});

describe('divergenceRows: тело — флаг, а не пункт (РП-10)', () => {
  test('bodyChanged даёт строку «Тело: запись изменилась», хотя пунктов по свойствам нет', () => {
    // Ровно тот отказ, ради которого функция и общая: место, забывшее развернуть флаг,
    // показало бы владельцу «Устарело» с пустым списком причин под ним.
    expect(divergenceRows(reg, { mismatches: [], bodyChanged: true })).toEqual([
      { key: 'orbis/body', text: BODY_MISMATCH_TEXT },
    ]);
  });

  test('расхождения по свойствам печатаются значениями; ключ строки — id свойства', () => {
    expect(
      divergenceRows(reg, {
        mismatches: [{ property: 'orbis/task_status', expected: ['inbox'], actual: 'done' }],
        bodyChanged: false,
      }),
    ).toEqual([
      { key: 'orbis/task_status', text: 'Задача · Состояние задачи: ожидали inbox, сейчас done' },
    ]);
  });

  test('форма absent печатается словами «поля не было», а не литералом', () => {
    expect(
      divergenceRows(reg, {
        mismatches: [{ property: 'orbis/due_date', expected: 'absent', actual: '2026-09-01' }],
        bodyChanged: false,
      })[0]?.text,
    ).toBe('Задача · Срок: ожидали поля не было, сейчас 2026-09-01');
  });

  test('пустой ответ — пустой список: «устарело» без причин не рисуется вовсе', () => {
    expect(divergenceRows(reg, { mismatches: [], bodyChanged: false })).toEqual([]);
  });
});
