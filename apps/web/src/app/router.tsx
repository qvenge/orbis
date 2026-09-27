import { homePlaceOf } from '@orbis/shared';
import { type Address, buildAddress, currentEntry, HOST_APP } from '@orbis/shared/nav';
import { ArchiveRestore } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import { OpenPlaques } from '../features/apps/OpenPlaques';
import { NavTilesSlot } from '../features/apps/slots';
import { useApps } from '../features/apps/useApps';
import { ChatScreen } from '../features/chat/ChatScreen';
import { useSupplyRecords } from '../features/page/useSupplyRecords';
import { MemoryScreen } from '../features/settings/MemoryScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { invalidateGraph } from '../lib/invalidate';
import { appKeyOf, HOST_HOME, type NavOverlay, useNav } from '../state/navigation';
import { trpc } from '../trpc';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { type FrameApp, FrameAppContext } from './frame/FrameApp';
import { useAppShell } from './frame/useAppShell';
import { settleOverlay } from './history';
import { ReservedScreen } from './ReservedScreen';
import { ScreenFallback } from './ScreenFallback';
import { ScreenHeader } from './ScreenHeader';

// Ленивый экран записи: первым кадром его может и не быть (чат, настройки), а открывают его жестом.
// Граница лени стоит ЗДЕСЬ, а не в модуле: десятки тестов рендерят экран напрямую через
// renderWithProviders, и ленивость модуля уронила бы их все.
// ВАЖНО: у модуля не должно остаться ни одного статического импортёра — статический импорт рядом с
// динамическим молча схлопывает чанк обратно во входной (сторож — scripts/check-lazy-chunks.ts).
// Меню «⋯» записи (`DetailMenu`), редактор тела и блок «Записи» ленивы ещё раз, своими чанками
// внутри экрана (`DetailMenuSlot.tsx`, `EditorShell.tsx`, `RecordsBlockSlot.tsx`).
// Экраны Бюджета, импорта и Повестки ушли из интерфейса (спека 1б §8.6, РП-31) — `legacy-1v/`.
const lazyDetailScreen = () =>
  lazy(() =>
    import('../features/entity-detail/DetailScreen').then((m) => ({ default: m.DetailScreen })),
  );
let DetailScreen = lazyDetailScreen();

// Экран поиска хоста — ленивым чанком (R-35): входной чанк входит в эагерное замыкание экрана записи
// (порог РП-25), а поиск нужен только после жеста (🔍, ⌘K) или по ссылке `/search?q=…`. Второй
// ленивый вход поиска — окно ⌘K (`AppShell`); панель с группами у них общая, своим чанком.
const SearchScreen = lazy(() =>
  import('../features/search/SearchScreen').then((m) => ({ default: m.SearchScreen })),
);

/**
 * Забыть загрузку экрана записи — ТОЛЬКО для тестов: `lazy` помнит и удачу, и отказ навсегда, а
 * кадры загрузки и ошибки чанка рамка обязана показывать в каждом тесте файла.
 */
export function resetDetailScreenModuleForTests(): void {
  DetailScreen = lazyDetailScreen();
}

/**
 * Экран по текущему месту модели (спека 1б §7.1): `home` и `record` — экран записи (страница своим
 * телом, запись — шаблоном; рамку и место уточняет правило открытия, `useOpening`), экраны хоста —
 * чат, настройки, память, поиск. Над содержимым — контекст приложения рамки для ссылок (`FrameAppContext`, §7.2).
 *
 * <main> — единственный вертикальный скролл-контейнер уровня приложения: sticky-шапка внутри экранов
 * прилипает к его верху. Отступ снизу — под капсулу кнопок хоста (§6.2 п. 4).
 */
export function ActiveScreen() {
  const model = useNav((s) => s.model);
  const overlay = useNav((s) => s.overlay);
  const address = currentEntry(model).address;
  const hostScreen = address.kind === 'host-screen';
  const frame = useMemo<FrameApp>(
    () =>
      hostScreen ? { app: HOST_APP, via: 'host-screen' } : { app: model.activeApp, via: 'content' },
    [hostScreen, model.activeApp],
  );
  const place = overlay !== null ? overlay.path : buildAddress(address);
  return (
    <main data-testid="screen-content" data-place={place} className="flex-1 overflow-y-auto pb-24">
      <FrameAppContext.Provider value={frame}>
        {/* Одна граница на всё содержимое <main>: экраны сменяют друг друга целиком. resetKey
            снимает пойманную ошибку при уходе на другое место. */}
        <ChunkErrorBoundary resetKey={place}>
          <Suspense fallback={<ScreenFallback />}>
            {overlay !== null ? (
              <OverlayScreen overlay={overlay} />
            ) : (
              <PlaceScreen address={address} />
            )}
          </Suspense>
        </ChunkErrorBoundary>
      </FrameAppContext.Provider>
    </main>
  );
}

function PlaceScreen({ address }: { address: Address }) {
  switch (address.kind) {
    case 'record':
      return <DetailScreen entityId={address.id} />;
    case 'home':
      return <HomeScreen app={appKeyOf(address.app)} />;
    case 'host-screen':
      switch (address.screen) {
        case 'chat':
          return <ChatScreen />;
        case 'settings':
          return <SettingsScreen />;
        case 'memory':
          return <MemoryScreen />;
        case 'search':
          return <SearchScreen />;
      }
  }
}

