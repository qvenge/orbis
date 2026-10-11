import type { Mutation, MutationCache } from '@tanstack/react-query';
import { isUndoEpoch, undoEpoch } from './undo-epoch';

const epochs = new WeakMap<Mutation<unknown, unknown, unknown, unknown>, number>();
export function currentMutationEpoch(
  mutation: Mutation<unknown, unknown, unknown, unknown>,
): boolean {
  const epoch = epochs.get(mutation);
  return epoch !== undefined && isUndoEpoch(epoch);
}
/**
 * Публичные execute/setOptions сохраняют epoch конкретного запроса даже после смены options наблюдателем.
 * Поштучные callbacks MutationObserver остаются под собственными поколениями редактора.
 */
export function guardMutationEpoch(cache: MutationCache): void {
  cache.subscribe((event) => {
    if (event.type !== 'added') return;
    const mutation = event.mutation;
    const execute = mutation.execute.bind(mutation);
    mutation.execute = (variables) => {
      if (!epochs.has(mutation)) epochs.set(mutation, undoEpoch());
      return execute(variables);
    };
    const setOptions = mutation.setOptions.bind(mutation);
    mutation.setOptions = (options) => {
      const current = () => currentMutationEpoch(mutation);
      const mutationFn = options.mutationFn;
      setOptions({
        ...options,
        ...(mutationFn && {
          mutationFn: (...args) => {
            if (!current()) throw new Error('Сессия изменилась');
            return mutationFn(...args);
          },
        }),
        ...(options.onMutate && {
          onMutate: (...args) => (current() ? options.onMutate?.(...args) : undefined),
        }),
        ...(options.onSuccess && {
          onSuccess: (...args) => (current() ? options.onSuccess?.(...args) : undefined),
        }),
        ...(options.onError && {
          onError: (...args) => (current() ? options.onError?.(...args) : undefined),
        }),
        ...(options.onSettled && {
          onSettled: (...args) => (current() ? options.onSettled?.(...args) : undefined),
        }),
      });
    };
    mutation.setOptions(mutation.options);
  });
}
