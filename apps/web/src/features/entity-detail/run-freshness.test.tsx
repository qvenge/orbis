import { act, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { testFreshnessOf } from '../../test/freshness';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { DetailScreen } from './DetailScreen';

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

afterEach(() => vi.useRealTimers());

test('a running agent run reads on feed, without a per-run interval', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let outcome = 'running';
  const { calls, queryClient } = renderWithProviders(
    <DetailScreen entityId="r1" />,
    (path, input) => {
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
      // Реестр — шаблону хоста: ленту прогона он ставит карточкой `{{card: orbis/agent-run}}`, а
      // карточку по имени аспекта узнаёт только реестр (задача 14 страниц 1а).
      return registryReply(path) ?? {};
    },
    { freshness: true },
  );
  await screen.findByTestId('run-feed');
  const gets = () =>
    calls.filter((c) => c.path === 'entity.get' && (c.input as { id: string }).id === 'r1').length;
  const before = gets();
  expect(before).toBeGreaterThan(0);

  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(gets()).toBe(before);

  outcome = 'finished';
  await act(async () => {
    testFreshnessOf(queryClient).changes([{ kind: 'entity', rowKey: 'r1' }]);
    await vi.advanceTimersByTimeAsync(120);
  });
  expect(gets()).toBe(before + 1);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(gets()).toBe(before + 1);
});
