#!/usr/bin/env bun
// biome-ignore-all lint/complexity/noUselessStringRaw: маркеры ниже переносятся между спекой,
// планом и кодом ДОСЛОВНО, поэтому все до одного обёрнуты в String.raw — включая те, где
// сегодня нет escape-последовательности. В обычном шаблонном литерале дописанный `\b`
// стал бы символом backspace, маркер перестал бы совпадать с чем-либо, и гейт молча
// показал бы ноль — тот самый отказ, против которого он написан.
/**
 * Греп-гейт старой формы данных — §А12-2 спеки «Реформа свойств», приёмка §С8-10.
 *
 * Приёмка среза требует «ноль совпадений» по маркерам старой формы (пути `aspects->`,
 * алиас `due=`, неквалифицированные имена полей в тексте запроса, обращения к колонке
 * `meta` сущности и прочее). Держать такую проверку в голове нельзя: она проверяется
 * ОДИН раз в конце среза, а нарушается по одной строке в каждой из двадцати задач.
 *
 * Почему источник — `git grep`, а не grep(1). Это ЗАМЕРЕНО, а не выведено. Файл
 * `apps/server/src/budget/aggregates.ts` содержал два литеральных NUL-байта в шаблонных
 * строках (ключи сортировки, строки :904-905 на момент написания). Реализация grep,
 * встречающая NUL, вправе объявить файл двоичным — и тогда 51 строка `aspects->` в нём
 * не попадает в приёмку вовсе.
 *
 * Оговорка: поведение зависит от РЕАЛИЗАЦИИ, и обобщать замер на «любой grep» нельзя.
 * Три замера на до-правочном блобе одного и того же файла:
 *  • ugrep 7.8.4 (то, чем `grep` оказался в оболочке разработчика) — НОЛЬ строк и молча,
 *    без пометки «Binary file matches»: при отсутствии текстовых совпадений печатать нечего;
 *  • стоковый /usr/bin/grep (BSD grep 2.6.0-FreeBSD) — находит все 51 строку;
 *  • GNU grep — печатает «Binary file … matches», то есть не молчит, но и строк не даёт.
 * Вывод для гейта тот же: закладываться на то, какой grep окажется у запускающего (и в
 * образе CI), нельзя — поэтому источник совпадений фиксирован `git grep` с флагами ниже.
 *
 * Флаги git grep здесь выбраны так:
 *  • `-a` (--text) — файлы с NUL-байтами сопоставляются как текст. Это страховка на
 *    будущее, а не только на `aggregates.ts`: NUL может появиться снова (ключ сортировки
 *    с разделителем — приём, который в этой кодовой базе уже применялся трижды).
 *  • `-I` (пропускать двоичные) сознательно НЕ ставится. Замер: на `aggregates.ts` он не
 *    менял ничего — git считает файл двоичным по первым 8000 байтам, а NUL-байты лежали
 *    на 904-й строке, далеко за этой границей, поэтому `git grep -nI` находил там все 51
 *    строку. Но стоит NUL'у оказаться в начале файла — `-I` выбросит его целиком и так
 *    же молча. Гейт не должен зависеть от того, в какой трети файла стоит байт.
 *  • `-P` (PCRE2) — маркеры пишутся в синтаксисе JS-регулярок (`\s`, `\b`, `(?:)`), и
 *    ТОТ ЖЕ текст маркера ниже перепроверяется движком JS. POSIX-ERE (`-E`) не знает
 *    `\b`: `git grep -naE '\bdue='` по дереву даёт 0 строк там, где PCRE даёт 3, то есть
 *    гейт был бы зелёным по причине, не имеющей отношения к коду.
 *
 * Оборотная сторона `git grep`: он видит только ЗАРЕГИСТРИРОВАННЫЕ файлы. Новый файл,
 * который ещё не `git add`нут, гейт не проверит — локально это стоит помнить, в CI
 * безразлично (там дерево checkout'а целиком в индексе).
 *
 * Отсев не-исходников сделан pathspec'ом, а не постфильтром: миграции (`db/migrations`)
 * содержат старую форму по определению — они её и создали, переписывать накаченный SQL
 * нельзя; снапшоты (`*.snap`) — производные файлы.
 *
 * Двойная фильтрация (git grep → JS-регулярка) не избыточность: `exclude`-формы
 * (`import.meta` и соседи) вырезаются на стороне JS, и чтобы «строк» в отчёте означало
 * ровно «строк, где маркер сработал по правилам этого файла», совпадение git'а
 * перепроверяется тем же движком, что применяет исключения.
 *
 * Запуск:
 *   bun scripts/check-legacy-form.ts          — отчёт «маркер → файлов/строк», код 0 всегда;
 *   bun scripts/check-legacy-form.ts --gate   — код 1 при любом совпадении вне allowlist.
 *
 * Сейчас (срез А) гейт стоит в режиме отчёта: маркеры описывают форму, которую срез
 * ПЕРЕВОДИТ, и до конца перевода совпадения законны. Падающим (`--gate` в CI) он
 * становится Задачей 23 — тогда же наполняется allowlist.
 */

