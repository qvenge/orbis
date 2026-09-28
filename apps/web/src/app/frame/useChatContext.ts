import { HOST_APP } from '@orbis/shared/nav';
import { useMemo } from 'react';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { chatContextOf } from './chat-context';
import { useAppShell } from './useAppShell';

/**
 * Запись, про которую открыт чат (спека 1б §6.4, РП-27): её id и заголовок для чипа «Про: …» в поле
 * ввода. `'screen'` — экран чата телефона (место под ним), `'side'` — боковой чат десктопа (текущее
 * место основной области; меняется вслед за ним). Домашняя приложения — запись «Домашняя» его
 * оболочки; экраны хоста — `null` (без чипа).
 *
 * Заголовок — `entity.resolveRefs` (тот же вход, что у чипов ссылок, Ф-1б-6): пока не приехал — «…»;
 * записи нет (удалена, чужая) — чипа нет: ссылка в никуда агенту не поможет.
 */
export function useChatContext(
  where: 'screen' | 'side',
): { entityId: string; title: string } | null {
  const model = useNav((s) => s.model);
  const place = useMemo(() => chatContextOf(model, where), [model, where]);
  // Оболочку читает и присутствие хоста — тем же ключом; для записи она не нужна, но хук безусловен.
  const shell = useAppShell(place?.kind === 'home' ? place.app : HOST_APP);
  const entityId =
    place === null ? null : place.kind === 'record' ? place.id : (shell.home ?? null);
  const refs = trpc.entity.resolveRefs.useQuery(
    { ids: entityId === null ? [] : [entityId] },
    { enabled: entityId !== null },
  );
  if (entityId === null) return null;
  if (refs.data === undefined) return { entityId, title: '…' };
  const ref = refs.data.find((r) => r.id === entityId);
  return ref === undefined ? null : { entityId, title: ref.title };
}
