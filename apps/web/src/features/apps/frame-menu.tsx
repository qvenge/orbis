import { APP_NAV, SUPPLY_TEXT } from '@orbis/shared';
import { type AppKey, HOST_APP } from '@orbis/shared/nav';
import { supplyPrintNeedsBody, supplyStatusOf } from '@orbis/shared/supply/print';
import { ListTree, RotateCcw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import type { DropdownMenuSection } from '../../ui/DropdownMenu';
import { useToast } from '../../ui/toast-store';
import type { WireEntity } from '../entity-detail/record-host';
import { BATCH_FAILED, useUpdateBatch } from '../page/useUpdateBatch';
import { etalonRefIds, revertIsNoop, shellRevertPlan } from '../supply/revert-shell';
import { REVERT, STATUS_EDITED, STATUS_ETALON } from '../supply/useSupply';
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

/** Диалог «Вернуть как было» оболочки хоста — тоже после жеста. */
const RevertShellDialog = lazy(() =>
  import('../supply/RevertShellDialog').then((m) => ({ default: m.RevertShellDialog })),
);

/**
 * Признак записи поставки в разделе меню (срез 1б §9.1 п. 5): «Как в поставке» / «Изменено вами»;
 * не запись поставки (нет аспекта — своя или выведенная из поставки, R-17) — признака нет.
 */
export function supplyNoteOf(row: WireEntity): string | undefined {
  // Mixed-kind запись с известным page-ключом требует настоящего текста; ожидание — без статуса.
  if (row.body === undefined && supplyPrintNeedsBody(row)) return undefined;
  const status = supplyStatusOf({ ...row, body: row.body ?? null });
  return status === null ? undefined : status === 'etalon' ? STATUS_ETALON : STATUS_EDITED;
}

/**
 * «Вернуть как было» есть, когда запись поставки изменена И в ней лежит печать эталона: без печати
 * возвращать не к чему — сервер ответил бы отказом, а пункт обещал бы действие, которого нет.
 */
export function canRevert(row: WireEntity): boolean {
  if (row.body === undefined && supplyPrintNeedsBody(row)) return false;
  // Архивная запись — не запись поставки ключа: сервер ищет живую (`liveOrRefuse`) и отказал бы.
  return (
    !row.archived &&
    supplyStatusOf({ ...row, body: row.body ?? null }) === 'edited' &&
    typeof row.props[SUPPLY_TEXT] === 'string'
  );
}

/**
 * Предлагать ли «Вернуть как было» у оболочки хоста: сверх `canRevert` — вернёт ли возврат хоть что-то.
 * Эталон пишется без архивных целей (R-16), и оболочка, которая отличается от поставки только
 * архивными разделами, после возврата осталась бы той же — сервер отказывает «возвращать нечего»
 * (`revertToEtalon`). Живость целей — по `entity.resolveRefs`; пока ответа нет, пункта нет; ответ с
 * ошибкой — пункт есть, а диалог не даст подтвердить вслепую (`RevertShellDialog`).
 */
function useShellRevertOffered(row: WireEntity | null): boolean {
  const plan = row !== null && canRevert(row) ? shellRevertPlan(row.props) : null;
  const ids = plan === null ? [] : refIdsKey(etalonRefIds(plan));
  const refs = trpc.entity.resolveRefs.useQuery({ ids }, { enabled: ids.length > 0 });
  if (row === null || plan === null) return false;
  if (ids.length === 0) return !revertIsNoop(row, plan, new Set());
  if (refs.data === undefined) return refs.isError;
  return !revertIsNoop(row, plan, new Set(refs.data.filter((r) => !r.archived).map((r) => r.id)));
}

/** Подписи жестов навигации: пункт меню, заголовок записи журнала и то, что назовёт «отмени последнее». */
export const CONFIGURE_NAV = 'Настроить навигацию';
export const ADD_TO_NAV = 'Добавить в навигацию';
export const REMOVE_FROM_NAV = 'Убрать из навигации';

/**
 * Раздел «Приложение «A»» (пункты записи-приложения рамки, в том числе хоста на `/`) и редактор
 * навигации, который он открывает. Записи рамки нет — раздела нет: править нечего.
 *
 * У записи-приложения поставки (оболочка хоста) — признак «Как в поставке» / «Изменено вами» и
 * «Вернуть как было» (§9.1 п. 4–5): её экран записи недостижим (Р-20 — запись-приложение открывает
 * своё приложение), поэтому пункты записи живут здесь. Возврат — только через диалог исчезающих
 * разделов (`RevertShellDialog`): молча снести разделы, добавленные владельцем, меню не вправе.
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
  const needsBody =
    frame !== null && frame.row.body === undefined && supplyPrintNeedsBody(frame.row);
  // useApps остаётся лёгким: только открытое ленивое меню дочитывает текст для page-печати.
  const body = trpc.entity.get.useQuery(
    { id: frame?.id ?? '', include: ['body'] },
    { enabled: needsBody },
  );
  const read = body.data?.entity;
  // Кеш ключуется id; ответ старой рамки не относится к новой. Метаданные списка могут быть свежее чтения.
  const statusRow = needsBody
    ? !body.isError && read?.id === frame?.id && typeof read?.body === 'string'
      ? { ...frame.row, body: read.body }
      : null
    : (frame?.row ?? null);
  // Снимок записи на момент жеста: редактор правит ту версию, которую открыл.
  const [editing, setEditing] = useState<WireEntity | null>(null);
  const [reverting, setReverting] = useState<WireEntity | null>(null);
  const note = statusRow === null ? undefined : supplyNoteOf(statusRow);
  const revertOffered = useShellRevertOffered(statusRow);
  const sections: DropdownMenuSection[] =
    frame === null
      ? []
      : [
          {
            label: `Приложение «${frame.title}»`,
            ...(note !== undefined && { note }),
            items: [
              {
                label: CONFIGURE_NAV,
                icon: <ListTree size={16} aria-hidden />,
                onSelect: () => setEditing(frame.row),
              },
              ...(revertOffered
                ? [
                    {
                      label: REVERT,
                      icon: <RotateCcw size={16} aria-hidden />,
                      onSelect: () => setReverting(frame.row),
                    },
                  ]
                : []),
            ],
          },
        ];
  const element = (
    <>
      {editing !== null && (
        <Suspense fallback={null}>
          <NavEditor app={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {reverting !== null && (
        <Suspense fallback={null}>
          <RevertShellDialog row={reverting} onClose={() => setReverting(null)} />
        </Suspense>
      )}
    </>
  );
  return { apps, frame, sections, element };
}