/** Пути, внутри которых ищется старая форма. Формат — git pathspec, `:!` — исключение. */
export const SEARCH_PATHSPEC: readonly string[] = [
  'apps/server/src',
  'apps/server/test',
  'apps/server/perf',
  'packages/shared/src',
  'apps/web/src',
  'scripts',
  ':!*.snap',
  ':!apps/server/src/db/migrations/**',
];

export type LegacyMarker = {
  /** Имя маркера. На него ссылаются брифы задач среза — переименование ломает ссылки. */
  readonly id: string;
  /** Текст регулярки: отдаётся в `git grep -P` и перепроверяется движком JS. */
  readonly pattern: string;
  /**
   * Формы, которые из строки вырезаются ПЕРЕД перепроверкой маркера. Именно вырезаются,
   * а не «строка со словом X целиком не считается»: правило «содержит — пропустить»
   * ослепило бы гейт на строке, где рядом с законным `relations.meta` стоит настоящее
   * обращение к колонке сущности.
   */
  readonly exclude?: readonly RegExp[];
};

/**
 * СТРОКА, КОТОРАЯ ЦЕЛИКОМ КОММЕНТАРИЙ, — не использование формы, а объяснение того, чего
 * больше нет, и маркеры снятых носителей её не считают.
 *
 * Почему это не поблажка. Три маркера ниже (`aspects-legacy`, `relation-type`,
 * `entity-meta`) описывают то, чего в базе НЕТ с contract-миграции 0017: колонки сняты, и
 * вернуть их можно только новой миграцией. А объяснять удалённое надо ТАМ, ГДЕ ЕГО БОЛЬШЕ
 * НЕТ, — иначе следующий читатель не узнает, почему `rel_uniq` стоит на роли, почему у
 * связи мешок `meta` есть, а у сущности нет, и почему бюджет считает одну роль. Запрет
 * называть снятое по имени сделал бы докблоки лживыми — самая дорогая цена из возможных.
 *
 * Маркер при этом ловит ИМЯ, ВЕРНУВШЕЕСЯ В КОД: импорт, вызов, поле, SQL-строку, хвостовой
 * комментарий рядом с кодом. Снимается только строка, которая КОММЕНТАРИЙ ЦЕЛИКОМ —
 * `//`, `*`, `/*` либо SQL-ное `--` в начале (внутри шаблонных литералов SQL комментарии
 * пишутся так). Тот же приём и тот же довод, что у маркера `legacy-grammar`, где он
 * заведён Задачей 21b.
 */
const COMMENT_ONLY_LINE = /^\s*(?:\/\/|\*|\/\*|--).*$/;

