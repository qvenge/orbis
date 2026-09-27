import { CalendarClock, Wallet } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from './ScreenHeader';

const TEXT = {
  budget: { title: 'Бюджет', message: 'Бюджет придёт со следующим срезом' },
  agenda: { title: 'Повестка', message: 'Повестка придёт со следующим срезом' },
} as const;

/**
 * Зарезервированный адрес (спека 1б §3.4, §7.1, §8.6): старые ссылки `/budget…`, `/a/budget…` и
 * `/agenda` ведут сюда — плашка, а не пустота или падение. Кнопки «включить» нет: включать нечего —
 * приложения «Бюджет» и Повестка приходят срезом 1в (экраны лежат в `legacy-1v`, §15).
 */
export function ReservedScreen({ which }: { which: 'budget' | 'agenda' }) {
  const t = TEXT[which];
  return (
    <>
      <ScreenHeader title={t.title} />
      <div data-testid="reserved-screen">
        <EmptyState
          icon={
            which === 'budget' ? (
              <Wallet size={32} aria-hidden />
            ) : (
              <CalendarClock size={32} aria-hidden />
            )
          }
          title={t.message}
        />
      </div>
    </>
  );
}
