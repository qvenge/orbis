/**
 * Структурный снимок экрана записи (приёмка С1а-5, РП-10): ЧТО стоит на экране и в каком
 * порядке — без текстов, классов и id записей.
 *
 * Зачем структура, а не картинка и не DOM целиком. Снимков в web нет вовсе (Ф-1а-17), а срез 1а
 * пересобирает экран записи из шаблона: разметка обязана поменяться (обёртки, классы, порядок
 * узлов внутри блоков), и сравнение DOM краснело бы на каждой законной правке. Приёмке нужен
 * ответ на другой вопрос — «те же блоки, в тех же вкладках, в том же порядке», — и снимок
 * отвечает ровно на него. Три намеренных отличия нового экрана (спека §8.2) задача 14 снимает
 * функцией поверх эталона, а не правкой эталона.
 *
 * Ориентиры — по `data-testid`, которые экран УЖЕ несёт (их держат поведенческие тесты, и
 * переименование одного из них красит не только этот снимок). Там, где у блока testid нет,
 * узнаём его по признаку, который даёт сама разметка экрана (эмодзи, секции подзадач и
 * блокировок), — продуктовый код ради снимка не трогается.
 */

export interface DetailStructure {
  aboveTabs: string[]; // ориентиры над вкладками в порядке документа
  tabs: { label: string; parts: string[] }[]; // подпись вкладки + ориентиры её панели
}

/**
 * Узел вкладок экрана записи: граница «над вкладками» / «внутри вкладок» — контейнер `{{tabs}}`
 * шаблона хоста (`page-tabs`, экран с задачи 14).
 *
 * Эталон задача 2 снимала со старого экрана, где тот же узел звался `entity-tabs`. Запасного имени
 * здесь нет: старого экрана в коде больше нет, и имя, которое не встретится ни на одном экране,
 * только делало бы вид, что съёмка старого экрана ещё возможна.
 */
const TABS_TESTID = 'page-tabs';

/**
 * Имена ориентиров. Все, кроме трёх помеченных, — `data-testid` экрана один в один.
 *
 * `tags-block` и `page-text` на экране до среза 1а НЕТ: их заводят задачи 13–14 (блок тегов и
 * текст страницы). Они стоят здесь заранее, чтобы тот же экстрактор узнал их на новом экране:
 * эталон снят без них, и их появление — одно из трёх намеренных отличий, а не новый ориентир,
 * который экстрактор молча пропустил бы.
 *
 * Карточки аспектов (`aspect-<id>`, включая секцию «Свойства» — `aspect-free`) в список не
 * входят: это семейство, а не имя, и в снимок они идут вместе со своими свойствами.
 */
export const LANDMARKS: readonly string[] = [
  // над вкладками
  'detail-menu',
  'proposal-overlay',
  'body-notices',
  // первая вкладка старого экрана («Сущность», в эталоне); на новом часть из них — над вкладками
  // и в своих карточках «Записи» (§8.2)
  'emoji', // признак, не testid — см. `isEmoji`
  'native-row',
  'native-memory', // строка памяти AI стоит ВМЕСТО native-row (NativeRow → MemoryRow)
  'tags-block',
  'page-text',
  'plan-to-fact-card',
  'goal-progress',
  'goal-unsupported', // GoalProgress при отказе расчёта рисует это ВМЕСТО полосы
  'ticket-waiting',
  'routine-status',
  'run-feed',
  'body', // признак, не testid — первый кадр (`editor-preview`) или сам редактор (`body-editor`)
  // «Детали» старого экрана (в эталоне)
  'assignment-card',
  'versions-card',
  'subtask',
  'subtask-add', // признак, не testid — секция подзадач, см. `SECTION_ANCHORS`
  'runs-list',
  'block-add', // признак, не testid — секция блокировок, см. `SECTION_ANCHORS`
  'block-row',
  'backlink',
];

const ASPECT_PREFIX = 'aspect-';
const PROP_PREFIX = 'prop-';
const BODY_TESTIDS = new Set(['editor-preview', 'body-editor']);