export const LEGACY_MARKERS: ReadonlyArray<LegacyMarker> = [
  { id: 'aspects-path', pattern: String.raw`aspects(_legacy)?\s*->` },
  // `aspectsMap` — имя старой карты в WIRE-форме, снято Задачей 13c;
  // `aspects_legacy`/`aspectsLegacy` — имя КОЛОНКИ, снятой contract-миграцией 0017;
  // `legacy-form` — модуль проекции, удалённый там же. Ни одного из трёх в коде больше нет,
  // и маркер обязан давать НОЛЬ вне allowlist навсегда: имя, вернувшееся в код, означает
  // воскресшую вторую запись тех же значений. Маркер `->>'` из §А12-2 НЕ заводится: после
  // перевода `props->>'orbis/…'` — законная форма доступа, а старую форму целиком покрывает
  // `aspects(_legacy)?\s*->`.
  {
    id: 'aspects-legacy',
    pattern: String.raw`aspects_legacy|aspectsLegacy|aspectsMap|legacy-form`,
    exclude: [COMMENT_ONLY_LINE],
  },
  {
    id: 'relation-type',
    pattern: String.raw`relation_type|relationType|RELATION_TYPES`,
    exclude: [COMMENT_ONLY_LINE],
  },
  // entity-meta — АДРЕСУЕМОЕ имя снятой колонки, и только оно. Голое `\bmeta\b` по этим же
  // путям давало 281 совпадение — гейт на 281 строке неисполним.
  //
  // Задача 23b сузила маркер, и вот замер, по которому: три ветки-эвристики
  // (`meta: {}`, `meta: (row|input|values).meta`, `input.meta`) на рабочем дереве давали
  // 13 совпадений, из которых НАСТОЯЩИМ было ОДНО (`executor.ts:1577`, писатель
  // `entities.meta`, снят этой же задачей). Остальные 12 — мешок СВЯЗИ: `toWireRelation`
  // (`wire.ts`), фикстуры связей web (`detail.test.tsx` ×6, `Blocks.test.tsx`), payload
  // связи (`relations.test.ts`) и два положительных контроля стража web. Различить связь и
  // сущность построчно нельзя — ключ один и тот же, а признак (`sourceId`) стоит соседней
  // строкой; ветки ловили форму, а не смысл, и промахивались двенадцать раз из тринадцати.
  //
  // Чем закрыт класс, который они пытались ловить, после сноса колонки:
  //  • `apps/web/src/test/fixtures.test.ts` — страж «мешок `meta` только у СВЯЗЕЙ», разбор по
  //    соседству (окно ±8 строк, признак `sourceId`) с положительными контролями правила:
  //    он решает ровно ту задачу, которая построчному грепу не по силам;
  //  • на сервере — типы: после 0017 в `db/schema.ts` у `entities` колонки `meta` нет,
  //    поэтому `meta:` во вставке сущности не компилируется, а не «ускользает от маркера».
  // Маркеру остаётся то, что однозначно: адресация колонки и имя её индекса.
  //
  // ДВЕ ФОРМЫ ИМЕНИ, а не `entities?`: прежняя запись `entities?\.meta` раскрывалась как
  // «entitie» плюс необязательная «s» и не совпадала с `entity.meta` — то есть с самой
  // естественной формой обращения в JS. Индекс тоже назван обеими: в `0001:104` он
  // `entities_meta_gin`, а прежний маркер искал `entity_meta_gin` и не нашёл бы его.
  {
    id: 'entity-meta',
    pattern: String.raw`entit(?:y|ies)\.meta\b|entit(?:y|ies)_meta_gin`,
    exclude: [COMMENT_ONLY_LINE, /import\.meta/, /relations?\.meta/, /\bmetadata\b/],
  },
  { id: 'due-alias', pattern: String.raw`\bdue=` },
  // Голое имя поля в тексте запроса — и в `{{query:}}`, и в строковых литералах web
  // (useAgenda/txQuery/browser/query). Сам по себе `aspect=` маркером НЕ является:
  // `aspect=orbis/…` — законная конструкция канона (§А5-3в, §А5-7); ловится только
  // неквалифицированное имя поля ПОСЛЕ него.
  //
  // `(?<![/\w])`, а НЕ `\b` перед именем поля, и это замер, а не вкус (долг 12 ветки).
  // В PCRE и в JS `/` — граница слова, поэтому `\bstatus=` совпадал ВНУТРИ
  // `orbis/task_status=`, `\bdirection=` — внутри `orbis/direction=`, то есть маркер
  // считал нарушением ровно ту key-форму, ради которой он написан. Замер на рабочем
  // дереве: `\b` — 130 строк, из них 127 содержат `orbis/`; `(?<![/\w])` — 65. Разница
  // не в строгости, а в правде: 65 — это места, где имя поля стоит БЕЗ неймспейса.
  // Отрицательный lookbehind запрещает перед именем и `/` (квалификатор канона), и любой
  // словесный символ (хвост `task_status=`, `planned_amount=`).
  {
    id: 'bare-field',
    pattern: String.raw`(\{\{query:|aspect=|sortBy=)[^}'"\n]*(?<![/\w])(status|stage|priority|kind|scope|outcome|undecided|due_date|start_at|occurred_on|planned|amount|direction|category_ref)=`,
  },
  // Парсер заголовка правила УДАЛЁН (Задача 18, В7): образец и цель уехали в свойства
  // (`orbis/rule_pattern`, `orbis/rule_target`), заголовок стал генерируемой подписью.
  // Маркер с этого момента обязан давать НОЛЬ вне allowlist — и это проверяется по
  // рабочему дереву (`check-legacy-form.test.ts`), а не только на синтетике.
  // `rulePatternFromTitle` переехала в `server/memory/rules.ts` под честным именем
  // `patternFromTransactionTitle` (она про заголовок ТРАНЗАКЦИИ) — маркером не является;
  // `formatRuleLabel` — новая генерация подписи, тоже не она.
  { id: 'rule-parser', pattern: String.raw`parseRuleTitle|formatRuleTitle` },
  { id: 'pseudo-aspect', pattern: String.raw`ENTITY_PSEUDO_ASPECT|'orbis/entity'` },
  { id: 'service-const', pattern: String.raw`SERVICE_ASPECT_IDS` },
  { id: 'prop-type-heur', pattern: String.raw`\bpropType\(` },
  // Старая плоская грамматика §6.1 УДАЛЕНА Задачей 21b целиком: четыре модуля
  // (`grammar`/`parse`/`serialize`/`legacy-bridge`), их тесты, `buildFieldCatalog` и
  // эвристика `propType`. Маркер ловит и ИМПОРТ несуществующего модуля, и любое из имён,
  // которые он отдавал: имя, вернувшееся в код, означает воскресшую вторую грамматику, а
  // единственный текст запроса с этого момента — key-форма канона (§А5-3).
  //
  // Обязан давать НОЛЬ вне allowlist НАВСЕГДА, и это проверяется по РАБОЧЕМУ дереву
  // (`check-legacy-form.test.ts`), а не только на синтетике: закрытая дверь, а не счётчик.
  {
    id: 'legacy-grammar',
    pattern: String.raw`query/(grammar|serialize|legacy-bridge)|\bparseQueryAny\b|\bserializeQuery\b|\bbuildFieldCatalog\b|\blegacyAstToQueryAst\b|\blegacyCatalogFromRegistry\b`,
    // КОММЕНТАРИИ СНЯТЫ, и это не поблажка. Удалённое надо объяснять там, где его больше
    // нет: докблоки `parse-text.ts`, `bind-query.ts`, `catalog.ts` и обоих баррелей
    // называют мост и старые модули поимённо — иначе следующий читатель не узнает, почему
    // форма текста ровно одна. Маркер ловит ИМЯ, ВЕРНУВШЕЕСЯ В КОД: импорт, вызов, экспорт.
    // Снимается строка, КОТОРАЯ ЦЕЛИКОМ комментарий (начинается с `//`, `*` или `/*`), а не
    // всякая, где комментарий встретился: код с хвостовым `// …` остаётся под гейтом.
    exclude: [/^\s*(?:\/\/|\*|\/\*).*$/],
  },
];

