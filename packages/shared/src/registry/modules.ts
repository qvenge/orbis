import { z } from 'zod';
import type { AspectDefinition } from './property-type';
import { attachToolName } from './tool-schema';

// СЛОВАРЬ МОДУЛЕЙ И ПОВЕРХНОСТЕЙ (§Б5-1, §Б8-1; форма имени — ревизия 3).
// Имя — `<модуль>/<поверхность>`, и модуль подписки читается ИЗ ИМЕНИ: второй источник ответа «чья
// это поверхность» разъехался бы с первым на первом переносе поверхности между модулями.
// Словарь ЗАКРЫТ и держит РОВНО поверхности, у которых в Б-1 есть движок (Р-К-10): по нему отказывает
// SURFACE_UNKNOWN, а имя без исполнителя — обещание, которое некому сдержать. `core/row` и
// `core/exclude-blocked` (`apps/server/test/surfaces.ts`) сюда НЕ входят: правило строки живёт
// константой M14_ROW_ELEMENTS (Р-К-1), excludeBlocked — частный случай Q, строки реестра у них нет.
export const MODULE_IDS = ['finance', 'planner', 'goals', 'ade', 'memory'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const SURFACES = ['planner/agenda', 'finance/budget-overview'] as const;
export type SurfaceName = (typeof SURFACES)[number];
/** Форма имени: `core` — ядро (модуля нет), остальные головы — id модуля. */
export const SURFACE_RE = /^(core|finance|planner|goals|ade|memory)\/[a-z][a-z0-9-]*$/;
/** Модуль поверхности; `core/…` — ядро, выключению не подлежит (§Б8-3). */
export function surfaceModuleOf(surface: string): ModuleId | null {
  const head = surface.split('/')[0] ?? '';
  return (MODULE_IDS as readonly string[]).includes(head) ? (head as ModuleId) : null;
}

/**
 * КАКОЙ ДВИЖОК ОБСЛУЖИВАЕТ ПОВЕРХНОСТЬ. Таблица нужна потому, что дискриминант декларации — `engine`,
 * а адрес показа — `surface`, и без сверки декларация Budget, объявленная на повестку, проходила бы
 * все проверки формы: движок повестки получил бы чужую форму уже на исполнении, то есть у владельца,
 * а не у автора декларации.
 *
 * Имена движков написаны здесь литералами, а не импортом из `subscription-type.ts`: стрелка между
 * файлами односторонняя (форма подписки читает словарь поверхностей), и обратная замкнула бы цикл.
 * `satisfies` держит таблицу ПОЛНОЙ: новая поверхность без движка не скомпилируется.
 */
export const SURFACE_ENGINE = {
  'planner/agenda': 'agenda',
  'finance/budget-overview': 'budget',
} as const satisfies Readonly<Record<SurfaceName, string>>;

/**
 * Манифест модуля (§Б8-1) — всё, чего НЕТ в колонке `module` строк реестров. Реестровая
 * половина состава Финансов (18 свойств + 3 аспекта + 2 роли) уже размечена данными
 * (`builtin-aspects.ts:121/:164/:187`) и здесь не дублируется: два списка одного состава
 * разошлись бы на первой новой строке.
 */
export interface ModuleManifest {
  id: ModuleId;
  tools: readonly string[]; // core-тулы; attach_* — из aspect.module
  promptFragments: readonly { id: string; text: string }[]; // политика-проза модуля
  surfaces: readonly SurfaceName[];
  codeRemainder: readonly { where: string; why: string }[]; // вход метрики отчёта §С1-4
}

/**
 * Блок «Бюджет» — ДОСЛОВНО четыре строки `llm/prompts/v5.ts:83-86`. `spend_class` в нём —
 * ключ ОТВЕТА тула `budget_status`, и тот же текст стоит в описании тула
 * (`tools/registry.ts:1100`): правка одной стороны развела бы фрагмент с описанием.
 */
const FIN_BUDGET_TEXT =
  'Бюджет (тул budget_status):\n- Финансовые вопросы — «что по бюджету?», «могу позволить X?», остатки конвертов, распределение бюджета — решай вызовом budget_status: он возвращает готовые агрегаты месяца (конверты со spent/remaining/dailyPace, баланс, comingUp, planned, unbudgeted) и spend_class категорий. Не пересчитывай эти агрегаты вручную через entity_query/user_query.\n- Свободные деньги («могу позволить?»): сумма remaining конвертов категорий со spend_class=discretionary МИНУС будущие planned-оттоки — записи planned и comingUp из budget_status, брать только direction=expense: доходные инстансы (например, будущую зарплату из comingUp) НЕ вычитай. Будущие recurring-платежи УЖЕ входят туда как planned-инстансы — НЕ суммируй recurring отдельно: это двойной вычет.\n- Категорию без spend_class не включай в расчёт молча — явно попроси пользователя классифицировать её (fixed/discretionary).';

const FINANCE_FRAGMENTS = [
  {
    id: 'finance/amounts',
    text: 'Деньги (модуль «Финансы»):\n- Денежные суммы — decimal-строки с двумя знаками после точки ("500.00"), никогда числа с плавающей точкой.\n- orbis/finance_category — только uuid реально существующей категории: найди её через entity_query. Не подставляй выдуманный uuid.',
  },
  {
    id: 'finance/one-intent',
    text: '- Деньги на той же сущности: «оплатить страховку 12000 до пятницы» = одна сущность с аспектами orbis/task и orbis/financial и свойствами orbis/task_status, orbis/due_date, orbis/amount, orbis/direction, orbis/finance_category, orbis/planned=true, orbis/occurred_on — а НЕ отдельная задача плюс отдельная трата.',
  },
  { id: 'finance/budget', text: FIN_BUDGET_TEXT },
] as const;

export const MODULE_MANIFESTS: Readonly<Record<ModuleId, ModuleManifest>> = {
  finance: {
    id: 'finance',
    tools: ['budget_status', 'import_csv_start'],
    promptFragments: FINANCE_FRAGMENTS,
    surfaces: ['finance/budget-overview'],
    codeRemainder: [
      {
        where: 'apps/server/src/routers/{budget,import}.ts',
        why: 'tRPC-ручки Финансов гейтит web, а модульные гейты web — срез Б-3 (§С9 п.5); серверная половина Б-1 — маска на тулах, фрагментах, подписках и записи (§Б8-3)',
      },
      {
        where: 'apps/server/src/llm/prompts/routine-v3.ts:63-64',
        why: 'канал рутины — своя линейка промпта; её разборка по модулям идёт вместе с фрагментами Планировщика (Б-3)',
      },
      {
        where: 'packages/shared/src/fast-path/index.ts',
        why: 'клиентский fast-path денег — код-остаток клиента, гейтится web (Б-3)',
      },
      {
        where: 'apps/server/src/budget/aggregates.ts — computeOverview',
        why: 'Р-К-5: оракул сверки живёт до Б-2',
      },
    ],
  },
  // Остальные четыре: реестровый состав уже размечен колонкой `module`, непустых фрагментов
  // в Б-1 у них нет — приёмка §С8-22 требует серверную половину ТОЛЬКО Финансов.
  planner: {
    id: 'planner',
    tools: [],
    promptFragments: [],
    surfaces: ['planner/agenda'],
    codeRemainder: [
      {
        where: 'llm/prompts/v6.ts — примеры «одна сущность на намерение» и шпаргалки',
        why: 'фрагменты Планировщика — Б-3 вместе с гейтами web (§С9 п.5)',
      },
    ],
  },
  goals: {
    id: 'goals',
    tools: [],
    promptFragments: [],
    surfaces: [],
    codeRemainder: [
      {
        where: 'llm/prompts/v6.ts — блок «Цели и горизонты»',
        why: 'то же, что у Планировщика (Б-3)',
      },
    ],
  },
  ade: { id: 'ade', tools: [], promptFragments: [], surfaces: [], codeRemainder: [] },
  memory: {
    id: 'memory',
    tools: [],
    promptFragments: [],
    surfaces: [],
    codeRemainder: [
      {
        where: 'tools/registry.ts:267 — memory_rule_suggestion',
        why: '§Б8-1 называет её тулом; в коде это ВИД КАРТОЧКИ — уносить нечего до появления тула',
      },
    ],
  },
};

/** Ядро (`module: null`) не выключается никогда (§Б8-2) — отсюда обе ветки на «нет модуля». */
export function isModuleEnabled(
  module: string | null | undefined,
  disabled: readonly string[],
): boolean {
  return module === null || module === undefined || !disabled.includes(module);
}

/**
 * Модуль тула: `attach_*` — по колонке `module` его АСПЕКТА, core-тул — по манифесту.
 * Тула вне обоих источников (ядро) здесь нет по построению — ответ `null`.
 */
export function moduleOfTool(
  name: string,
  reg: { aspects: ReadonlyMap<string, AspectDefinition> },
): ModuleId | null {
  // attach_* адресуется КЛЮЧОМ аспекта, и обратная нормализация имени невозможна («-» и «/»
  // склеиваются в «_» — докблок `attachToolName`), поэтому идём вперёд от ключей.
  if (name.startsWith('attach_')) {
    for (const a of reg.aspects.values()) {
      if (attachToolName(a.key) === name) return MODULE_IDS.find((m) => m === a.module) ?? null;
    }
    return null;
  }
  for (const id of MODULE_IDS) if (MODULE_MANIFESTS[id].tools.includes(name)) return id;
  return null;
}

/**
 * Проза ВКЛЮЧЁННЫХ модулей одной секцией канала (§Б8-3) — `null`, когда включённым модулям
 * сказать нечего: пустая секция в канале выглядела бы для модели оборванным заголовком.
 */
export function modulePromptFragments(disabled: readonly string[]): string | null {
  const texts = MODULE_IDS.filter((m) => isModuleEnabled(m, disabled)).flatMap((m) =>
    MODULE_MANIFESTS[m].promptFragments.map((f) => f.text),
  );
  return texts.length === 0 ? null : texts.join('\n');
}

/**
 * Схема входа объявлена ЗДЕСЬ: её читают и ручка `user.setModuleEnabled`, и стадия 1
 * исполнителя. Два «похожих» описания одной операции разъехались бы — тот же довод, что в
 * докблоке `registryMutation` (`routers/registry.ts:40-46`).
 */
export const setModuleEnabledInput = z
  .object({ module: z.enum(MODULE_IDS), enabled: z.boolean() })
  .strict();
