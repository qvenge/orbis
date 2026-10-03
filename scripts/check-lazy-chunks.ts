#!/usr/bin/env bun
/**
 * Страж инварианта ленивой загрузки (ветка backlog-lazy-split, решение D33).
 *
 * Экраны вынесены из первого кадра через React.lazy в `apps/web/src/app/router.tsx` (с среза 1б —
 * экран записи и экран поиска хоста).
 * Инвариант держится на том, что у этих модулей НЕТ ни одного статического импортёра в графе
 * сборки: статический импорт рядом с динамическим схлопывает чанк обратно во входной.
 *
 * Ломается он молча. Замер (2026-08-10): один `import { DetailScreen } from …` в AppShell.tsx
 * убирает файл `DetailScreen-*.js` из dist целиком и утяжеляет входной чанк со 159.8 до
 * 195.2 кБ gzip — при этом `tsc`, `biome` и все тесты web остаются зелёными, а сборка не
 * говорит ни слова. Заметить это мог только следующий ручной замер, то есть никто.
 *
 * Проверка нарочно бинарная — «файл чанка есть / файла нет», без порогов на размер.
 * Причина: именно так выглядит нарушение (файл ИСЧЕЗАЕТ, фасада-обёртки rolldown не
 * оставляет), а порог в байтах пришлось бы держать с запасом на честный рост фич — и он
 * либо пропускал бы регрессию, либо падал бы на каждой второй правке. Инвариант здесь
 * качественный («экран не в первом кадре»), таким его и проверяем.
 *
 * Имя общего чанка сознательно не проверяется: rolldown называет его по первому модулю
 * (наблюдались и `Input-*`, и `EnvelopeCard-*`), это деталь реализации, а не договор.
 *
 * ПОРОГИ ВЕСА — отдельные флаги, и они не противоречат абзацу выше: наличие чанка ловит, что модуль
 * СХЛОПНУЛСЯ, а порог — что чанк честно, но незаметно ТОЛСТЕЕТ (РП-25 среза страниц 1б):
 *  - `--max-gzip <Чанк>=<байт>` — gzip файла чанка (уровень по умолчанию, как в отчёте сборки vite);
 *  - `--max-closure-gzip <Чанк>=<байт>` — gzip ЗАМЫКАНИЯ: файл чанка и все чанки, достижимые из
 *    него статическими импортами, транзитивно (уровень 9 — как у замера базы, см. `closureOf`).
 * Второй флаг — не дубль первого, и это замерено (рулинг R-3 среза 1б): статический импорт Radix в
 * эагерный код экрана записи растил файл `DetailScreen-*.js` на +33 Б — rollup вынес Radix в общие
 * чанки, — а первый кадр записи рос на ~16 кБ gzip, мимо порога на файл.
 *
 * Запуск: `bun scripts/check-lazy-chunks.ts [--max-gzip Ч=Б] [--max-closure-gzip Ч=Б]` — после
 * сборки web. В CI стоит следом за ней, с порогами экрана записи.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

/** Сборщик может оставить lazy export в отдельном чанке, но вынести static sibling в общий. Проверяем также исходные рёбра. */
export function runtimeModuleImports(source: string): string[] {
  const file = ts.createSourceFile(
    'source.tsx',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  return file.statements.flatMap((node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const runtime =
        clause === undefined ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            (bindings !== undefined &&
              (ts.isNamespaceImport(bindings) || bindings.elements.some((e) => !e.isTypeOnly)))));
      return runtime && ts.isStringLiteral(node.moduleSpecifier) ? [node.moduleSpecifier.text] : [];
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const runtime =
        node.exportClause === undefined ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.some((e) => !e.isTypeOnly);
      return runtime ? [node.moduleSpecifier.text] : [];
    }
    return [];
  });
}
const SOURCE_LAZY_EDGES = [
  {
    source: 'apps/web/src/features/entity-detail/DetailScreen.tsx',
    modules: ['VersionsCard', 'ConfigureView'],
  },
  { source: 'apps/web/src/features/entity-detail/record-blocks.tsx', modules: ['VersionsCard'] },
  {
    source: 'apps/web/src/features/entity-detail/ProposalOverlay.tsx',
    modules: ['ProposalOverlayView'],
  },
];

const ASSETS_DIR = 'apps/web/dist/assets';
const ROUTER = 'apps/web/src/app/router.tsx';

/**
 * Экраны, у которых обязан быть собственный чанк. Сверяется с router.tsx ниже. Экраны Бюджета и
 * импорта сняты с роутера срезом 1б (РП-26, РП-31), их код удалён срезом 1в (§8.1).
 */
const LAZY_SCREENS = [
  'DetailScreen',
  // Задача 24 (R-35): экран поиска хоста `/search?q=…` — после жеста (🔍, ⌘K на телефоне) или по
  // ссылке. Входной чанк входит в эагерное замыкание экрана записи (порог РП-25, R-36), и эагерный
  // поиск ехал бы в первом кадре каждой записи.
  'SearchScreen',
];

