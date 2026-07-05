import { type FormEvent, useId, useState } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

type Settings = RouterOutputs['user']['getSettings'];

export function GeneralForm({ settings }: { settings: Settings }) {
  const utils = trpc.useUtils();
  const update = trpc.user.updateSettings.useMutation({
    onSuccess: () => void utils.user.getSettings.invalidate(),
  });
  const [timezone, setTimezone] = useState(settings.timezone);
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency);
  const [weekStartDay, setWeekStartDay] = useState(settings.weekStartDay);
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
      <Button type="submit" variant="primary">
        Сохранить
      </Button>
    </form>
  );
}
