import { type ReactNode, useState } from 'react';
import { Tabs } from '../../ui/Tabs';
import { TabPartHost, useRecordHost } from '../entity-detail/record-host';

/**
 * Контейнер `{{tabs}}` (спека страниц 1а §7.1) — те же `ui/Tabs`, что на экране записи.
 *
 * Значение вкладки — её порядковый номер, а не подпись: две вкладки с одной подписью законны
 * (препроход их не запрещает), и одинаковые значения Radix счёл бы одной вкладкой.
 *
 * Какая вкладка открыта — сообщается частям через хост (`TabPartHost` → `activeTab`): список
 * версий на скрытой вкладке в сеть не ходит. Вложенная вкладка видна, только пока видна и
 * внешняя: открытая внутренняя часть на скрытой внешней вкладке для человека так же скрыта.
 */
export function TabsContainer({
  tabs,
}: {
  tabs: readonly { label: string; content: ReactNode; keepMounted: boolean }[];
}) {
  const [open, setOpen] = useState('0');
  // Открытая вкладка — в пределах нынешнего числа вкладок. Текст страницы меняется и без
  // размонтирования (правка агентом, настройка, переход по кешу): было три вкладки и открыта
  // третья, стало две — без приведения не активна ни одна, и под ярлыками пусто (§6.5).
  const active = Number(open) < tabs.length ? open : '0';
  const outerVisible = useRecordHost().activeTab !== null;
  return (
    <div data-testid="page-tabs">
      <Tabs
        value={active}
        onValueChange={setOpen}
        tabs={tabs.map((tab, i) => {
          const value = String(i);
          return {
            value,
            label: tab.label,
            keepMounted: tab.keepMounted,
            content: (
              <TabPartHost value={value} open={outerVisible && active === value}>
                {tab.content}
              </TabPartHost>
            ),
          };
        })}
      />
    </div>
  );
}