/**
 * Общие чанки ленивой части: сами по себе не экраны, но статический импортёр у любого из них
 * уводил бы во входной чанк те же байты, а файлы экранов при этом оставались бы на месте.
 *
 * С задачи 19 среза 1б (РП-26) до задачи 24 список был пуст, и это замерено сборкой, а не выведено:
 *  - `NativeRow` (`features/entity-detail/NativeRow.tsx`) был общим чанком экрана записи и экрана
 *    категории Бюджета; экран категории ушёл из роутера, и rollup вклеил строку в чанк
 *    `DetailScreen` (+2,67 кБ gzip файла по отчёту vite). Вес экрана записи с ней держат пороги
 *    `--max-gzip`/`--max-closure-gzip` (РП-25);
 *  - строитель запроса ленты транзакций был общим чанком экранов «Транзакции» и категории; ни
 *    одного ленивого импортёра у него не осталось, отдельного чанка не стало (модуль удалён 1в §8.1).
 *
 * Третий общий чанк, `dist-*` (код Radix), сюда сознательно НЕ включён: его имя даёт путь внутри
 * node_modules, а не наш файл, и при добавлении Radix-компонента в ленивый экран он разъезжается на
 * два чанка — провал такой проверки было бы не отличить от обычной перетасовки зависимостей.
 * Принятый долг.
 */
const SHARED_CHUNKS: readonly string[] = [
  // Задача 24 (R-35): панель поиска `SearchPanel` (поле, три группы, пачка блоков) — общий чанк двух
  // ленивых входов поиска: экрана `SearchScreen` и окна ⌘K `SearchDialog`. Имя чанка устойчиво —
  // панель и есть его первый модуль (замерено сборкой задачи 24: `SearchPanel-*.js`). Статический
  // импорт панели из эагерного кода (кнопка 🔍, хоткей, рамка) вклеил бы её во входной чанк.
  'SearchPanel',
];

/**
 * Ленивые модули ВНУТРИ экрана сущности (не экраны, поэтому и не сверяются с роутером).
 *
 * Оба тянут за собой `@orbis/shared/doc` — всю схему документа, 154.5 кБ gzip отдельным чанком.
 * Статический импорт любого из них схлопнул бы этот вес в чанк `DetailScreen`, то есть в первый
 * кадр КАЖДОГО открытия записи, мимо двухфазного монтирования, ради которого написаны три
 * задачи подряд. Ломается это ровно так же молча, как и у экранов: `tsc`, `biome` и все тесты
 * остаются зелёными, а файл чанка просто исчезает из dist.
 *
 * Точки лени: `EditorShell.tsx` (BodyEditor) и `EntityBody.tsx` (MarkdownToggle).
 */
const LAZY_EDITOR_MODULES = ['BodyEditor', 'MarkdownToggle'];

/**
 * Ленивые модули экрана записи — ради ВЕСА его первого кадра, а не ради схемы документа.
 *
 * `DetailMenu` — меню ⋮ с деревом Radix-меню (menu, popper, floating-ui; ≈7,7 кБ gzip). Шаблон хоста
 * (срез страниц 1а, задача 14) довёл чанк `DetailScreen` до +17 % от базы среза, за порог сторожа
 * РП-11 (+15 %); меню нужно только после жеста и стало ленивым (точка лени — `DetailMenuSlot.tsx`).
 * Статический импорт `DetailMenu.tsx` схлопнул бы чанк обратно — молча, как у редактора выше.
 *
 * `RecordsBlock` — блок «Записи» (`{{records}}`, срез страниц 1б, задача 18): список, фильтр и быстрый
 * ввод нужны одной странице, а рендерер страниц эагерен в каждом открытии записи (спека 1б §12, Н-9).
 * Точка лени — `features/browser/RecordsBlockSlot.tsx` (с задачи 19 единственное место показа —
 * рендерер страниц: экран «Обзор» снят); статический импорт блока схлопнул бы чанк в чанк записи.
 *
 * `OpenPlaqueList` и `AppsBlock` (срез 1б, задача 20): плашки правила открытия с вопросом спора мест
 * и блок «Приложения» нужны редкой записи и редкой странице, а правило открытия считается на каждом
 * открытии. Точки лени — `features/apps/OpenPlaques.tsx` и `features/apps/slots.tsx`. У `AppsBlock`
 * второй ленивый импортёр — лист «Все приложения», поэтому его держит и ребро ниже (как `RecordsBlock`).
 *
 * `RefListControl` (срез 1б, задача 21): «упорядоченный список ссылок» — контрол одного свойства
 * («Навигация» приложения), а `PropertyControl`, который его выбирает, эагерен в каждой записи. Точка
 * лени — `lib/registry/PropertyControl.tsx`; второй импортёр (статический) — ленивый редактор
 * навигации, поэтому и здесь ребро ниже, а не одна проверка наличия.
 *
 * `SupplyPlaque` (срез 1б, задача 22): плашка обновления поставки с кнопками — только у записи
 * поставки с обновлением, а рендерер записи и страницы эагерен. Точка лени —
 * `features/supply/SupplyPlaqueSlot.tsx`.
 */
