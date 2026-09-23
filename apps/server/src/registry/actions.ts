// ВАЛИДАТОР ДЕКЛАРАЦИИ ДЕЙСТВИЯ (§Б6-1/§Б6-3, рамка Б2.7). Полная проверка ПЕРЕД записью —
// тот же контракт, что у `assertSubscription` (`subscriptions/registry.ts`) и по той же
// причине (Р-И-7 Б-1): fail-closed на ЧТЕНИИ запер бы владельца снаружи собственного реестра.
//
// ПОРЯДОК СТУПЕНЕЙ — не косметика (§1.6 реестра интерфейсов):
//  1) сырой обход шагов на ключи ветвления — ДО схемы: `.strict()` сказал бы «лишний ключ»,
//     а §Б6-3 требует назвать ВЕТВЛЕНИЕ и его ключ;
//  2) строка в E-позиции — ДО разбора формы (`SECOND_LANGUAGE`, как у подписок);
//  3) форма; 4) ключ и namespace; 5) шаги; 6) кап и `over`; 7) шаблон входа шага;
//  8) типы E; 9) неиспользуемый параметр; 10) чувствительность.
import {
  ACTION_STEP_TOOLS,
  type ActionDefinition,
  actionDefinitionSchema,
  attachAspectInput,
  attachToolName,
  entityCreateInput,
  entityUpdateInput,
  MODULE_IDS,
  relationCreateInput,
  relationDeleteInput,
} from '@orbis/shared';
// Типы языка E — из его подпути, как у `subscriptions/registry.ts` (баррель реестра их не
// реэкспортирует, и второй адрес для одного типа заводить незачем).
import type { ExprScope, ExprType } from '@orbis/shared/expr';
// Q map-действия: тип дерева и узла фильтра — подпуть запросов (как у `tools/dispatch.ts`).
import type { QueryAst, QueryFilterNode } from '@orbis/shared/query';
import { z } from 'zod';
import { ExecError } from '../errors';
import { assertExprChecked } from '../expr/check';
import type { RegistrySnapshot } from './load';

export interface ActionCheckScope {
  reg: RegistrySnapshot;
  systemSeed: boolean;
}

/** Отказ формы декларации: VALIDATION с ПРИЧИНОЙ в details — как у подписок. */
function bad(
  reason: string,
  action: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ExecError('VALIDATION', message, { reason, action, ...details });
}

/** §Б6-3: условие или альтернатива НА УРОВНЕ ШАГА; E-`if` внутри `input` законен. */
const BRANCH_KEYS = ['when', 'if', 'else', 'unless'] as const;

/**
 * ОБРАЗ `actionToolName` НАД `ACTION_KEY_RE` — ровно те имена, которые тул действия может носить
 * (рулинг 6-1). Ключ — `<ns>/<slug>`, где ns — `[a-z][a-z0-9-]*` (ни одного `_`), slug —
 * `[a-z][a-z0-9_-]*`; нормализация `actionToolName` («/» и «-» → «_») даёт
 * `action_<ns'>_<slug'>`, и у каждой строки этой регулярки прообраз есть (ns' обратно — «_» → «-»).
 *
 * ПОЧЕМУ НЕ `startsWith('action_')`. Префикс захватил бы реестровые тулы `action_set`/`action_remove`
 * (задача 10) и назвал бы их ВЛОЖЕННОСТЬЮ, хотя это «шаг вне словаря» (§Б6-3, `ACTION_STEP_TOOL`):
 * действие, правящее реестр действий, — не вызов действия. Им регулярка не соответствует по
 * построению — после `action_` у них нет второго сегмента. Перебором словаря действий (а не формой)
 * проверка тоже была бы неверна: шаг, зовущий тул ещё не посеянного действия или самого себя,
 * — та же вложенность, а словарь её не знает.
 */
const ACTION_TOOL_NAME_RE = /^action_[a-z][a-z0-9_]*_[a-z][a-z0-9_]*$/;

