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
import { createHash } from 'node:crypto';
import {
  ACTION_STEP_TOOLS,
  type ActionDefinition,
  type ActionParam,
  type ActionStep,
  actionDefinitionSchema,
  attachAspectInput,
  attachToolName,
  bindingIndexOf,
  canonicalJson,
  entityCreateInput,
  entityUpdateInput,
  exprMarkerSchema,
  isActionToolName,
  MODULE_IDS,
  type PropertyDefinition,
  type PropertyKind,
  type PropertyType,
  relationCreateInput,
  relationDeleteInput,
  type SensitivityFact,
} from '@orbis/shared';
// Типы языка E — из его подпути, как у `subscriptions/registry.ts` (баррель реестра их не
// реэкспортирует, и второй адрес для одного типа заводить незачем).
import {
  EXPR_TREE_DEPTH_CAP,
  type ExprScope,
  type ExprType,
  exprTreeExceedsDepth,
  exprTypeOfKind,
} from '@orbis/shared/expr';
// Q map-действия: тип дерева и узла фильтра — подпуть запросов (как у `tools/dispatch.ts`); оттуда же
// «списочность» свойства — решение языка, общее с чекером E (`typedOfProp`).
import { isListPropertyType, type QueryAst, type QueryFilterNode } from '@orbis/shared/query';
import { z } from 'zod';
import { ExecError } from '../errors';
import { ROUTINE_UNTOUCHABLE_OBJECTS } from '../executor/invariants';
import { resolvePropertyRef } from '../executor/props';
import { assertExprChecked } from '../expr/check';
// Предикат доверенности рутины — ОДИН на политику и валидатор (Р-И-25): факт `grants_autonomy`
// шага обязан считаться тем же правилом, каким классификатор поднимает уровень вызова, иначе
// декларация могла бы «не объявить» то, что политика на прогоне всё равно увидит. Импорт —
// чтение: `confirmation.ts` тянет только `tools/registry-tools` → `registry/deltas`, цикла нет.
import {
  AUTONOMY_PROPERTIES,
  grantsRoutineAutonomy,
  ROUTINE_MODE_PROPERTY,
} from '../policy/confirmation';
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
  // Тип параметра — тоже форма: json-параметру нечем стать в выражении (у вложенного объекта нет
  // скалярного значения, §6.4), и сказать это нужно ЗДЕСЬ, по имени параметра, а не безымянным
  // `EXPR_TYPE` при первом `{param}` — или вовсе никогда, если параметр никто не читает.
  for (const p of decl.params) paramExprType(decl.key, p);

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
  // ЧЬЯ СТРОКА — ТОТ ЖЕ ВОПРОС, ЧТО NAMESPACE (m-3 гейта задачи 6): строка с `graph_id NULL` — это
  // СИСТЕМНАЯ строка для всех графов (`loadRegistryRows` отдаёт её каждому, `ORDER BY graph_id NULLS
  // FIRST`), а строка владельца несёт его граф. Своё действие без графа легло бы в словарь всех
  // владельцев сразу, а сид с графом — одному; писатель и строка обязаны сходиться. Дверь `action_set`
  // проставляет граф владельца сама (`setOwnAction`), здесь — защёлка на любой будущий писатель.
  if (scope.systemSeed !== (decl.graphId === null)) {
    bad(
      'ACTION_NAMESPACE',
      decl.key,
      scope.systemSeed
        ? `системное действие «${decl.key}» не может принадлежать графу ${decl.graphId}`
        : `своё действие «${decl.key}» без графа-владельца читалось бы системным`,
      { graphId: decl.graphId },
    );
  }
  const taken = [...scope.reg.actions.values()].find((a) => a.key === decl.key && a.id !== decl.id);
  if (taken !== undefined) {
    bad('ACTION_KEY_TAKEN', decl.key, `ключ «${decl.key}» уже занят действием ${taken.id}`, {
      other: taken.id,
    });
  }
  // Словарь `reason` тулов действий (задача 10, Р-К-40): `ACTION_TARGET_SYSTEM` — `action_set`/`action_remove` адресуют
  // системную строку (по образцу `RULE_TARGET_SYSTEM_ROLE`); «своего действия нет» — `NOT_FOUND`. Здесь не бросается:
  // адрес системной строки знает дверь (`setOwnAction`, `prepareActionRemove`), а не валидатор декларации.

  // (5) Шаги: только графовые тулы с inverse (Р-10); действие действие не зовёт.
  for (const [index, step] of decl.steps.entries()) {
    // Имя тула действия — общим предикатом (`isActionToolName`, shared): префикс захватил бы реестровые
    // `action_set`/`action_remove`, которые вложенностью не являются (рулинг 6-1).
    if (step.tool === 'run_action' || isActionToolName(step.tool)) {
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
    const scripted = delegationObjectNamedBy(scope.reg, step);
    if (scripted !== null) {
      bad(
        'ACTION_STEP_TOOL',
        decl.key,
        scripted === MARKER_ASPECTS
          ? `действие «${decl.key}»: шаг ${index + 1} задаёт аспекты выражением — худший случай: рутина или прогон; рутины и прогоны действиями не сценарируются (§Б6-3)`
          : `действие «${decl.key}»: шаг ${index + 1} трогает «${scripted}» — рутины и прогоны действиями не сценарируются (§Б6-3)`,
        { step: index, tool: step.tool, aspect: scripted },
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
  // затыкается заглушкой ТИПА ПОЗИЦИИ, и дальше работает НАСТОЯЩИЙ конверт.
  for (const [index, step] of decl.steps.entries()) {
    // Маркер строгий (`exprMarkerSchema`): сосед у `$expr` не «лишний ключ, который никто не
    // прочтёт», а данные, молча выпавшие из шаблона, — и автор уверен, что их записал.
    for (const site of markerSitesOf(step.input)) {
      // Слишком глубокое дерево схеме не отдаётся (`z.lazy` исчерпал бы стек до всякого условия):
      // его называет гейт глубины ступени 8 (`EXPR_TOO_DEEP`).
      if (exprTreeExceedsDepth(site.node, EXPR_TREE_DEPTH_CAP)) continue;
      const marker = exprMarkerSchema.safeParse(site.marker);
      if (!marker.success) {
        bad(
          'ACTION_STEP_INPUT',
          decl.key,
          `действие «${decl.key}»: шаг ${index + 1}, позиция ${site.segs.join('.')} — маркер {$expr} не разобран`,
          {
            step: index,
            tool: step.tool,
            path: site.segs.join('.'),
            issues: marker.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          },
        );
      }
    }
    const probe = stepTemplateSchema(step.tool).safeParse(stripMarkers(step.input, []));
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
  // `offered_by[].when` — предикат (§Б6-6), как и `precondition`.
  for (const [index, offer] of decl.offered_by.entries()) {
    if (offer.when === undefined) continue;
    const path = `offered_by.${index}.when`;
    const t = assertExprChecked(offer.when, { ...exprScope, reg: scope.reg });
    if (t.kind !== 'boolean') {
      bad('ACTION_PRECONDITION_TYPE', decl.key, `${path} действия «${decl.key}» — не предикат`, {
        actual: t.kind,
        path,
      });
    }
  }
  // `{$expr}` шага — выражение ТИПА СВОЕЙ ПОЗИЦИИ (§1.6 реестра интерфейсов, ступень 8): значение
  // свойства — типа свойства-цели, поле конверта — типа поля. Без этого запись действия проходила
  // бы, а дальше одно из двух: несовместимый тип валит КАЖДЫЙ прогон (действие вечно сломано,
  // тул LLM падает на каждом вызове), а строковый (decimal или date в `text`) не ловится нигде и
  // молча пишется текстом навсегда.
  for (const [index, step] of decl.steps.entries()) {
    assertStepValues(decl.key, index, step, scope.reg, exprScope);
  }

  // (9) Р-34 (урок остатка 39): параметр, который никто не читает, — обещание поверхности,
  // которое некому исполнить. Обход по УЖЕ разобранным E-позициям: второй обход сырого
  // дерева нашёл бы `{param}` и внутри литерала json-значения, где это просто данные.
  const used = new Set<string>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) collect(n);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (typeof o.param === 'string') used.add(o.param);
    for (const v of Object.values(o)) collect(v);
  };
  if (decl.precondition !== null) collect(decl.precondition);
  for (const [path, node] of rawExprSites(decl as unknown as Record<string, unknown>)) {
    if (path !== 'precondition') collect(node);
  }
  const unused = decl.params.map((p) => p.name).filter((n) => !used.has(n));
  if (unused.length > 0) {
    bad(
      'ACTION_PARAM_UNUSED',
      decl.key,
      `действие «${decl.key}»: параметр(ы) ${unused.join(', ')} не читает ни precondition, ни один шаг (Р-34)`,
      { params: unused },
    );
  }

  // (10) §Б6-1 дословно: декларация факты может только ДОБАВЛЯТЬ; шаг с фактом выше
  // задекларированных — отказ. Сравнение по множеству, а не по длине: лишний объявленный
  // факт законен (он поднимает уровень, а не опускает).
  const declared = new Set<string>(decl.sensitivity);
  for (const [index, step] of decl.steps.entries()) {
    for (const fact of stepFactsOf(scope.reg, step)) {
      if (!declared.has(fact)) {
        throw new ExecError(
          'SENSITIVITY_UNDERDECLARED',
          `действие «${decl.key}»: шаг ${index + 1} несёт факт «${fact}», которого декларация не объявила (§Б6-1)`,
          { action: decl.key, step: index, fact },
        );
      }
    }
    // Сегодня недостижимо: ступень 5 пускает ровно тулы, которые таблица ниже считает обратимыми.
    // Стоит здесь как защёлка на день, когда словарь шагов вырастет, а таблица — нет (§Б6-4).
    if (!stepReversible(step.tool)) {
      bad(
        'ACTION_STEP_TOOL',
        decl.key,
        `действие «${decl.key}»: у шага ${index + 1} нет inverse (§Б6-4)`,
        {
          step: index,
          tool: step.tool,
        },
      );
    }
  }

  return decl;
}

/**
 * ФАКТЫ ЧУВСТВИТЕЛЬНОСТИ ШАГА — СТАТИЧЕСКАЯ ТАБЛИЦА (Р-9, Р-И-25) по шаблону входа, до исполнения.
 * Графовые тулы производят ДВА факта:
 *  - `touches_money` — шаг пишет свойство, привязанное к слоту `orbis/money-movement`. Читается из
 *    ПРИВЯЗОК, а не из списка имён свойств: список «какие свойства про деньги» жил бы вторым мнением
 *    рядом с контрактом и разошёлся бы с ним у первого же своего денежного аспекта владельца
 *    (§Б2-1: принадлежность — привязкой);
 *  - `grants_autonomy` — шаг правит доверенность рутины. Предикат — `grantsRoutineAutonomy`
 *    политики, тот же, которым классификатор поднимает уровень вызова (`policy/confirmation.ts`):
 *    `entity_update`, называющий `orbis/routine_mode`/`orbis/allowed_tools` в `props` или `unset`;
 *    `entity_create` и `attach_orbis_routine`, кладущие «вооружённый» набор.
 *
 * ХУДШИЙ СЛУЧАЙ ДЛЯ ПОДСТАНОВКИ (Р-9). Значение `{$expr}` до исполнения неизвестно: маркер в позиции
 * доверенности у create/attach читается как «вооружает» (`act`, непустой список). Маркер в `unset` — И
 * на месте элемента (`unset: [{$expr}]`), И на месте ВСЕГО списка (`unset: {$expr}`, тип позиции
 * `list<text>`, конверт его пропускает) — снятие НЕИЗВЕСТНЫХ свойств, то есть и денежного, и
 * доверенности. Читать `unset` только как массив нельзя: маркер-список проходил бы мимо обоих
 * фактов (фикс-раунд 2, N-1). У update сама правка ключа доверенности — уже выдача, там худший
 * случай совпадает с буквальным.
 *
 * Адрес свойства во входе — КЛЮЧ (`props`, `unset`, `data` у `attach_*`), привязка же хранит id;
 * перевод — тем же `resolvePropertyRef`, каким исполнитель резолвит патч: у своих свойств key и id
 * расходятся, и второе правило перевода здесь разошлось бы с исполнителем на первом же из них.
 *
 * Остальных трёх фактов графовые тулы не производят: `changes_registry` — факт реестровых тулов
 * (классификатор, `policy/sensitivity.ts`), а `external` и `irreversible` в v1 объявляются только
 * декларацией — производителя у них нет.
 */
export function stepFactsOf(reg: RegistrySnapshot, step: ActionStep): readonly SensitivityFact[] {
  const money = new Set<string>();
  for (const b of bindingIndexOf(reg).byContract('orbis/money-movement')) {
    for (const propertyId of Object.values(b.bind)) money.add(propertyId);
  }
  const input = step.input;
  const unset = Array.isArray(input.unset) ? (input.unset as unknown[]) : [];
  const addressed = [
    ...Object.keys(recordOf(input.props)),
    ...unset.filter((k): k is string => typeof k === 'string'),
    // attach_* пишет набор аспекта целиком — `data` адресуется КЛЮЧАМИ свойств (§А9-1).
    ...Object.keys(recordOf(input.data)),
  ];
  const written = addressed.map((k) => resolvePropertyRef(reg, k)?.id ?? k);
  const unsetUnknown = isMarker(input.unset) || unset.some(isMarker);
  const out: SensitivityFact[] = [];
  if (unsetUnknown || written.some((p) => money.has(p))) out.push('touches_money');
  if (unsetUnknown || grantsRoutineAutonomy(step.tool, worstCaseAutonomy(step.tool, input))) {
    out.push('grants_autonomy');
  }
  // §Б6-4: необратимый шаг обязан объявиться ДО исполнения. Все шаги v1 обратимы по таблице
  // ниже, поэтому `irreversible` здесь не производится — ветка появится вместе с первым
  // необратимым тулом шага (её отсутствие сторожит `stepReversible`).
  return out;
}

/**
 * Шаблон входа, в котором маркер позиции доверенности заменён «вооружающим» значением — худший
 * случай Р-9 для наборов, которые create и attach кладут ЦЕЛИКОМ (`autonomyArmed` смотрит на
 * значение). У update предикату значим ключ, а не значение, — вход отдаётся как есть.
 */
function worstCaseAutonomy(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const bag = tool === 'entity_create' ? 'props' : tool.startsWith('attach_') ? 'data' : undefined;
  if (bag === undefined) return input;
  const values = { ...recordOf(input[bag]) };
  for (const p of AUTONOMY_PROPERTIES) {
    if (!isMarker(values[p])) continue;
    values[p] = p === ROUTINE_MODE_PROPERTY ? 'act' : ['<$expr>'];
  }
  return { ...input, [bag]: values };
}

function recordOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function isMarker(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.hasOwn(v, '$expr');
}

/**
 * ЕСТЬ ЛИ У ШАГА INVERSE (Р-10, §Б6-4). Таблица СТАТИЧЕСКАЯ, потому что до исполнения
 * прочитать обратимость неоткуда: `registryPlan` отдаёт `inverse: []`, а наполняется он
 * ВНУТРИ `apply` и УСЛОВНО (`executor.ts` — только `if (before !== undefined)`).
 * Отсюда правило худшего случая: условное — необратимо.
 */
export function stepReversible(tool: string): boolean {
  return (ACTION_STEP_TOOLS as readonly string[]).includes(tool) || tool.startsWith('attach_');
}

/**
 * ЛИЧНОСТЬ ДЕКЛАРАЦИИ (Р-И-31): версии у строки `action_definitions` нет, и «Устарело»
 * отложенной единицы (§Б6-7, задача 8) сверяет именно хеш. В хеш входит ТО, ЧТО МЕНЯЕТ
 * ИСПОЛНЕНИЕ: шаги, параметры, предусловие, множество целей, кап и объявленные факты.
 * Подпись, описание, `rank` и `offered_by` — нет: правка подписи чужого действия это
 * ДЕЛЬТА (§С3), и она не имеет права протухлять уже поставленную единицу.
 *
 * Хеш считается ЗДЕСЬ, а не `unitHash`-ом (`policy/pending.ts`): импорт из политики в
 * реестр замкнул бы дугу «реестр → политика → реестр». Канон один и тот же — `canonicalJson`
 * из shared (`aspect-registry.ts`), — поэтому два хеша одной формы совпадают по построению.
 */
export function actionHash(decl: ActionDefinition): string {
  const identity = {
    steps: decl.steps,
    params: decl.params,
    precondition: decl.precondition,
    over: decl.over,
    sensitivity: decl.sensitivity,
    batch_cap: decl.batch_cap,
  };
  return createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

/** Адрес «аспекты заданы выражением» в отказе ступени 5: значение до прогона неизвестно. */
const MARKER_ASPECTS = '{$expr}';

/**
 * ОБЪЕКТ МАШИНЕРИИ ДЕЛЕГИРОВАНИЯ, КОТОРЫЙ ШАГ НАЗЫВАЕТ (фикс-раунд 1 задачи 7: Fable I-1(а) + I-4,
 * гейт I-T10a/I-T10b): рутина или прогон (`ROUTINE_UNTOUCHABLE_OBJECTS` — тот же список, что у запрета
 * по объекту для фона). `null` — не называет; `MARKER_ASPECTS` — набор аспектов задан выражением, и
 * худший случай считается названным.
 *
 * ПОЧЕМУ СТАТИЧЕСКИЙ ОТКАЗ, А НЕ ПОВТОР ЗАМКОВ НА ИСПОЛНЕНИИ. Для одиночного тула `runMutation`
 * (`tools/dispatch.ts`) держит четыре замка над рутинами, которых у ветки действия нет: скан
 * разоружения и оживления через носитель (`autonomyChangedByCarrier`, Р-12-2/3/5 — `attach_orbis_routine`
 * заменяет набор целиком, `aspects.detach` уносит носитель, `aspects.attach` оживляет запись с
 * пережившими значениями), гейт инструкции act-рутины (C1b-1) и лимит рутин `gateRoutinesMax` (§8).
 * Действие исполняется одной пачкой по резолвленным шагам (`actions/run.ts`), и дыры там были бы
 * ровно те, что закрывали десять фикс-раундов Задачи 12: одна декларация, принятая карточкой однажды,
 * дальше провозила бы разоружение или новую рутину каждым вызовом `run_action`. Проще и строже — не
 * пустить такой шаг в декларацию вовсе: рутины и прогоны — предмет РУТИН и владельца, а не действий
 * (симметрично Р-10 про реестр; анти-цель 3 §С2-3). Цель-рутину у `entity_update` на исполнении
 * отвергает ещё и `loadTargets` (`actions/resolve.ts`), а эта ступень закрывает формы, где рутина
 * НАЗВАНА, а не адресована: `attach_*` её аспекта и `aspects`/`aspects.attach`/`aspects.detach`.
 */
function delegationObjectNamedBy(reg: RegistrySnapshot, step: ActionStep): string | null {
  const untouchable = (id: string): boolean =>
    (ROUTINE_UNTOUCHABLE_OBJECTS as readonly string[]).includes(id);
  if (step.tool.startsWith('attach_')) {
    const aspect = attachAspectOf(reg, step.tool);
    if (aspect !== undefined && untouchable(aspect.id)) return aspect.id;
  }
  const aspects = step.input.aspects;
  if (aspects === undefined) return null;
  if (isMarker(aspects)) return MARKER_ASPECTS;
  const lists = Array.isArray(aspects)
    ? [aspects]
    : [recordOf(aspects).attach, recordOf(aspects).detach];
  for (const list of lists) {
    if (isMarker(list)) return MARKER_ASPECTS;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isMarker(item)) return MARKER_ASPECTS;
      if (typeof item !== 'string') continue;
      // Аспект во входе — ключ или id (`resolveAttachAspect` исполнителя принимает оба).
      const id = [...reg.aspects.values()].find((a) => a.key === item)?.id ?? item;
      if (untouchable(id)) return id;
    }
  }
  return null;
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
    for (const site of markerSitesOf(s.input)) {
      yield [`${inputPath(index, site.segs)}.$expr`, site.node];
    }
  }
}

