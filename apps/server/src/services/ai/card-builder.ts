import type { ActionResult, Card } from '@orbis/shared';

export function buildCards(actions: ActionResult[], defaultCurrency: string): Card[] {
  const cards: Card[] = [];

  for (const action of actions) {
    if (action.type === 'entity_created' && action.entity) {
      cards.push({ type: 'entity', entity: action.entity });
    } else if (action.type === 'entity_updated' && action.entity) {
      cards.push({ type: 'entity', entity: action.entity });
    } else if (action.type === 'entity_list' && action.entities) {
      cards.push({ type: 'entity_list', entities: action.entities, title: 'Search Results' });
    } else if (action.type === 'summary_generated' && action.data) {
      const card = buildSummaryCard(action.data as Record<string, unknown>, defaultCurrency);
      if (card) cards.push(card);
    }
  }

  return cards;
}

function buildSummaryCard(d: Record<string, unknown>, currency: string): Card | null {
  const sType = d.summaryType as string;

  if (sType === 'budget') {
    return {
      type: 'budget_summary',
      totalIncome: d.totalIncome as number,
      totalExpenses: d.totalExpenses as number,
      balance: d.balance as number,
      currency,
    } as Card;
  }

  if (sType === 'fitness') {
    return {
      type: 'fitness_progress',
      period: `${d.year}/${d.month}`,
      workouts: d.workouts as number,
      totalVolume: d.totalVolume as number,
      totalDuration: d.totalDuration as number,
      avgEffort: d.avgEffort as number,
    } as Card;
  }

  if (sType === 'nutrition') {
    return {
      type: 'nutrition_summary',
      period: `${d.year}/${d.month}`,
      dailyAvgCalories: d.dailyAvgCalories as number,
      dailyAvgProtein: d.dailyAvgProtein as number,
      dailyAvgCarbs: d.dailyAvgCarbs as number,
      dailyAvgFat: d.dailyAvgFat as number,
      totalMeals: d.totalMeals as number,
    } as Card;
  }

  if (sType === 'habits') {
    return {
      type: 'habit_streaks',
      habits: d.habits as Array<{ name: string; emoji: string | null; streak: number; checkedInToday: boolean }>,
    } as Card;
  }

  if (sType === 'day') {
    return {
      type: 'day_summary',
      date: d.date as string,
      tasks: d.tasks as number,
      completed: d.completed as number,
      events: d.events as number,
    } as Card;
  }

  if (sType === 'week') {
    return {
      type: 'week_plan',
      days: d.days as Array<{ date: string; weekday: string; tasks: number; events: number }>,
    } as Card;
  }

  return null;
}