export function assertAction(raw: unknown, scope: ActionCheckScope): ActionDefinition {
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  const rawRec = rec(raw);
  const rawKey = String(rawRec?.key ?? rawRec?.id ?? '<без ключа>');

  // (1) Ветвление — по СЫРОМУ объекту, до схемы.
  const rawSteps = Array.isArray(rawRec?.steps) ? (rawRec.steps as unknown[]) : [];
  for (const [index, step] of rawSteps.entries()) {
    const s = rec(step);
    if (s === undefined) continue;
    for (const key of BRANCH_KEYS) {
      if (Object.hasOwn(s, key)) {
        throw new ExecError(
          'ACTION_BRANCH',
          `действие «${rawKey}»: шаг ${index + 1} несёт ключ «${key}» — ветвлений у действия нет (§Б6-3; «если/пока» — это рутина)`,
          { action: rawKey, step: index, key },
        );
      }
    }
  }

  // (2) Строка там, где ждут выражение E.
  for (const [path, value] of rawExprSites(rawRec)) {
    if (typeof value === 'string') {
      throw new ExecError(
        'SECOND_LANGUAGE',
        `действие «${rawKey}»: в позиции ${path} ожидается выражение E, а не текст`,
        { action: rawKey, path },
      );
    }
  }

  // (3) Форма.
  const parsed = actionDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    bad('ACTION_MALFORMED', rawKey, `декларация действия «${rawKey}» не разобрана`, {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  const decl = parsed.data;

  // (4) Namespace ключа — по тому, кто пишет. Системная строка адресуется модулем, своя —
  // `user/`: иначе владелец занял бы имя модуля, и следующий пересев столкнулся бы с ним.
  const namespace = decl.key.split('/')[0] ?? '';
  if (scope.systemSeed) {
    if (!(MODULE_IDS as readonly string[]).includes(namespace)) {
      bad(
        'ACTION_NAMESPACE',
        decl.key,
        `системное действие «${decl.key}» обязано жить в namespace модуля`,
        { namespace },
      );
    }
    if (decl.module !== namespace) {
      bad(
        'ACTION_NAMESPACE',
        decl.key,
        `модуль «${decl.module}» не совпадает с namespace ключа «${namespace}»`,
        { namespace, module: decl.module },
      );
    }
  } else if (namespace !== 'user') {
    bad(
      'ACTION_NAMESPACE',
      decl.key,
      `своё действие «${decl.key}» обязано жить в namespace user/`,
      {
        namespace,
      },
    );
  }
  const taken = [...scope.reg.actions.values()].find((a) => a.key === decl.key && a.id !== decl.id);
  if (taken !== undefined) {
    bad('ACTION_KEY_TAKEN', decl.key, `ключ «${decl.key}» уже занят действием ${taken.id}`, {
      other: taken.id,
    });
  }
  // Словарь `reason` тулов действий (задача 10, Р-К-40): `ACTION_TARGET_SYSTEM` — `action_set`/`action_remove` адресуют
  // системную строку (по образцу `RULE_TARGET_SYSTEM_ROLE`); «своего действия нет» — `NOT_FOUND`. Здесь не бросается.

  // (5) Шаги: только графовые тулы с inverse (Р-10); действие действие не зовёт.
  for (const [index, step] of decl.steps.entries()) {
    if (step.tool === 'run_action' || ACTION_TOOL_NAME_RE.test(step.tool)) {
      throw new ExecError(
        'ACTION_NESTED',
        `действие «${decl.key}»: шаг ${index + 1} вызывает действие «${step.tool}» — глубина вложенности 0 (§Б6-3)`,
        { action: decl.key, step: index, tool: step.tool },
      );
    }
    const known =
      (ACTION_STEP_TOOLS as readonly string[]).includes(step.tool) ||
      (step.tool.startsWith('attach_') && attachAspectOf(scope.reg, step.tool) !== undefined);
    if (!known) {
      bad(
        'ACTION_STEP_TOOL',
        decl.key,
        `действие «${decl.key}»: шаг ${index + 1} зовёт «${step.tool}» — шаги v1 это ${ACTION_STEP_TOOLS.join(', ')} и attach_<аспект> (§Б6-3)`,
        { step: index, tool: step.tool },
      );
    }
  }

  // (6) Кап пачки — Р-К-14 дословно: «кап обязателен» читается как ОТКАЗ, а не подстановка.
  if (decl.over !== null && decl.batch_cap === null) {
    throw new ExecError(
      'BATCH_UNBOUNDED',
      `действие «${decl.key}»: пакетное действие без капа — множество Q не ограничено (§Б6-3)`,
      { action: decl.key },
    );
  }
  if (decl.over === null && decl.batch_cap !== null) {
    bad(
      'ACTION_CAP_WITHOUT_QUERY',
      decl.key,
      `действие «${decl.key}»: капа у одиночного действия быть не может`,
      {},
    );
  }
  if (decl.over !== null) assertActionQuery(decl.key, decl.over);

  // (7) Форма входа шага — КОНВЕРТ ТУЛА, в котором любое значение может быть `{$expr}`.
  // Вторая zod-модель конвертов здесь была бы вторым описанием тула и разъехалась бы с
  // `contracts/tools.ts` при первом же новом поле; поэтому маркеры ВЫРЕЗАЮТСЯ, а «дырка»
  // затыкается заглушкой, и дальше работает НАСТОЯЩИЙ конверт.
  for (const [index, step] of decl.steps.entries()) {
    const probe = stepTemplateSchema(step.tool).safeParse(stripMarkers(step.input));
    if (!probe.success) {
      bad(
        'ACTION_STEP_INPUT',
        decl.key,
        `действие «${decl.key}»: шаг ${index + 1} не разобран конвертом тула «${step.tool}»`,
        {
          step: index,
          tool: step.tool,
          issues: probe.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      );
    }
  }

  // (8) Типы E: `precondition` — предикат, каждый `{$expr}` — тотальное выражение.
  // Область одна на декларацию: параметры типизируются ИЗ НЕЁ (Р-К-24).
  const exprScope = actionExprScope(decl, scope.reg);
  if (decl.precondition !== null) {
    const t = assertExprChecked(decl.precondition, { ...exprScope, reg: scope.reg });
    if (t.kind !== 'boolean') {
      bad(
        'ACTION_PRECONDITION_TYPE',
        decl.key,
        `precondition действия «${decl.key}» — не предикат`,
        {
          actual: t.kind,
        },
      );
    }
  }
  for (const [path, node] of rawExprSites(decl as unknown as Record<string, unknown>)) {
    if (path === 'precondition') continue;
    const t = assertExprChecked(node, { ...exprScope, reg: scope.reg });
    // `offered_by[].when` — предикат (§Б6-6), как и `precondition`; `{$expr}` шага — любой тотальный тип.
    if (path.startsWith('offered_by.') && t.kind !== 'boolean') {
      bad('ACTION_PRECONDITION_TYPE', decl.key, `${path} действия «${decl.key}» — не предикат`, {
        actual: t.kind,
        path,
      });
    }
  }

  return decl;
}

/** Аспект по имени `attach_*`-тула — перебором реестра (нормализация имени необратима). */
function attachAspectOf(reg: RegistrySnapshot, tool: string) {
  for (const a of reg.aspects.values()) if (attachToolName(a.key) === tool) return a;
  return undefined;
}

/**
 * Q map-действия — не статическое множество `scope`/`ref.target`, и `assertStaticQuery`
 * (`query/static.ts`) ему не судья: тот отвергает date-токены («множество менялось бы
 * каждый день»), а «просроченные на сегодня» — ровно то, ради чего Р-30 и заводит пакетное
 * действие (Р-К-25). Запрещено здесь другое: ПРОЕКЦИЯ (порядок и усечение задаёт кап и
 * `ORDER BY id` резолва — задача 7) и `this` (у действия нет сущности-хозяина, в которой лежал
 * бы запрос).
 */
function assertActionQuery(key: string, over: QueryAst): void {
  for (const field of ['sortBy', 'limit', 'display', 'title'] as const) {
    if (over[field] !== undefined) {
      bad(
        'ACTION_OVER_PROJECTION',
        key,
        `действие «${key}»: проекция «${field}» у множества целей бессмысленна — объём задаёт batch_cap`,
        { field },
      );
    }
  }
  // Обход ИТЕРАТИВНЫЙ, со своим стеком — по доводу `scopeNamesAspect` (`deltas.ts`): второе место,
  // чья глубина упирается в стек интерпретатора, заводить незачем, а итерация стоит столько же.
  const stack: QueryFilterNode[] = over.filter === null ? [] : [over.filter];
  while (stack.length > 0) {
    const node = stack.pop() as QueryFilterNode;
    if ('and' in node) stack.push(...node.and);
    else if ('or' in node) stack.push(...node.or);
    else if ('not' in node) stack.push(node.not);
    else if ('rel' in node && 'of' in node.rel && node.rel.of === 'this') {
      bad(
        'ACTION_OVER_PROJECTION',
        key,
        `действие «${key}»: «this» в множестве целей — у действия нет сущности-хозяина`,
        {},
      );
    }
  }
}

/**
 * E-позиции СЫРОЙ декларации: `precondition`, `offered_by[].when` (§Б6-6 — предикат над
 * записью-целью) и каждая обёртка `{$expr}` внутри `input` шага.
 */
function* rawExprSites(rawRec: Record<string, unknown> | undefined): Generator<[string, unknown]> {
  if (rawRec === undefined) return;
  if (Object.hasOwn(rawRec, 'precondition') && rawRec.precondition !== null) {
    yield ['precondition', rawRec.precondition];
  }
  const offers = Array.isArray(rawRec.offered_by) ? (rawRec.offered_by as unknown[]) : [];
  for (const [index, offer] of offers.entries()) {
    const o = offer as Record<string, unknown> | null;
    if (o !== null && typeof o === 'object' && o.when !== undefined) {
      yield [`offered_by.${index}.when`, o.when];
    }
  }
  const steps = Array.isArray(rawRec.steps) ? (rawRec.steps as unknown[]) : [];
  for (const [index, step] of steps.entries()) {
    const s = step as Record<string, unknown> | null;
    if (s === null || typeof s !== 'object') continue;
    yield* walkMarkers(s.input, `steps.${index}.input`);
  }
}
function* walkMarkers(value: unknown, path: string): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* walkMarkers(v, `${path}.${i}`);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, '$expr')) {
    yield [`${path}.$expr`, obj.$expr];
    return;
  }
  for (const [k, v] of Object.entries(obj)) yield* walkMarkers(v, `${path}.${k}`);
}

