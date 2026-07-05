import type { EntityCreateInput } from '../contracts/tools';
import { newId } from '../ids';

export type FastPathCategory = { id: string; aliases: string[]; spendClass?: string };
export type FastPathCtx = {
  categories: FastPathCategory[];
  defaultCurrency: string;
  today?: string;
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

function findCategory(words: string[], cats: FastPathCategory[]): FastPathCategory | null {
  const lw = words.map((w) => w.toLowerCase().replace(/[.,!?]/g, ''));
  for (const c of cats) {
    const aliases = c.aliases.map((a) => a.toLowerCase());
    if (lw.some((w) => aliases.includes(w))) return c;
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

  const category = findCategory(textWords, ctx.categories);
  if (!category) return { ok: false, reason: 'unknown_category' };

  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const create: EntityCreateInput = {
    id: newId(),
    title,
    tags: [],
    aspects: {
      'orbis/financial': {
        amount,
        direction: income ? 'income' : 'expense',
        currency,
        occurred_on: today,
        category_ref: category.id,
      },
    },
  };
  return { ok: true, create };
}
