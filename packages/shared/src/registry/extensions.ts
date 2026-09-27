import { z } from 'zod';
import type { AspectDefinition } from './property-type';
import { actionToolName, attachToolName, isActionToolName } from './tool-schema';
import { effectiveLabel, type LocalizedText } from './types';

// СЛОВАРЬ РАСШИРЕНИЙ И ПОВЕРХНОСТЕЙ (§Б5-1, §Б8-1; спека 1б §3.3, §8.1).
// Имя поверхности — `<расширение>/<поверхность>` или `core/<поверхность>`, и расширение подписки
// читается ИЗ ИМЕНИ: второй источник ответа «чья это поверхность» разъехался бы с первым на первом
// переносе поверхности (1б перенёс Повестку в ядро — ровно этот случай).
// Словарь поверхностей ЗАКРЫТ и держит РОВНО поверхности, у которых есть движок (Р-К-10): по нему
// отказывает SURFACE_UNKNOWN, а имя без исполнителя — обещание, которое некому сдержать.
// `core/row` и `core/exclude-blocked` (`apps/server/test/surfaces.ts`) сюда НЕ входят: правило
// строки живёт константой M14_ROW_ELEMENTS (Р-К-1), excludeBlocked — частный случай Q.
//
// `planner` и `memory` — ЯДРО с 1б (спека §8.1): их строки несут `module: null`, а не id. Прежний
// `ade` разделён на «Проекты» и «Разработку» (РП-1); в маске его не бывало (переключался только
// `finance`), поэтому переезда данных нет. `finance` не переименовывается: его хранят маска и журнал.
export const EXTENSION_IDS = ['finance', 'goals', 'projects', 'dev'] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];
export const SURFACES = ['core/agenda', 'finance/budget-overview'] as const;
export type SurfaceName = (typeof SURFACES)[number];
/** Форма имени: `core` — ядро (расширения нет), остальные головы — id расширения. */
export const SURFACE_RE = /^(core|finance|goals|projects|dev)\/[a-z][a-z0-9-]*$/;
/** Расширение поверхности; `core/…` — ядро, выключению не подлежит (§Б8-3). */
export function surfaceExtensionOf(surface: string): ExtensionId | null {
  const head = surface.split('/')[0] ?? '';
  return (EXTENSION_IDS as readonly string[]).includes(head) ? (head as ExtensionId) : null;
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
  'core/agenda': 'agenda',
  'finance/budget-overview': 'budget',
} as const satisfies Readonly<Record<SurfaceName, string>>;

/**
 * Своя карточка аспекта (спека 1б §4.1, §8.5): компонент web показывает запись с этим аспектом, а
 * `rank` — её место в `{{cards: own}}`. Ранг принадлежит КАРТОЧКЕ, а не аспекту: карточка
 * исполнителя ранжируется своим рангом, по какому бы аспекту она ни показывалась.
 */
export interface OwnCardDecl {
  aspect: string;
  rank: number;
}

/**
 * Манифест расширения (спека 1б §4.1; сменяет `ModuleManifest` §Б8-1) — всё, чего НЕТ в колонке
 * `module` строк реестров. Реестровая половина состава (свойства, аспекты, роли) уже размечена
 * данными и здесь не дублируется: два списка одного состава разошлись бы на первой новой строке.
 * «Реализует» по той же причине не объявляется — оно выводится из `implements` аспектов расширения.
 */
export interface ExtensionManifest {
  id: ExtensionId;
  /** Подпись расширения — экран «Приложения и расширения» (задача 22) и тексты отказов. */
  name: LocalizedText;
  /** Эмодзи плитки расширения. */
  icon: string;
  /** Что расширение приносит — строка карточки на экране «Приложения и расширения». */
  description: LocalizedText;
  tools: readonly string[]; // core-тулы; attach_* — из aspect.module
  promptFragments: readonly { id: string; text: string }[]; // политика-проза расширения
  surfaces: readonly SurfaceName[];
  /**
   * «Читает» контракты — ОБЪЯВЛЕНИЕ без проверки (спека §15: проверка придёт с первым
   * расширением не из поставки, пока читатель и автор — один код поставки).
   */
  reads: readonly string[];
  /** Свои карточки аспектов расширения с рангом (§4.1). */
  cards: readonly OwnCardDecl[];
  codeRemainder: readonly { where: string; why: string }[]; // вход метрики отчёта §С1-4
}