/**
 * Секции «Подзадачи» и «Блокировки» живут на КАЖДОЙ записи (заголовок + поле добавления), но
 * своего testid у секции нет — testid есть только у строк (`subtask`, `block-row`). Без
 * ориентира пустая секция была бы для снимка невидима, и новый экран, потерявший её у записи
 * без связей, прошёл бы сравнение. Узнаём секцию по её полю добавления: у него стабильное
 * доступное имя, и оно же — то, по чему секцию находит человек со скринридером.
 *
 * Место в порядке — место самого поля: у подзадач оно ПОСЛЕ строк, у блокировок — в шапке,
 * ДО строк. Это свойство разметки, а не ошибка снимка.
 */
const SECTION_ANCHORS: Readonly<Record<string, string>> = {
  'subtask-add': 'input[aria-label="Новая подзадача"]',
  'block-add': 'button[aria-label="Добавить блокировку"]',
};

/**
 * Эмодзи записи — крупный `aria-hidden` span прямо перед строкой заголовка (`TitleBlock`,
 * record-blocks.tsx). Признак — положение и немота, а не класс: класс — дело вёрстки.
 */
function isEmoji(el: Element): boolean {
  if (el.tagName !== 'SPAN' || el.getAttribute('aria-hidden') !== 'true') return false;
  const next = el.nextElementSibling?.getAttribute('data-testid');
  return next === 'native-row' || next === 'native-memory';
}

/** Ориентир узла или `null`. Карточка аспекта сюда не приходит — у неё свой разбор. */
function landmarkOf(el: Element): string | null {
  const testId = el.getAttribute('data-testid');
  if (testId !== null) {
    if (BODY_TESTIDS.has(testId)) return 'body';
    if (LANDMARKS.includes(testId) && !(testId in SECTION_ANCHORS)) return testId;
  }
  for (const [name, selector] of Object.entries(SECTION_ANCHORS)) {
    if (el.matches(selector)) return name;
  }
  if (isEmoji(el)) return 'emoji';
  return null;
}

/**
 * Карточка аспекта: `aspect:<id>[prop:<id>,…]`, свойства — в порядке DOM. Один контрол бывает
 * собран из нескольких узлов с одним testid (множественный выбор), поэтому — без повторов.
 */
function aspectEntry(section: Element, testId: string): string {
  const props = new Set<string>();
  for (const node of section.querySelectorAll(`[data-testid^="${PROP_PREFIX}"]`)) {
    props.add(`prop:${(node.getAttribute('data-testid') ?? '').slice(PROP_PREFIX.length)}`);
  }
  return `aspect:${testId.slice(ASPECT_PREFIX.length)}[${[...props].join(',')}]`;
}

/**
 * Ориентиры поддерева в порядке документа. `skip` — узел, в который не заходим (область
 * вкладок при сборе «над вкладками»). Вложенные ориентиры попадают в снимок тоже: блок внутри
 * блока — такая же часть структуры, как соседний.
 */
function collect(root: Element, skip?: Element): string[] {
  const out: string[] = [];
  const visit = (el: Element) => {
    if (el === skip) return;
    const testId = el.getAttribute('data-testid');
    if (testId?.startsWith(ASPECT_PREFIX)) {
      out.push(aspectEntry(el, testId));
      return;
    }
    const name = landmarkOf(el);
    if (name !== null) out.push(name);
    for (const child of el.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

export function snapshotDetailStructure(container: HTMLElement): DetailStructure {
  const tabsRoot = container.querySelector(`[data-testid="${TABS_TESTID}"]`) ?? undefined;
  const aboveTabs = collect(container, tabsRoot);
  if (tabsRoot === undefined) return { aboveTabs, tabs: [] };
  const doc = container.ownerDocument;
  const tabs = [...tabsRoot.querySelectorAll('[role="tab"]')].map((trigger) => {
    // Панель ищется по `aria-controls` триггера: Radix ставит его и тогда, когда панель не
    // смонтирована (вкладка без keepMounted — «Тред»), и такая вкладка фиксируется только
    // подписью.
    const panelId = trigger.getAttribute('aria-controls');
    const panel = panelId === null ? null : doc.getElementById(panelId);
    return {
      label: (trigger.textContent ?? '').trim(),
      parts: panel === null ? [] : collect(panel),
    };
  });
  return { aboveTabs, tabs };
}
