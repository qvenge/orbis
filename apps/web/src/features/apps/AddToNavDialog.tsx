import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { ADD_TO_NAV, type FrameRecord, useNavWrite } from './frame-menu';
import { inNav, navOf, withSection } from './nav-edit';
import type { Apps } from './useApps';

/** Место в выборе: оболочка хоста и живые свои приложения. */
function candidatesOf(apps: Apps): FrameRecord[] {
  const shell = apps.hostShell;
  return [
    ...(shell !== null && !shell.archived
      ? [{ id: shell.id, title: shell.title, host: true, nav: navOf(shell.props), row: shell }]
      : []),
    ...apps.apps
      .filter((a) => !a.archived)
      .map((a) => ({ id: a.id, title: a.title, host: false, nav: navOf(a.row.props), row: a.row })),
  ];
}

/**
 * «⋯ → Добавить в навигацию» (срез 1б §9.3): один глагол вместо «Закрепить» и «Добавить в
 * приложение» — выбор приложения (по умолчанию текущее) или «Новое приложение…». Без дублей:
 * приложение, где запись уже стоит, не выбирается («уже здесь»), а запись раздела в конец навигации
 * добавляет `withSection` — второй экземпляр id не появится и при гонке с другим устройством.
 *
 * Пачка — одна правка навигации выбранного приложения (архивные разделы вычищаются, §4.4); «Дом»
 * бездомной странице, поставленной в своё приложение, ставит сервер той же пачкой (§4.3).
 *
 * Модуль ЛЕНИВЫЙ: диалог нужен после жеста.
 */
export function AddToNavDialog({
  entityId,
  apps,
  current,
  onNewApp,
  onClose,
}: {
  entityId: string;
  apps: Apps;
  /** Запись-приложение рамки (`frameRecordOf`): она выбрана по умолчанию. */
  current: FrameRecord | null;
  onNewApp: () => void;
  onClose: () => void;
}) {
  const writeNav = useNavWrite();
  const candidates = candidatesOf(apps);
  const free = candidates.filter((c) => !inNav(c.nav, entityId));
  const byDefault = free.find((c) => c.id === current?.id)?.id ?? free[0]?.id ?? null;
  const [chosen, setChosen] = useState<string | null>(byDefault);
  const target = free.find((c) => c.id === chosen) ?? null;

  function add() {
    if (target === null) return;
    onClose();
    void writeNav(
      target,
      (nav) => withSection(nav, entityId),
      `Добавлено в навигацию «${target.title}»`,
      ADD_TO_NAV,
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={ADD_TO_NAV}
    >
      <div className="flex flex-col gap-3 pt-2 text-sm">
        <fieldset className="flex flex-col gap-0.5">
          <legend className="sr-only">Приложение</legend>
          {candidates.map((c) => {
            const already = inNav(c.nav, entityId);
            return (
              <label
                key={c.id}
                className={`flex min-h-11 items-center gap-2 rounded-md px-2 ${
                  already ? 'text-text-muted' : 'cursor-pointer hover:bg-surface-2'
                }`}
              >
                <input
                  type="radio"
                  name="add-to-nav-app"
                  value={c.id}
                  checked={chosen === c.id}
                  disabled={already}
                  onChange={() => setChosen(c.id)}
                  className="accent-accent"
                />
                {c.row.emoji && <span aria-hidden>{c.row.emoji}</span>}
                {/* Пометка — тем же текстом, что заголовок: отдельный элемент слепил бы доступное
                    имя в «Мой домуже здесь». */}
                <span className="min-w-0 flex-1 truncate">
                  {already ? `${c.title} (уже здесь)` : c.title}
                </span>
              </label>
            );
          })}
        </fieldset>
        <Button
          variant="outline"
          onClick={() => {
            onClose();
            onNewApp();
          }}
        >
          Новое приложение…
        </Button>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={add} disabled={target === null}>
            Добавить
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
