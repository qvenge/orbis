// ФОРМА ДЕЙСТВИЯ (§Б6-1, ревизия 4) — строка реестра `action_definitions`.
//
// ПОЧЕМУ ОБЁРТКА `{$expr}`, А НЕ «узел E где угодно» (Р-И-24). `input` шага — JSON-шаблон
// конверта тула, и в нём законно лежат ЗНАЧЕНИЯ json-свойств: объект `{prop: "…"}` —
// допустимое значение `orbis/progress_source`. Без маркера подстановка и значение
// неразличимы, и один и тот же шаблон читался бы двумя способами в зависимости от того,
// кто его читает. Маркер стоит ровно там, где автор сказал «подставь».
//
// ФАЙЛ — ЛИСТ ПАКЕТА по тем же правилам, что `query/ast.ts`: импортирует только каноны
// (`expr/ast`, `query/ast`), словари (`types`, `modules`, `builtin-contracts`) и регулярку
// имени (`property-type`). Обратного ребра ни у одного из них нет — цикла инициализации
// zod-схем здесь возникнуть не может (проба: ни один из пяти не импортирует `action-type`).
import { z } from 'zod';
import { exprNodeSchema } from '../expr/ast';
import { queryAstSchema } from '../query/ast';
import { SENSITIVITY_FACTS } from './builtin-contracts';
import { SURFACE_RE } from './modules';
import { NAMESPACED_KEY_RE } from './property-type';
import { localizedTextSchema, PROPERTY_KINDS } from './types';

const N = z.string().min(1);

/** Р-11/В-9: ОДНА константа — дефолт `batch_cap` сидов и предел длины голого `batch_execute`. */
export const BATCH_CAP_DEFAULT = 100;
/** §Б6-1 ревизия 4: `key` namespaced — из него собирается имя тула действия (§Б6-6). */
export const ACTION_KEY_RE = NAMESPACED_KEY_RE;
/** Р-10: шаги v1 — графовые тулы с inverse; `attach_<аспект>` добавляет `assertAction` по префиксу. */
export const ACTION_STEP_TOOLS = [
  'entity_create',
  'entity_update',
  'relation_create',
  'relation_delete',
] as const;
export const ACTION_PARAM_NAME_RE = /^[a-z][a-z0-9_]*$/;

export const exprMarkerSchema = z.object({ $expr: exprNodeSchema }).strict();

export const actionParamSchema = z
  .object({
    name: z.string().regex(ACTION_PARAM_NAME_RE, 'ASCII-слаг параметра'),
    // Контракт вместо kind — «ссылка на сущность-реализацию» (§Б6-1): значение uuid,
    // а членство проверяется по привязкам, не по типу свойства.
    type: z.union([
      z.object({ kind: z.enum(PROPERTY_KINDS) }).strict(),
      z.object({ contract: N }).strict(),
    ]),
    required: z.boolean().default(true),
  })
  .strict();
export type ActionParam = z.infer<typeof actionParamSchema>;

// `.strict()` отвергает `when`/`if`/`else` на уровне шага ФОРМОЙ; `ACTION_BRANCH` с
// именем ключа даёт `assertAction`, который смотрит СЫРОЙ объект первым (§Б6-3).
export const actionStepSchema = z.object({ tool: N, input: z.record(z.unknown()) }).strict();
export type ActionStep = z.infer<typeof actionStepSchema>;

export const actionOfferSchema = z
  .object({
    surface: z.string().regex(SURFACE_RE, 'имя поверхности <модуль>/<имя>').optional(),
    when: exprNodeSchema.optional(),
    llm: z.boolean().optional(),
  })
  .strict();

export const actionDefinitionSchema = z
  .object({
    id: N,
    graphId: z.string().uuid().nullable(),
    key: z.string().regex(ACTION_KEY_RE, 'namespaced ASCII-слаг'),
    label: localizedTextSchema,
    description: localizedTextSchema,
    params: z.array(actionParamSchema).default([]),
    precondition: exprNodeSchema.nullable().default(null),
    /** §Б6-3: map-действие по результатам Q. `null` — одиночное действие над `$self`. */
    over: queryAstSchema.nullable().default(null),
    steps: z.array(actionStepSchema).min(1),
    sensitivity: z.array(z.enum(SENSITIVITY_FACTS)).default([]),
    offered_by: z.array(actionOfferSchema).default([]),
    module: z.string().nullable(),
    batch_cap: z.number().int().min(1).nullable().default(null),
    status: z.enum(['active', 'deprecated']).default('active'),
    rank: z.number().int(),
  })
  .strict();
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;
export type ActionDefinitionInput = z.input<typeof actionDefinitionSchema>;
