import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { PeriodNav } from '../common/PeriodNav.tsx';
import { BudgetOverview } from './BudgetOverview.tsx';
import { BudgetTransactions } from './BudgetTransactions.tsx';
import { QuickAddBar } from './QuickAddBar.tsx';

export function BudgetView() {
  const { navigate } = useNavigationStore();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions'>('overview');

  const handlePrev = () => {
    if (month === 1) {
      setYear(year - 1);
      setMonth(12);
    } else {
      setMonth(month - 1);
    }
  };

  const handleNext = () => {
    if (month === 12) {
      setYear(year + 1);
      setMonth(1);
    } else {
      setMonth(month + 1);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <IconButton icon={ArrowLeft} label="Go back" onClick={() => navigate('hub')} />
          <h2 className="text-sm font-semibold text-text">Budget</h2>
          <div className="flex-1" />
          <PeriodNav year={year} month={month} onPrev={handlePrev} onNext={handleNext} />
        </div>

        {/* Tabs */}
        <div className="flex gap-4 px-4">
          <button
            onClick={() => setActiveTab('overview')}
            className={`border-b-2 pb-2 text-xs font-medium transition-colors duration-150 ${
              activeTab === 'overview'
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('transactions')}
            className={`border-b-2 pb-2 text-xs font-medium transition-colors duration-150 ${
              activeTab === 'transactions'
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Transactions
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' ? (
          <BudgetOverview year={year} month={month} />
        ) : (
          <BudgetTransactions year={year} month={month} />
        )}
      </div>

      {/* Quick Add */}
      <QuickAddBar year={year} month={month} />
    </div>
  );
}
