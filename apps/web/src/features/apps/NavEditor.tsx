import {
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  effectiveLabel,
  NAV_FORMS,
  type NavForm,
  OWNER_LOCALE,
} from '@orbis/shared';
import { X } from 'lucide-react';
import { useState } from 'react';
import { FIELD_CLASS } from '../../lib/registry/controls';
import {
  ARCHIVED_NOTE,
  MISSING_NOTE,
  type PickedRef,
  RefListControl,
  RefSearch,
  useRefRows,
} from '../../lib/registry/RefListControl';
import { useRegistry } from '../../lib/registry/useRegistry';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Input } from '../../ui/Input';
import type { WireEntity } from '../entity-detail/record-host';
import { type UpdateBatchOperation, useUpdateBatch } from '../page/useUpdateBatch';
import { CONFIGURE_NAV } from './frame-menu';
import { cleanNav, goneOf, navOf } from './nav-edit';

interface Draft {
  title: string;
  emoji: string;
  home: string | null;
  form: NavForm;
  nav: readonly string[];
}

function draftOf(app: WireEntity): Draft {
  const home = app.props[APP_HOME];
  const form = app.props[APP_NAV_FORM];
  return {
    title: app.title,
    emoji: app.emoji ?? '',
    home: typeof home === 'string' && home !== '' ? home : null,
    form: (NAV_FORMS as readonly unknown[]).includes(form) ? (form as NavForm) : 'header-list',
    nav: navOf(app.props),
  };
}

const sameList = (a: readonly string[], b: unknown): boolean =>
  Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Правка записи-приложения из черновика — ОДНОЙ операцией пачки (одна запись журнала, один Undo):
 * пишется только изменённое. Навигация — вычищенной от архивных и исчезнувших разделов (§4.4): их
 * вычистка и сама — изменение, поэтому «Сохранить» без других правок убирает архивный раздел, а не
 * оставляет плашку навсегда. Архивная «Домашняя», которую не трогали, не пишется вовсе — проверка
 * ссылок отвергла бы её (плашка остаётся до смены). `null` — писать нечего.
 */
export function navEditOperation(
  app: WireEntity,
  draft: Draft,
  gone: ReadonlySet<string>,
): UpdateBatchOperation | null {
  const was = draftOf(app);
  const title = draft.title.trim();
  const emoji = draft.emoji.trim();
  const nav = cleanNav(draft.nav, gone);
  const props: Record<string, unknown> = {};
  const unset: string[] = [];
  if (!sameList(nav, app.props[APP_NAV])) props[APP_NAV] = nav;
  if (draft.form !== was.form) props[APP_NAV_FORM] = draft.form;
  if (draft.home !== was.home) {
    if (draft.home === null) unset.push(APP_HOME);
    else props[APP_HOME] = draft.home;
  }
  const input = {
    id: app.id,
    ...(title !== was.title && { title }),
    ...(emoji !== was.emoji && { emoji: emoji === '' ? null : emoji }),
    ...(Object.keys(props).length > 0 && { props }),
    ...(unset.length > 0 && { unset }),
  };
  return Object.keys(input).length === 1 ? null : { tool: 'entity_update', input };
}

/**
 * «⋯ → Настроить навигацию» (срез 1б §9.3) — редактор записи-приложения: порядок разделов (кнопками
 * и перетаскиванием), добавить поиском, убрать, домашняя, форма навигации, имя, иконка. Правка копится
 * в черновике и уходит по «Сохранить» одной пачкой: перестановка, записанная каждым нажатием ↑,
 * дала бы столько же Undo и промежуточных навигаций.
 *
 * Модуль ЛЕНИВЫЙ (раздел «Приложение» меню грузит его выбором пункта). Архивный раздел или
 * домашняя — строкой-плашкой «в архиве» (§4.4, §6.6): видно, что было и что стало.
 */
