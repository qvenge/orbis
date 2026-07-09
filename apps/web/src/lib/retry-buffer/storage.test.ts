import { beforeEach, expect, test } from 'vitest';
import type { QueuedCreate } from './index';
import { localStorageQueue, setQueueScope } from './index';

const KEY = 'orbis:retry-buffer:v1';
const item = (clientId: string): QueuedCreate => ({
  clientId,
  tool: 'entity.create',
  payload: { input: { title: 'обед 340' } },
  createdAt: '2026-07-09T00:00:00.000Z',
});

beforeEach(() => {
  localStorage.clear();
  setQueueScope(null);
});

// store создаётся на импорте модуля (state/retry.ts) — исключение из load() означало бы
// белый экран на каждой перезагрузке, пока пользователь вручную не почистит localStorage.
test('битый JSON в ключе не роняет load — очередь читается как пустая', () => {
  localStorage.setItem(KEY, '{не json');
  expect(localStorageQueue.load()).toEqual([]);
});

test('валидный, но не-массив JSON тоже деградирует до пустой очереди', () => {
  for (const raw of ['null', '"5"', '{}', '17']) {
    localStorage.setItem(KEY, raw);
    expect(localStorageQueue.load()).toEqual([]);
  }
});

test('записи чужой формы отбрасываются, валидные остаются', () => {
  localStorage.setItem(KEY, JSON.stringify([item('a'), { clientId: 42 }, null, item('b')]));
  expect(localStorageQueue.load().map((q) => q.clientId)).toEqual(['a', 'b']);
});

// §5.3: буфер персональный. На общем браузере очередь одного владельца не должна
// дренироваться под токеном другого.
test('очереди разных владельцев не пересекаются', () => {
  setQueueScope('user-a');
  localStorageQueue.save([item('a1')]);

  setQueueScope('user-b');
  expect(localStorageQueue.load()).toEqual([]);
  localStorageQueue.save([item('b1')]);

  setQueueScope('user-a');
  expect(localStorageQueue.load().map((q) => q.clientId)).toEqual(['a1']);
});

test('записи, накопленные до логина, переносятся первому владельцу и не достаются второму', () => {
  // офлайн-ввод до скоупа (общий ключ)
  localStorageQueue.save([item('before-login')]);

  setQueueScope('user-a');
  expect(localStorageQueue.load().map((q) => q.clientId)).toEqual(['before-login']);
  expect(localStorage.getItem(KEY)).toBeNull(); // legacy-ключ вычищен переносом

  setQueueScope('user-b');
  expect(localStorageQueue.load()).toEqual([]);
});
