import { createContext, type ReactNode, useContext, useState } from 'react';
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
/**
 * Память открытых вкладок, живущая ВЫШЕ рендерера: `get`/`set` по ключу контейнера.
 *
 * Нужна экрану записи. Он монтируется без key (router.tsx), и переход на НЕкэшированную запись
 * показывает скелетон — рендерер со своими вкладками размонтируется и встаёт заново. Своё
 * состояние контейнера сбросилось бы на первую вкладку, а человек, листавший подзадачи с
 * «Деталей», хочет видеть «Детали» соседней записи (ревью Задачи 16 до среза). Правда о вкладке
 * одна — у экрана, как было до шаблона хоста. Нет провайдера — вкладка своя, у контейнера.
 */
export interface TabMemory {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

const TabMemoryContext = createContext<TabMemory | null>(null);

export function TabMemoryProvider({ value, children }: { value: TabMemory; children: ReactNode }) {
  return <TabMemoryContext.Provider value={value}>{children}</TabMemoryContext.Provider>;
}

/**
 * Ключи памяти — в пространстве `scope` (шаблона): один и тот же путь контейнера в двух разных
 * шаблонах — два разных контейнера, и вкладка одного не должна открывать вкладку другого.
 */
export function TabMemoryScope({ scope, children }: { scope: string; children: ReactNode }) {
  const outer = useContext(TabMemoryContext);
  if (outer === null) return <>{children}</>;
  return (
    <TabMemoryContext.Provider
      value={{
        get: (key) => outer.get(`${scope}:${key}`),
        set: (key, value) => outer.set(`${scope}:${key}`, value),
      }}
    >
      {children}
    </TabMemoryContext.Provider>
  );
}

export function TabsContainer({
  tabs,
  memoryKey,
}: {
  tabs: readonly { label: string; content: ReactNode; keepMounted: boolean }[];
  /** Место контейнера в дереве (путь узла) — ключ в памяти вкладок экрана, если она есть. */
  memoryKey: string;
}) {
  const memory = useContext(TabMemoryContext);
  const [own, setOwn] = useState('0');
  const open = memory === null ? own : (memory.get(memoryKey) ?? '0');
  const setOpen = memory === null ? setOwn : (value: string) => memory.set(memoryKey, value);
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
                {/* Части вкладки — столбиком с тем же шагом, что узлы корня рендерера: узлы
                    вкладки приходят списком без обёртки, и без неё карточки слипались бы. */}
                <div className="flex flex-col gap-6 pt-2">{tab.content}</div>
              </TabPartHost>
            ),
          };
        })}
      />
    </div>
  );
}
