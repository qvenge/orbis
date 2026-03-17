import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { PeriodNav } from '../common/PeriodNav.tsx';
import { FitnessOverview } from './FitnessOverview.tsx';
import { FitnessWorkouts } from './FitnessWorkouts.tsx';
import { QuickLogWorkout } from './QuickLogWorkout.tsx';

export function FitnessView() {
  const { openHub } = useNavigationStore();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [activeTab, setActiveTab] = useState<'overview' | 'workouts'>('overview');

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
      {/* Header */}
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={openHub}
            className="rounded-md p-1 text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-sm font-semibold text-text">Fitness</h2>
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
            onClick={() => setActiveTab('workouts')}
            className={`border-b-2 pb-2 text-xs font-medium transition-colors duration-150 ${
              activeTab === 'workouts'
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Workouts
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' ? (
          <FitnessOverview year={year} month={month} />
        ) : (
          <FitnessWorkouts year={year} month={month} />
        )}
      </div>

      {/* Quick Log */}
      <QuickLogWorkout />
    </div>
  );
}
