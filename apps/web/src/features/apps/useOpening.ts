import {
  chooseOpening,
  HOME_PROPERTY,
  type OpenDecision,
  type OpenPlaque,
  type TemplateCandidate,
} from '@orbis/shared';
import { currentEntry, HOST_APP } from '@orbis/shared/nav';
import { useEffect, useMemo, useState } from 'react';
import { appKeyOf, appRefOf, placeKeyOf, useNav } from '../../state/navigation';
import type { WireEntity } from '../entity-detail/record-host';
import type { PageTemplates } from '../page/usePageTemplates';
import type { Apps } from './useApps';

export interface Opening {
  /** Приложение рамки, в которой запись показана: `null` — хост. Шаблоны выбираются только его. */
  frameApp: string | null;
  /** Шаблоны этой рамки (§5.1: шаблоны принадлежат приложениям) — выбор 1а идёт только среди них. */
  templates: PageTemplates;
  /** Плашки на экране: решения этого места и решения, вызвавшего замену адреса (R-25). */
  plaques: readonly OpenPlaque[];
}

const NO_PLAQUES: readonly OpenPlaque[] = [];

/** Шаблон — этой рамки: у хоста — пустой «Дом» (или оболочка хоста, как читает правило открытия). */
const inFrame = (t: TemplateCandidate, frameApp: string | null, shellId: string | null) =>
  frameApp === null ? t.home === null || t.home === shellId : t.home === frameApp;

/**
 * Правило открытия в экране записи (срез 1б §5.2, §7.2, §7.4; РП-20, РП-21): решение
 * `chooseOpening` по приложению ТЕКУЩЕГО адреса — рамка, плашки и уточнение места.
 *
 * Зовётся, только когда на экране — адрес этой записи (`record`): домашняя приложения (`home`)
 * показывается в его рамке по определению, а экран без роутера (тесты экрана) — в хосте, как в 1а.
 * Пока не приехали приложения или шаблоны, правило не зовётся: без списка приложений адрес вышел бы
 * «не найдено», без шаблонов — «нет вида» (carry задачи 20, Opus M-3).
 *
 * Место уточняется ЗАМЕНОЙ (`replacePlace`), не новым шагом: запись-приложение — его домашняя (Р-20);
 * `redirect` — адрес рамки решения; иначе, если рамка решения — не активное приложение модели
 * (`/a/<выключенное>` — модель не знает выключенных, carry Fable M-4), место переезжает в стопку
 * рамки с тем же адресом: рамку рисует `model.activeApp` (R-22), а адрес держит плашку.
 *
 * Плашки решения, вызвавшего замену (шаг 0 + «одно → сразу туда», R-25), пересчёт для нового адреса
 * уже не даст — они живут здесь до следующего перехода владельца (ключ места `placeKeyOf`).
 */
export function useOpening(
  entity: WireEntity | undefined,
  apps: Apps,
  templates: PageTemplates,
): Opening {
  const address = useNav((s) => currentEntry(s.model).address);
  const activeApp = useNav((s) => s.model.activeApp);
  const placeKey = useNav((s) => placeKeyOf(s.model));
  const shellId = apps.hostShell?.id ?? null;
  const here = entity !== undefined && address.kind === 'record' && address.id === entity.id;
  const ready = here && apps.status === 'ok' && templates.status !== 'loading';

  const decision = useMemo<OpenDecision | null>(() => {
    if (!ready || entity === undefined || address.kind !== 'record') return null;
    const home = entity.props[HOME_PROPERTY];
    return chooseOpening({
      app: address.app,
      record: {
        id: entity.id,
        aspects: entity.aspects,
        home: typeof home === 'string' && home !== '' ? home : null,
      },
      apps: apps.apps,
      hostShellId: shellId,
      templates: templates.templates,
      // Сломанность рамку и место не меняет (R-26): её решает выбор 1а внутри рамки (`RecordView`).
      isBroken: () => null,
    });
  }, [ready, entity, address, apps.apps, shellId, templates.templates]);

  const [carried, setCarried] = useState<{ key: string; plaques: readonly OpenPlaque[] } | null>(
    null,
  );
  // Переход владельца — место сменилось: плашки прежнего решения больше не про этот экран.
  if (carried !== null && carried.key !== placeKey) setCarried(null);

  useEffect(() => {
    if (decision === null || entity === undefined || address.kind !== 'record') return;
    const nav = useNav.getState();
    const to = decision.openApp;
    if (to !== undefined) {
      nav.replacePlace(to, to.kind === 'host-screen' ? HOST_APP : appKeyOf(to.app));
      return;
    }
    const frame = decision.frame.kind === 'app' ? decision.frame.id : HOST_APP;
    if (decision.redirect) {
      nav.replacePlace({ kind: 'record', app: appRefOf(frame), id: entity.id }, frame);
      if (decision.plaques.length > 0) {
        setCarried({ key: placeKeyOf(useNav.getState().model), plaques: decision.plaques });
      }
    } else if (frame !== nav.model.activeApp) {
      nav.replacePlace(address, frame);
    }
  }, [decision, entity, address]);

  const frameApp =
    decision === null
      ? activeApp === HOST_APP
        ? null
        : activeApp
      : decision.frame.kind === 'app'
        ? decision.frame.id
        : null;
  const framed = useMemo(
    () => ({
      ...templates,
      templates: templates.templates.filter((t) => inFrame(t, frameApp, shellId)),
    }),
    [templates, frameApp, shellId],
  );
  const own = decision?.plaques ?? NO_PLAQUES;
  const plaques = useMemo(
    () => (carried === null ? own : [...carried.plaques, ...own]),
    [carried, own],
  );
  return { frameApp, templates: framed, plaques };
}
