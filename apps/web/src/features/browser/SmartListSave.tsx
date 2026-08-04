import { newId } from '@orbis/shared';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';

// §3.8: «Сохранить как smart list» → сущность (body=query-блок, тег smart-list) + автозакреп.
export function SmartListSave({ query, title }: { query: string; title: string }) {
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation();
  const settings = trpc.user.getSettings.useQuery();
  const update = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });

  async function save() {
    const id = newId();
    await create.mutateAsync({
      input: { id, title, tags: ['smart-list'], body: `{{query:${query}}}` },
      source: 'quick_capture',
    });
    // Сущность smart-list'а — обычная запись графа: в списках Browser она обязана
    // появиться сама, без ожидания staleTime (закреп ниже обновляет только настройки).
    invalidateGraph(utils);
    const pinned = settings.data?.pinnedEntities ?? [];
    await update.mutateAsync({ pinnedEntities: [...pinned, { id, order: pinned.length }] });
  }
  return (
    <Button variant="ghost" onClick={save}>
      Сохранить как smart list
    </Button>
  );
}
