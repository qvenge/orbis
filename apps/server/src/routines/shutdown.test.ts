// apps/server/src/routines/shutdown.test.ts
// Реестр ручных прогонов (хвост C2-1): рубильник, ожидание и идемпотентность shutdown —
// чистые юниты без БД. Сценарий S-1 гейт-ревью: реестр ПУСТ в момент abort (штатно для
// shutdown index.ts — рубильник дёргается до дренажа HTTP), прогон регистрируется ПОСЛЕ
// (runNow, доживший в дренаже) — первый shutdown() ждать его не мог, второй обязан.
import { describe, expect, test } from 'bun:test';
import { makeRunRegistry } from './shutdown';

function gate(): { promise: Promise<string>; release: (v: string) => void } {
  let release: (v: string) => void = () => {};
  const promise = new Promise<string>((r) => {
    release = r;
  });
  return { promise, release };
}

describe('makeRunRegistry (routines/shutdown.ts)', () => {
  test('track возвращает тот же исход; shutdown дёргает сигнал и ждёт зарегистрированные прогоны', async () => {
    const registry = makeRunRegistry();
    expect(registry.signal.aborted).toBe(false);
    const g = gate();
    const tracked = registry.track(g.promise);

    let stopped = false;
    const stopping = registry.shutdown().then(() => {
      stopped = true;
    });
    expect(registry.signal.aborted).toBe(true);
    await Bun.sleep(10);
    expect(stopped).toBe(false); // прогон ещё идёт — shutdown ждёт
    g.release('готово');
    expect(await tracked).toBe('готово');
    await stopping;
    expect(stopped).toBe(true);
  });

  test('реестр пуст при abort, track ПОСЛЕ → первый shutdown уже завершён, повторный дожидается (S-1)', async () => {
    const registry = makeRunRegistry();
    await registry.shutdown(); // пустой реестр: резолвится сразу, сигнал дёрнут
    expect(registry.signal.aborted).toBe(true);

    // Запрос, доживший в дренаже, регистрирует прогон уже под дёрнутым сигналом
    const g = gate();
    const tracked = registry.track(g.promise);
    let stopped = false;
    const again = registry.shutdown().then(() => {
      stopped = true;
    });
    await Bun.sleep(10);
    expect(stopped).toBe(false);
    g.release('закрыт aborted');
    expect(await tracked).toBe('закрыт aborted');
    await again;
    expect(stopped).toBe(true);
    // Идемпотентность: третий вызов на пустом реестре — сразу
    await registry.shutdown();
  });

  test('отклонённый прогон не валит shutdown и не остаётся в реестре; прогон, добавленный во время ожидания, тоже дожидается', async () => {
    const registry = makeRunRegistry();
    const failing = gate();
    const tracked = registry.track(
      failing.promise.then(() => Promise.reject(new Error('сбой раннера'))),
    );
    tracked.catch(() => {}); // как роутер: свой catch
    const later = gate();
    let stopped = false;
    const stopping = registry.shutdown().then(() => {
      stopped = true;
    });
    // Пока первый висит — регистрируем второй
    registry.track(later.promise);
    failing.release('x');
    await Bun.sleep(10);
    expect(stopped).toBe(false); // второй ещё не закрыт
    later.release('y');
    await stopping;
    expect(stopped).toBe(true);
  });
});