/**
 * Блок «Бюджет» — ДОСЛОВНО четыре строки `llm/prompts/v5.ts:83-86`. `spend_class` в нём —
 * ключ ОТВЕТА тула `budget_status`, и тот же текст стоит в описании тула
 * (деф тула `budget_status` в `tools/registry.ts`): правка одной стороны развела бы
 * фрагмент с описанием.
 */
const FIN_BUDGET_TEXT =
  'Бюджет (тул budget_status):\n- Финансовые вопросы — «что по бюджету?», «могу позволить X?», остатки конвертов, распределение бюджета — решай вызовом budget_status: он возвращает готовые агрегаты месяца (конверты со spent/remaining/dailyPace, баланс, comingUp, planned, unbudgeted) и spend_class категорий. Не пересчитывай эти агрегаты вручную через entity_query/user_query.\n- Свободные деньги («могу позволить?»): сумма remaining конвертов категорий со spend_class=discretionary МИНУС будущие planned-оттоки — записи planned и comingUp из budget_status, брать только direction=expense: доходные инстансы (например, будущую зарплату из comingUp) НЕ вычитай. Будущие recurring-платежи УЖЕ входят туда как planned-инстансы — НЕ суммируй recurring отдельно: это двойной вычет.\n- Категорию без spend_class не включай в расчёт молча — явно попроси пользователя классифицировать её (fixed/discretionary).';

const FINANCE_FRAGMENTS = [
  {
    id: 'finance/amounts',
    text: 'Деньги (расширение «Финансы»):\n- Денежные суммы — decimal-строки с двумя знаками после точки ("500.00"), никогда числа с плавающей точкой.\n- orbis/finance_category — только uuid реально существующей категории: найди её через entity_query. Не подставляй выдуманный uuid.\n- Категорию резолви по синонимам: «aspect=orbis/category, orbis/aliases=такси» (резолв категории по синониму: aliases — список, фильтр ищет точное вхождение — регистр важен, синонимы строчные).',
  },
  {
    id: 'finance/one-intent',
    text: '- Деньги на той же сущности: «оплатить страховку 12000 до пятницы» = одна сущность с аспектами orbis/task и orbis/financial и свойствами orbis/task_status, orbis/due_date, orbis/amount, orbis/direction, orbis/finance_category, orbis/planned=true, orbis/occurred_on — а НЕ отдельная задача плюс отдельная трата.',
  },
  { id: 'finance/budget', text: FIN_BUDGET_TEXT },
] as const;

/**
 * Проза Целей (спека 1б §8.2): блок «Цели и горизонты» промпта v7 разделён — две строки о целях
 * ДОСЛОВНО из `llm/prompts/v7.ts:66-67` (их гарды — валидатор записи `orbis/goal`, описание тула
 * `attach_orbis_goal` — стоят в `v8.test.ts` на этом фрагменте), третья — целевая часть строки
 * «Спланируй неделю…» (`v7.ts:69`) для всех трёх её фраз: план недели и вопрос о годе включают цели. Горизонты по страницам хоста остались в теле v8 (Н-7): они не
 * принадлежат расширению и не гаснут вместе с ним.
 */
const GOALS_FRAGMENTS = [
  {
    id: 'goals/goals',
    text: 'Цели (расширение «Цели»):\n- Измеримая цель пользователя («накопить 300 000», «прочитать 24 книги», «вес 80 кг») — ОДНА сущность с аспектом orbis/goal: orbis/target_value — целевое число decimal-строкой, orbis/progress_source — откуда берётся факт (query — ДЕРЕВО запроса по графу, такое же, как во входе ast тула entity_query, плюс aggregate: sum, count или latest). Какие ключи требует каждый вариант aggregate — в описании тула attach_orbis_goal; не угадывай их состав.\n- orbis/current_value НЕ заполняй никогда: прогресс цели считает сервер, обходя граф запросом из orbis/progress_source при каждом чтении.\n- «Спланируй неделю», «как идут цели», «что у меня на год» — цели смотри тоже: entity_query с aspect=orbis/goal, и только потом предлагай. Не заводи дубли уже существующих целей: найденное правь, а не создавай заново.',
  },
] as const;

