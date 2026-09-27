import type { ReactNode } from 'react';
import { AppsList } from './AppsList';
import { ExtensionsList } from './ExtensionsList';
import { SupplyUpdates } from './SupplyUpdates';

/**
 * Вкладка настроек «Приложения и расширения» (срез 1б §8.6; сменяет «Views», С1б-10): расширения с
 * переключателями и тем, что каждое приносит; приложения — хост и свои, «Выключить», «Удалить»,
 * «Новое приложение»; «Обновления» поставки (§9.1).
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `SettingsScreen`): экран настроек лежит во входном чанке, а тот входит
 * в замыкание первого кадра записи (РП-25) — списки, диалоги и кнопки поставки нужны только открытой
 * вкладке.
 */
export function AppsAndExtensions() {
  return (
    <div className="flex flex-col gap-6 p-3">
      <Section title="Расширения">
        <ExtensionsList />
      </Section>
      <Section title="Приложения">
        <AppsList />
      </Section>
      <Section title="Обновления">
        <SupplyUpdates />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      {children}
    </section>
  );
}