export type AllowEntry = {
  /** Путь от корня репозитория, ровно как его печатает `git grep`. */
  readonly path: string;
  /**
   * Маркеры, по которым файл снят. Не указан — снят по ВСЕМ (так заведены две записи самого
   * гейта: в них дословно перечислены все маркеры сразу).
   *
   * Список нужен, чтобы поблажка была РОВНО по размеру повода. Сьют на четыре тысячи строк,
   * снятый целиком ради одного утверждения «этого ключа в карточке нет», перестал бы
   * проверяться по остальным десяти маркерам — и первая же вернувшаяся туда старая форма
   * прошла бы молча.
   */
  readonly markers?: readonly string[];
  /** Почему совпадения в этом файле законны. Без причины запись не заводится. */
  readonly reason: string;
};

/**
 * Файлы, совпадения в которых не считаются нарушением.
 *
 * Запись снимает файл по перечисленным маркерам (без списка — по всем), поэтому отчёт
 * печатает, сколько строк сняла каждая: растущее число видно глазом и требует объяснения.
 *
 * ЧТО СЮДА ПОПАДАЕТ — ровно три класса, и у каждого своё основание:
 *  1. ЗАМОРОЖЕННЫЙ АРТЕФАКТ. Промпты `v1…v4`, `routine-v1/v2` и их `.fixture.txt` — снимки
 *     того, что модель ВИДЕЛА; их текст не правится ни байтом (РП-18), иначе снимок
 *     перестаёт быть снимком. Туда же — прод-тела владельца в `onboarding.test.ts` и
 *     golden-корпус вердиктов: оба заморожены как ВХОД, а не как образец сверки.
 *  2. УТВЕРЖДЕНИЕ ОБ ОТКАЗЕ. Тест, который пишет старую форму и требует на неё ошибку,
 *     обязан содержать её дословно — иначе он проверяет не то, что называет.
 *  3. САМ ГЕЙТ И ЕГО ТЕСТ: маркеры перечислены в них дословно.
 *
 * Чего здесь НЕТ и быть не должно: боевого кода. Ни одной записи на продуктовые каталоги,
 * кроме замороженных промптов, — поблажка продукту означала бы, что форма жива.
 */