/**
 * Конверт тула с «дырками» под подстановку: маркер `{$expr}` заменяется на значение,
 * которое конверт заведомо примет в позициях шагов v1 (конверты значений свойств —
 * `z.unknown()`, у `id`/`entity_id`/`source_id`/`target_id` — uuid, у `title` — непустая
 * строка): валидный uuid-плейсхолдер. Проверяется ФОРМА конверта, а типы выражений —
 * ступенью 8; смешивать их нельзя: тип подстановки zod не знает.
 */
const MARKER_UUID = '00000000-0000-4000-8000-000000000000';
function stripMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMarkers);
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, '$expr')) return MARKER_UUID;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, stripMarkers(v)]));
}
function stepTemplateSchema(tool: string): z.ZodTypeAny {
  if (tool.startsWith('attach_')) return attachAspectInput;
  const byTool: Record<string, z.ZodTypeAny> = {
    entity_create: entityCreateInput,
    entity_update: entityUpdateInput,
    relation_create: relationCreateInput,
    relation_delete: relationDeleteInput,
  };
  return byTool[tool] ?? z.never();
}

export function actionExprScope(
  decl: ActionDefinition,
  _reg: RegistrySnapshot,
): Omit<ExprScope, 'reg'> {
  const params: Record<string, ExprType> = {};
  for (const p of decl.params) {
    params[p.name] = 'kind' in p.type ? ({ kind: p.type.kind } as ExprType) : { kind: 'text' };
  }
  // `allowDeref: true` — действие читает ЦЕЛЬ, а не пишет чужое (§Б3-3 запрещает deref в
  // C-правилах записи, а не в подстановках). `contract` не задан: слотов у действия нет области.
  return { params, allowDeref: true };
}
