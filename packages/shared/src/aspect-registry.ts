// packages/shared/src/aspect-registry.ts
// tag_mappings — дословно PRD 01 §3.1–§3.7; ai_instructions — короткие правила
// применения аспекта (попадают в описание attach_<aspect>-тулов, §7.6).
import type { AspectId } from './constants';

export interface BuiltinAspectMeta {
  id: AspectId;
  name: string;
  namespace: 'orbis';
  description: string;
  icon: string;
  aiInstructions: string;
  tagMappings: string[];
  viewConfig: { keyFields: string[] };
}

export const BUILTIN_ASPECT_META: BuiltinAspectMeta[] = [
  {
    id: 'orbis/schedule',
    name: 'Schedule',
    namespace: 'orbis',
    icon: '📅',
    description: 'Привязка сущности ко времени: событие, встреча, дедлайн по времени.',
    aiInstructions:
      'Применяй, когда во вводе есть дата или время события. start_at обязателен (ISO 8601 с таймзоной пользователя). recurrence задаётся только на шаблоне повторения; инстансы порождает сервер.',
    tagMappings: ['schedule', 'event', 'meeting', 'appointment'],
    viewConfig: { keyFields: ['start_at', 'end_at', 'all_day'] },
  },
  {
    id: 'orbis/task',
    name: 'Task',
    namespace: 'orbis',
    icon: '✅',
    description: 'Задача: действие с состоянием, приоритетом и сроком.',
    aiInstructions:
      'Применяй к действиям. status по умолчанию inbox; явный срок → due_date (date, не timestamp). completed_at проставляет сервер при переходе в done — не передавай его сам.',
    tagMappings: ['task', 'todo', 'action', 'deadline'],
    viewConfig: { keyFields: ['status', 'due_date', 'priority'] },
  },
  {
    id: 'orbis/financial',
    name: 'Financial',
    namespace: 'orbis',
    icon: '💸',
    description: 'Финансовая операция: расход или доход.',
    aiInstructions:
      'amount — строка decimal (например "340.00"), всегда положительная; знак задаёт direction. category_ref — uuid категории-сущности: резолви по aliases категорий через entity_query. occurred_on — дата операции в таймзоне пользователя.',
    tagMappings: ['expense', 'income', 'payment', 'cost'],
    viewConfig: { keyFields: ['amount', 'direction', 'category_ref'] },
  },
  {
    id: 'orbis/note',
    name: 'Note',
    namespace: 'orbis',
    icon: '📝',
    description: 'Маркер «главное назначение — текст»; содержимое живёт в body сущности.',
    aiInstructions:
      'Применяй, когда пользователь фиксирует мысль/заметку/документ. Текст кладётся в body сущности, не в поля аспекта.',
    tagMappings: ['note', 'thought', 'idea', 'journal'],
    viewConfig: { keyFields: ['content_type', 'pinned'] },
  },
  {
    id: 'orbis/budget',
    name: 'Budget',
    namespace: 'orbis',
    icon: '✉️',
    description: 'Конверт бюджета: лимит по категории на период.',
    aiInstructions:
      'Конверт на период: category_ref, limit (decimal-строка), period_start/period_end включительно. spent не хранится — вычисляется из транзакций-детей.',
    tagMappings: ['budget', 'envelope', 'limit'],
    viewConfig: { keyFields: ['limit', 'period_start', 'period_end'] },
  },
  {
    id: 'orbis/category',
    name: 'Category',
    namespace: 'orbis',
    icon: '🏷️',
    description: 'Категория финансовых операций: иерархия, синонимы, правила.',
    aiInstructions:
      'Категория — сущность, не строка. aliases — синонимы в нижнем регистре (рус+англ) для резолва ввода. Иерархия — через relation parent.',
    tagMappings: ['category'],
    viewConfig: { keyFields: ['icon', 'color', 'spend_class'] },
  },
  {
    id: 'orbis/memory',
    name: 'Memory',
    namespace: 'orbis',
    icon: '🧠',
    description: 'Память AI: факты о пользователе и правила обработки ввода.',
    aiInstructions:
      'kind=fact — знание о пользователе; kind=rule — правило обработки («бар → Развлечения»). scope — aspect-id домена, к которому правило привязано; пусто = глобально.',
    tagMappings: ['memory', 'preference', 'rule'],
    viewConfig: { keyFields: ['kind', 'scope'] },
  },
];
