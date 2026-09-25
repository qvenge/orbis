import type { DetailStructure } from './structure-snapshot';

/**
 * Три намеренных отличия экрана записи через шаблон хоста от экрана до среза 1а (спека страниц
 * 1а §8.2; приёмка С1а-5, РП-10) — функциями над структурным снимком, а не правкой эталона.
 *
 * Эталон (`golden/detail-structure.json`) снят задачей 2 со старого экрана и не перезаписывается
 * никогда. Новый экран сверяется с `INTENDED_1A(эталон)`: каждое отличие — своя поимённая чистая
 * функция, видимая ревью, и вход не мутируется. Четвёртой функции нет и быть не должно: «Всё
 * остальное по составу совпадает. Любое другое расхождение — дефект» (§8.2).
 */

/** Части строки заголовка на старой «Сущности»: эмодзи и сама строка (обычная или памяти AI). */
const TITLE_PARTS: ReadonlySet<string> = new Set(['emoji', 'native-row', 'native-memory']);

/**
 * §8.2 (1): «Заголовок и теги над вкладками и видны на любой вкладке (сегодня заголовок есть
 * только на первой, тегов на экране нет)». Строка заголовка с эмодзи уходит из первой вкладки над
 * вкладки, за ней встаёт блок тегов — строки `{{title}}` и `{{tags}}` шаблона хоста (§8.1).
 */
export function titleAndTagsAboveTabs(s: DetailStructure): DetailStructure {
  const [first, ...rest] = s.tabs;
  if (first === undefined) return s;
  return {
    aboveTabs: [...s.aboveTabs, ...first.parts.filter((p) => TITLE_PARTS.has(p)), 'tags-block'],
    tabs: [{ ...first, parts: first.parts.filter((p) => !TITLE_PARTS.has(p)) }, ...rest],
  };
}

/** §8.2 (2): «Вкладка „Сущность“ → „Запись“ (словарь концепции)». */
export function renameEntityTab(s: DetailStructure): DetailStructure {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.label === 'Сущность' ? { ...t, label: 'Запись' } : t)),
  };
}

type Match = (part: string) => boolean;
const is =
  (name: string): Match =>
  (p) =>
    p === name;
const section =
  (aspectId: string): Match =>
  (p) =>
    p.startsWith(`aspect:${aspectId}[`);

/**
 * Части своих карточек — в порядке строк `{{card: X}}` шаблона хоста (§8.1), внутри карточки — в
 * порядке её частей (`own-cards.tsx`). История прогонов на старом экране одна на запись: у рутины
 * она часть карточки рутины, у тикета — карточки назначения.
 */
function ownCardParts(isRoutine: boolean): readonly (readonly Match[])[] {
  return [
    // {{card: orbis/goal}} — секция полей цели, затем прогресс (или отказ его расчёта).
    [section('orbis/goal'), is('goal-progress'), is('goal-unsupported')],
    // {{card: orbis/assignment}} — назначение; у тикета ещё ожидание человека и история прогонов.
    [is('assignment-card'), is('ticket-waiting'), ...(isRoutine ? [] : [is('runs-list')])],
    // {{card: orbis/routine}} — секция полей рутины, её состояние и история прогонов.
    [section('orbis/routine'), is('routine-status'), ...(isRoutine ? [is('runs-list')] : [])],
    // {{card: orbis/agent-run}} — лента прогона.
    [is('run-feed')],
    // {{card: orbis/financial}} — секция полей финансов и карточка «план → факт».
    [section('orbis/financial'), is('plan-to-fact-card')],
  ];
}

/**
 * §8.2 (3): «Аспект со своей карточкой показывается одним куском на вкладке „Запись“ над телом.
 * Сегодня части разнесены: прогресс цели наверху, поля — в „Деталях“; ожидание тикета наверху,
 * назначение — в „Деталях“».
 *
 * Части своих карточек снимаются с обеих вкладок и встают одним куском на первую вкладку перед
 * телом (`{{body}}` — последняя строка вкладки «Запись» в §8.1). На «Деталях» остаётся прежний
 * порядок: прочие карточки, версии, подзадачи, блокировки, обратные ссылки (`{{cards}}` …
 * `{{backlinks}}`).
 */
export function ownCardsOnRecordTab(s: DetailStructure): DetailStructure {
  const [record, ...rest] = s.tabs;
  if (record === undefined) return s;
  const all = s.tabs.flatMap((t) => t.parts);
  const isRoutine = all.some(section('orbis/routine'));
  const taken = new Set<string>();
  const piece: string[] = [];
  for (const card of ownCardParts(isRoutine)) {
    for (const match of card) {
      for (const p of all) {
        if (!taken.has(p) && match(p)) {
          taken.add(p);
          piece.push(p);
        }
      }
    }
  }
  const left = record.parts.filter((p) => !taken.has(p));
  const at = left.indexOf('body');
  const parts =
    at === -1 ? [...left, ...piece] : [...left.slice(0, at), ...piece, ...left.slice(at)];
  return {
    ...s,
    tabs: [
      { ...record, parts },
      ...rest.map((t) => ({ ...t, parts: t.parts.filter((p) => !taken.has(p)) })),
    ],
  };
}

/** Снимок, который ОБЯЗАН дать новый экран на фикстуре эталона: три отличия §8.2 по порядку. */
export function INTENDED_1A(golden: DetailStructure): DetailStructure {
  return ownCardsOnRecordTab(renameEntityTab(titleAndTagsAboveTabs(golden)));
}
