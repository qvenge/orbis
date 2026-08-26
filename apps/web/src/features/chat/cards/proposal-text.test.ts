// Подписи расхождений предложения (Ш1.3, §А7-3/§А7-4). Единица расхождения — СВОЙСТВО, а
// подписи в `lib/field-labels` до Задачи 13a знают старые имена полей: без перевода владелец
// читал бы «task_status: ожидали done» вместо «Задача · статус: …».
import { describe, expect, test } from 'vitest';
import {
  BODY_MISMATCH_TEXT,
  divergenceRows,
  legacyPairOf,
  noteKey,
  noteText,
  propertyLabel,
} from './proposal-text';

describe('noteText: обе формы расхождения на прогоне', () => {
  test('новая форма (свойство) читается теми же словами, что и прежняя пара', () => {
    const byProperty = noteText({
      property: 'orbis/task_status',
      note: 'ожидали inbox, сейчас done',
    });
    const byPair = noteText({
      aspect: 'orbis/task',
      field: 'status',
      note: 'ожидали inbox, сейчас done',
    });
    expect(byProperty).toBe('Задача · статус: ожидали inbox, сейчас done');
    // Формы две, строка одна: владелец не должен видеть разницы между прогонами до и после
    expect(byProperty).toBe(byPair);
  });

  test('расхождение ТЕЛА сохраняет свой текст в обеих формах', () => {
    expect(noteText({ property: 'orbis/body', note: 'тело изменено' })).toBe(BODY_MISMATCH_TEXT);
    expect(noteText({ aspect: '', field: 'body', note: 'тело изменено' })).toBe(BODY_MISMATCH_TEXT);
  });

  test('core-проекция подписана без выдуманного носителя: аспекта у неё нет (§А1-3)', () => {
    // Псевдо-аспект `orbis/entity` снят Задачей 5, и подставлять core-свойству носителя
    // больше нечем. Подпись — одно имя поля, ровно как у строк отложенной единицы, где
    // `archived` и раньше приезжал без аспекта: два разных слова про одно поле были бы
    // двумя разными полями для читателя.
    expect(noteText({ property: 'orbis/archived', note: 'ожидали false, сейчас true' })).toBe(
      'архив: ожидали false, сейчас true',
    );
    expect(propertyLabel('orbis/archived')).toBe('архив');
    expect(propertyLabel('orbis/task_status')).toBe('Задача · статус');
  });

  test('своё свойство владельца деградирует честно: локальное имя, а не сырой id', () => {
    expect(noteText({ property: 'user/часы', note: 'изменилось' })).toBe('часы: изменилось');
  });

  test('legacyPairOf переводит по таблице соответствий, а не по догадке', () => {
    expect(legacyPairOf('orbis/amount')).toEqual({ aspect: 'orbis/financial', field: 'amount' });
    expect(legacyPairOf('orbis/routine_at')).toEqual({ aspect: 'orbis/routine', field: 'at' });
    // Носителя нет — и поля `aspect` в ответе нет вовсе: пустая строка была вторым способом
    // сказать «здесь не аспект», и печаталась она пустым местом перед разделителем.
    expect(legacyPairOf('orbis/body')).toEqual({ field: 'body' });
    expect(legacyPairOf('orbis/archived')).toEqual({ field: 'archived' });
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
    expect(divergenceRows({ mismatches: [], bodyChanged: true })).toEqual([
      { key: 'orbis/body', text: BODY_MISMATCH_TEXT },
    ]);
  });

  test('расхождения по свойствам печатаются значениями; ключ строки — id свойства', () => {
    expect(
      divergenceRows({
        mismatches: [{ property: 'orbis/task_status', expected: ['inbox'], actual: 'done' }],
        bodyChanged: false,
      }),
    ).toEqual([{ key: 'orbis/task_status', text: 'Задача · статус: ожидали inbox, сейчас done' }]);
  });

  test('форма absent печатается словами «поля не было», а не литералом', () => {
    expect(
      divergenceRows({
        mismatches: [{ property: 'orbis/due_date', expected: 'absent', actual: '2026-09-01' }],
        bodyChanged: false,
      })[0]?.text,
    ).toBe('Задача · срок: ожидали поля не было, сейчас 2026-09-01');
  });

  test('пустой ответ — пустой список: «устарело» без причин не рисуется вовсе', () => {
    expect(divergenceRows({ mismatches: [], bodyChanged: false })).toEqual([]);
  });
});