const FROZEN_PROMPTS = [
  'v1',
  'v1.fixture',
  'v2',
  'v2.fixture',
  'v3',
  'v3.fixture',
  'v4',
  'v4.fixture',
  'routine-v1',
  'routine-v1.fixture',
  'routine-v2',
  'routine-v2.fixture',
] as const;

export const ALLOWLIST: ReadonlyArray<AllowEntry> = [
  {
    path: 'scripts/check-legacy-form.ts',
    reason: 'сам гейт: маркеры перечислены в нём дословно, иначе он находит собственный список',
  },
  {
    path: 'scripts/check-legacy-form.test.ts',
    reason: 'тест гейта: образцы старой формы в нём — предмет проверки, а не нарушение',
  },
  {
    path: 'scripts/legacy-aspects-map.test.ts',
    reason:
      'страж старой карты в фикстурах: образец формы и его allowlist перечислены дословно — ' +
      'иначе он находит сам себя (тот же случай, что у гейта выше)',
  },

  // --- 1. Замороженные артефакты ---------------------------------------------------------
  ...FROZEN_PROMPTS.map((name) => ({
    path: `apps/server/src/llm/prompts/${name}.${name.endsWith('.fixture') ? 'txt' : 'ts'}`,
    markers: ['bare-field'] as const,
    reason:
      'замороженный снимок промпта (РП-18): его текст — то, что модель ВИДЕЛА, и правка ' +
      'любого байта делает снимок не снимком; шпаргалка грамматики в нём голая по построению',
  })),
  {
    path: 'apps/server/src/llm/prompts/v4.test.ts',
    markers: ['bare-field'],
    reason:
      'снимок примеров v4 ДОСЛОВНО (`expect(...).toContain`): формы старые намеренно — ' +
      'таким v4 и был, и правка примера обязана быть видимым движением в диффе',
  },
  {
    path: 'apps/server/src/llm/prompts/v5.test.ts',
    markers: ['bare-field'],
    reason:
      'гард смены линейки: цитирует строки v4 (их в v5 быть не должно) и утверждает ОТКАЗ ' +
      'разбора голых имён — обе половины требуют старой формы дословно',
  },
  {
    path: 'apps/server/src/llm/prompts/routine-v3.test.ts',
    markers: ['bare-field'],
    reason: 'то же, что у v5.test.ts, для линейки рутин: цитата routine-v2 плюс отказ разбора',
  },
  {
    path: 'apps/server/src/seed/onboarding.test.ts',
    markers: ['bare-field'],
    reason:
      'прод-тела владельца, замороженные как ВХОД бэкфилла D42 (дословно из `696dda3`): ' +
      'подогнать их под сегодняшний сид нельзя — в базе лежит именно эта строка, и именно ' +
      'на ней бэкфилл обязан сработать один раз',
  },
  {
    path: 'apps/server/perf/explain.test.ts',
    markers: ['aspects-legacy', 'entity-meta'],
    reason:
      'приёмка «EXPLAIN против 0017»: `DROPPED_BY_0017` перечисляет СНЯТЫЕ индексы дословно ' +
      '— иначе утверждение «вердиктные индексы в DROP-список не входят» проверять не с чем',
  },
  {
    path: 'apps/server/test/golden/validator-verdicts.json',
    markers: ['bare-field'],
    reason:
      'golden-корпус вердиктов, замороженный Задачей 23a: он собран ДО перевода и по другим ' +
      'источникам, поэтому правка входа обессмысливает сверку',
  },

  // --- 2. Утверждения об отказе -----------------------------------------------------------
  {
    path: 'packages/shared/src/query/ast-fixtures.ts',
    markers: ['bare-field'],
    reason:
      'опись боевых текстов ДО реформы: у каждой записи `verdict: UNKNOWN_FIELD` — это ' +
      'фикстуры ОТКАЗА разбора, и старая форма в них предмет проверки',
  },
  {
    path: 'apps/web/src/lib/query-blocks/parse.test.ts',
    markers: ['bare-field'],
    reason: 'проба «голое имя поля → UNKNOWN_FIELD»: форма отказа пишется дословно',
  },
  {
    path: 'apps/server/src/tools/dispatch.test.ts',
    markers: ['bare-field', 'aspects-legacy'],
    reason:
      'entity_query со старым именем поля → ошибка с именем в тексте; список ключей, которых ' +
      'в карточке НЕТ, называет `aspectsMap` дословно',
  },
  {
    path: 'apps/server/src/executor/legacy-input-rejected.test.ts',
    markers: ['aspects-legacy'],
    reason:
      'приёмка §С8-10 п.13: старая карта на входе → VALIDATION, и вторая половина — греп ' +
      'по дереву на отсутствие снятого модуля; оба имени пишутся дословно',
  },
  {
    path: 'apps/server/src/wire.test.ts',
    markers: ['aspects-legacy'],
    reason: 'утверждение «`aspectsMap` в wire-форме НЕТ» — имя ключа называется дословно',
  },
  {
    path: 'apps/server/src/export.test.ts',
    markers: ['aspects-legacy'],
    reason: 'то же утверждение для формы экспорта',
  },
  {
    path: 'apps/server/src/agent-loop/verbs.test.ts',
    markers: ['aspects-legacy'],
    reason: 'то же утверждение для замороженного снимка wire-формы прогона (§7.8)',
  },
  {
    path: 'apps/web/src/test/fixtures.test.ts',
    markers: ['aspects-legacy'],
    reason: 'страж web «старой карты в фикстурах нет»: искомая подстрока — само имя',
  },
  {
    path: 'apps/server/test/e2e.slice1a.test.ts',
    markers: ['relation-type'],
    reason: 'утверждение «`relationType` в wire-форме связи НЕТ» — имя поля называется дословно',
  },
  {
    path: 'packages/shared/src/contracts/tools.test.ts',
    markers: ['relation-type'],
    reason: 'контракт ребра принимает `role` и ОТВЕРГАЕТ `relation_type` — имя в предмете проверки',
  },
];

