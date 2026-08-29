import { screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { DetailScreen } from './DetailScreen';
import { RUN_POLL_MS, runPollInterval } from './run-poll';

// Опрос идущего прогона (D-2): чистое правило и его подключение к экрану прогона.

describe('runPollInterval', () => {
  test('идущий прогон → RUN_POLL_MS; терминальный, не прогон, нет данных → false', () => {
    // Адрес исхода — id СВОЙСТВА (§А1-1): «сперва аспект, потом поле в нём» больше нет.
    expect(runPollInterval({ 'orbis/run_outcome': 'running' })).toBe(RUN_POLL_MS);
    for (const outcome of ['finished', 'checkpoint', 'failed', 'answered', 'stale', 'abandoned']) {
      expect(runPollInterval({ 'orbis/run_outcome': outcome })).toBe(false);
    }
    // Не прогон: свойства исхода у сущности нет вовсе.
    expect(runPollInterval({ 'orbis/task_status': 'inbox' })).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });
});

const RUN_PROPS = {
  'orbis/run_routine': 'rt1',
  'orbis/run_bucket': 'manual:2026-08-18T12:00:00.000Z',
  'orbis/run_outcome': 'running',
  'orbis/run_started_at': '2026-08-18T12:00:00.000Z',
  'orbis/last_step_at': '2026-08-18T12:00:00.000Z',
  'orbis/step_count': 0,
  'orbis/run_steps': [],
};

const RUN_ENTITY = wireEntity({
  id: 'r1',
  title: 'Прогон: Утренний обзор — вручную',
  bodyDoc: null,
  props: RUN_PROPS,
  aspects: ['orbis/agent-run'],
  createdAt: '2026-08-18T12:00:00.000Z',
  updatedAt: '2026-08-18T12:00:00.000Z',
});

describe('экран прогона', () => {
  afterEach(() => vi.useRealTimers());

  test('пока прогон running, entity.get повторяется сам через RUN_POLL_MS; после терминального исхода — нет', async () => {
    // Часы поддельные, но идут (shouldAdvanceTime): waitFor testing-library живёт на реальных
    // таймерах, а refetchInterval react-query — на setTimeout, который двигаем руками.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let outcome = 'running';
    const { calls } = renderWithProviders(<DetailScreen entityId="r1" />, (path, input) => {
      if (path === 'entity.get' && (input as { id: string }).id === 'r1') {
        return {
          entity: { ...RUN_ENTITY, props: { ...RUN_PROPS, 'orbis/run_outcome': outcome } },
          relations: [],
          thread: null,
        };
      }
      // Ссылки на рутину и прочее дочитывают свой entity.get (EntityRef): заголовка хватит
      if (path === 'entity.get') {
        return { entity: { id: (input as { id: string }).id, title: 'Утренний обзор' } };
      }
      if (path === 'routine.proposal') return null;
      return {};
    });
    await screen.findByTestId('run-feed');
    const gets = () =>
      calls.filter((c) => c.path === 'entity.get' && (c.input as { id: string }).id === 'r1')
        .length;
    const before = gets();
    expect(before).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(RUN_POLL_MS + 50);
    expect(gets()).toBe(before + 1);

    // Прогон закрылся: следующий опрос привозит терминальный исход и выключает себя
    outcome = 'finished';
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS + 50);
    const afterFinish = gets();
    expect(afterFinish).toBe(before + 2);
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 2);
    expect(gets()).toBe(afterFinish);
  });
});
