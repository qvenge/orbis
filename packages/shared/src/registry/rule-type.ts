/**
 * ФОРМА ПРАВИЛА КАТАЛОГА (§Б4-1) — двенадцать шаблонов §Б4-3 одной схемой.
 *
 * Правило живёт в СТРОКЕ РЕЕСТРА (поле `rules` свойства, аспекта или роли), а не в коде: «что
 * обязательно, что запрещено, что проставляется само» владелец объявляет декларацией, и движок
 * правил (задачи 3–4) исполняет её одинаково для встроенных строк и для строк владельца.
 *
 * ПОЧЕМУ СОЮЗ ПО `template`, А НЕ ОДНА ФОРМА С НЕОБЯЗАТЕЛЬНЫМИ ПОЛЯМИ. У каждого шаблона свои
 * параметры, и `{template:'unique_among', params:{property:'…'}}` (единственное число вместо
 * списка) обязано отвергаться РАЗБОРОМ, а не падать позже в движке. Тот же приём, что у
 * `contractSlotTypeSchema` и у узла E: форма разводит то, что различается смыслом.
 *
 * ИМПОРТ `exprNodeSchema` — ПРЯМОЙ (`../expr/ast`), как у `contract-type.ts:15`: баррель `../expr`
 * тянет `check.ts`, который импортирует типы реестра обратно, и цикл модулей на старте пакета не
 * нужен.
 */
import { z } from 'zod';
import { exprNodeSchema } from '../expr/ast';

export const RULE_TEMPLATES = [
  'requires_when',
  'forbidden_when',
  'on_enter_class',
  'default',
  'unique_among',
  'target_max_incoming',
  'acyclic',
  'mirror_relation',
  'nearest_ancestor',
  'materialize',
  'rollover',
  'assign_level',
] as const; // 12 (§Б4-3)
export type RuleTemplate = (typeof RULE_TEMPLATES)[number];