export type Hit = {
  readonly marker: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

export type MarkerReport = {
  readonly id: string;
  /** Совпадения вне allowlist — то, что считает приёмка. */
  readonly hits: readonly Hit[];
  /** Файлы (уникальные) из `hits`. */
  readonly files: readonly string[];
  /** Снято `exclude`-формами маркера. */
  readonly excluded: number;
  /** Снято allowlist'ом, по записям. */
  readonly allowed: ReadonlyMap<string, number>;
};

/** Снят ли файл по ЭТОМУ маркеру (запись без списка маркеров снимает по всем). */
function allowedFor(path: string, marker: string): boolean {
  return ALLOWLIST.some(
    (e) => e.path === path && (e.markers === undefined || e.markers.includes(marker)),
  );
}

/** Метка-заглушка вместо вырезанной `exclude`-формы: не буква и не цифра, границы слов не рвёт. */
const MASK_CHAR = '\u0001';

function maskExcluded(line: string, excludes: readonly RegExp[]): string {
  let masked = line;
  for (const ex of excludes) {
    // Длина сохраняется: маска не должна склеивать соседние куски строки в новое совпадение.
    masked = masked.replace(new RegExp(ex.source, `${ex.flags.replace('g', '')}g`), (m) =>
      MASK_CHAR.repeat(m.length),
    );
  }
  return masked;
}

/** `path:line:текст` — путь берётся нежадно, чтобы двоеточие внутри имени файла не съело номер. */
const GREP_LINE = /^(.*?):(\d+):([\s\S]*)$/;

export function scanMarker(marker: LegacyMarker, cwd: string): MarkerReport {
  const res = Bun.spawnSync(
    ['git', 'grep', '-n', '-a', '-P', '-e', marker.pattern, '--', ...SEARCH_PATHSPEC],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );
  // git grep: 0 — есть совпадения, 1 — нет, >1 — ошибка (нет PCRE2 в сборке git, не репозиторий).
  // Ошибку нельзя принять за «чисто»: молчащий гейт хуже отсутствующего.
  if (res.exitCode > 1) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(
      `check-legacy-form: git grep вернул код ${res.exitCode} на маркере ${marker.id}: ${err}\n` +
        'Если git собран без PCRE2, флаг -P недоступен — гейт без него давал бы ложный ноль ' +
        'на маркерах с \\b, поэтому падаем, а не переключаемся на -E.',
    );
  }

  const hits: Hit[] = [];
  const allowed = new Map<string, number>();
  const re = new RegExp(marker.pattern);
  const excludes = marker.exclude ?? [];
  let excluded = 0;

  const out = new TextDecoder().decode(res.stdout);
  for (const raw of out.split('\n')) {
    if (raw === '') continue;
    const m = GREP_LINE.exec(raw);
    if (m === null) {
      throw new Error(`check-legacy-form: строка git grep не разобрана: ${JSON.stringify(raw)}`);
    }
    const [, path, lineNo, text] = m as unknown as [string, string, string, string];
    if (excludes.length > 0 && !re.test(maskExcluded(text, excludes))) {
      excluded += 1;
      continue;
    }
    if (allowedFor(path, marker.id)) {
      allowed.set(path, (allowed.get(path) ?? 0) + 1);
      continue;
    }
    hits.push({ marker: marker.id, path, line: Number(lineNo), text });
  }

  return { id: marker.id, hits, files: [...new Set(hits.map((h) => h.path))], excluded, allowed };
}

