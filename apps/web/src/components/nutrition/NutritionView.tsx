import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { PeriodNav } from '../common/PeriodNav.tsx';
import { NutritionOverview } from './NutritionOverview.tsx';
import { NutritionDay } from './NutritionDay.tsx';
import { QuickLogMeal } from './QuickLogMeal.tsx';

export function NutritionView() {
  const { navigate } = useNavigationStore();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [activeTab, setActiveTab] = useState<'overview' | 'day'>('overview');

  const handlePrev = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  };

  const handleNext = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <IconButton icon={ArrowLeft} label="Go back" onClick={() => navigate('hub')} />
          <h2 className="text-sm font-semibold text-text">Nutrition</h2>
          <div className="flex-1" />
          <PeriodNav year={year} month={month} onPrev={handlePrev} onNext={handleNext} />
        </div>

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
            onClick={() => setActiveTab('day')}
            className={`border-b-2 pb-2 text-xs font-medium transition-colors duration-150 ${
              activeTab === 'day'
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Day
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' ? (
          <NutritionOverview year={year} month={month} />
        ) : (
          <NutritionDay year={year} month={month} />
        )}
      </div>

      <QuickLogMeal />
    </div>
  );
}
