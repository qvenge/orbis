import type { EntityCreateInput } from '../contracts/tools';
import { newId } from '../ids';
import { normalizeCounterparty } from '../import/normalize';

/**
 * `title` ОБЯЗАТЕЛЕН, хотя правило теперь ссылается на категорию ПО ID (В7): по названию
 * категорию по-прежнему ищет вторая ступень резолва — алиасы (`findCategory` сравнивает
 * слово входа со списком `aliases`, а сама категория показывается заголовком). Пропуск
 * ловится на typecheck, а не тишиной в резолве.
 */
export type FastPathCategory = {
  id: string;
  title: string;
  aliases: string[];
  spendClass?: string;
};
/**
 * Активное memory-правило владельца в форме, которую понимает applyMemoryRules. Все три
 * поля — ЗНАЧЕНИЯ СВОЙСТВ записи (В7), заголовок сюда не едет вовсе:
 *  - `pattern` — `orbis/rule_pattern`: текст, по которому правило узнаёт ввод. До реформы
 *    его выковыривал из заголовка парсер, и заголовок без разделителя означал молча
 *    мёртвое правило; теперь правило без образца незаписываемо (`memory/rules.ts`);
 *  - `targetId` — `orbis/rule_target`: id категории. ИМЕННО ID, а не название: правило
 *    переживает переименование категории, и второго резолва по строке здесь больше нет;
 *  - `updatedAt` — ISO-время правки правила (`WireEntity.updatedAt`); обязательно, потому
 *    что при конфликте двух правил с одним образцом побеждает САМОЕ СВЕЖЕЕ, и оба
 *    потребителя (быстрый ввод и резолв импорта) обязаны отвечать одинаково.
 */
export type FastPathRule = { pattern: string; targetId: string; updatedAt: string };

/**
 * Правило применимо к области: та же область ЛИБО правило глобально (области нет вовсе —
 * «пусто = глобально», реестр аспекта памяти).
 *
 * Предикат объявлен ЗДЕСЬ, потому что сторон у него две и они на разных языках: сервер
 * выражает его в SQL (`memory/select.ts`, `memoryRulesWhere`), клиент — этой функцией, и
 * запрос грамматики §А5-3 дизъюнкцию «равно ИЛИ отсутствует» выразить не может (скобок в
 * v1 нет). Отбирать одинаково они обязаны: расхождение здесь означает правило, которое
 * работает в импорте и не работает в быстром вводе, — ровно тот молчаливый разъезд, ради
 * которого предикат вообще стал общим. Схождение двух сторон пиннится тестом
 * (`memory/select.test.ts`) на одном наборе строк.
 *
 * Ключ, ПРИСУТСТВУЮЩИЙ со значением `null`, глобальным правилом НЕ считается: в SQL
 * `NOT props ? key` на нём ложно, и вторая сторона обязана отвечать так же.
 */
export function ruleAppliesTo(ruleScope: unknown, scope: string): boolean {
  return ruleScope === undefined ? true : ruleScope === scope;
}
export type FastPathCtx = {
  categories: FastPathCategory[];
  defaultCurrency: string;
  today?: string;
  /** Активные correction-правила владельца (§7.5); порядок списка на исход не влияет. */
  rules?: FastPathRule[];
};
export type FastPathResult =
  | { ok: true; create: EntityCreateInput }
  | { ok: false; reason: 'ambiguous' | 'unknown_category' | 'question' | 'no_match' };

const CURRENCY_TOKENS: Record<string, string> = {
  '₽': 'RUB',
  руб: 'RUB',
  р: 'RUB',
  rub: 'RUB',
  $: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
};
const QUESTION_WORDS = [
  'сколько',
  'что',
  'когда',
  'где',
  'какой',
  'какая',
  'why',
  'how',
  'what',
  'when',
];

function toDecimal2(raw: string): string {
  const norm = raw.replace(',', '.');
  const [i, f = ''] = norm.split('.');
  const frac = `${f}00`.slice(0, 2);
  return `${i}.${frac}`;
}

/**
 * Резолв категории по алиасам: первое слово, совпавшее с алиасом (регистр и хвостовая
 * пунктуация игнорируются); нет совпадения — null. Экспортируется, потому что тем же
 * словарём категоризирует строки CSV-ревью сервер (Task C2, 03-budget §3.4): второй
 * реализации сопоставления быть не должно.
 */