const TEXT: ExprType = { kind: 'text' };
const LIST_TEXT: ExprType = { kind: 'list', of: TEXT };
/**
 * ТИП ПОЛЯ КОНВЕРТА шагов v1 — то, чем обязан стать `{$expr}` в этой позиции. Мешки свойств
 * (`props`, `data`) сюда не входят: их тип даёт реестр по ключу. Поля-id — `text` (uuid — строка,
 * и `$self` чекер типизирует так же); `expectedUpdatedAt` — момент; списки адресов (`tags`, `unset`,
 * `aspects` создания и `attach`/`detach` правки) — `list<text>`, их элемент — `text`.
 */
const ENVELOPE_FIELD_TYPES: Readonly<Record<string, ExprType>> = {
  id: TEXT,
  entity_id: TEXT,
  source_id: TEXT,
  target_id: TEXT,
  role: TEXT,
  title: TEXT,
  emoji: TEXT,
  body: TEXT,
  archived: { kind: 'boolean' },
  expectedUpdatedAt: { kind: 'timestamp' },
  tags: LIST_TEXT,
  unset: LIST_TEXT,
  aspects: LIST_TEXT,
  attach: LIST_TEXT,
  detach: LIST_TEXT,
};
const PROPERTY_BAGS: ReadonlySet<string> = new Set(['props', 'data']);