const LAZY_DETAIL_MODULES = [
  // R44: настройка после соответствующего жеста.
  'ConfigureView',
  'undo-toast',
  // R42: версии и диалог закрепления грузятся после первого открытия списка или жеста.
  'VersionsCard',
  // R43: запрос eager, представление непустого предложения lazy.
  'ProposalOverlayView',
  'DetailMenu',
  'RecordsBlock',
  'OpenPlaqueList',
  'AppsBlock',
  'RefListControl',
  'SupplyPlaque',
  // Задача 23: плашка выключенного расширения с «Включить» — переключатель с тостом и отменой нужен
  // только записи с выключенным расширением (точка лени — `entity-detail/AspectSection.tsx`).
  'ExtensionOffPlaque',
  // Срез 1в (§5.1, РП-18): переключатель параметра страницы нужен редкой странице, а рендерер
  // эагерен в каждом открытии записи (точка лени — `features/page/blocks/ParamSwitchSlot.tsx`).
  'ParamSwitch',
  // Срез 1в (§5.2, РП-18, задача 7): лента по дням — группы, подписи дней и колонка времени в поясе
  // владельца — нужна редкому блоку страницы (точка лени — `features/page/blocks/DayGroupsSlot.tsx`).
  'DayGroups',
  // Скорость, задача 12 (R-29): лента нужна только записи прогона, не первому кадру каждой записи.
  'RunFeed',
];

/**
 * Ленивые модули рамки хоста (срез 1б, задача 19): `HostMenu` — содержимое одного меню «⋯» на
 * экранах без своих пунктов (чат, настройки, «Не найдено», кадры загрузки и ошибки). Кнопка «⋯» —
 * эагерная на каждом экране (`app/frame/ScreenMenu.tsx`), Radix-меню — только нажатием. Статический
 * импорт `HostMenu` в рамку утащил бы Radix-меню во входной чанк и в первый кадр каждой записи.
 *
 * Задача 20: лист разделов `NavSheet` (с бейджами и ярлыками «↗ Дом»), лист «Все приложения»
 * `AllAppsSheet` и плитки «домашней как центр» `NavTiles` — после жеста или на редкой форме; входной
 * чанк входит в замыкание экрана записи, и их вес там лишний (РП-25, замер в отчёте задачи 20).
 *
 * Задача 22: вкладка настроек «Приложения и расширения» `AppsAndExtensions` — экран настроек лежит во
 * входном чанке, а списки, диалоги и кнопки поставки нужны только открытой вкладке. Точка лени —
 * `features/settings/SettingsScreen.tsx`.
 */
const LAZY_FRAME_MODULES = [
  'HostMenu',
  'NavSheet',
  'AllAppsSheet',
  'NavTiles',
  'AppsAndExtensions',
  // Задача 24 (R-35): окно поиска ⌘K десктопа — только открытым (🔍, ⌘K). Точка лени — `app/AppShell.tsx`;
  // эагерны там лишь горячая клавиша `useSearchHotkey` и стор окна `useSearchDialog`.
  'SearchDialog',
  // Задача 25: рамка десктопа — рейка хоста, сайдбар навигации и боковой чат одним чанком, только на
  // ширине десктопа (телефону их код не нужен). Точка лени — `app/AppShell.tsx`; эагерны лишь выбор
  // рамки (`useIsDesktop`), стор бокового чата и чистые функции контекста чата.
  'DesktopFrame',
];

/**
 * ТРЕТЬЯ проверка — СОСТАВ чанка, а не его наличие (Ш1, задача 11).
 *
 * Две проверки выше слепы к самой дорогой регрессии, и это ЗАМЕРЕНО, а не выведено. Разведка
 * собрала сборку, в которой вся схема документа (494 кБ raw / 155 кБ gzip) переехала в чанк
 * `DetailScreen`, а `doc-*.js` исчез из dist целиком, — и этот скрипт напечатал `ok` с кодом
 * 0. Второй страж (`save.test.tsx`) там тоже молчит: он нетранзитивен и знает поимённый
 * список файлов. То есть ровно та регрессия, против которой оба написаны, проходила молча.
 *
 * Что проверяется на каждое ребро `from ↛ to`:
 *  1. чанк `to` вообще ЕСТЬ отдельным файлом. Нет — значит его содержимое куда-то вклеилось,
 *     и это тот самый случай, который прошёл мимо стражей;
 *  2. `from` не дотягивается до `to` по СТАТИЧЕСКИМ импортам — ни напрямую, ни через
 *     соседей. Транзитивность здесь и есть весь смысл: `save.test.tsx` прямо признаётся, что
 *     «новый общий сосед со схемой внутри» его обойдёт, а по dist граф виден целиком.
 *
 * Первое ребро — «чанк записи не знает схему документа»: `DetailScreen` открывается при каждом
 * заходе в запись, а `@orbis/shared/doc` нужен только редактору и тумблеру разметки, и оба
 * ленивые. Динамический `import()` ребром НЕ считается — на нём всё и держится.
 *
 * Второе — «чанк записи не знает блок „Записи“» (срез страниц 1б, задача 18), и проверки наличия
 * ему МАЛО — это замерено мутацией: статический импорт `RecordsBlock` в рендерер НЕ убирает файл
 * `RecordsBlock-*.js` из dist, пока у модуля есть второй ленивый импортёр (так было с экраном
 * «Обзор» до задачи 19): rollup оставляет чанк общим, а `DetailScreen` просто начинает
 * импортировать его статически — блок едет в первом кадре каждой записи (+2 023 Б gzip замыкания,
 * в пределах запаса порога замыкания), а проверка наличия печатает `ok`. Второго импортёра сейчас
 * нет, но ребро остаётся: он появится с первым же новым местом показа блока.
 */
