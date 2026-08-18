import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { resetEnsuredThreads, useEnsuredThread } from './useEnsuredThread';

beforeEach(() => {
  // Заведённые треды помнит МОДУЛЬ, а модуль живёт дольше теста: без сброса второй тест видел
  // бы кеш первого и не звал бы ensureThread вовсе.
  resetEnsuredThreads();
});

/**
 * Пробник МЕНЯЕТ `entityId` у живого хука — то есть делает ровно то, чего сегодняшние
 * вызывающие не делают: `EntityThreadTab` монтируют с `key` по id записи (DetailScreen), и там
 * смена записи — всегда новый экземпляр. Хук, однако, экспортирован и общий, и вызывающий без
 * `key` появится раньше, чем о нём вспомнят; молча отдать ему тред ЧУЖОЙ записи (сообщения
 * уехали бы не туда) — цена, которой у общего хука быть не должно.
 */
function EnsureProbe() {
  const [entityId, setEntityId] = useState('e1');
  const { state } = useEnsuredThread(entityId);
  return (
    <div>
      <button type="button" onClick={() => setEntityId('e2')}>
        на e2
      </button>
      <span data-testid="probe">{state.status === 'ready' ? state.threadId : state.status}</span>
    </div>
  );
}

const threadOf = (input: unknown) => ({
  threadId: `th-${(input as { entityId: string }).entityId}`,
});

test('смена записи без key: хук заводит тред НОВОЙ записи, а не отдаёт чужой', async () => {
  const { calls } = renderWithProviders(<EnsureProbe />, (path, input) => {
    if (path === 'chat.ensureThread') return threadOf(input);
    throw new Error(`unexpected ${path}`);
  });
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));

  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));

  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));
  expect(calls.filter((c) => c.path === 'chat.ensureThread').map((c) => c.input)).toEqual([
    { entityId: 'e1' },
    { entityId: 'e2' },
  ]);
});

test('поздний ответ ПРЕЖНЕЙ записи состояние новой не затирает', async () => {
  // Отложенные ответы — массивом, а не переменной: `let x: F | null = null`, присвоенная внутри
  // замыкания, сужается компилятором до `null` и на вызове даёт `never` (проверено tsc).
  const releaseE1: ((v: { threadId: string }) => void)[] = [];
  renderWithProviders(<EnsureProbe />, (path, input) => {
    if (path !== 'chat.ensureThread') throw new Error(`unexpected ${path}`);
    if ((input as { entityId: string }).entityId === 'e1')
      return new Promise<{ threadId: string }>((resolve) => {
        releaseE1.push(resolve);
      });
    return threadOf(input);
  });

  // Ответ по e1 ещё в полёте — уходим на e2 и дожидаемся ЕГО треда.
  await waitFor(() => expect(releaseE1).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));

  // …и только теперь отвечает e1. Это ответ на вопрос, который больше не задан.
  await act(async () => {
    releaseE1[0]?.({ threadId: 'th-e1' });
  });
  expect(screen.getByTestId('probe')).toHaveTextContent('th-e2');
  // И по e1 никто ничего не переспрашивал: поздний ответ ОТБРОШЕН, а не превращён в новый
  // запрос (в кеш он при этом лёг — под id, для которого спрашивали).
  expect(releaseE1).toHaveLength(1);
});

// Под StrictMode React прогоняет и рендер, и эффекты монтирования ДВАЖДЫ — а состояние здесь
// правится прямо в рендере (штатный приём «adjusting state on prop change»). У ошибки в таком
// приёме ровно два исхода, и оба видны отсюда: лишняя мутация на второй прогон эффекта либо
// «Too many re-renders» (React бросает из рендера, и renderWithProviders падает вместе с ним).
test('смена записи под StrictMode: ровно две мутации, по одной на запись', async () => {
  const { calls } = renderWithProviders(
    <EnsureProbe />,
    (path, input) => {
      if (path === 'chat.ensureThread') return threadOf(input);
      throw new Error(`unexpected ${path}`);
    },
    { strict: true },
  );
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e1'));

  fireEvent.click(screen.getByRole('button', { name: 'на e2' }));

  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('th-e2'));
  expect(calls.filter((c) => c.path === 'chat.ensureThread').map((c) => c.input)).toEqual([
    { entityId: 'e1' },
    { entityId: 'e2' },
  ]);
});
