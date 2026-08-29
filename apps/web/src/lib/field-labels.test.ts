// Страж рукописных словарей подписей (§А9-2, Задача 13a).
//
// Подписи полей и аспектов уехали в реестр, и вернуть их в код можно ОДНИМ движением —
// дописав рядом ещё одну карту «ключ → русское слово». Ломается это молча: карта работает,
// экран выглядит правильно, а владелец, переименовавший свойство, продолжает видеть старое
// слово — и узнаёт об этом не от теста, а от расхождения двух экранов.
//
// Проверка идёт по ИСХОДНИКУ, а не по поведению, потому что проверяемое здесь — именно
// отсутствие кода. Поведенческого следа у «второго словаря» нет вовсе, пока он совпадает
// с реестром: он вреден ровно тем, что когда-нибудь разойдётся.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

/**
 * Исходник соседнего модуля — ТОЛЬКО через параметр, никогда не литералом на месте: vite
 * разбирает `new URL('./литерал', import.meta.url)` статически и подменяет его адресом
 * ассета, на котором readFileSync падает «The URL must be of scheme file» (приём save.test).
 */
function readModule(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

/** Имена констант-словарей `Record<string, string>` в исходнике. */
function labelDictionaries(code: string): string[] {
  return [...code.matchAll(/const\s+(\w+)\s*:\s*Record<\s*string\s*,\s*string\s*>/g)].flatMap(
    (m) => (m[1] === undefined ? [] : [m[1]]),
  );
}

test('field-labels.ts держит ровно ОДИН словарь — подписи агрегатов', () => {
  const code = readModule('./field-labels.ts');
  // Список, а не число: вернувшийся `FIELD_LABELS` должен быть НАЗВАН в падении, иначе
  // читатель отчёта увидит «2 !== 1» и пойдёт искать сам.
  expect(labelDictionaries(code)).toEqual(['AGGREGATE_LABELS']);
  // Позитивный контроль разбора: если бы регулярка перестала находить что-либо, проверка
  // выше проходила бы на ЛЮБОМ файле — в том числе на вернувшем все три прежних словаря.
  expect(labelDictionaries('const X: Record<string, string> = {};')).toEqual(['X']);
  // Имён снятых функций в файле не осталось: `fieldLabel`/`aspectLabel` живут в
  // `registry/labels.ts` и берут слова из реестра.
  expect(code).not.toContain('fieldLabel');
  expect(code.match(/^export .*$/gm)).toEqual([
    'export function aggregateLabel(op: string): string {',
  ]);
});

test('registry/labels.ts не содержит ни одного русского слова в КОДЕ — только правила', () => {
  // Главное свойство модуля подписей: слов в нём нет. Русский текст в нём законен ровно в
  // комментариях, поэтому они снимаются, а всё остальное обязано остаться латиницей.
  const code = readModule('./registry/labels.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  expect(code).not.toMatch(/[А-Яа-яЁё]/);
  // Позитивный контроль снятия комментариев: если бы регулярки съедали ВЕСЬ файл, проверка
  // выше молчала бы и на модуле, набитом словарями.
  expect(code).toContain('export function fieldLabel');
});
