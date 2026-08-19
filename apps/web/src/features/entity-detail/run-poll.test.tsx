import { screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { DetailScreen } from './DetailScreen';
import { RUN_POLL_MS, runPollInterval } from './run-poll';

// Опрос идущего прогона (D-2): чистое правило и его подключение к экрану прогона.

describe('runPollInterval', () => {
  test('идущий прогон → RUN_POLL_MS; терминальный, не прогон, нет данных → false', () => {
    expect(runPollInterval({ 'orbis/agent-run': { outcome: 'running' } })).toBe(RUN_POLL_MS);
    for (const outcome of ['finished', 'checkpoint', 'failed', 'answered', 'stale', 'abandoned']) {
      expect(runPollInterval({ 'orbis/agent-run': { outcome } })).toBe(false);
    }
    expect(runPollInterval({ 'orbis/task': { status: 'inbox' } })).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
    expect(runPollInterval({ 'orbis/agent-run': null as unknown as Record<string, unknown> })).toBe(
      false,
    );
  });
});

const RUN_ASPECT = {
  routine_id: 'rt1',
  bucket: 'manual:2026-08-18T12:00:00.000Z',
  outcome: 'running',
  started_at: '2026-08-18T12:00:00.000Z',
  last_step_at: '2026-08-18T12:00:00.000Z',
  step_count: 0,
  steps: [],
};

const RUN_ENTITY = {
  id: 'r1',
  title: 'Прогон: Утренний обзор — вручную',
  body: '',
  bodyDoc: null,
  emoji: null,
  tags: [],
  archived: false,
  aspects: { 'orbis/agent-run': RUN_ASPECT },
  createdAt: '2026-08-18T12:00:00.000Z',
  updatedAt: '2026-08-18T12:00:00.000Z',
};

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
          entity: {
            ...RUN_ENTITY,
            aspects: { 'orbis/agent-run': { ...RUN_ASPECT, outcome } },
          },
          relations: [],
          thread: null,
        };
      }
      // Ссылки на рутину и прочее дочитывают свой entity.get (EntityRef): заголовка хватит
      if (path === 'entity.get') {
        return { entity: { id: (input as { id: string }).id, title: 'Утренний обзор' } };
      }
      if (path === 'aspect.list') return [];
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