/** Адрес позиции во входе шага: маркер в КОРНЕ `input` — сам `steps.N.input`, без висящей точки. */
function inputPath(index: number, segs: readonly string[]): string {
  return segs.length === 0 ? `steps.${index}.input` : `steps.${index}.input.${segs.join('.')}`;
}

/** Маркер `{$expr}` шаблона входа: путь сегментами от корня `input`, сам маркер и его выражение. */
interface MarkerSite {
  segs: readonly string[];
  marker: Record<string, unknown>;
  node: unknown;
}
function* markerSitesOf(value: unknown, segs: readonly string[] = []): Generator<MarkerSite> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* markerSitesOf(v, [...segs, String(i)]);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, '$expr')) {
    yield { segs, marker: obj, node: obj.$expr };
    return;
  }
  for (const [k, v] of Object.entries(obj)) yield* markerSitesOf(v, [...segs, k]);
}

/** Тип поля конверта по пути; `undefined` — у позиции своего типа нет. Мешки свойств — не здесь. */
function envelopeTypeAt(segs: readonly string[]): ExprType | undefined {
  const last = segs[segs.length - 1];
  if (last === undefined) return undefined;
  const isIndex = /^\d+$/.test(last);
  const field = isIndex ? segs[segs.length - 2] : last;
  const type = field === undefined ? undefined : ENVELOPE_FIELD_TYPES[field];
  if (type === undefined || !isIndex) return type;
  return type.kind === 'list' ? type.of : undefined;
}

