import { TRPCClientError } from '@trpc/client';
import { useState } from 'react';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';

type Entity = RouterOutputs['entity']['get']['entity'];
type UpdateInput = RouterInputs['entity']['update'];

// §9.2: detail тянет body+relations+thread. Один и тот же input — ключ кэша для
// useQuery и точечных optimistic-патчей (cancel/getData/setData/invalidate).
const DETAIL_INCLUDE: NonNullable<RouterInputs['entity']['get']['include']> = [
  'body',
  'relations',
  'thread',
];

export function detailGetInput(id: string): RouterInputs['entity']['get'] {
  return { id, include: DETAIL_INCLUDE };
}

// Оптимистичное применение entity_update-патча поверх кэша (§9.2 shallow-merge аспектов;
// null-ключ = снятие аспекта). updatedAt НЕ трогаем — истинное значение принесёт refetch.
function applyPatch(entity: Entity, input: UpdateInput): Entity {
  const next: Entity = { ...entity };
  if (input.title !== undefined) next.title = input.title;
  if (input.emoji !== undefined) next.emoji = input.emoji;
  if (input.body !== undefined) next.body = input.body;
  if (input.archived !== undefined) next.archived = input.archived;
  if (input.aspects) {
    const aspects: Record<string, Record<string, unknown>> = { ...entity.aspects };
    for (const [key, value] of Object.entries(input.aspects)) {
      if (value === null) delete aspects[key];
      else aspects[key] = { ...(aspects[key] ?? {}), ...value };
    }
    next.aspects = aspects;
  }
  return next;
}

// Общая optimistic-concurrency обвязка entity.update (§5.2): optimistic-патч + откат при
// любой ошибке; CONFLICT (409, из STALE_VERSION) → флаг conflict для сообщения «обновите».
export function useEntityUpdate(entityId: string) {
  const utils = trpc.useUtils();
  const input = detailGetInput(entityId);
  const [conflict, setConflict] = useState(false);

  const mutation = trpc.entity.update.useMutation({
    onMutate: async (vars) => {
      setConflict(false);
      await utils.entity.get.cancel(input);
      const prev = utils.entity.get.getData(input);
      utils.entity.get.setData(input, (old) =>
        old ? { ...old, entity: applyPatch(old.entity, vars) } : old,
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      utils.entity.get.setData(input, ctx?.prev);
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') setConflict(true);
    },
    onSuccess: () => setConflict(false),
    onSettled: () => void utils.entity.get.invalidate(input),
  });

  return { mutation, conflict, dismissConflict: () => setConflict(false) };
}

export function useEntityDetail(entityId: string) {
  const get = trpc.entity.get.useQuery(detailGetInput(entityId));
  const { mutation, conflict, dismissConflict } = useEntityUpdate(entityId);
  const entity = get.data?.entity;

  // Чекбокс task (§3.6): status=done + completed_at (optimistic + откат при ошибке).
  function toggleTask(done: boolean) {
    mutation.mutate({
      id: entityId,
      aspects: {
        'orbis/task': {
          status: done ? 'done' : 'inbox',
          completed_at: done ? new Date().toISOString() : null,
        },
      },
    });
  }

  // §5.2: expectedUpdatedAt = ТОЧНАЯ строка updatedAt, которую клиент видел в кэше.
  function saveBody(body: string) {
    if (!entity) return;
    mutation.mutate({ id: entityId, body, expectedUpdatedAt: entity.updatedAt });
  }

  function setArchived(archived: boolean) {
    mutation.mutate({ id: entityId, archived });
  }

  return {
    get,
    entity,
    update: mutation,
    toggleTask,
    saveBody,
    setArchived,
    conflict,
    dismissConflict,
  };
}
