import { expect, test } from 'bun:test';
import { APP_VERSION } from '../apps/web/src/app/version';
import { MIN_COMPATIBLE_CLIENT_VERSION } from '../packages/shared/src/constants';

const parts = (v: string): number[] => v.split('.').map(Number);
function less(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

test('свежий клиент проходит собственный версионный гейт: APP_VERSION ≥ MIN_COMPATIBLE_CLIENT_VERSION', () => {
  // Подняв минимум и забыв версию клиента, сервер отказал бы 412 каждому запросу только что
  // выкаченного веба. Константы живут в разных пакетах и связаны были одним комментарием.
  expect(less(APP_VERSION, MIN_COMPATIBLE_CLIENT_VERSION)).toBe(false);
});

// Старое имя поля провода здесь НЕ пишется дословно: маркер `owner-key` гейта
// scripts/check-legacy-form.ts ловит его и в именах тестов (исключения для комментариев
// у маркера нет намеренно). Что именно сменилось — сказано в packages/shared/src/constants.ts.
test('срез Г: клиент со старым полем провода отсекается — минимум не ниже 0.2.0', () => {
  expect(less(MIN_COMPATIBLE_CLIENT_VERSION, '0.2.0')).toBe(false);
});