/**
 * Заглушка под тип позиции — значение, которое конверт заведомо примет там, где стоял маркер:
 * uuid для полей-id и текста, `true` для `archived`, момент для `expectedUpdatedAt`, `[]` для
 * списков. Одна заглушка на всё (uuid) давала ложный `ACTION_STEP_INPUT` у `archived` из параметра
 * (m-1 гейта). Значения свойств в конверте — `z.unknown()`, им подходит любая.
 */
const MARKER_UUID = '00000000-0000-4000-8000-000000000000';
function stubOf(type: ExprType | undefined): unknown {
  switch (type?.kind) {
    case 'boolean':
      return true;
    case 'timestamp':
      return '2000-01-01T00:00:00.000Z';
    case 'date':
      return '2000-01-01';
    case 'number':
      return 0;
    case 'decimal':
      return '0';
    case 'list':
      return [];
    default:
      return MARKER_UUID;
  }
}
/**
 * Конверт тула с «дырками» под подстановку: маркер `{$expr}` заменяется заглушкой типа позиции.
 * Проверяется ФОРМА конверта, а типы выражений — ступенью 8; смешивать их нельзя: тип подстановки
 * zod не знает.
 */
function stripMarkers(value: unknown, segs: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => stripMarkers(v, [...segs, String(i)]));
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, '$expr')) {
    return stubOf(PROPERTY_BAGS.has(segs[0] ?? '') ? undefined : envelopeTypeAt(segs));
  }
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, stripMarkers(v, [...segs, k])]),
  );
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

