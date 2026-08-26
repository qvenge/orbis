// Подписи расхождений предложения (Ш1.3, §А7-4). Единица расхождения на прогоне стала
// СВОЙСТВОМ, а подписи в `lib/field-labels` до Задачи 13a знают старые имена полей: без
// перевода владелец читал бы «task_status: ожидали done» вместо «Задача · статус: …».
import { describe, expect, test } from 'vitest';
import { BODY_MISMATCH_TEXT, legacyPairOf, noteKey, noteText } from './proposal-text';

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

  test('core-проекция отложенной архивации подписана как запись, а не сырым id', () => {
    expect(noteText({ property: 'orbis/archived', note: 'ожидали false, сейчас true' })).toBe(
      'Запись · архив: ожидали false, сейчас true',
    );
  });

  test('своё свойство владельца деградирует честно: локальное имя, а не сырой id', () => {
    expect(noteText({ property: 'user/часы', note: 'изменилось' })).toBe(' · часы: изменилось');
  });

  test('legacyPairOf переводит по таблице соответствий, а не по догадке', () => {
    expect(legacyPairOf('orbis/amount')).toEqual({ aspect: 'orbis/financial', field: 'amount' });
    expect(legacyPairOf('orbis/routine_at')).toEqual({ aspect: 'orbis/routine', field: 'at' });
    expect(legacyPairOf('orbis/body')).toEqual({ aspect: '', field: 'body' });
  });

  test('ключ строки списка различает записи обеих форм', () => {
    expect(noteKey({ property: 'orbis/task_status', note: '' })).toBe('orbis/task_status');
    expect(noteKey({ aspect: 'orbis/task', field: 'status', note: '' })).toBe('orbis/task:status');
  });
});