export function findCategory(words: string[], cats: FastPathCategory[]): FastPathCategory | null {
  const lw = words.map((w) => w.toLowerCase().replace(/[.,!?]/g, ''));
  for (const c of cats) {
    const aliases = c.aliases.map((a) => a.toLowerCase());
    if (lw.some((w) => aliases.includes(w))) return c;
  }
  return null;
}

/**
 * Correction-правила памяти (01-arch §7.5, §7.8): «правило „кофе → Развлечения“ работает
 * и в детерминированном пути, без LLM». Применяется ПЕРЕД резолвом по алиасам обоими
 * потребителями — fast-path-парсером и категоризацией строк CSV-ревью (Task D4, K12):
 * второй реализации правил быть не должно, иначе клиент и импорт разъедутся.
 *
 * Контракт:
 *  - вход и паттерн правила нормализуются ОДНОЙ И ТОЙ ЖЕ normalizeCounterparty (§3.4.1),
 *    поэтому «SBOL ПЯТЁРОЧКА 843» матчится правилом «пятерочка»; совпадение — вхождение
 *    паттерна в нормализованный вход ПО ГРАНИЦЕ ТОКЕНОВ: токены паттерна обязаны идти
 *    во входе подряд и целиком. Подстрочное сравнение (до уборочной фазы) ловило чужие
 *    слова — канонический пример спеки «бар → Развлечения» перехватывал «барбершоп», то
 *    есть правило активно портило категоризацию; соседняя ступень той же категоризации
 *    (резолв по алиасам, findCategory) всегда сравнивала по целому слову;
 *  - из подошедших побеждает САМОЕ СПЕЦИФИЧНОЕ — с самым длинным образцом; при равной
 *    длине — САМОЕ СВЕЖЕЕ по updatedAt, и только затем лексикография id категории
 *    (порядок обязан быть ПОЛНЫМ: web и сервер читают правила в разном порядке, и
 *    неполный порядок дал бы им разные ответы на одних и тех же данных).
 *    Свежесть здесь — не украшение: два активных правила с одним образцом и разными
 *    категориями штатно рождает эскалация §7.8 (её гейты пропускают новую пару категорий),
 *    и по алфавиту победило бы то СТАРОЕ правило, которое пользователь только что
 *    исправил, — «Запомнил» на экране, а быстрый ввод и импорт ставят прежнюю категорию;
 *  - правило ссылается на категорию ПО ID (`orbis/rule_target`, В7): переименование
 *    категории правило больше не отвязывает, и два одноимённых конверта различимы.
 *    Правило, чья категория не в словаре (заархивирована, снесена, не приехала в
 *    контекст), просто ИГНОРИРУЕТСЯ — пробуем следующее, затем алиасы;
 *  - правило с пустым образцом — не правило (записать такое нельзя, `memory/rules.ts`;
 *    ветка держит данные, записанные ДО fail-closed, и прямые записи в БД).
 */
/**
 * Токены паттерна идут во входе подряд и целиком. Обе строки уже нормализованы
 * normalizeCounterparty, то есть разделены ровно одним пробелом, — поэтому достаточно
 * поиска подстроки по строкам, обёрнутым пробелами: он и есть проверка границы токена
 * (и держит многословный паттерн «яндекс такси» как непрерывную последовательность).
 */
function matchesByToken(haystack: string, pattern: string): boolean {
  return ` ${haystack} `.includes(` ${pattern} `);
}

export function applyMemoryRules(
  input: string,
  rules: FastPathRule[],
  cats: FastPathCategory[],
): FastPathCategory | null {
  const haystack = normalizeCounterparty(input);
  if (haystack === '') return null;

  const matched: Array<{ updatedAt: string; pattern: string; targetId: string }> = [];
  for (const rule of rules) {
    // Образец нормализуется И ЗДЕСЬ, а не только на записи: его значение — обычное
    // текстовое свойство, и владелец вправе поправить его руками в любом регистре.
    const pattern = normalizeCounterparty(rule.pattern);
    if (pattern === '' || !matchesByToken(haystack, pattern)) continue;
    matched.push({ updatedAt: rule.updatedAt, pattern, targetId: rule.targetId });
  }
  matched.sort((a, b) => {
    if (a.pattern.length !== b.pattern.length) return b.pattern.length - a.pattern.length;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.targetId === b.targetId) return 0;
    return a.targetId < b.targetId ? -1 : 1;
  });

  for (const rule of matched) {
    const category = cats.find((c) => c.id === rule.targetId);
    if (category !== undefined) return category;
  }
  return null;
}

