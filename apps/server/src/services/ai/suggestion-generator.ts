import type { ActionResult } from '@orbis/shared';

export function generateSuggestions(actions: ActionResult[], activeView?: string): string[] {
  const suggestions: string[] = [];

  for (const action of actions) {
    if (action.type === 'entity_created') {
      suggestions.push('Undo');
      const aspects = action.entity?.aspects as Record<string, unknown> | undefined;
      if (aspects?.['orbis/task']) {
        suggestions.push('Set priority');
        suggestions.push('Set due date');
      }
      if (aspects?.['orbis/financial']) {
        suggestions.push('Budget status');
      }
      if (aspects?.['orbis/fitness']) {
        suggestions.push('Fitness progress');
      }
      if (aspects?.['orbis/nutrition']) {
        suggestions.push('Nutrition this month');
      }
    }
    if (action.type === 'summary_generated') {
      suggestions.push('Show details');
    }
  }

  if (suggestions.length === 0 && activeView) {
    if (activeView === 'budget') {
      suggestions.push('Budget status', 'Recent expenses');
    } else if (activeView === 'fitness') {
      suggestions.push('Fitness progress', 'Log a workout');
    } else if (activeView === 'nutrition') {
      suggestions.push('Nutrition this month', 'Log a meal');
    } else if (activeView === 'habits') {
      suggestions.push('Show my habits', 'Check in on habits');
    } else if (activeView === 'calendar') {
      suggestions.push("What's on today?", 'Plan my week');
    }
  }

  if (suggestions.length === 0) {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) {
      suggestions.push('Plan my day', "What's on today?");
    } else if (hour >= 18 || hour < 6) {
      suggestions.push('How was my day?', 'Budget status');
    } else {
      suggestions.push("What's today?", 'Show my tasks');
    }
    suggestions.push('Show my habits');
  }

  return suggestions.slice(0, 4);
}