const FORBIDDEN_EDGES: readonly { from: string; to: string; hint: string }[] = [
  { from: 'DetailScreen', to: 'ConfigureView', hint: 'R44: редактор настройки после жеста.' },
  {
    from: 'DetailScreen',
    to: 'ProposalOverlayView',
    hint: 'R43: query wrapper не импортирует представление статически.',
  },
  {
    from: 'DetailScreen',
    to: 'VersionsCard',
    hint: 'R42: оба потребителя версий грузят модуль только через lazy().',
  },
  {
    from: 'DetailScreen',
    to: 'undo-toast',
    hint: 'Отмена и плашка — только через undo-lazy, после первого действия.',
  },
  {
    from: 'DetailScreen',
    to: 'RunFeed',
    hint: 'Ленту прогона грузит только lazy() из entity-detail/own-cards.tsx (R-29).',
  },
  {
    from: 'DetailScreen',
    to: 'doc',
    hint:
      "Ищите импортёра: `grep -rn \"@orbis/shared/doc'\" apps/web/src --include='*.ts*'` —\n" +
      'разрешён только каталог features/entity-editor и только листовые сабпаты `/diff`\n' +
      'и `/types` вне его.',
  },
  {
    from: 'DetailScreen',
    to: 'RecordsBlock',
    hint:
      "Ищите импортёра: `grep -rn \"RecordsBlock'\" apps/web/src --include='*.ts*'` — блок\n" +
      'грузится только через `features/browser/RecordsBlockSlot.tsx` (своя точка лени, спека 1б §12).',
  },
  {
    from: 'DetailScreen',
    to: 'AppsBlock',
    hint:
      "Ищите импортёра: `grep -rn \"AppsBlock'\" apps/web/src --include='*.ts*'` — блок «Приложения»\n" +
      'грузится только через `features/apps/slots.tsx` и лист «Все приложения» (задача 20).',
  },
  {
    // Печати и статус поставки (задача 22) нужны только ленивым частям — меню «⋯», плашке и сравнению.
    // Реэкспорт из барреля `@orbis/shared/supply` (его web берёт эагерно) утянул бы код в эагерный
    // чанк, и файл `print-*.js` при этом исчез бы (замерено: +508 Б gzip замыкания).
    from: 'DetailScreen',
    to: 'print',
    hint:
      "Ищите импортёра: `grep -rn \"@orbis/shared/supply'\" apps/web/src --include='*.ts*'` — печати\n" +
      'берутся только сабпатом `@orbis/shared/supply/print`, а баррель их не реэкспортирует (задача 22).',
  },
  {
    from: 'DetailScreen',
    to: 'RefListControl',
    hint:
      "Ищите импортёра: `grep -rn \"RefListControl'\" apps/web/src --include='*.ts*'` — контрол\n" +
      'грузится только лениво из `lib/registry/PropertyControl.tsx` и редактором навигации (задача 21).',
  },
  {
    // Полевые замеры (план скорости, задача 3, гейт I-1): транспорт пачек (клиент tRPC с `httpLink`) и наблюдатели
    // Web Vitals — ленивым чанком `perf/boot` из `main.tsx`; эагерны только метки и буфер. Статический импорт
    // `boot`, `transport` или `vitals` из эагерного кода вклеил бы их обратно в первый кадр записи (замер: ≈700 Б gzip).
    from: 'DetailScreen',
    to: 'boot',
    hint:
      "Ищите импортёра: `grep -rn \"perf/\\(boot\\|transport\\|vitals\\)'\" apps/web/src --include='*.ts*'` —\n" +
      'их грузит только `import()` в `main.tsx`; буфер туда передаётся аргументом (`PerfBuffer`).',
  },
];

// --- Разбор dist: каталог чанков — параметром (ради фикстурного теста) ---------------------

/** Файлы чанка по имени модуля: имя модуля, дефис, хэш сборки (то же правило, что у проверки наличия). */
export function chunkFilesIn(files: readonly string[], name: string): string[] {
  return files.filter((f) => new RegExp(`^${name}-[\\w-]+\\.js$`).test(f));
}

/**
 * Статические импорты чанка — `import … from"./x.js"`, голый `import"./x.js"` и
 * `export … from"./x.js"`.
 *
 * Скобки, исключённые из класса `[^'"()]`, отсекают ДИНАМИЧЕСКИЙ `import("./x.js")` — и это
 * главное свойство разбора: ленивая загрузка не ребро, ради неё всё и затевалось. Мимо
 * разбора проходит и таблица `__vite__mapDeps` в начале чанка: она перечисляет
 * предзагружаемые ленивые чанки строками вида `"assets/doc-*.js"` — без `./` и без оператора
 * импорта. Оба свойства проверены на настоящем dist, а не выведены из чтения регэкспа.
 */
