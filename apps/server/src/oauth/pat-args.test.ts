// Разбор аргументов выдачи PAT. Тест живёт в сьюте сервера, а не рядом со скриптами:
// каталог scripts/ не входит ни в один workspace — его не покрывает ни `bun run test`,
// ни `tsc --noEmit` (apps/server/tsconfig.json: include ["src"]). Ошибка в разборе там
// не поймалась бы ничем, кроме выданного не того токена.
import { expect, test } from 'bun:test';
import { parsePatArgs } from './pat-args';

/** Успешный разбор или падение с внятной причиной — вместо `as` и `!` в каждой проверке. */
function parsed(...args: string[]) {
  const out = parsePatArgs(args);
  if ('error' in out) throw new Error(`ожидался разбор, получен отказ: ${out.error}`);
  return out;
}

test('позиционные аргументы: владелец и метка', () => {
  expect(parsed('owner-1', 'CI')).toEqual({ ownerId: 'owner-1', label: 'CI', scope: 'full' });
});

// Область по умолчанию — полный доступ: так подключены все уже описанные в документации
// агенты, и молчаливое сужение отобрало бы у них доступ.
test('без флага область полная', () => {
  expect(parsed('owner-1').scope).toBe('full');
});

test('--scope worker сужает выдачу', () => {
  expect(parsed('owner-1', 'CI', '--scope', 'worker').scope).toBe('worker');
});

// Флаг читается в любом месте строки и не съедает метку: позиционные считаются отдельно.
test('флаг перед позиционными не путается с меткой', () => {
  expect(parsed('--scope', 'worker', 'owner-1', 'CI')).toEqual({
    ownerId: 'owner-1',
    label: 'CI',
    scope: 'worker',
  });
});

test('форма --scope=worker принимается наравне с раздельной', () => {
  expect(parsed('owner-1', '--scope=worker').scope).toBe('worker');
});

// Ключевое: опечатка не должна выдавать САМЫЙ ШИРОКИЙ доступ вместо самого узкого.
test('неизвестная область — отказ, а не откат на полный доступ', () => {
  expect(parsePatArgs(['owner-1', '--scope', 'wroker'])).toMatchObject({
    error: expect.stringContaining('wroker'),
  });
});

test('--scope без значения — отказ', () => {
  expect(parsePatArgs(['owner-1', '--scope'])).toMatchObject({ error: expect.any(String) });
});

// Неизвестный флаг молча стал бы МЕТКОЙ («--scpoe») — и владелец, попросивший
// исполнителя, получил бы полный доступ с диковинной подписью в списке «Агенты».
test('неизвестный флаг — отказ, а не метка', () => {
  expect(parsePatArgs(['owner-1', '--scpoe', 'worker'])).toMatchObject({
    error: expect.stringContaining('--scpoe'),
  });
});

test('без владельца — отказ', () => {
  expect(parsePatArgs([])).toMatchObject({ error: expect.any(String) });
  expect(parsePatArgs(['--scope', 'worker'])).toMatchObject({ error: expect.any(String) });
});
