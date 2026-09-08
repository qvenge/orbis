// ДЕКЛАРАЦИЯ ПОДПИСКИ (§Б5-1) — строгая форма, по ветке на движок. Схема в shared, а не на сервере:
// её читают сид, валидатор записи и дельта; клиенту подписки НЕ отдаются (Р3), но пакет общий.
// Дискриминант — `engine`, а не `surface`: форму определяет движок, поверхность — только место
// показа; иначе движку пришлось бы разбирать чужую форму вторым разбором.
import { z } from 'zod';
// Из `../expr/ast`, а не из корневого барреля: язык E в корень не едет (Р-И-8), а баррель `../expr`
// тянет чекер, который типы реестра импортирует обратно.
import { exprNodeSchema } from '../expr/ast';
import type { ModuleId, SurfaceName } from './modules';
// Дом формы имени слота — `property-type.ts` (Р-К-51): стрелка от контрактов к свойствам
// односторонняя, и обратная замкнула бы цикл модулей.
import { SLOT_KEY_RE } from './property-type';

/**
 * Позиция языка E. Алиас, а не прямое имя схемы: по нему грепом видны ВСЕ места декларации, где
 * стоит выражение, — а их пятнадцать в двух ветках, и перечень нужен и валидатору, и диффу Ш1.
 */
const exprRef = exprNodeSchema;

export const agendaSubscriptionSchema = z
  .object({
    engine: z.literal('agenda'),
    params: z.array(z.enum(['window_from', 'window_to'])).default(['window_from', 'window_to']),
    show: z
      .object({
        contract: z.literal('orbis/when'),
        slot: z.literal('moment'),
        window: z.object({ from: exprRef, to: exprRef }).strict(),
        prefer: z.array(z.string()).default([]),
        sortBy: z.enum(['asc', 'desc']).default('asc'),
        limit: z.number().int().min(1).default(200),
      })
      .strict(),
    overdue: z
      .object({
        contract: z.literal('orbis/when'),
        slots: z.tuple([z.literal('deadline'), z.literal('moment')]),
        before: exprRef,
        where: exprRef,
        prefer: z.array(z.string()).default([]),
        limit: z.number().int().min(1).default(200),
      })
      .strict(),
    // `isRecurringTemplate` (`useAgenda.ts:93-95`) — декларацией: набор контракта, а не код клиента.
    hide: z
      .object({ contract: z.literal('orbis/recurrence'), set: z.literal('templates') })
      .strict(),
  })
  .strict();

export const budgetSubscriptionSchema = z
  .object({
    engine: z.literal('budget'),
    currency_rule: z.enum(['owner_default_if_absent']),
    params: z.array(z.enum(['period_start', 'period_end', 'horizon_end'])),
    sources: z
      .object({
        movement: z
          .object({ contract: z.literal('orbis/money-movement'), counted_set: z.string() })
          .strict(),
        envelope: z
          .object({
            contract: z.literal('orbis/envelope'),
            binding_role: z.string(),
            selector: z
              .object({
                match: z.array(z.enum(['category', 'currency', 'period'])),
                tie_break: z.array(z.enum(['shorter_period', 'later_start', 'min_id'])),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    // `active` — остаток, значение `{const:true}`; ключ обязателен, и его отсутствие называет
    // валидатор (`SUBSCRIPTION_PHASE_ACTIVE_MISSING`), а не форма: схема записи о нём не знает.
    phases: z.record(z.string().regex(SLOT_KEY_RE), exprRef),
    aggregates: z.record(
      z.string().regex(SLOT_KEY_RE),
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('sum'),
            over: z.literal('movement'),
            of: z.object({ slot: z.string() }).strict(),
            bound_via: z.string().optional(),
            unbound_via: z.string().optional(),
            alive: z.boolean().default(false),
            scope: z.enum(['envelope', 'period']),
            group_by: z.object({ slot: z.string() }).strict().optional(),
            window: z.enum(['envelope_period', 'period']),
            currency: z.enum(['same_as_envelope', 'owner_default_only']),
            where: exprRef.optional(),
            materialize: z.boolean().default(false),
          })
          .strict(),
        z
          .object({ kind: z.literal('formula'), scope: z.literal('envelope'), expr: exprRef })
          .strict(),
      ]),
    ),
    rollup: z
      .object({
        role: z.string(),
        mode: z.literal('same_currency_only'),
        applies_to: z.array(z.string()),
      })
      .strict(),
    // Порог — СТРОКА (§Б3-5): дробное JSON-число теряет хвост до всякой проверки.
    alerts: z
      .object({
        warn_at: z.string().regex(/^\d+(\.\d+)?$/),
        on_raw: z.literal(true),
        skip_phases: z.array(z.string()),
        inclusive: z.literal(true),
      })
      .strict(),
    lists: z.record(
      z.string(),
      z
        .object({
          over: z.literal('movement'),
          counted_set: z.string(),
          requires_relation: z
            .object({ role: z.string(), side: z.enum(['source', 'target']) })
            .strict()
            .optional(),
          excludes_relation: z
            .object({ role: z.string(), side: z.enum(['source', 'target']) })
            .strict()
            .optional(),
          window: z.object({ from: exprRef, to: exprRef }).strict().optional(),
          where: exprRef.optional(),
          order_by: z.array(
            z.union([
              z.object({ slot: z.string() }).strict(),
              z.object({ core: z.enum(['id', 'title']) }).strict(),
            ]),
          ),
        })
        .strict(),
    ),
    cards: z
      .object({
        order_by: z.array(
          z.union([
            z.object({ deref: z.object({ slot: z.string(), read: z.string() }).strict() }).strict(),
            z.object({ slot: z.string() }).strict(),
            z.object({ core: z.enum(['id']) }).strict(),
          ]),
        ),
      })
      .strict(),
    // Р12: перенос читается кодом `rolloverCreate` как параметры, а не исполняется движком.
    rollover: z
      .object({
        source: z.literal('exact_calendar_month'),
        carry: z.object({ agg: z.string() }).strict(),
      })
      .strict(),
  })
  .strict();

export const subscriptionDefinitionSchema = z.discriminatedUnion('engine', [
  agendaSubscriptionSchema,
  budgetSubscriptionSchema,
]);
export type SubscriptionDefinition = z.infer<typeof subscriptionDefinitionSchema>;
export type AgendaSubscription = z.infer<typeof agendaSubscriptionSchema>;
export type BudgetSubscription = z.infer<typeof budgetSubscriptionSchema>;

/** Встроенная подписка в коде — сторона «после» сида (её список наполняют задачи 6 и 9). */
export interface BuiltinSubscriptionDef {
  id: string;
  surface: SurfaceName;
  definition: SubscriptionDefinition;
  module: ModuleId | null;
  rank: number;
}