export function staticImports(dir: string, file: string): string[] {
  const src = readFileSync(`${dir}/${file}`, 'utf8');
  return [
    ...src.matchAll(
      /(?:^|[;\s}])(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?["']\.\/([\w.-]+\.js)["']/g,
    ),
  ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** Достижим ли `target` из `start` по статическим импортам (обход в ширину по чанкам dist). */
function reaches(dir: string, files: readonly string[], start: string, target: string): boolean {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const next of staticImports(dir, file)) {
      if (next === target) return true;
      if (seen.has(next) || !files.includes(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

/**
 * Эагерное замыкание чанка: сам файл и все чанки, достижимые из него СТАТИЧЕСКИМИ импортами,
 * транзитивно. Динамический `import()` в замыкание не идёт — по нему грузится ленивое, ради него
 * всё и затевалось (разбор — `staticImports`). Это и есть байты, которые браузер тянет, чтобы
 * показать первый кадр экрана: файл чанка без соседей недосчитывает общее, вынесенное rollup'ом.
 */
export function closureOf(dir: string, file: string): string[] {
  const files = readdirSync(dir);
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of staticImports(dir, current)) {
      if (seen.has(next) || !files.includes(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

// --- Пороги веса (РП-25, рулинг R-3 среза страниц 1б) ---------------------------------------

/** Порог: имя модуля чанка и предел в байтах gzip. */
export interface Budget {
  chunk: string;
  max: number;
}

export interface Budgets {
  /** `--max-gzip` — gzip файла чанка. */
  file: Budget[];
  /** `--max-closure-gzip` — gzip эагерного замыкания чанка (`closureOf`). */
  closure: Budget[];
}

const BUDGET_FLAGS: Readonly<Record<string, keyof Budgets>> = {
  '--max-gzip': 'file',
  '--max-closure-gzip': 'closure',
};

/**
 * Разбор флагов порогов. Всё непонятное — ошибка, а не пропуск: опечатка в имени флага в CI
 * молча снимала бы порог, и сторож зеленел бы без проверки — ровно тот класс, против которого он.
 */
export function parseBudgetArgs(argv: readonly string[]): Budgets {
  const out: Budgets = { file: [], closure: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const kind = Object.hasOwn(BUDGET_FLAGS, flag) ? BUDGET_FLAGS[flag] : undefined;
    if (kind === undefined) {
      throw new Error(
        `check-lazy-chunks: неизвестный аргумент ${flag}. ` +
          'Флаги: --max-gzip <Чанк>=<байт>, --max-closure-gzip <Чанк>=<байт>.',
      );
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`check-lazy-chunks: у ${flag} нет значения — ждём <Чанк>=<байт>.`);
    }
    const m = /^(\w+)=(\d+)$/.exec(value);
    if (m === null) {
      throw new Error(
        `check-lazy-chunks: значение ${flag} «${value}» — не <Чанк>=<байт> (целое число байт).`,
      );
    }
    out[kind].push({ chunk: m[1] as string, max: Number(m[2]) });
  }
  return out;
}

/**
 * Уровень сжатия замыкания — 9: им снята база задачи 1 среза 1б (304 855 Б, скрипт имплементера
 * `closure.py`, `gzip.compress` Python — уровень 9 по умолчанию), и порог CI отсчитан от замера тем
 * же уровнем. Файл чанка — уровнем zlib по умолчанию: им мерят отчёт сборки vite и все базы файла
 * (27 562 Б на начале среза, порог 34 889 Б). Разные уровни у двух флагов — ради сравнимости с их
 * базами, а не случайность.
 */
const CLOSURE_GZIP_LEVEL = 9;

const gzipBytes = (dir: string, file: string, level?: number): number =>
  gzipSync(readFileSync(`${dir}/${file}`), level === undefined ? {} : { level }).length;

/**
 * Проверка порогов на каталоге чанков. Код 1 — превышение (с числами и составом) или чанка с таким
 * именем нет ровно одного: порог на отсутствующий файл — это ноль байт и вечный «ok».
 */
export function checkBudgets(dir: string, budgets: Budgets): { code: 0 | 1; lines: string[] } {
  const files = readdirSync(dir);
  const lines: string[] = [];
  let failed = false;
  const fileOf = (b: Budget, flag: string): string | null => {
    const found = chunkFilesIn(files, b.chunk);
    if (found.length === 1) return found[0] as string;
    failed = true;
    lines.push(
      `check-lazy-chunks: ${flag} ${b.chunk}: ` +
        (found.length === 0
          ? `чанка ${b.chunk}-*.js в dist нет — порог мерить не на чем (модуль схлопнулся или переименован).`
          : `чанков ${b.chunk}-*.js несколько (${found.join(', ')}) — порог неоднозначен.`),
    );
    return null;
  };

  for (const b of budgets.file) {
    const file = fileOf(b, '--max-gzip');
    if (file === null) continue;
    const size = gzipBytes(dir, file);
    if (size > b.max) {
      failed = true;
      lines.push(
        `check-lazy-chunks: чанк ${file} — ${size} Б gzip, порог ${b.max} Б (превышение ${size - b.max} Б).\n` +
          'Порог не поднимать: сначала разобрать, что приехало в первый кадр (РП-25) — лишний\n' +
          'статический импорт тяжёлого модуля обычно лечится точкой лени.',
      );
    } else {
      lines.push(`вес: ${file} — ${size} Б gzip при пороге ${b.max} Б (запас ${b.max - size} Б)`);
    }
  }

  for (const b of budgets.closure) {
    const file = fileOf(b, '--max-closure-gzip');
    if (file === null) continue;
    const members = closureOf(dir, file).map((f) => ({
      f,
      size: gzipBytes(dir, f, CLOSURE_GZIP_LEVEL),
    }));
    const size = members.reduce((sum, m) => sum + m.size, 0);
    if (size > b.max) {
      failed = true;
      const heaviest = [...members]
        .sort((x, y) => y.size - x.size)
        .map((m) => `  ${m.f} — ${m.size} Б`)
        .join('\n');
      lines.push(
        `check-lazy-chunks: эагерное замыкание ${file} — ${size} Б gzip -9, порог ${b.max} Б ` +
          `(превышение ${size - b.max} Б).\n` +
          'Растёт первый кадр экрана, даже если сам файл чанка почти не изменился: rollup выносит\n' +
          'общее в соседние чанки, и они едут вместе с ним. Состав замыкания (по весу):\n' +
          `${heaviest}\n` +
          'Порог не поднимать: найдите статический импорт, притащивший вес, и сделайте его ленивым.',
      );
    } else {
      lines.push(
        `вес: замыкание ${file} (${members.length} файлов) — ${size} Б gzip -9 при пороге ${b.max} Б ` +
          `(запас ${b.max - size} Б)`,
      );
    }
  }
  return { code: failed ? 1 : 0, lines };
}

// --- Запрещённое содержимое замыкания (R-19 среза 1в) ---------------------------------------

/** Текст, которого в эагерном замыкании чанка быть не должно, и файл-источник этого текста. */
export interface ClosureTextRule {
  chunk: string;
  text: string;
  source: string;
  hint: string;
}

/**
 * Встроенный словарь свойств (`BUILTIN_PROPERTY_META`, ≈7 КБ gzip, с каноном Q-AST внутри
 * `orbis/progress_source`) web не читает — реестр ему отдаёт сервер, — и сборщик его выбрасывает
 * (R-19 среза 1в: вызов со словарём помечен чистым, `contracts/budget.ts` не ищет по словарю на
 * верхнем уровне). Вернуть его в первый кадр экрана записи может одна строка — снятая аннотация
 * или новый поиск по словарю при загрузке модуля, — и порог замыкания это НЕ ловит: запас после
 * R-19 больше веса словаря (замерено мутацией: без аннотации — 329 380 Б при пороге 329 400).
 * Поэтому отдельная проверка — по ТЕКСТУ описания свойства, который есть только в словаре.
 *
 * Позитивный контроль — текст обязан стоять в `source`: переписанное описание иначе сделало бы
 * проверку вечным «ok» (маркер пропал бы из сборки вместе с источником).
 */
const FORBIDDEN_CLOSURE_TEXT: readonly ClosureTextRule[] = [
  {
    chunk: 'DetailScreen',
    text: 'Деньги приходят или уходят',
    source: 'packages/shared/src/registry/builtin-properties.ts',
    hint:
      'Встроенный словарь свойств приехал в первый кадр. Проверьте аннотацию чистоты у\n' +
      '`BUILTIN_PROPERTY_META` и что ни один модуль, который грузит web, не читает словарь на\n' +
      'верхнем уровне (образец — `DIRECTION_OPTIONS` в `contracts/budget.ts`).',
  },
  {
    // Схема замеров (план скорости, задача 3, гейт I-1): web берёт из контракта только типы и списки, схема разбирает
    // вход на сервере. Цепочку `z.object(…).strict()` сборщик чистой не считает — без пометки `@__PURE__` у фабрик
    // схема ехала бы в первый кадр записи мёртвым кодом (≈180 Б gzip). Маркер — маска версии, она есть только в схеме.
    chunk: 'DetailScreen',
    text: '/^\\d+\\.\\d+\\.\\d+$/',
    source: 'packages/shared/src/contracts/perf.ts',
    hint:
      'Схема замеров приехала в первый кадр. Проверьте пометки `@__PURE__` у `perfSampleSchema` и\n' +
      '`perfReportInput` и что web не читает их (только типы `PerfSample`, списки `PERF_*`).',
  },
];

/**
 * Проверка содержимого замыкания. Код 1 — текст найден в замыкании чанка либо отсутствует в своём
 * источнике (маркер устарел); чанка нет ровно одного — тоже код 1, как у порогов.
 */
export function checkClosureText(
  dir: string,
  rules: readonly ClosureTextRule[],
  readSource: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): { code: 0 | 1; lines: string[] } {
  const files = readdirSync(dir);
  const lines: string[] = [];
  for (const rule of rules) {
    if (!readSource(rule.source).includes(rule.text)) {
      lines.push(
        `check-lazy-chunks: маркер «${rule.text}» не найден в ${rule.source} — проверка ` +
          `содержимого ${rule.chunk} устарела; выберите текст, который там есть.`,
      );
      continue;
    }
    const found = chunkFilesIn(files, rule.chunk);
    if (found.length !== 1) {
      lines.push(`check-lazy-chunks: чанков ${rule.chunk}-*.js не ровно один (${found.length}).`);
      continue;
    }
    const hit = closureOf(dir, found[0] as string).find((f) =>
      readFileSync(`${dir}/${f}`, 'utf8').includes(rule.text),
    );
    if (hit !== undefined) {
      lines.push(
        `check-lazy-chunks: в эагерном замыкании ${found[0]} (файл ${hit}) — «${rule.text}» ` +
          `из ${rule.source}.\n${rule.hint}`,
      );
    }
  }
  return { code: lines.length === 0 ? 0 : 1, lines };
}

// --- Проверка сборки ------------------------------------------------------------------------

function main(argv: readonly string[]): void {
  let budgets: Budgets;
  try {
    budgets = parseBudgetArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }

  // --- Сверка списка с роутером -------------------------------------------------------------
  // Седьмая точка lazy(), добавленная без правки LAZY_SCREENS, осталась бы без охраны — молча,
  // то есть ровно тем способом, против которого этот страж и написан. Сверяем не число, а
  // ИМЕНА: чанк называется по базовому имени модуля из import(), поэтому список обязан совпасть
  // с набором ленивых импортов роутера точь-в-точь.
  for (const edge of SOURCE_LAZY_EDGES) {
    const imports = runtimeModuleImports(readFileSync(edge.source, 'utf8'));
    const forbidden = imports.filter((path) =>
      edge.modules.includes(
        path
          .replace(/\.(?:tsx?|jsx?)$/, '')
          .split('/')
          .at(-1) ?? '',
      ),
    );
    if (forbidden.length > 0) {
      console.error(
        `check-lazy-chunks: source static edge ${edge.source} → ${forbidden.join(', ')}; siblings одного модуля тоже должны оставаться lazy.`,
      );
      process.exit(1);
    }
  }
  const routerSrc = readFileSync(ROUTER, 'utf8');
  const inRouter = [...routerSrc.matchAll(/lazy\([\s\S]{0,200}?import\('([^']+)'\)/g)].map(
    (m) => m[1].split('/').pop() as string,
  );
  const onlyInRouter = inRouter.filter((n) => !LAZY_SCREENS.includes(n));
  const onlyInList = LAZY_SCREENS.filter((n) => !inRouter.includes(n));
  if (onlyInRouter.length > 0 || onlyInList.length > 0) {
    console.error(
      `check-lazy-chunks: список LAZY_SCREENS разошёлся с ${ROUTER}.\n` +
        (onlyInRouter.length > 0 ? `  ленивые в роутере, но не в списке: ${onlyInRouter}\n` : '') +
        (onlyInList.length > 0 ? `  в списке, но уже не ленивые в роутере: ${onlyInList}\n` : '') +
        'Приведите список в соответствие — охрана должна покрывать все точки lazy().',
    );
    process.exit(1);
  }

  let files: string[];
  try {
    files = readdirSync(ASSETS_DIR);
  } catch {
    console.error(
      `check-lazy-chunks: каталога ${ASSETS_DIR} нет — сначала соберите web:\n` +
        '  bun run --filter @orbis/web build',
    );
    process.exit(1);
  }

  const guarded = [
    ...LAZY_SCREENS,
    ...SHARED_CHUNKS,
    ...LAZY_EDITOR_MODULES,
    ...LAZY_DETAIL_MODULES,
    ...LAZY_FRAME_MODULES,
  ];
  const missing = guarded.filter(
    (name) => !files.some((f) => new RegExp(`^${name}-[\\w-]+\\.js$`).test(f)),
  );

  if (missing.length > 0) {
    console.error(
      'check-lazy-chunks: отдельного чанка нет у модулей: ' +
        `${missing.join(', ')}.\n` +
        'Это значит, что где-то появился СТАТИЧЕСКИЙ импорт такого модуля — рядом с ленивым он\n' +
        'схлопывает чанк во входной, и байты снова едут в первом кадре. Найдите импортёра\n' +
        "(`grep -rn \"<Модуль>'\" apps/web/src --include='*.ts*'`, тесты не считаются — они не\n" +
        'входят в сборку) и уберите его. Если импортёру нужен общий помощник из ленивого\n' +
        'модуля, вынесите помощник в отдельный листовой файл.',
    );
    process.exit(1);
  }

  for (const edge of FORBIDDEN_EDGES) {
    const targets = chunkFilesIn(files, edge.to);
    if (targets.length === 0) {
      console.error(
        `check-lazy-chunks: чанка ${edge.to}-*.js в dist нет вовсе.\n` +
          'Это НЕ «модуль стал не нужен»: rolldown не оставляет фасада, а вклеивает содержимое\n' +
          `в того, кто его импортирует статически, — то есть вес уехал в чужой чанк (скорее всего\n` +
          `в ${edge.from}). Найдите статический импорт и уберите его.`,
      );
      process.exit(1);
    }
    for (const from of chunkFilesIn(files, edge.from)) {
      /**
       * ПОЗИТИВНЫЙ КОНТРОЛЬ РАЗБОРА — раньше самой проверки, и он тут по той же причине, по
       * которой написана вся третья проверка: молчащий страж хуже отсутствующего.
       *
       * `staticImports` знает ровно один формат спецификатора — `./имя.js`. Смени vite базовый
       * путь или разложи чанки по подкаталогам — разбор перестанет видеть рёбра вообще, и
       * проверка ниже напечатала бы `ok` на любой сборке. Пустой список у чанка экрана
       * невозможен по существу, поэтому пустота означает не «зависимостей нет», а «разбор
       * сломался».
       *
       * Сегодня у `DetailScreen` их двенадцать (сборка задачи 19 среза 1б: jsx-runtime, index, dist,
       * types, …); `NativeRow` среди них больше нет — вклеен в сам чанк (см. `SHARED_CHUNKS`). Чанка `diff` в списке БОЛЬШЕ НЕТ, и это не потеря: Задача 20 завела второй
       * листовой сабпат `@orbis/shared/doc/types` (версия схемы, имена нод, обход состава), и
       * rolldown сложил оба листовых модуля в ОДИН чанк `types-*.js` — 2.21 кБ gzip против 2.05 кБ
       * у прежнего `diff-*.js` (замерено на двух сборках, до и после). Схема документа в него не
       * попала: `types-*.js` статических импортов не имеет вовсе, а `doc-*.js` по-прежнему
       * отдельный чанк на 153 кБ gzip — его и сторожит ребро ниже.
       *
       * Число это НЕ договор и в проверку не входит: редакция до Ш1.1 называла шесть и устарела в
       * том же срезе, где была написана, а читают её при СРАБОТАВШЕМ страже — то есть когда
       * человеку и так уже нехорошо. Проверяется единственное: список непуст.
       */
      if (staticImports(ASSETS_DIR, from).length === 0) {
        console.error(
          `check-lazy-chunks: у чанка ${from} не разобрано НИ ОДНОГО статического импорта.\n` +
            'Так не бывает: чанк экрана всегда тянет общие модули. Значит сломался разбор —\n' +
            'скорее всего сборка сменила формат спецификаторов (другой base, чанки в подкаталоге),\n' +
            'и проверка состава ниже стала бы печатать ok на любой сборке. Почините staticImports.',
        );
        process.exit(1);
      }
      const hit = targets.find((t) => reaches(ASSETS_DIR, files, from, t));
      if (hit !== undefined) {
        console.error(
          `check-lazy-chunks: чанк ${from} СТАТИЧЕСКИ импортирует ${hit} (прямо или через соседей).\n` +
            `Инвариант: чанк «${edge.from}» не знает «${edge.to}» — иначе его вес едет в первом\n` +
            'кадре каждого открытия записи, мимо ленивой загрузки. Проверяющие тесты и стражи\n' +
            'наличия чанков этого не видят: файлы остаются на месте, переезжает только состав.\n' +
            edge.hint,
        );
        process.exit(1);
      }
    }
  }

  // --- Пороги веса: после наличия и состава — чанк, которого нет, мерить бессмысленно ---------
  const weight = checkBudgets(ASSETS_DIR, budgets);
  if (weight.code !== 0) {
    console.error(weight.lines.join('\n'));
    process.exit(1);
  }
  const content = checkClosureText(ASSETS_DIR, FORBIDDEN_CLOSURE_TEXT);
  if (content.code !== 0) {
    console.error(content.lines.join('\n'));
    process.exit(1);
  }

  console.log(
    `check-lazy-chunks: ok — отдельные чанки на месте у всех ${guarded.length} ` +
      `(${LAZY_SCREENS.length} экранов + ${SHARED_CHUNKS.length} общих + ` +
      `${LAZY_EDITOR_MODULES.length} ленивых модулей редактора + ` +
      `${LAZY_DETAIL_MODULES.length} ленивых модулей экрана записи + ` +
      `${LAZY_FRAME_MODULES.length} ленивых модулей рамки), список экранов сверен с роутером, ` +
      `состав чанков сверен по запрещённым рёбрам (${FORBIDDEN_EDGES.length}) ` +
      `(${FORBIDDEN_EDGES.map((e) => `${e.from} ↛ ${e.to}`).join(', ')}), ` +
      `содержимое замыканий — по ${FORBIDDEN_CLOSURE_TEXT.length} маркерам (R-19).`,
  );
  for (const line of weight.lines) console.log(line);
}

if (import.meta.main) main(process.argv.slice(2));
