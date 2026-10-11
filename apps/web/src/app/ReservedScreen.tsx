import { Wallet } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';
import { ScreenHeader } from './ScreenHeader';

const TEXT = {
  budget: { title: 'Бюджет', message: 'Бюджет придёт отдельным срезом' },
} as const;

/**
 * Зарезервированный адрес (спека 1б §3.4, §7.1, §8.6): старые ссылки `/budget…` и `/a/budget…` ведут
 * сюда — плашка, а не пустота или падение. Кнопки «включить» нет: включать нечего. `/agenda` с 1в —
 * запись поставки «Повестка» (§6.2), не плашка.
 */
export function ReservedScreen({ which }: { which: 'budget' }) {
  const t = TEXT[which];
  return (
    <>
      <ScreenHeader title={t.title} />
      <div data-testid="reserved-screen">
        <EmptyState icon={<Wallet size={32} aria-hidden />} title={t.message} />
      </div>
    </>
  );
}