/** Печать типа для текста отказа: читателем будет человек в карточке. */
function typeLabel(type: ExprType): string {
  if (type.kind === 'list') return `list<${typeLabel(type.of)}>`;
  if (type.kind === 'class') return `class<${type.contract}>`;
  return type.kind;
}
function sameType(a: ExprType, b: ExprType): boolean {
  if (a.kind === 'list' && b.kind === 'list') return sameType(a.of, b.of);
  if (a.kind === 'class' && b.kind === 'class') return a.contract === b.contract;
  return a.kind === b.kind;
}
/** Тип значения свойства-цели: список — для `cardinality: many`, элемент — его скаляр (как `typedOfProp`). */
function propertyValueType(def: PropertyDefinition, element: boolean): ExprType {
  const base = exprTypeOfKind(def.type.kind);
  return isListPropertyType(def.type) && !element ? { kind: 'list', of: base } : base;
}

/**
 * СТУПЕНЬ 8 ДЛЯ ШАГА: адреса свойств существуют, каждый `{$expr}` — типа своей позиции (§1.6).
 * Отказ — `VALIDATION reason: 'ACTION_VALUE_TYPE'` по образцу `RULE_VALUE_TYPE` правил: «ожидался
 * decimal» без адреса читается как ошибка чекера, а это ошибка ДЕЙСТВИЯ. Тем же именем назван и
 * адрес свойства, которого нет в реестре, и json-свойство под выражением — `assertRule` сводит оба
 * случая к одной причине по тому же доводу: значению некуда лечь.
 */
