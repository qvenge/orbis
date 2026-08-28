import type { EntityCreateInput } from '../contracts/tools';
import { newId } from '../ids';
import { normalizeCounterparty } from '../import/normalize';
import { parseRuleTitle } from '../memory/rule';

/**
 * `title` ОБЯЗАТЕЛЕН: правило памяти ссылается на категорию НАЗВАНИЕМ (§7.8, D3a), и
 * категория без title для applyMemoryRules неотличима от несуществующей — правило по ней
 * молча игнорировалось бы. Все точки сборки контекста title кладут, так что обязательность
 * ничего не ломает, зато пропуск ловится на typecheck, а не тишиной в резолве.
 */
export type FastPathCategory = {
  id: string;
  title: string;
  aliases: string[];
  spendClass?: string;
};
/**
 * Активное memory-правило владельца (`orbis/memory`, `kind=rule`, `scope=orbis/financial`)
 * в форме, которую понимает applyMemoryRules:
 *  - `title` — КАК ЕСТЬ: вся машиночитаемая часть правила живёт в заголовке, и разбирает
 *    его только applyMemoryRules — вызывающий парсингом не занимается;
 *  - `updatedAt` — ISO-время правки правила (`WireEntity.updatedAt`); обязательно, потому
 *    что при конфликте двух правил с одинаковым паттерном побеждает САМОЕ СВЕЖЕЕ, и оба
 *    потребителя (fast-path и резолв импорта) обязаны отвечать одинаково.
 */
export type FastPathRule = { title: string; updatedAt: string };
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
 *  - из подошедших побеждает САМОЕ СПЕЦИФИЧНОЕ — с самым длинным паттерном; при равной
 *    длине — САМОЕ СВЕЖЕЕ по updatedAt, и только затем лексикография заголовка (порядок
 *    обязан быть полным: web и сервер читают правила в разном порядке).
 *    Свежесть здесь — не украшение: два активных правила с одним паттерном и разными
 *    категориями штатно рождает эскалация §7.8 (её гейты пропускают новую пару категорий),
 *    и по алфавиту победило бы то СТАРОЕ правило, которое пользователь только что
 *    исправил, — «Запомнил» на экране, а быстрый ввод и импорт ставят прежнюю категорию;
 *  - правило ссылается на категорию названием (id в правиле нет): резолв по title
 *    категории через ту же нормализацию; правило с ненайденной категорией просто
 *    ИГНОРИРУЕТСЯ (пробуем следующее, затем алиасы) — переименование категории не
 *    имеет права ронять резолв;
 *  - нераспознанный заголовок (нет стрелки, пустой паттерн) — не правило.
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

  const matched: Array<{
    title: string;
    updatedAt: string;
    pattern: string;
    categoryTitle: string;
  }> = [];
  for (const rule of rules) {
    const parsed = parseRuleTitle(rule.title);
    if (parsed === null) continue;
    const pattern = normalizeCounterparty(parsed.pattern);
    if (pattern === '' || !matchesByToken(haystack, pattern)) continue;
    matched.push({
      title: rule.title,
      updatedAt: rule.updatedAt,
      pattern,
      categoryTitle: parsed.categoryTitle,
    });
  }
  matched.sort((a, b) => {
    if (a.pattern.length !== b.pattern.length) return b.pattern.length - a.pattern.length;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.title === b.title) return 0;
    return a.title < b.title ? -1 : 1;
  });

  for (const rule of matched) {
    const wanted = normalizeCounterparty(rule.categoryTitle);
    if (wanted === '') continue;
    const category = cats.find((c) => normalizeCounterparty(c.title) === wanted);
    if (category !== undefined) return category;
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

  // Правила памяти — ДО алиасов (§7.5): подтверждённое пользователем исправление
  // обязано перекрывать словарь категорий, иначе «кофе» продолжит уходить в Еду.
  const category =
    applyMemoryRules(title, ctx.rules ?? [], ctx.categories) ??
    findCategory(textWords, ctx.categories);
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
