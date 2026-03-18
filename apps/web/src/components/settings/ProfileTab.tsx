import { useSettingsStore } from '../../stores/settings.ts';
import { trpc } from '../../lib/trpc.ts';
import { SettingRow } from './SettingRow.tsx';

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const CURRENCIES = ['RUB', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'KZT'];
const WEEK_DAYS = ['monday', 'sunday', 'saturday'];

export function ProfileTab() {
  const { settings, fetchSettings } = useSettingsStore();
  const updateMutation = trpc.user.updateSettings.useMutation({
    onSuccess: () => fetchSettings(),
  });

  if (!settings) return null;

  const handleChange = (field: string, value: string) => {
    updateMutation.mutate({ [field]: value });
  };

  return (
    <div className="space-y-4">
      <SettingRow label="Timezone">
        <select
          value={settings.timezone ?? 'Europe/Moscow'}
          onChange={(e) => handleChange('timezone', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Currency">
        <select
          value={settings.defaultCurrency ?? 'RUB'}
          onChange={(e) => handleChange('defaultCurrency', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Week starts on">
        <select
          value={settings.weekStartDay ?? 'monday'}
          onChange={(e) => handleChange('weekStartDay', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {WEEK_DAYS.map((d) => (
            <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}