function assertStepValues(
  key: string,
  index: number,
  step: ActionStep,
  reg: RegistrySnapshot,
  exprScope: Omit<ExprScope, 'reg'>,
): void {
  const path = (segs: readonly string[]) => inputPath(index, segs);
  const refuse = (segs: readonly string[], message: string, details: Record<string, unknown>) =>
    bad(
      'ACTION_VALUE_TYPE',
      key,
      `действие «${key}»: шаг ${index + 1}, ${path(segs)} — ${message}`,
      {
        step: index,
        path: path(segs),
        ...details,
      },
    );
  // (а) Адреса свойств — литералы: ключи мешков и имена в `unset`. Свойства, которого нет, шаг не
  // запишет никогда, и сказать это надо при записи действия, а не на каждом его прогоне.
  for (const bag of PROPERTY_BAGS) {
    for (const k of Object.keys(recordOf(step.input[bag]))) {
      if (resolvePropertyRef(reg, k) === undefined) {
        refuse([bag, k], `свойства «${k}» в реестре нет`, { property: k });
      }
    }
  }
  const unset = Array.isArray(step.input.unset) ? (step.input.unset as unknown[]) : [];
  for (const [i, k] of unset.entries()) {
    if (typeof k === 'string' && resolvePropertyRef(reg, k) === undefined) {
      refuse(['unset', String(i)], `свойства «${k}» в реестре нет`, { property: k });
    }
  }
  // (б) Каждый маркер — против типа своей позиции.
  for (const site of markerSitesOf(step.input)) {
    const [head, propertyKey] = site.segs;
    let want: ExprType | undefined;
    if (head !== undefined && PROPERTY_BAGS.has(head) && propertyKey !== undefined) {
      const def = resolvePropertyRef(reg, propertyKey) as PropertyDefinition;
      if (def.type.kind === 'json') {
        // У вложенного объекта нет скалярного значения (§6.4) — ни целиком, ни по частям.
        refuse(site.segs, `свойству json нельзя проставить значение выражением`, {
          property: propertyKey,
        });
      }
      const element = site.segs.length === 3 && isListPropertyType(def.type);
      if (site.segs.length > 3 || (site.segs.length === 3 && !element)) {
        refuse(
          site.segs,
          `подстановка внутри значения свойства «${propertyKey}» — не позиция значения`,
          {
            property: propertyKey,
          },
        );
      }
      want = propertyValueType(def, element);
    } else {
      want = envelopeTypeAt(site.segs);
    }
    const got = assertExprChecked(site.node, { ...exprScope, reg }, want);
    if (want !== undefined && !sameType(got, want)) {
      refuse(
        site.segs,
        `выражение типа ${typeLabel(got)} не сходится с типом позиции ${typeLabel(want)}`,
        {
          expected: typeLabel(want),
          actual: typeLabel(got),
        },
      );
    }
  }
}