export const RULE_LEVELS = ['silent', 'show', 'discuss', 'never'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

/** Р-6: карта один к одному; идентификаторы кода канонические, слова спеки — подписи. */
export const RULE_LEVEL_TO_CONFIRMATION = {
  silent: 'execute',
  show: 'preview',
  discuss: 'explicit-confirmation',
  never: 'forbidden',
} as const satisfies Record<
  RuleLevel,
  'execute' | 'preview' | 'explicit-confirmation' | 'forbidden'
>;

export const RULE_ID_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Носитель правила (Р-К-53): строка реестра, в поле `rules` которой правило лежит. Тип объявлен
 * ЗДЕСЬ, рядом с формой, а не у фикстур: его читают и словарь фикстур (`rule-fixtures.ts`), и
 * валидатор сервера (`registry/rules.ts`), и у имени должен быть один дом.
 */
export interface RuleCarrier {
  kind: 'aspect' | 'property' | 'role';
  id: string;
}

const N = z.string().min(1);

/** Область действия правила (Р-25): четвёртая ветка `{contract}` принимается ФОРМОЙ, исполнение — V2. */
export const ruleScopeSchema = z.union([
  z.object({ aspect: N }).strict(),
  z.object({ property: N }).strict(),
  z.object({ role: N }).strict(),
  z.object({ contract: N }).strict(),
]);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** Р-И-30: актор, к которому правило обращено; конкретная рутина адресуется своим uuid (В-П-1в). */
export const ruleActorSchema = z.union([
  z.enum(['owner', 'ai', 'routine']),
  z.object({ routine: z.string().uuid() }).strict(),
]);

/** Параметры движка правил, доступные `{param}` (Р-И-18); наполняет движок лениво. */
export const RULE_PARAMS = {
  default_currency: { kind: 'text' },
} as const satisfies Record<string, { kind: string }>;

const base = {
  id: z.string().regex(RULE_ID_RE),
  scope: ruleScopeSchema.optional(), // умолчание — строка-носитель
  when: exprNodeSchema.optional(), // E → boolean (§Б4-2); у assign_level ОБЯЗАТЕЛЕН (refine)
  enabled: z.boolean().default(true),
  /** Р-И-2: поведение под internalUndo. */
  undo: z.enum(['check', 'skip']).default('check'),
};

export const ruleDefinitionSchema = z
  .discriminatedUnion('template', [
    z
      .object({
        ...base,
        template: z.literal('requires_when'),
        params: z.object({ property: N }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('forbidden_when'),
        params: z.object({ property: N }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('on_enter_class'),
        params: z
          .object({
            /**
             * Событие (Р-И-37): класс слота контракта у записи вошёл в `in` (по `entityClassOf`
             * до/после) ЛИБО значение свойства вошло в `in` (когда класса под нужное состояние
             * нет — `waiting` внутри класса `active`).
             */
            enter: z.union([
              z.object({ contract: N, slot: N, in: z.array(N).min(1) }).strict(),
              z
                .object({ property: N, in: z.array(z.union([z.string(), z.boolean()])).min(1) })
                .strict(),
            ]),
            /** Проставить свойство значением E при входе. */
            set: z.object({ property: N, value: exprNodeSchema }).strict().optional(),
            /** При уходе из класса — снять свойства. Хотя бы одно из set/on_leave обязательно (refine). */
            on_leave: z
              .object({ unset: z.array(N).min(1) })
              .strict()
              .optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('default'),
        params: z.object({ property: N, value: exprNodeSchema }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('unique_among'),
        params: z.object({ properties: z.array(N).min(1) }).strict(),
      })
      .strict(),
    // Ролевые ограничения — ссылка на `role.constraints` (Б2.5): параметров у строки нет, строка —
    // метка каталога.
    z
      .object({
        ...base,
        template: z.literal('target_max_incoming'),
        params: z.object({}).strict(),
      })
      .strict(),
    z.object({ ...base, template: z.literal('acyclic'), params: z.object({}).strict() }).strict(),
    z
      .object({
        ...base,
        template: z.literal('mirror_relation'),
        params: z.object({ meta_key: N, skip_computed: z.boolean() }).strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('nearest_ancestor'),
        params: z
          .object({
            targets: z.object({ parent: N, root: N }).strict(),
            depth_cap: z.number().int().min(1).max(64),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('materialize'),
        params: z
          .object({
            horizon_days: z.number().int().min(1),
            retro_days: z.number().int().min(0),
            trigger_properties: z.array(N).min(1),
            // aspectId → перечень наследуемых свойств (явный, inv §6 п.3)
            inherit: z.record(N, z.array(N)),
            own: z.record(N, z.union([z.literal('instance_date'), z.boolean(), z.string()])),
            origin_role: N,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('rollover'),
        params: z
          .object({
            source: z.literal('exact_calendar_month'),
            carry: z.object({ agg: N }).strict(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...base,
        template: z.literal('assign_level'),
        params: z.object({}).strict(),
        level: z.enum(RULE_LEVELS),
        actor: ruleActorSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((rule, ctx) => {
    // `assign_level` БЕЗ `when` — правило «всегда», то есть тихое понижение уровня на любой записи
    // носителя. Такого правила у осторожности быть не может (§Б4-5), и отвергается оно формой, а
    // не движком: молча исполненное «всегда silent» владелец увидел бы уже по последствиям.
    if (rule.template === 'assign_level' && rule.when === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['when'],
        message: 'assign_level без when: условие уровня обязательно (§Б4-5)',
      });
    }
    // `on_enter_class` без `set` и без `on_leave` не делает НИЧЕГО: событие объявлено, писателя
    // нет. Пустое правило в каталоге читается как работающее — потому отказ, а не пропуск.
    if (
      rule.template === 'on_enter_class' &&
      rule.params.set === undefined &&
      rule.params.on_leave === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['params'],
        message: 'on_enter_class: обязательно хотя бы одно из set / on_leave (§Б4-3)',
      });
    }
  });
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleDefinitionInput = z.input<typeof ruleDefinitionSchema>;
