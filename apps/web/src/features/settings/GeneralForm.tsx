import { type FormEvent, useId, useState } from 'react';
import { type ThemePref, useThemePref } from '../../lib/theme';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';

type Settings = RouterOutputs['user']['getSettings'];

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'Системная' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

export function GeneralForm({ settings }: { settings: Settings }) {
  const utils = trpc.useUtils();
  const { show } = useToast();
  const update = trpc.user.updateSettings.useMutation({
    onSuccess: () => {
      void utils.user.getSettings.invalidate();
      show('Сохранено');
    },
    onError: () => show('Не удалось сохранить настройки', 'danger'),
  });
  const [timezone, setTimezone] = useState(settings.timezone);
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency);
  const [weekStartDay, setWeekStartDay] = useState(settings.weekStartDay);
  const [themePref, setThemePref] = useThemePref();
  const tzId = useId();
  const curId = useId();
  const wsdId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    // LWW, только изменённые поля (все optional в updateSettings).
    const patch: Record<string, unknown> = {};
    if (timezone !== settings.timezone) patch.timezone = timezone;
    if (defaultCurrency !== settings.defaultCurrency) patch.defaultCurrency = defaultCurrency;
    if (weekStartDay !== settings.weekStartDay) patch.weekStartDay = weekStartDay;
    update.mutate(patch);
  }

  return (
    <form data-testid="general-form" onSubmit={submit} className="flex flex-col gap-3 p-3">
      <label htmlFor={tzId} className="flex flex-col gap-1 text-sm">
        Таймзона
        <Input
          id={tzId}
          aria-label="Таймзона"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
      </label>
      <label htmlFor={curId} className="flex flex-col gap-1 text-sm">
        Валюта по умолчанию
        <Input
          id={curId}
          aria-label="Валюта"
          value={defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
          maxLength={3}
        />
      </label>
      <label htmlFor={wsdId} className="flex flex-col gap-1 text-sm">
        Начало недели
        <select
          id={wsdId}
          aria-label="Начало недели"
          value={weekStartDay}
          onChange={(e) => setWeekStartDay(e.target.value as typeof weekStartDay)}
          className="rounded-control border border-line bg-surface px-3 py-2"
        >
          <option value="monday">Понедельник</option>
          <option value="sunday">Воскресенье</option>
        </select>
      </label>
      {/* Тема — только клиентская настройка (localStorage), в серверный patch НЕ попадает. */}
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1">Тема</legend>
        <div className="flex gap-1 rounded-control border border-line bg-surface p-1">
          {THEME_OPTIONS.map((opt) => {
            const active = themePref === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => setThemePref(opt.value)}
                className={`flex-1 rounded-sm px-3 py-1.5 text-sm transition ${
                  active ? 'bg-surface-2 text-text' : 'text-text-secondary hover:text-text'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </fieldset>
      <Button type="submit" variant="primary" className="self-start" disabled={update.isPending}>
        {update.isPending && <Spinner size={14} aria-label="Сохранение" />}
        Сохранить
      </Button>
    </form>
  );
}