export const EXTENSION_MANIFESTS: Readonly<Record<ExtensionId, ExtensionManifest>> = {
  finance: {
    id: 'finance',
    name: { ru: 'Финансы', en: 'Finance' },
    icon: '💰',
    description: {
      ru: 'Расходы и доходы, категории, конверты бюджета и импорт выписок',
      en: 'Expenses and income, categories, budget envelopes and statement import',
    },
    tools: ['budget_status', 'budget_rollover', 'import_csv_start'],
    promptFragments: FINANCE_FRAGMENTS,
    surfaces: ['finance/budget-overview'],
    // Контракты языка (Р-7): Финансы их реализуют своими аспектами и читают в движке бюджета,
    // но не владеют ими — `module: null` у обоих.
    reads: ['orbis/money-movement', 'orbis/envelope'],
    // Ранг 50 — последней, как в снимке 1а (РП-23): цель 10, ядро 20–40, финансы 50.
    cards: [{ aspect: 'orbis/financial', rank: 50 }],
    codeRemainder: [
      {
        where: 'apps/server/src/routers/{budget,import}.ts',
        why: 'tRPC-ручки Финансов — код, а не данные реестра: их обходы маски (план → факт, проводка плановых, импорт) закрыты своими гейтами в коде (срез 1б, задача 7; §Б8-3 ревизия 7), экраны гейтит web',
      },
      {
        where: 'packages/shared/src/fast-path/index.ts',
        why: 'клиентский fast-path денег — код-остаток клиента, гейтится web (Б-3)',
      },
    ],
  },
  // Цели, Проекты, Разработка: реестровый состав размечен колонкой `module`; тулов у них нет,
  // фрагмент есть только у Целей — строки о целях из тела промпта (v8, спека 1б §8.2).
  goals: {
    id: 'goals',
    name: { ru: 'Цели', en: 'Goals' },
    icon: '🎯',
    description: {
      ru: 'Измеримые цели с прогрессом, который считается по записям графа',
      en: 'Measurable goals whose progress is computed from the records of the graph',
    },
    tools: [],
    promptFragments: GOALS_FRAGMENTS,
    surfaces: [],
    reads: [],
    // Ранг 10 — первой, как в снимке 1а (РП-23).
    cards: [{ aspect: 'orbis/goal', rank: 10 }],
    codeRemainder: [],
  },
  projects: {
    id: 'projects',
    name: { ru: 'Проекты', en: 'Projects' },
    icon: '📁',
    description: {
      ru: 'Проекты со стадиями и иерархия работы под ними',
      en: 'Projects with stages and the hierarchy of work beneath them',
    },
    tools: [],
    promptFragments: [],
    surfaces: [],
    reads: [],
    cards: [],
    codeRemainder: [],
  },
  dev: {
    id: 'dev',
    name: { ru: 'Разработка', en: 'Development' },
    icon: '🛠️',
    description: {
      ru: 'Репозитории кода, над которыми работает исполнитель',
      en: 'Code repositories the executor works on',
    },
    tools: [],
    promptFragments: [],
    surfaces: [],
    reads: [],
    cards: [],
    codeRemainder: [],
  },
};

/**
 * Свои карточки ЯДРА (спека 1б §4.1): исполнитель, рутина, прогон. Живут у хоста, а не в манифесте:
 * их аспекты — ядро, выключать их нечему. Ранги — между целью (10) и финансами (50), чтобы
 * `{{cards: own}}` воспроизводил порядок снимка 1а (РП-23).
 */
export const HOST_OWN_CARDS: readonly OwnCardDecl[] = [
  { aspect: 'orbis/assignment', rank: 20 },
  { aspect: 'orbis/routine', rank: 30 },
  { aspect: 'orbis/agent-run', rank: 40 },
];

/**
 * Порядок `{{cards: own}}` (спека §8.5): карточки ядра и ВСЕХ расширений по рангу. Выключенные здесь
 * не отсеиваются намеренно: выключенное расширение показывает карточку только для чтения с плашкой
 * (§8.3), а не прячет её, — отсев по маске был бы решением вызывающего, а не порядка.
 */
export function ownCardOrder(): readonly OwnCardDecl[] {
  return [...HOST_OWN_CARDS, ...EXTENSION_IDS.flatMap((id) => EXTENSION_MANIFESTS[id].cards)].sort(
    (a, b) => a.rank - b.rank,
  );
}

/**
 * Подпись расширения для текстов отказов и заголовков журнала. id вне словаря (устаревший элемент
 * маски — колонка text[] без CHECK) возвращается как есть: подпись нужна человеку, и молча
 * подставить чужую было бы хуже, чем показать id.
 */