/**
 * ПОРЯДОК СТУПЕНЕЙ РЕЗОЛВА КАТЕГОРИИ — именованный параметр, а не порядок строк в двух
 * файлах (§7.5: «подтверждённое пользователем исправление обязано перекрывать словарь
 * категорий, иначе „кофе“ продолжит уходить в Еду»).
 *
 * ОСТАТОК C С НАЗВАННОЙ ГРАНИЦЕЙ (правило 5 §С1-4, «почему кодом»; R24). Порядок шагов
 * категоризации — это правило-данные, и в части Б его выражает декларация модуля. В срезе
 * А выражать его нечем: языка правил каталога ещё нет, а зашивать порядок дважды (в
 * быстром вводе и в резолве импорта) — ровно та вторая копия знания, которую реформа
 * убирает. Ступени разъезжались уже: резолв импорта до Task D4 знал ТОЛЬКО алиасы, и на
 * реальной выписке правила владельца в импорте не работали вовсе. Поэтому порядок —
 * ОДНА константа с двумя вызывающими; появится язык — переедет в декларацию целиком.
 */
export const RESOLVE_ORDER = ['rules', 'aliases'] as const;
export type ResolveStep = (typeof RESOLVE_ORDER)[number];

/**
 * Прогон ступеней резолва в порядке RESOLVE_ORDER. Ступени приходят ЛЕНИВЫМИ: вторая не
 * считается, если ответила первая, — иначе смена порядка меняла бы ещё и объём работы.
 */
export function resolveCategoryInOrder(
  steps: {
    [K in ResolveStep]: () => FastPathCategory | null;
  },
): FastPathCategory | null {
  for (const step of RESOLVE_ORDER) {
    const found = steps[step]();
    if (found !== null) return found;
  }
  return null;
}

export function parseFastPath(text: string, ctx: FastPathCtx): FastPathResult {
  const input = text.trim();
  if (!input) return { ok: false, reason: 'no_match' };

  const lower = input.toLowerCase();
  if (
    input.includes('?') ||
    QUESTION_WORDS.some((w) => new RegExp(`(^|\\s)${w}(\\s|$)`, 'i').test(lower))
  ) {
    return { ok: false, reason: 'question' };
  }

  // Отделяем прилипшие символы валют: "340₽" → "340 ₽".
  const spaced = input
    .replace(/([₽$€])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();

  const numberRe = /(^|\s)(\+)?(\d+(?:[.,]\d+)?)(?=\s|$)/g;
  const matches = [...spaced.matchAll(numberRe)];
  if (matches.length === 0) return { ok: false, reason: 'no_match' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };

  const m = matches[0];
  const rawNumber = m?.[3];
  if (rawNumber === undefined) return { ok: false, reason: 'no_match' };
  const income = m?.[2] === '+';
  const amount = toDecimal2(rawNumber);

  let currency = ctx.defaultCurrency;
  const textWords: string[] = [];
  for (const word of spaced.split(' ')) {
    const bare = word.replace(/^\+/, '');
    if (/^\d+(?:[.,]\d+)?$/.test(bare)) continue; // числовой токен
    const cur = CURRENCY_TOKENS[word.toLowerCase()];
    if (cur) {
      currency = cur;
      continue;
    }
    textWords.push(word);
  }

  const title = textWords.join(' ').trim();
  if (!title) return { ok: false, reason: 'no_match' };

  // Порядок ступеней — RESOLVE_ORDER, один на быстрый ввод и резолв импорта.
  const category = resolveCategoryInOrder({
    rules: () => applyMemoryRules(title, ctx.rules ?? [], ctx.categories),
    aliases: () => findCategory(textWords, ctx.categories),
  });
  if (!category) return { ok: false, reason: 'unknown_category' };

  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  // Новая форма создания (§А9-1/§А1-1): значения — `props` по id свойства, аспект — просто
  // тем, чем он и стал: пометкой в списке. Адреса здесь ИМЕННО id, а не `key`: у встроенных
  // свойств они совпадают, но быстрый путь — машинный, и резолв на границе ему не нужен.
  const create: EntityCreateInput = {
    id: newId(),
    title,
    tags: [],
    props: {
      'orbis/amount': amount,
      'orbis/direction': income ? 'income' : 'expense',
      'orbis/currency': currency,
      'orbis/occurred_on': today,
      'orbis/finance_category': category.id,
    },
    aspects: ['orbis/financial'],
  };
  return { ok: true, create };
}