export function NavEditor({ app, onClose }: { app: WireEntity; onClose: () => void }) {
  const registry = useRegistry();
  const runBatch = useUpdateBatch();
  const [draft, setDraft] = useState<Draft>(() => draftOf(app));
  const stored = navOf(app.props);
  // Тем же ключом, что список разделов (`useRefRows`): одна выдача на редактор.
  const navRefs = useRefRows(stored);
  const homeRefs = useRefRows(draft.home === null ? [] : [draft.home]);
  const gone = goneOf(stored, navRefs.rows);
  const navDef = registry.property(APP_NAV);
  const formDef = registry.property(APP_NAV_FORM);
  const formLabel = (f: NavForm) => {
    const o =
      formDef?.type.kind === 'select' ? formDef.type.options.find((x) => x.key === f) : null;
    return o ? effectiveLabel(o.label, OWNER_LOCALE) : f;
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  // Выбранная в поиске домашняя — её заголовок до ответа по новому id (гейт 21, M-4).
  const [pickedHome, setPickedHome] = useState<(PickedRef & { id: string }) | null>(null);
  const known = draft.home === null ? undefined : homeRefs.byId.get(draft.home);
  const picked = pickedHome !== null && pickedHome.id === draft.home ? pickedHome : undefined;
  const home = known ?? picked;
  const homeArchived = known?.archived === true;
  const homeMissing = draft.home !== null && home === undefined && homeRefs.rows !== undefined;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * Диалог закрывается только ЗАПИСАННОЙ пачкой (гейт 21, M-3): отказ (правило каталога, сеть) оставляет
   * черновик на экране — имя, порядок и форму не приходится набирать заново — и говорит об отказе
   * здесь же, а не только тостом.
   */
  async function save() {
    if (gone === null || saving) return;
    const op = navEditOperation(app, draft, gone);
    if (op === null) {
      onClose();
      return;
    }
    setSaving(true);
    setFailed(false);
    const ok = await runBatch([op], 'Навигация сохранена', { action: CONFIGURE_NAV });
    setSaving(false);
    if (ok) onClose();
    else setFailed(true);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={CONFIGURE_NAV}
    >
      <div data-testid="nav-editor" className="flex flex-col gap-3 pt-2 text-sm">
        <div className="flex gap-2">
          <div className="flex w-20 flex-col gap-1">
            <span className="text-text-secondary">Иконка</span>
            <Input
              aria-label="Иконка"
              value={draft.emoji}
              maxLength={16}
              onChange={(e) => set({ emoji: e.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-text-secondary">Имя</span>
            <Input
              aria-label="Имя"
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-text-secondary">Домашняя</span>
          {draft.home !== null && (
            <div
              data-testid="nav-home"
              {...(homeArchived && { 'data-archived': 'true' })}
              className={`flex min-h-11 items-center gap-2 rounded-md px-2 ${
                homeArchived || homeMissing ? 'bg-surface-2 text-text-muted' : ''
              }`}
            >
              {home?.emoji && <span aria-hidden>{home.emoji}</span>}
              <span className="min-w-0 flex-1 truncate">
                {home?.title ?? (homeMissing ? draft.home : '…')}
              </span>
              {(homeArchived || homeMissing) && (
                <span className="text-2xs">{homeMissing ? MISSING_NOTE : ARCHIVED_NOTE}</span>
              )}
              <button
                type="button"
                aria-label="Убрать домашнюю"
                onClick={() => set({ home: null })}
                className="cursor-pointer rounded p-1 hover:bg-surface-2"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          )}
          {/* Сама запись-приложение домашней не бывает (правило `app_home_not_self`). */}
          <RefSearch
            label="Сменить домашнюю"
            exclude={[app.id]}
            onPick={(id, p) => {
              setPickedHome({ id, ...p });
              set({ home: id });
            }}
          />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-text-secondary">Форма навигации</span>
          <select
            aria-label="Форма навигации"
            className={FIELD_CLASS}
            value={draft.form}
            onChange={(e) => set({ form: e.target.value as NavForm })}
          >
            {NAV_FORMS.map((f) => (
              <option key={f} value={f}>
                {formLabel(f)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-text-secondary">Разделы</span>
          {navDef === undefined ? (
            <p className="text-text-muted">Реестр загружается…</p>
          ) : (
            <RefListControl
              def={navDef}
              label="Разделы"
              value={draft.nav}
              onChange={(nav) => set({ nav })}
              exclude={[app.id]}
            />
          )}
        </div>

        {failed && (
          <p role="alert" className="text-danger">
            Не удалось сохранить — правки на месте, можно исправить и повторить.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => void save()}
            disabled={draft.title.trim() === '' || gone === null || saving}
          >
            Сохранить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
