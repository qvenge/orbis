import { APP_NAV } from '@orbis/shared';
import { type AppKey, HOST_APP } from '@orbis/shared/nav';
import { ListTree } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import type { DropdownMenuSection } from '../../ui/DropdownMenu';
import { useToast } from '../../ui/toast-store';
import type { WireEntity } from '../entity-detail/record-host';
import { BATCH_FAILED, useUpdateBatch } from '../page/useUpdateBatch';
import { cleanNav, goneOf, navOf, refIdsKey } from './nav-edit';
import { type Apps, useApps } from './useApps';

/**
 * Раздел «Приложение «A»» меню «⋯» и правка навигации из меню (срез 1б §6.4, §9.3).
 *
 * Модуль живёт ТОЛЬКО в ленивом содержимом меню (`DetailMenu`, `HostMenu`): кнопка «⋯» эагерная на
 * каждом экране (`ScreenMenu`), и раздел, собранный там, утащил бы список приложений и эти пункты во
 * входной чанк — а он входит в замыкание первого кадра записи (РП-25, запас веса). Содержимое меню
 * остаётся смонтированным после закрытия списка, поэтому и редактор навигации живёт здесь, как
 * диалоги пунктов записи.
 */

/** Запись-приложение рамки: то, что правят «Настроить навигацию» и «Добавить/Убрать из навигации». */
export interface FrameRecord {
  id: string;
  title: string;
  /** Оболочка хоста (§6.5): «Дом» из её рамки не пишется — хост это пустой «Дом» (§4.3). */
  host: boolean;
  nav: readonly string[];
  row: WireEntity;
}

/**
 * Запись-приложение рамки — того, что показывает присутствие хоста: активное приложение модели
 * навигации (R-22, `HostPresence`). Адрес `/a/<оболочка хоста>` — сам хост (как у правила открытия).
 * `null` — записи нет: хост по эталону, приложение в архиве или не приложение, список не приехал.
 */
export function frameRecordOf(active: AppKey, apps: Apps): FrameRecord | null {
  const shell = apps.hostShell;
  const host = active === HOST_APP || active === shell?.id;
  const row = host ? shell : (apps.byId.get(active)?.row ?? null);
  // Архивная запись — не место правки: её навигацию не показывает ни одна рамка.
  const live = row !== null && !row.archived ? row : null;
  return live === null
    ? null
    : { id: live.id, title: live.title, host, nav: navOf(live.props), row: live };
}

/**
 * Записать навигацию приложения одной пачкой (§4.4): `next` — правка списка, архивные и исчезнувшие
 * разделы вычищаются по свежему `entity.resolveRefs` (тем же ключом, что у списка разделов, — из
 * кеша, если он есть). Ответа нет — пачка не уходит: вслепую она упала бы на проверке ссылок.
 */
export function useNavWrite(): (
  app: FrameRecord,
  next: (nav: readonly string[]) => readonly string[],
  doneTitle: string,
  action: string,
) => Promise<boolean> {
  const utils = trpc.useUtils();
  const runBatch = useUpdateBatch();
  const { show } = useToast();
  return async (app, next, doneTitle, action) => {
    let gone: ReadonlySet<string> | null = new Set();
    if (app.nav.length > 0) {
      try {
        gone = goneOf(app.nav, await utils.entity.resolveRefs.fetch({ ids: refIdsKey(app.nav) }));
      } catch {
        gone = null;
      }
    }
    if (gone === null) {
      show(BATCH_FAILED, 'danger');
      return false;
    }
    return runBatch(
      [
        {
          tool: 'entity_update',
          input: { id: app.id, props: { [APP_NAV]: cleanNav(next(app.nav), gone) } },
        },
      ],
      doneTitle,
      { action },
    );
  };
}

/** Редактор «Настроить навигацию» — после жеста: первому кадру меню он ни к чему. */
const NavEditor = lazy(() => import('./NavEditor').then((m) => ({ default: m.NavEditor })));

/** Подписи жестов навигации: пункт меню, заголовок записи журнала и то, что назовёт «отмени последнее». */
export const CONFIGURE_NAV = 'Настроить навигацию';
export const ADD_TO_NAV = 'Добавить в навигацию';
export const REMOVE_FROM_NAV = 'Убрать из навигации';

/**
 * Раздел «Приложение «A»» (пункты записи-приложения рамки, в том числе хоста на `/`) и редактор
 * навигации, который он открывает. Записи рамки нет — раздела нет: править нечего.
 */
export function useFrameMenu(): {
  apps: Apps;
  frame: FrameRecord | null;
  sections: DropdownMenuSection[];
  element: ReactNode;
} {
  const apps = useApps();
  const active = useNav((s) => s.model.activeApp);
  const frame = frameRecordOf(active, apps);
  // Снимок записи на момент жеста: редактор правит ту версию, которую открыл.
  const [editing, setEditing] = useState<WireEntity | null>(null);
  const sections: DropdownMenuSection[] =
    frame === null
      ? []
      : [
          {
            label: `Приложение «${frame.title}»`,
            items: [
              {
                label: CONFIGURE_NAV,
                icon: <ListTree size={16} aria-hidden />,
                onSelect: () => setEditing(frame.row),
              },
            ],
          },
        ];
  const element =
    editing === null ? null : (
      <Suspense fallback={null}>
        <NavEditor app={editing} onClose={() => setEditing(null)} />
      </Suspense>
    );
  return { apps, frame, sections, element };
}
