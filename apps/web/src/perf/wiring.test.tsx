// Проводка отклика действий (спека скорости §3.1; гейт задачи 3, M-4): какие правки экрана пишут `action_*` и с каким
// видом. Метки настоящие, сборщик подменён копилкой; сервер — заглушка `renderWithProviders`.
import type { PerfSample } from '@orbis/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QuickCapture } from '../features/browser/QuickCapture';
import { useRecordEdits } from '../features/entity-detail/useEntityDetail';
import { renderWithProviders, trpcError, wireEntity } from '../test/harness';
import { resetMarksForTests } from './marks';

const recorded = vi.hoisted(() => [] as PerfSample[]);
vi.mock('./collector', () => ({
  recordSample: (s: PerfSample) => recorded.push(s),
  perfBase: () => ({ device: 'desktop', appVersion: '0.5.0' }),
}));

// Порядок «видно»/«подтверждено» не пинится: заглушка сервера отвечает быстрее кадра, в жизни — наоборот.
const actions = () =>
  recorded
    .filter((s) => s.metric.startsWith('action_'))
    .map((s) => [s.metric, s.kind])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const ENTITY = wireEntity({ id: 'e1', title: 'Запись' });
type Edits = ReturnType<typeof useRecordEdits>;

/** Экран правок записи из одной кнопки: правка — колбэк теста над обвязкой `useRecordEdits`. */
function Edit({ run }: { run: (e: Edits) => void }) {
  const edits = useRecordEdits('e1', ENTITY as unknown as Parameters<typeof useRecordEdits>[1]);
  return (
    <button type="button" onClick={() => run(edits)}>
      править
    </button>
  );
}

function press(run: (e: Edits) => void, fail = false) {
  cleanup();
  renderWithProviders(<Edit run={run} />, (path) => {
    if (path !== 'entity.update') return {};
    if (fail) throw trpcError('INTERNAL_SERVER_ERROR');
    return { ...ENTITY };
  });
  fireEvent.click(screen.getByRole('button', { name: 'править' }));
}

beforeEach(() => {
  recorded.length = 0;
  resetMarksForTests();
});

describe('отклик действий записи (useEntityUpdate)', () => {
  test('чекбокс «готово» и снятие галочки — вид checkbox: «видно» и «подтверждено»', async () => {
    press((e) => e.toggleTask(true));
    await waitFor(() =>
      expect(actions()).toEqual([
        ['action_confirmed', 'checkbox'],
        ['action_visible', 'checkbox'],
      ]),
    );
    recorded.length = 0;
    press((e) => e.toggleTask(false));
    await waitFor(() => expect(actions()).toContainEqual(['action_confirmed', 'checkbox']));
  });

  test('заголовок — вид title; статус свойством — вид status', async () => {
    press((e) => e.saveTitle('Новый', 'Запись'));
    await waitFor(() => expect(actions()).toContainEqual(['action_confirmed', 'title']));
    recorded.length = 0;
    press((e) => e.update.mutate({ id: 'e1', props: { 'orbis/task_status': 'next' } }));
    await waitFor(() => expect(actions()).toContainEqual(['action_confirmed', 'status']));
  });

  test('автосохранение текста — не действие: замеров отклика нет', async () => {
    let settled = false;
    press((e) =>
      e.update.mutate(
        { id: 'e1', bodyDoc: { v: 3, doc: { type: 'doc', content: [] } } },
        { onSettled: () => (settled = true) },
      ),
    );
    await waitFor(() => expect(settled).toBe(true));
    expect(actions()).toEqual([]);
  });

  test('отказ сервера — «видно» есть, «подтверждено» нет', async () => {
    let settled = false;
    press(
      (e) =>
        e.update.mutate(
          { id: 'e1', props: { 'orbis/task_status': 'done' } },
          { onSettled: () => (settled = true) },
        ),
      true,
    );
    await waitFor(() => expect(settled).toBe(true));
    await waitFor(() => expect(actions()).toEqual([['action_visible', 'status']]));
  });
});

describe('отклик «＋» (QuickCapture)', () => {
  test('создание — только «подтверждено», вид create', async () => {
    renderWithProviders(<QuickCapture context={{ kind: 'root' }} />, (path) =>
      path === 'entity.create' ? wireEntity({ id: 'n1', title: 'молоко' }) : {},
    );
    fireEvent.change(screen.getByLabelText(/быстрая запись/i), { target: { value: 'молоко' } });
    fireEvent.submit(screen.getByTestId('quick-capture-form'));
    await waitFor(() => expect(actions()).toEqual([['action_confirmed', 'create']]));
  });

  test('отказ создания — замера нет', async () => {
    renderWithProviders(<QuickCapture context={{ kind: 'root' }} />, (path) => {
      if (path === 'entity.create') throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    });
    fireEvent.change(screen.getByLabelText(/быстрая запись/i), { target: { value: 'молоко' } });
    fireEvent.submit(screen.getByTestId('quick-capture-form'));
    await waitFor(() => expect(screen.getByLabelText(/быстрая запись/i)).toHaveValue('молоко'));
    await new Promise((r) => setTimeout(r, 20));
    expect(actions()).toEqual([]);
  });
});