/**
 * Домашняя приложения (⌂, `/`, `/a/<приложение>`) — запись «Домашняя» его оболочки экраном записи.
 * «Домой» в архиве — плашка «Домашняя в архиве — [восстановить]» (спека §6.6), а не пустота.
 *
 * Адрес `/a/<ref>` сперва проходит шаг 0 правила открытия (`homePlaceOf`, Фокус ревью п. 3):
 * выключенное, архивное или «не-приложение» — хост и плашка, адрес держит плашку, а рамка — хост
 * (место переезжает в стопку хоста: рамку рисует `model.activeApp`, R-22); оболочка хоста —
 * синоним `/`. Живое приложение по ключу поставки — его запись. Форма «домашняя как центр» —
 * плитки разделов над содержимым домашней (§6.2 п. 2).
 */
function HomeScreen({ app }: { app: string }) {
  const apps = useApps();
  const place = useMemo(
    () =>
      app === HOST_APP || apps.status !== 'ok'
        ? null
        : homePlaceOf({
            app: { kind: 'app', ref: app },
            apps: apps.apps,
            hostShellId: apps.hostShell?.id ?? null,
          }),
    [app, apps],
  );
  const target = place?.kind === 'app' ? place.id : app;
  const shell = useAppShell(target);
  // Рамка — по ответу шага 0, в обе стороны: плашка — место в стопке хоста; приложение ожило
  // («включить», «восстановить», правка агентом) — место обратно в рамку приложения (гейт 20, I-1).
  const frame = place === null ? null : place.kind === 'app' ? place.id : HOST_APP;
  useEffect(() => {
    if (frame === null) return;
    const nav = useNav.getState();
    if (place?.kind === 'alias') nav.replacePlace(HOST_HOME, HOST_APP);
    else if (nav.model.activeApp !== frame) {
      nav.replacePlace(currentEntry(nav.model).address, frame);
    }
  }, [frame, place]);
  // Приложения ещё едут — не «домашней нет»: адрес может оказаться выключенным или чужим.
  if (app !== HOST_APP && apps.status === 'loading') return <ScreenFallback />;
  if (place?.kind === 'fallback') {
    return (
      <>
        <ScreenHeader title="Приложение" />
        <OpenPlaques plaques={[place.plaque]} apps={apps} record={null} />
      </>
    );
  }
  if (shell.home !== null) {
    return (
      <DetailScreen
        entityId={shell.home}
        {...(shell.navForm === 'home-hub' && {
          lead: <NavTilesSlot app={target} />,
        })}
      />
    );
  }
  if (shell.homeArchived !== null) return <HomeArchived id={shell.homeArchived.id} />;
  if (shell.status === 'loading') return <ScreenFallback />;
  return (
    <>
      <ScreenHeader title={shell.title} />
      <EmptyState title="Домашней страницы у приложения нет" />
    </>
  );
}

function HomeArchived({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const restore = trpc.entity.update.useMutation({ onSuccess: () => invalidateGraph(utils) });
  return (
    <>
      <ScreenHeader title="Домой" />
      <div data-testid="home-archived">
        <EmptyState
          icon={<ArchiveRestore size={32} aria-hidden />}
          title="Домашняя в архиве"
          action={
            <Button
              variant="outline"
              disabled={restore.isPending}
              onClick={() => restore.mutate({ id, archived: false })}
            >
              Восстановить
            </Button>
          }
        />
      </div>
    </>
  );
}

function OverlayScreen({ overlay }: { overlay: NavOverlay }) {
  switch (overlay.kind) {
    case 'reserved':
      return <ReservedScreen which={overlay.key} />;
    case 'legacy-thread':
      return <LegacyThread threadId={overlay.threadId} />;
    case 'legacy-supply':
      return <LegacyRecords />;
  }
}

/**
 * Старая ссылка `/thread/<id>` (спека §7.1, РП-17): запись треда — её экран в хосте, тред без записи
 * (глобальный), неизвестный или отказ — чат хоста. Пока сервер ищет — кадр загрузки.
 */
function LegacyThread({ threadId }: { threadId: string }) {
  const q = trpc.chat.threadEntity.useQuery({ threadId }, { retry: false });
  const entityId = q.data?.entityId;
  const settled = q.data !== undefined || q.isError;
  useEffect(() => {
    if (!settled) return;
    settleOverlay({
      kind: 'address',
      address:
        typeof entityId === 'string'
          ? { kind: 'record', app: { kind: 'host' }, id: entityId }
          : { kind: 'host-screen', screen: 'chat' },
    });
  }, [settled, entityId]);
  return <ScreenFallback />;
}

/**
 * Старая ссылка `/browser` (спека §7.1): страница поставки «Записи» разделом хоста. Записи в поставке
 * нет (в архиве, выведена) или записи не приехали — «Домой» хоста.
 */
function LegacyRecords() {
  const supply = useSupplyRecords();
  const recordsId = supply.byKey.get('records')?.id;
  useEffect(() => {
    if (supply.status === 'loading') return;
    settleOverlay(
      recordsId !== undefined
        ? { kind: 'section', section: recordsId }
        : { kind: 'address', address: { kind: 'home', app: { kind: 'host' } } },
    );
  }, [supply.status, recordsId]);
  return <ScreenFallback />;
}
