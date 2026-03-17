import type { ChatMessage as ChatMessageType } from '../../stores/chat.ts';
import { EntityCard } from './EntityCard.tsx';
import { SuggestionChips } from './SuggestionChips.tsx';
import { BudgetSummaryCard } from './cards/BudgetSummaryCard.tsx';
import { DaySummaryCard } from './cards/DaySummaryCard.tsx';
import { FitnessProgressCard } from './cards/FitnessProgressCard.tsx';
import { NutritionSummaryCard } from './cards/NutritionSummaryCard.tsx';
import { HabitStreaksCard } from './cards/HabitStreaksCard.tsx';
import { WeekPlanCard } from './cards/WeekPlanCard.tsx';

interface ChatMessageProps {
  message: ChatMessageType;
  onSuggestionSelect?: (text: string) => void;
  onEntityClick?: (id: string) => void;
}

export function ChatMessage({ message, onSuggestionSelect, onEntityClick }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isUser ? 'order-1' : ''}`}>
        {/* Text bubble */}
        <div
          className={`rounded-2xl px-4 py-2 text-sm ${
            isUser
              ? 'bg-primary/15 text-text'
              : 'pl-3 text-text'
          }`}
        >
          <p className="whitespace-pre-wrap">{message.text}</p>
        </div>

        {/* Cards */}
        {message.cards && message.cards.length > 0 && (
          <div className="mt-2 space-y-2">
            {message.cards.map((card, i) => {
              if (card.type === 'entity' && card.entity) {
                return (
                  <EntityCard
                    key={i}
                    entity={card.entity}
                    onClick={() => onEntityClick?.(card.entity.id)}
                  />
                );
              }
              if (card.type === 'entity_list' && card.entities) {
                return (
                  <div key={i} className="space-y-1.5">
                    <p className="text-xs font-medium text-text-muted">{card.title}</p>
                    {card.entities.slice(0, 5).map((entity) => (
                      <EntityCard
                        key={entity.id}
                        entity={entity}
                        onClick={() => onEntityClick?.(entity.id)}
                      />
                    ))}
                  </div>
                );
              }
              if (card.type === 'budget_summary') {
                return <BudgetSummaryCard key={i} totalIncome={card.totalIncome} totalExpenses={card.totalExpenses} balance={card.balance} currency={card.currency} />;
              }
              if (card.type === 'day_summary') {
                return <DaySummaryCard key={i} date={card.date} tasks={card.tasks} completed={card.completed} events={card.events} />;
              }
              if (card.type === 'fitness_progress') {
                return <FitnessProgressCard key={i} period={card.period} workouts={card.workouts} totalVolume={card.totalVolume} totalDuration={card.totalDuration} avgEffort={card.avgEffort} />;
              }
              if (card.type === 'nutrition_summary') {
                return <NutritionSummaryCard key={i} period={card.period} dailyAvgCalories={card.dailyAvgCalories} dailyAvgProtein={card.dailyAvgProtein} dailyAvgCarbs={card.dailyAvgCarbs} dailyAvgFat={card.dailyAvgFat} totalMeals={card.totalMeals} />;
              }
              if (card.type === 'habit_streaks') {
                return <HabitStreaksCard key={i} habits={card.habits} />;
              }
              if (card.type === 'week_plan') {
                return <WeekPlanCard key={i} days={card.days} />;
              }
              return null;
            })}
          </div>
        )}

        {/* Suggestions */}
        {!isUser && message.suggestions && onSuggestionSelect && (
          <SuggestionChips suggestions={message.suggestions} onSelect={onSuggestionSelect} />
        )}
      </div>
    </div>
  );
}