/**
 * Гейт запускается ТОЛЬКО из корня репозитория, и это проверяется, а не подразумевается.
 *
 * Замер: в синтетическом репозитории с нарушениями запуск из `<корень>/apps` печатал
 * «ok — совпадений старой формы нет» и выходил с кодом 0. Механика отказа: pathspec'ы
 * `git grep` отсчитываются от cwd, из `apps/` ни один из них (`apps/server/src`, …) ни с
 * чем не совпадает, а `git grep` по несовпавшему pathspec не ошибается — он тихо
 * возвращает 1, то есть «совпадений нет». Ложный зелёный неотличим от чистого дерева.
 *
 * Это не теоретический риск: приёмочные шаги Задач 8 и 9 плана зовут гейт рядом с
 * `cd apps/server && bun test …`, то есть ровно из того cwd, где он врал бы.
 */
export function assertRepoRoot(cwd: string): void {
  const res = Bun.spawnSync(['git', 'rev-parse', '--show-cdup'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (res.exitCode !== 0) {
    const err = new TextDecoder().decode(res.stderr).trim();
    throw new Error(
      `check-legacy-form: ${cwd} — не рабочее дерево git, гейту неоткуда брать совпадения: ${err}`,
    );
  }
  // Пусто ровно в корне; из подкаталога git печатает путь наверх («../», «../../», …).
  const cdup = new TextDecoder().decode(res.stdout).trim();
  if (cdup !== '') {
    throw new Error(
      'check-legacy-form: гейт запускается только из КОРНЯ репозитория, а запущен из ' +
        `${cwd} (git rev-parse --show-cdup: «${cdup}»).\n` +
        "Причина: пути гейта — pathspec'ы git grep, они отсчитываются от текущего каталога. " +
        'Из подкаталога ни один не совпадёт, git grep вернёт «совпадений нет», и гейт ' +
        'напечатал бы ноль по любой зоне — ложный зелёный, неотличимый от чистого дерева.',
    );
  }
}

export function scan(cwd: string): MarkerReport[] {
  assertRepoRoot(cwd);
  return LEGACY_MARKERS.map((marker) => scanMarker(marker, cwd));
}

// --- Печать -------------------------------------------------------------------------------

/**
 * NUL и прочие управляющие байты из найденной строки — иначе вывод рвёт терминал: гейт по
 * построению читает файлы, в которых такие байты есть (ради них он и написан).
 * Сравнение по коду, а не регуляркой с диапазоном управляющих символов: эту форму biome
 * запрещает правилом noControlCharactersInRegex, и запрещает по делу.
 */
function printable(text: string): string {
  const flat = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f ? '·' : ch;
  })
    .join('')
    .trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

function table(reports: readonly MarkerReport[]): string {
  const idWidth = Math.max(...LEGACY_MARKERS.map((m) => m.id.length), 'ИТОГО'.length);
  const head = `  ${'маркер'.padEnd(idWidth)}  строк  файлов  снято`;
  const rule = `  ${'-'.repeat(idWidth)}  -----  ------  -----`;
  const rows = reports.map((r) => {
    const suppressed = r.excluded + [...r.allowed.values()].reduce((a, b) => a + b, 0);
    return (
      `  ${r.id.padEnd(idWidth)}  ${String(r.hits.length).padStart(5)}  ` +
      `${String(r.files.length).padStart(6)}  ${String(suppressed).padStart(5)}`
    );
  });
  const totalLines = reports.reduce((a, r) => a + r.hits.length, 0);
  const totalFiles = new Set(reports.flatMap((r) => r.files)).size;
  const totalSuppressed = reports.reduce(
    (a, r) => a + r.excluded + [...r.allowed.values()].reduce((x, y) => x + y, 0),
    0,
  );
  // «файлов» в итоге — объединение, а не сумма: один файл обычно нарушает несколькими маркерами.
  const total =
    `  ${'ИТОГО'.padEnd(idWidth)}  ${String(totalLines).padStart(5)}  ` +
    `${String(totalFiles).padStart(6)}  ${String(totalSuppressed).padStart(5)}`;
  return [head, rule, ...rows, rule, total].join('\n');
}

function allowlistNote(reports: readonly MarkerReport[]): string {
  if (ALLOWLIST.length === 0) return '  (пуст)';
  return ALLOWLIST.map((e) => {
    const n = reports.reduce((a, r) => a + (r.allowed.get(e.path) ?? 0), 0);
    return `  ${e.path} — снято строк: ${n} — ${e.reason}`;
  }).join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const gate = args.includes('--gate');
  const unknown = args.filter((a) => a !== '--gate');
  if (unknown.length > 0) {
    console.error(
      `check-legacy-form: неизвестные аргументы: ${unknown.join(', ')}\n` +
        'Использование: bun scripts/check-legacy-form.ts [--gate]',
    );
    process.exit(2);
  }

  const cwd = process.cwd();
  let reports: MarkerReport[];
  try {
    reports = scan(cwd);
  } catch (e) {
    // Код 2, а не 1: единица означает «найдена старая форма», и спутать отказ окружения
    // с находкой нельзя — обе ветки читает CI.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  console.log('check-legacy-form: маркеры старой формы данных (§А12-2, приёмка §С8-10)');
  console.log(`пути: ${SEARCH_PATHSPEC.join(' ')}`);
  console.log('');
  console.log(table(reports));
  console.log('');
  console.log('allowlist:');
  console.log(allowlistNote(reports));

  const failing = reports.filter((r) => r.hits.length > 0);

  if (!gate) {
    console.log('');
    console.log('Режим отчёта: код возврата 0 при любых цифрах. Падающим гейт делает флаг --gate.');
    return;
  }

  if (failing.length === 0) {
    console.log('');
    console.log('check-legacy-form: ok — совпадений старой формы нет.');
    return;
  }

  console.error('');
  console.error('check-legacy-form: найдена старая форма данных — приёмка §С8-10 требует нуля.');
  for (const r of failing) {
    console.error(`\n[${r.id}] ${r.hits.length} строк в ${r.files.length} файлах:`);
    for (const h of r.hits) {
      console.error(`  ${h.path}:${h.line}: ${printable(h.text)}`);
    }
  }
  console.error(
    '\nЕсли совпадение законно — заведите файл в ALLOWLIST внутри этого скрипта ' +
      'с причиной, по которой старая форма в нём остаётся.',
  );
  process.exit(1);
}

// Скрипт одновременно и деливеребл, и модуль: тест импортирует LEGACY_MARKERS/ALLOWLIST,
// поэтому сам прогон запускается только при прямом вызове.
if (import.meta.main) {
  main();
}
