import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { DetailScreen } from './DetailScreen';
import { detailGetInput } from './useEntityDetail';

// Пробник читает ТУ ЖЕ entity.get-запись из кэша (общий ключ detailGetInput) и рендерит
// body как plain-текст без локального стейта — в отличие от keyed-textarea он честно
// отражает финальное состояние кэша (React коалесцирует optimistic+rollback в один коммит).
function BodyProbe() {
  const q = trpc.entity.get.useQuery(detailGetInput('e1'));
  return <span data-testid="body-probe">{q.data?.entity.body ?? ''}</span>;
}

const entity = {
  id: 'e1',
  ownerId: 'u',
  title: 'Задача',
  emoji: null,
  body: 'тело',
  bodyRefs: [],
  tags: ['work'],
  meta: {},
  aspects: { 'orbis/task': { status: 'inbox', priority: 'high' } },
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
};

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

test('чекбокс task → entity.update status=done + completed_at', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update')
      return { ...entity, aspects: { 'orbis/task': { status: 'done', completed_at: 'now' } } };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByText('Задача')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.update');
    const input = c?.input as {
      id: string;
      aspects: { 'orbis/task': { status: string; completed_at?: unknown } };
    };
    expect(input.id).toBe('e1');
    expect(input.aspects['orbis/task'].status).toBe('done');
    expect(input.aspects['orbis/task'].completed_at).toBeTruthy();
  });
});

test('inline body-правка шлёт expectedUpdatedAt = точная строка updatedAt', async () => {
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path) => {
    if (path === 'entity.get')
      return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
    if (path === 'entity.update') return { ...entity, body: 'новое' };
    if (path === 'relation.listFor') return [];
    if (path === 'aspect.list') return [];
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'новое' } });
  fireEvent.blur(screen.getByTestId('body-edit'));
  await waitFor(() => {
    const c = calls.find(
      (x) => x.path === 'entity.update' && (x.input as { body?: string }).body === 'новое',
    );
    expect((c?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(
      '2026-07-05T10:00:00.000Z',
    );
  });
});

test('inline body-правка: CONFLICT (409) → откат кэша к прежнему body + alert «обновите»', async () => {
  let getCalls = 0;
  renderWithProviders(
    <>
      <DetailScreen entityId="e1" />
      <BodyProbe />
    </>,
    async (path) => {
      if (path === 'entity.get') {
        getCalls += 1;
        if (getCalls === 1)
          return { entity, relations: [], thread: { threadId: 'th1', messages: [] } };
        // 2-й get (refetch после invalidate в onSettled) намеренно «зависает»: он НЕ даёт
        // независимого источника прежнего body, поэтому 'тело' в кэше — заслуга onError-отката
        // setData(ctx.prev), а не refetch. Уберёшь откат — здесь останется 'конфликтное' (не-тавтология).
        return new Promise(() => {});
      }
      if (path === 'entity.update') throw trpcError('CONFLICT');
      if (path === 'relation.listFor') return [];
      if (path === 'aspect.list') return [];
      return {};
    },
  );
  await waitFor(() => expect(screen.getByTestId('body-edit')).toBeInTheDocument());
  expect(screen.getByTestId('body-probe')).toHaveTextContent('тело');

  fireEvent.change(screen.getByTestId('body-edit'), { target: { value: 'конфликтное' } });
  fireEvent.blur(screen.getByTestId('body-edit'));

  // (б) сообщение конфликта показано
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/Изменено в другом месте.*обновите/),
  );
  // (а) кэш откатился к прежнему body: оптимистичный патч 'конфликтное' снят (snapshot восстановлен)
  await waitFor(() => expect(screen.getByTestId('body-probe')).toHaveTextContent('тело'));
  expect(screen.getByTestId('body-probe')).not.toHaveTextContent('конфликтное');
});
