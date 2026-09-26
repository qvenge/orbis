/**
 * «Обновить» под сервис-воркером (Л-5 живой приёмки 1а): голая перезагрузка под старым SW отдаёт
 * прекешированный старый `index.html`, и кнопка «Обновить» не обновляла. Функция сначала просит
 * регистрацию обновиться и ждёт смены контроллера (с потолком ожидания), и только потом
 * перезагружает — ровно один раз.
 *
 * Среда — двойник `FreshReloadEnv`: в jsdom `navigator.serviceWorker` нет.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type FreshReloadEnv, reloadWithFreshWorker, SW_UPDATE_TIMEOUT_MS } from './fresh-reload';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type Worker = { postMessage: ReturnType<typeof vi.fn> };
type Registration = {
  update: () => Promise<void>;
  installing: Worker | null;
  waiting: Worker | null;
};

/** Двойник среды: регистрация, слушатели `controllerchange` и счётчик перезагрузок. */
function world(registration: Registration | undefined) {
  const listeners = new Set<() => void>();
  const reload = vi.fn();
  const sw = {
    getRegistration: vi.fn(async () => registration),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'controllerchange') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'controllerchange') listeners.delete(listener);
    }),
  };
  const env: FreshReloadEnv = {
    sw: sw as unknown as FreshReloadEnv['sw'],
    reload,
    timeoutMs: SW_UPDATE_TIMEOUT_MS,
  };
  const controllerChange = () => {
    for (const listener of [...listeners]) listener();
  };
  return { env, reload, listeners, controllerChange };
}

const worker = (): Worker => ({ postMessage: vi.fn() });

/** Регистрация, у которой `update()` оставляет новый воркер в установке. */
const installingAfterUpdate = (): Registration => {
  const reg: Registration = {
    installing: null,
    waiting: null,
    update: vi.fn(async () => {
      reg.installing = worker();
    }),
  };
  return reg;
};

test('(1) сервис-воркеров нет вовсе — перезагрузка сразу, один раз', async () => {
  const reload = vi.fn();
  await reloadWithFreshWorker({ sw: undefined, reload, timeoutMs: SW_UPDATE_TIMEOUT_MS });
  expect(reload).toHaveBeenCalledTimes(1);
});

test('(2) регистрации нет — перезагрузка сразу', async () => {
  const { env, reload } = world(undefined);
  await reloadWithFreshWorker(env);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('(3) новый воркер ставится — перезагрузка только после controllerchange, слушатель снят', async () => {
  const reg = installingAfterUpdate();
  const { env, reload, listeners, controllerChange } = world(reg);
  const done = reloadWithFreshWorker(env);
  await vi.advanceTimersByTimeAsync(0);
  expect(reg.update).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  expect(listeners.size).toBe(1);

  controllerChange();
  await done;
  expect(reload).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  // Потолок ожидания после смены контроллера второй перезагрузки не даёт.
  await vi.advanceTimersByTimeAsync(SW_UPDATE_TIMEOUT_MS);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('(4) controllerchange не пришёл — перезагрузка один раз по потолку ожидания', async () => {
  const { env, reload, listeners } = world(installingAfterUpdate());
  const done = reloadWithFreshWorker(env);
  await vi.advanceTimersByTimeAsync(SW_UPDATE_TIMEOUT_MS - 1);
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(reload).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

test('(5) после update() ни installing, ни waiting — свежий уже управляет, перезагрузка сразу', async () => {
  const reg: Registration = { installing: null, waiting: null, update: vi.fn(async () => {}) };
  const { env, reload, listeners } = world(reg);
  await reloadWithFreshWorker(env);
  expect(reg.update).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

test('(6) update() отвергнут — перезагрузка всё равно, один раз', async () => {
  const reg: Registration = {
    installing: null,
    waiting: null,
    update: vi.fn(async () => {
      throw new Error('сеть');
    }),
  };
  const { env, reload } = world(reg);
  await reloadWithFreshWorker(env);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('(7) новый воркер ждёт — ему SKIP_WAITING, перезагрузка после controllerchange', async () => {
  const waiting = worker();
  const reg: Registration = { installing: null, waiting, update: vi.fn(async () => {}) };
  const { env, reload, controllerChange } = world(reg);
  const done = reloadWithFreshWorker(env);
  await vi.advanceTimersByTimeAsync(0);
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  expect(reload).not.toHaveBeenCalled();
  controllerChange();
  await done;
  expect(reload).toHaveBeenCalledTimes(1);
});
