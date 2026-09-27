import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  NAV_FORMS,
  type NavForm,
} from '@orbis/shared';
import {
  type AppKey,
  buildAddress,
  HOME_SECTION,
  HOST_APP,
  type NavModel,
} from '@orbis/shared/nav';
import { etalonOf, type SupplyEtalon, type SupplyKey } from '@orbis/shared/supply';
import { useMemo } from 'react';
import { useSupplyRecords } from '../../features/page/useSupplyRecords';
import { sectionRoot, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';

/** Раздел навигации приложения в листе разделов (спека 1б §6.2, §9.3). */
export interface ShellSection {
  id: string;
  title: string;
  emoji: string | null;
  /** Запись раздела в архиве — строка-плашка «в архиве», а не пустота (§4.4, §6.6). */
  archived: boolean;
  /** Бейдж раздела читает `NavSheet` (`useBadgeData`) — здесь его нет: оболочку рисует каждый экран. */
  badge: string | null;
  /** «Где остановились» (§7.3): заголовок верха стопки раздела, если открыто вглубь. */
  stoppedAt: string | null;
}

export interface AppShell {
  title: string;
  emoji: string | null;
  /** Домашняя приложения; `null` — нет живой (в архиве, удалена, не задана). */
  home: string | null;
  /** Заголовок домашней — раздел «иконка · раздел ▾» на домашней. */
  homeTitle: string | null;
  /** «Домой» задана, но в архиве — ⌂ показывает плашку «Домашняя в архиве — [восстановить]» (§6.6). */
  homeArchived: { id: string } | null;
  navForm: NavForm;
  sections: readonly ShellSection[];
  /** Оболочка хоста без записи, в архиве или испорчена — рамка по эталону поставки (§6.6). */
  fromEtalon: boolean;
  status: 'loading' | 'ok' | 'error';
}

const HOST_SHELL_KEY: SupplyKey = 'host-shell';
/** Своё приложение — id записи; ключ поставки в адресе (`/a/<ключ>`) записью не читается (задача 20). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_ETALON = etalonOf(HOST_SHELL_KEY) as Extract<SupplyEtalon, { kind: 'app' }>;

interface ShellRecord {
  title: string;
  emoji: string | null;
  aspects: readonly string[];
  props: Readonly<Record<string, unknown>>;
}

/** Оболочка из записи-приложения; испорчена (нет аспекта, навигация — не список id) — `null`. */
function shellOf(r: ShellRecord): { home: string | null; nav: string[]; navForm: NavForm } | null {
  if (!r.aspects.includes(APP_ASPECT)) return null;
  const nav = r.props[APP_NAV];
  if (!Array.isArray(nav) || nav.some((x) => typeof x !== 'string')) return null;
  const home = r.props[APP_HOME];
  const form = r.props[APP_NAV_FORM];
  return {
    home: typeof home === 'string' ? home : null,
    nav: nav as string[],
    navForm: (NAV_FORMS as readonly unknown[]).includes(form) ? (form as NavForm) : 'header-list',
  };
}

/** Записи, на которые ссылается место «последнее» каждого раздела приложения (вглубь от корня). */
function stoppedIdsOf(model: NavModel, app: AppKey): Map<string, string> {
  const out = new Map<string, string>();
  const nav = Object.hasOwn(model.apps, app) ? model.apps[app] : undefined;
  if (nav === undefined) return out;
  for (const [section, stack] of Object.entries(nav.stacks)) {
    if (section === HOME_SECTION) continue;
    // Верх, но не экран хоста: он лишь лежит поверх раздела (как `persistOf`).
    const top = [...stack].reverse().find((e) => e.address.kind !== 'host-screen');
    if (top === undefined || top.address.kind !== 'record') continue;
    if (buildAddress(top.address) === buildAddress(sectionRoot(app, section))) continue;
    out.set(section, top.address.id);
  }
  return out;
}

/**
 * Оболочка приложения (спека 1б §6.2, §6.5, §6.6): заголовок, иконка, домашняя, форма навигации и
 * разделы.
 *
 * Хост — запись поставки `host-shell` (`useSupplyRecords`: тем же ключом, что экран записи, — второго
 * запроса нет). Нет записи (не заведена, в архиве — архивных поставка не отдаёт) или она испорчена —
 * рамка по эталону `SUPPLY_ETALONS` с ключами, разрешёнными через записи поставки (§6.6), и
 * `fromEtalon` для плашки. Своё приложение — его запись (`entity.get`).
 *
 * Разделы и домашняя — одним `entity.resolveRefs` (заголовок, эмодзи, архив), без `entity.get` на
 * раздел. «Где остановились» — второй `resolveRefs` только по записям, открытым вглубь, и только
 * когда просят (`withStoppedAt` — лист разделов): оболочку рисует каждый экран, и запрос на каждый
 * переход вглубь ей ни к чему.
 */
export function useAppShell(app: AppKey, opts: { withStoppedAt?: boolean } = {}): AppShell {
  const isHost = app === HOST_APP;
  const supply = useSupplyRecords();
  const own = trpc.entity.get.useQuery({ id: app }, { enabled: !isHost && UUID_RE.test(app) });

  const base = useMemo((): {
    title: string;
    emoji: string | null;
    home: string | null;
    homeTitle: string | null;
    nav: readonly string[];
    navForm: NavForm;
    fromEtalon: boolean;
    status: AppShell['status'];
  } => {
    if (isHost) {
      const rec = supply.byKey.get(HOST_SHELL_KEY);
      const parsed = rec === undefined ? null : shellOf(rec);
      if (rec !== undefined && parsed !== null) {
        return {
          title: rec.title,
          emoji: rec.emoji,
          ...parsed,
          homeTitle: null,
          fromEtalon: false,
          status: supply.status,
        };
      }
      // Эталон поставки: ключи → записи поставки этого графа (живые; нет записи — раздела нет).
      const idOf = (k: SupplyKey) => supply.byKey.get(k)?.id ?? null;
      return {
        title: HOST_ETALON.title,
        emoji: HOST_ETALON.emoji,
        home: idOf(HOST_ETALON.home),
        homeTitle: etalonOf(HOST_ETALON.home).title,
        nav: HOST_ETALON.nav.flatMap((k) => idOf(k) ?? []),
        navForm: HOST_ETALON.navForm,
        // Пока записи поставки не приехали, говорить «повреждена» не о чем.
        fromEtalon: supply.status === 'ok',
        status: supply.status,
      };
    }
    const e = own.data?.entity;
    const parsed = e === undefined ? null : shellOf(e);
    return {
      title: e?.title ?? '…',
      emoji: e?.emoji ?? null,
      home: parsed?.home ?? null,
      homeTitle: null,
      nav: parsed?.nav ?? [],
      navForm: parsed?.navForm ?? 'header-list',
      fromEtalon: false,
      status: own.data !== undefined ? 'ok' : own.isError ? 'error' : 'loading',
    };
  }, [isHost, supply, own.data, own.isError]);

  const refIds = useMemo(
    () => [...new Set([...(base.home === null ? [] : [base.home]), ...base.nav])],
    [base.home, base.nav],
  );
  const refs = trpc.entity.resolveRefs.useQuery({ ids: refIds }, { enabled: refIds.length > 0 });

  const model = useNav((s) => s.model);
  const stopped = useMemo(
    () => (opts.withStoppedAt === true ? stoppedIdsOf(model, app) : new Map<string, string>()),
    [opts.withStoppedAt, model, app],
  );
  const stoppedIds = useMemo(() => [...new Set(stopped.values())], [stopped]);
  const stops = trpc.entity.resolveRefs.useQuery(
    { ids: stoppedIds },
    { enabled: stoppedIds.length > 0, placeholderData: (prev) => prev },
  );

  return useMemo<AppShell>(() => {
    const byId = new Map((refs.data ?? []).map((r) => [r.id, r]));
    const titleOf = new Map((stops.data ?? []).map((r) => [r.id, r.title]));
    const sections: ShellSection[] = base.nav.flatMap((sid) => {
      const r = byId.get(sid);
      // Не приехало — ещё грузится (заголовок «…»); приехало без записи — удалена или чужая:
      // раздела нет, пустой строке в листе нечего сказать.
      if (r === undefined && refs.data !== undefined) return [];
      const stopId = stopped.get(sid);
      return [
        {
          id: sid,
          title: r?.title ?? '…',
          emoji: r?.emoji ?? null,
          archived: r?.archived ?? false,
          badge: null,
          stoppedAt: stopId === undefined ? null : (titleOf.get(stopId) ?? null),
        },
      ];
    });
    const homeRef = base.home === null ? undefined : byId.get(base.home);
    const homeArchived =
      base.home !== null && homeRef?.archived === true ? { id: base.home } : null;
    return {
      title: base.title,
      emoji: base.emoji,
      home: homeArchived === null ? base.home : null,
      homeTitle: homeRef?.title ?? base.homeTitle,
      homeArchived,
      navForm: base.navForm,
      sections,
      fromEtalon: base.fromEtalon,
      status: base.status,
    };
  }, [base, refs.data, stops.data, stopped]);
}

/** Заголовок раздела для «иконка · раздел ▾»: домашняя — её запись, раздел — из листа. */
export function sectionTitleOf(shell: AppShell, section: string): string {
  if (section === HOME_SECTION) return shell.homeTitle ?? '…';
  return shell.sections.find((s) => s.id === section)?.title ?? '…';
}