export function extensionName(id: string, locale = 'ru'): string {
  return (EXTENSION_IDS as readonly string[]).includes(id)
    ? effectiveLabel(EXTENSION_MANIFESTS[id as ExtensionId].name, locale)
    : id;
}

/** Ядро (`module: null`) не выключается никогда (§Б8-2) — отсюда обе ветки на «нет расширения». */
export function isExtensionEnabled(
  module: string | null | undefined,
  disabled: readonly string[],
): boolean {
  return module === null || module === undefined || !disabled.includes(module);
}

/**
 * Расширение тула: `attach_*` — по колонке `module` его АСПЕКТА, `action_*` — по колонке `module`
 * его ДЕЙСТВИЯ (§Б6-6, Р-20: двенадцатая точка маски), core-тул — по манифесту. Ответ — ТОЛЬКО
 * значение словаря (спека §8.2): id вне словаря дал бы «неизвестный тул» вместо `MODULE_DISABLED`.
 * Тула вне всех источников (ядро) здесь нет по построению — ответ `null`.
 */
export function extensionOfTool(
  name: string,
  reg: {
    aspects: ReadonlyMap<string, AspectDefinition>;
    /** §Б6-6: действия публикуются тулами `action_*`; расширение читается из ИХ строки. */
    actions?: ReadonlyMap<string, { key: string; module: string | null }>;
  },
): ExtensionId | null {
  // attach_* адресуется КЛЮЧОМ аспекта, и обратная нормализация имени невозможна («-» и «/»
  // склеиваются в «_» — докблок `attachToolName`), поэтому идём вперёд от ключей.
  if (name.startsWith('attach_')) {
    for (const a of reg.aspects.values()) {
      if (attachToolName(a.key) === name) return EXTENSION_IDS.find((m) => m === a.module) ?? null;
    }
    return null;
  }
  if (isActionToolName(name)) {
    // Вперёд от ключей — по тому же доводу, что у attach_*: нормализация имени необратима. Имя —
    // общим предикатом, а не префиксом: реестровые `action_set`/`action_remove` (задача 10) — ядро.
    for (const a of reg.actions?.values() ?? []) {
      if (actionToolName(a.key) === name) return EXTENSION_IDS.find((m) => m === a.module) ?? null;
    }
    return null;
  }
  for (const id of EXTENSION_IDS) if (EXTENSION_MANIFESTS[id].tools.includes(name)) return id;
  return null;
}

/**
 * Проза ВКЛЮЧЁННЫХ расширений одной секцией канала (§Б8-3) — `null`, когда включённым расширениям
 * сказать нечего: пустая секция в канале выглядела бы для модели оборванным заголовком.
 */
export function extensionPromptFragments(disabled: readonly string[]): string | null {
  const texts = EXTENSION_IDS.filter((m) => isExtensionEnabled(m, disabled)).flatMap((m) =>
    EXTENSION_MANIFESTS[m].promptFragments.map((f) => f.text),
  );
  return texts.length === 0 ? null : texts.join('\n');
}

/**
 * Расширения, которые владелец вправе переключать, — ВСЕ четыре (П0, спека 1б §8.6). Условия
 * Ф-Б1-57б выполнены задачами 6 и 7: проза промпта расширения живёт во фрагментах манифеста и
 * гаснет с ним (задача 6), а поля выключенного расширения — только чтение, его шаблоны повторов
 * отсеиваются, рутины из его тулов пропускаются (задача 7). До этого выключение давало бы
 * половину: реестр снялся бы, а проза продолжала бы учить модель, и поля правились бы мимо плашки.
 * Отдельным именем, а не `EXTENSION_IDS` напрямую: вход операции — провод, и расширение, которое
 * однажды окажется непереключаемым, выпадет отсюда, не трогая словаря.
 */
export const SWITCHABLE_EXTENSION_IDS = EXTENSION_IDS satisfies readonly ExtensionId[];

/**
 * Схема входа объявлена ЗДЕСЬ: её читают и ручка `user.setModuleEnabled`, и стадия 1
 * исполнителя. Два «похожих» описания одной операции разъехались бы — тот же довод, что в
 * докблоке `registryMutation` (`routers/registry.ts`, `registryMutation`). Поле провода —
 * `module`, как и имя операции журнала `module_set` (РП-10): их хранят записи журнала.
 */
export const setExtensionEnabledInput = z
  .object({ module: z.enum(SWITCHABLE_EXTENSION_IDS), enabled: z.boolean() })
  .strict();
