import { Tabs as RT } from 'radix-ui';
import { type ReactNode, useState } from 'react';

export function Tabs({
  defaultValue,
  tabs,
}: {
  defaultValue: string;
  tabs: { value: string; label: string; content: ReactNode }[];
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <RT.Root value={value} onValueChange={setValue} className="flex flex-col">
      <RT.List className="flex gap-1 border-b border-line" aria-label="Вкладки">
        {tabs.map((t) => (
          <RT.Trigger
            key={t.value}
            value={t.value}
            onClick={() => setValue(t.value)}
            className="px-3 py-2 text-sm text-text-secondary data-[state=active]:border-b-2 data-[state=active]:border-accent data-[state=active]:text-text"
          >
            {t.label}
          </RT.Trigger>
        ))}
      </RT.List>
      {tabs.map((t) => (
        <RT.Content key={t.value} value={t.value} className="pt-3">
          {t.content}
        </RT.Content>
      ))}
    </RT.Root>
  );
}