/**
 * Тип `{param}` в выражениях действия — ТЕМ ЖЕ отображением рода, что у `{prop}` (`exprTypeOfKind`):
 * `select`/`time`/`ref`/`grant`/`registry_ref` — текст. Прежнее `{kind: p.type.kind}` с приведением
 * давало несуществующие `ExprType` (`{kind:'select'}`) и ложный `EXPR_TYPE` на сравнении параметра со
 * свойством того же рода. Параметр-контракт — uuid сущности-реализации, текст. json-параметр — отказ
 * формы: подставить вложенный объект в выражение нечем (§6.4).
 */
function paramExprType(key: string, p: ActionParam): ExprType {
  if (!('kind' in p.type)) return TEXT;
  if (p.type.kind === 'json') {
    bad(
      'ACTION_MALFORMED',
      key,
      `параметр «${p.name}» действия «${key}» типа json: у вложенного объекта нет скалярного значения — в выражение его не подставить (§6.4)`,
      { param: p.name, kind: p.type.kind },
    );
  }
  return exprTypeOfKind(p.type.kind);
}

/**
 * Тип ЛИТЕРАЛА параметра по его РОДУ — для сверки значения вызова (`actions/resolve.ts`) и для
 * JSON Schema тула действия (`tools/registry.ts`, `actionToolDefs`). Одна функция на двух
 * читателей: схема, показанная модели, и проверка значения обязаны отвечать одинаково.
 *
 * У параметра нет конфига рода (вариантов у `select`, цели у `ref`) — только `kind` (§Б6-1),
 * поэтому `select` читается как текст: схема `select` без вариантов не собирается вовсе
 * (`elementSchema` читает `options`) — то же отображение, что у `paramExprType` выше. Остальным
 * родам конфиг для формы не нужен; `json` до вызова не доезжает — его отвергает `assertAction`.
 */
export function paramLiteralType(kind: PropertyKind): PropertyType {
  return (kind === 'select' ? { kind: 'text' } : { kind }) as PropertyType;
}

export function actionExprScope(
  decl: ActionDefinition,
  _reg: RegistrySnapshot,
): Omit<ExprScope, 'reg'> {
  const params: Record<string, ExprType> = {};
  for (const p of decl.params) params[p.name] = paramExprType(decl.key, p);
  // `allowDeref: true` — действие читает ЦЕЛЬ, а не пишет чужое (§Б3-3 запрещает deref в
  // C-правилах записи, а не в подстановках). `contract` не задан: слотов у действия нет области.
  return { params, allowDeref: true };
}
