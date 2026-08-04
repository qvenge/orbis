// packages/shared/src/aspect-registry.ts
// tag_mappings — дословно PRD 01 §3.1–§3.7; ai_instructions — короткие правила
// применения аспекта (попадают в описание attach_<aspect>-тулов, §7.6).
import type { AspectId } from './constants';
import { aspectJsonSchema } from './schemas/aspects';

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
      'amount — строка decimal (например "340.00"), всегда положительная; знак задаёт direction. category_ref — uuid категории-сущности: резолви по aliases категорий через entity_query. occurred_on — дата операции в таймзоне пользователя. bank_txn_id заполняется ТОЛЬКО импортом банковской выписки — никогда не выставляй его сам.',
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
  {
    id: 'orbis/goal',
    name: 'Goal',
    namespace: 'orbis',
    icon: '🎯',
    description:
      'Цель с измеримым прогрессом: целевое значение и запрос, из которого он считается.',
    aiInstructions:
      'Применяй, когда у намерения есть измеримая цель («накопить 300000», «прочитать 24 книги»). target_value — decimal-строка, строго больше нуля. progress_source описывает, ОТКУДА берётся факт: query — запрос §6.1 по сущностям, aggregate — count (считает сущности; field при нём ЗАПРЕЩЁН, не передавай его) либо sum/latest (field ОБЯЗАТЕЛЕН — имя поля аспекта, например amount). unit — непустая подпись единицы, если она есть. current_value считает сервер, обходя граф; никогда не задавай и не правь его сам.',
    tagMappings: ['goal'],
    viewConfig: { keyFields: ['target_value', 'current_value', 'unit'] },
  },
];

/**
 * Канонический JSON для сравнения схем: ключи объектов сортируются, порядок массивов
 * сохраняется — в JSON Schema он значим (`enum`, `required`).
 *
 * Зачем: jsonb в PostgreSQL НЕ хранит порядок ключей (сортирует их по длине и байтам),
 * поэтому наивный `JSON.stringify` объявил бы расхождением любую схему, прошедшую через БД.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/** Строка реестра в БД (`aspect_definitions`, `owner_id IS NULL`) в форме сравнения. */
export interface AspectRegistryRow {
  id: string;
  schema: unknown;
  aiInstructions: string;
}

export interface AspectDrift {
  /** Встроенные аспекты, которых в реестре БД нет вовсе. */
  missing: AspectId[];
  /** Есть, но расходятся с кодом — и чем именно. */
  drifted: { id: AspectId; what: ('schema' | 'ai_instructions')[] }[];
}

export function hasAspectDrift(drift: AspectDrift): boolean {
  return drift.missing.length > 0 || drift.drifted.length > 0;
}

/**
 * Расхождение реестра аспектов в БД с кодом (ловушка релиза, бэклоги фаз C и D).
 * Исполнитель валидирует аспекты сущностей по JSON Schema из таблицы `aspect_definitions`,
 * которую заполняет `scripts/seed-aspects.ts` — он не вызывается ни Dockerfile, ни Render.
 * Релиз, изменивший поле аспекта, без пересева выкатывается со СТАРОЙ схемой: запись с новым
 * полем отклоняется валидацией (fail-closed, данные целы), то есть фича приезжает мёртвой.
 *
 * Сравниваются ровно две вещи: `schema` (по ней валидирует исполнитель) и `ai_instructions`
 * (они уезжают в описания `attach_*`-тулов, §7.6). Косметика — `name`/`icon`/`description`/
 * `tag_mappings`/`view_config` — не сверяется: её расхождение ничего не ломает, а шум в логе
 * старта обесценил бы сам сигнал. Паритет с `bun scripts/ops.ts check`, у которого тот же набор.
 */
export function diffBuiltinAspects(rows: AspectRegistryRow[]): AspectDrift {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const drift: AspectDrift = { missing: [], drifted: [] };
  for (const meta of BUILTIN_ASPECT_META) {
    const row = byId.get(meta.id);
    if (row === undefined) {
      drift.missing.push(meta.id);
      continue;
    }
    const what: ('schema' | 'ai_instructions')[] = [];
    if (canonicalJson(row.schema) !== canonicalJson(aspectJsonSchema(meta.id))) what.push('schema');
    if (row.aiInstructions !== meta.aiInstructions) what.push('ai_instructions');
    if (what.length > 0) drift.drifted.push({ id: meta.id, what });
  }
  return drift;
}
