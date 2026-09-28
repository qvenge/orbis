/**
 * ТОКЕНЫ ДАТ И ДВА КРАЯ (спека 1в §3.4) — одно правило для всех восьми токенов языка.
 *
 * У каждого токена есть НАЧАЛО и КОНЕЦ — календарные дни, включительно (таблица краёв §3.4). Форма
 * условия читает свой край: `=T` — оба (`[начало; конец]`), `<T` — «раньше начала», `>=T` (граница
 * `from` диапазона) — «не раньше начала», `>T` — «позже конца», `<=T` (граница `to`) — «не позже
 * конца». Края нет (`overdue` без начала, `after_7d` без конца) — сравнение с ним отказ `TOKEN_EDGE`
 * и при разборе текста, и при компиляции дерева, пришедшего мимо разбора.
 *
 * ПОЧЕМУ ОДНА ФУНКЦИЯ, а не таблица в каждом читателе. Края считают компилятор (SQL условия),
 * окно материализации повторов и перепись деревьев до выкатки. До 1в у них было две копии правила
 * «якоря» (`compile-ast.ts`, `materialize.ts`), и `<next_7d` значило «< сегодня+7», хотя `=next_7d`
 * начинается сегодня. Третья копия разошлась бы с двумя на первом новом токене.
 *
 * Даты — строковая календарная арифметика дома монорепо (`date.ts`, целые дни без пояса): пояс уже
 * учтён в `today` — «сегодня» владельца зовущий считает сам (`todayInTimeZone`).
 *
 * Файл — ЛИСТ канона: зависит только от `ast.ts` и `date.ts`, реестра не знает, поэтому едет в
 * браузер вместе с разбором (`@orbis/shared/query`) — словарь подписей читает конструктор запросов.
 */
import {
  addDays,
  epochDays,
  fromParts,
  lastDayOfMonth,
  mondayIndex,
  partsFromEpochDays,
  toParts,
} from '../date';
import { QUERY_DATE_TOKENS, type QueryDateToken } from './ast';

/**
 * Начало недели для `this_week`. В 1в — константа «понедельник» у зовущего (спека §3.4); настройка
 * владельца `weekStartDay` уже есть (Д-18), читать ли её — вопрос владельцу В-1. Параметром, а не
 * константой здесь: ответ на В-1 — правка одной строки у зовущего, а не этого файла.
 */
export type WeekStart = 'monday' | 'sunday';

/**
 * Подписи токенов — ОДИН словарь (РП-17): переключатель параметра, конструктор запросов и печать
 * берут их отсюда; прежний список web (`DATE_TOKEN_LABELS`) снят. Порядок ключей — порядок языка
 * (`QUERY_DATE_TOKENS`): по нему строится список выбора.
 */
export const QUERY_DATE_TOKEN_LABELS: Readonly<Record<QueryDateToken, string>> = {
  today: 'сегодня',
  overdue: 'просрочено',
  next_7d: '7 дней',
  after_7d: 'позже 7 дней',
  this_week: 'эта неделя',
  next_14d: '14 дней',
  this_month: 'этот месяц',
  last_month: 'прошлый месяц',
};

/** Края токена: дни `YYYY-MM-DD` включительно; `null` — края нет. */
export interface TokenEdges {
  start: string | null;
  end: string | null;
}

/** Первый и последний день месяца со сдвигом `shift` от месяца дня `day`. */
function monthEdges(day: string, shift: number): TokenEdges {
  const { y, m } = toParts(day);
  const index = y * 12 + (m - 1) + shift;
  const yy = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return {
    start: fromParts({ y: yy, m: mm, d: 1 }),
    end: fromParts({ y: yy, m: mm, d: lastDayOfMonth(yy, mm) }),
  };
}

/**
 * Края токена по «сегодня» владельца — таблица спеки §3.4, норматив:
 *
 * | токен        | начало                 | конец                          |
 * |--------------|------------------------|--------------------------------|
 * | `today`      | сегодня                | сегодня                        |
 * | `overdue`    | —                      | сегодня−1                      |
 * | `next_7d`    | сегодня                | сегодня+7                      |
 * | `next_14d`   | сегодня                | сегодня+14                     |
 * | `after_7d`   | сегодня+8              | —                              |
 * | `this_week`  | первый день недели     | последний день недели          |
 * | `this_month` | 1-е                    | последний день месяца          |
 * | `last_month` | 1-е прошлого           | последний день прошлого месяца |
 */
export function tokenEdges(token: QueryDateToken, today: string, weekStart: WeekStart): TokenEdges {
  switch (token) {
    case 'today':
      return { start: today, end: today };
    case 'overdue':
      return { start: null, end: addDays(today, -1) };
    case 'next_7d':
      return { start: today, end: addDays(today, 7) };
    case 'next_14d':
      return { start: today, end: addDays(today, 14) };
    case 'after_7d':
      return { start: addDays(today, 8), end: null };
    case 'this_week': {
      const days = epochDays(toParts(today));
      // `mondayIndex` — 0 у понедельника; с воскресенья неделя начинается на день раньше.
      const back = weekStart === 'monday' ? mondayIndex(days) : (mondayIndex(days) + 1) % 7;
      const start = fromParts(partsFromEpochDays(days - back));
      return { start, end: addDays(start, 6) };
    }
    case 'this_month':
      return monthEdges(today, 0);
    case 'last_month':
      return monthEdges(today, -1);
  }
}

/**
 * Форма условия с токеном: `eq` — `=T` (и `!=T` — его отрицание), `lt` — `<T`, `gte` — `>=T`
 * (граница `from`), `gt` — `>T`, `lte` — `<=T` (граница `to`). Какой край читает форма: `=` —
 * оба; `<` и `>=` — начало; `>` и `<=` — конец.
 */
export type TokenForm = 'eq' | 'lt' | 'gte' | 'gt' | 'lte';

export function edgeOf(form: TokenForm): 'both' | 'start' | 'end' {
  switch (form) {
    case 'eq':
      return 'both';
    case 'lt':
    case 'gte':
      return 'start';
    case 'gt':
    case 'lte':
      return 'end';
  }
}

/**
 * День, по которому проверяется существование края: у какого токена какого края нет, от «сегодня»
 * не зависит (`overdue` без начала, `after_7d` без конца), и спрашивать зовущего о дате ради этого
 * незачем.
 */
const PROBE_DAY = '2026-01-01';

/**
 * Каких краёв у токенов НЕТ — те же `null` таблицы `tokenEdges`, названные отдельно ради веса:
 * разбор (он в первом кадре экрана записи) спрашивает только о существовании края, и календарная
 * арифметика `tokenEdges` в браузерный чанк из-за этого не едет. Согласие двух мест пиннит тест
 * (`tokens.test.ts`: и таблица краёв, и перечень отказных форм).
 */
const MISSING_EDGE: Readonly<Partial<Record<QueryDateToken, 'start' | 'end'>>> = {
  overdue: 'start',
  after_7d: 'end',
};

/**
 * Читает ли форма край, которого у токена нет. `=` не отказывает никогда: открытый край у него —
 * одностороннее сравнение (`=overdue` — «не позже вчера»).
 */
export function tokenEdgeMissing(token: QueryDateToken, form: TokenForm): boolean {
  return MISSING_EDGE[token] === edgeOf(form);
}

const FORM_TEXT: Readonly<Record<TokenForm, string>> = {
  eq: "'='",
  lt: "'<'",
  gte: "'>=' (граница from)",
  gt: "'>'",
  lte: "'<=' (граница to)",
};

/**
 * Отказ сравнения с несуществующим краем — один текст у разбора (`TOKEN_EDGE`) и у компилятора
 * (`VALIDATION`, `reason: 'TOKEN_EDGE'`), с подсказкой, какие формы годятся.
 */
export const TOKEN_EDGE_MESSAGE = (token: QueryDateToken, form: TokenForm): string =>
  edgeOf(form) === 'start'
    ? `у токена ${token} нет начала — ${FORM_TEXT[form]} сравнивает с началом периода; ` +
      `годятся '=', '>' и '<=' (читают конец) или другой токен`
    : `у токена ${token} нет конца — ${FORM_TEXT[form]} сравнивает с концом периода; ` +
      `годятся '=', '<' и '>=' (читают начало) или другой токен`;

/**
 * Форма с токеном-границей в сохранённом дереве и что с её смыслом стало с 1в (перепись §3.4):
 * `same` — прежний, `changed` — другой, `refused` — теперь отказ (края нет).
 */
export interface TokenBoundaryForm {
  token: QueryDateToken;
  form: Exclude<TokenForm, 'eq'>;
  verdict: 'changed' | 'refused' | 'same';
}

/**
 * Прежний «якорь» токена в роли границы (правило до 1в, `tokenAnchor` компилятора и окна): день,
 * вокруг которого токен определён, — смещение от сегодня. Токенов 1в в таблице нет: до 1в их не
 * было, и сохранённого дерева с прежним смыслом у них быть не может.
 */
const PRE_1V_ANCHOR: Partial<Readonly<Record<QueryDateToken, number>>> = {
  today: 0,
  overdue: 0,
  next_7d: 7,
  after_7d: 7,
};

function verdictOf(token: QueryDateToken, form: Exclude<TokenForm, 'eq'>): TokenBoundaryForm {
  if (tokenEdgeMissing(token, form)) return { token, form, verdict: 'refused' };
  const anchor = PRE_1V_ANCHOR[token];
  if (anchor === undefined) return { token, form, verdict: 'same' };
  const edge = tokenEdges(token, PROBE_DAY, 'monday')[edgeOf(form) as 'start' | 'end'];
  return { token, form, verdict: edge === addDays(PROBE_DAY, anchor) ? 'same' : 'changed' };
}

const TOKENS: ReadonlySet<string> = new Set(QUERY_DATE_TOKENS);

/** Токен значения `{token}`; литерал и чужая форма — `null`. */
function tokenOf(value: unknown): QueryDateToken | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const token = (value as { token?: unknown }).token;
  return typeof token === 'string' && TOKENS.has(token) ? (token as QueryDateToken) : null;
}

/**
 * Формы с токеном-границей в дереве — для переписи до выкатки (задача 13, `--report`): `<T`, `>T`,
 * границы `from`/`to` диапазона. `=`/`!=` — не граница (смысл `=` у прежних токенов не менялся).
 *
 * Вход — ЛЮБОЙ JSON: `attrs.ast` блока тела, значение `orbis/progress_source`, `over` действия, узел
 * без корня. Обход — по ФОРМЕ узла (`{prop, op, value}`), а не по полю: адрес контракта в `prop`
 * учитывается наравне со свойством, реестр не нужен. Порядок выдачи — порядок обхода в глубину
 * (у диапазона — сначала `from`).
 */
// ОБХОДЧИК-Q: token-boundary
export function tokenBoundaryForms(ast: unknown): TokenBoundaryForm[] {
  const out: TokenBoundaryForm[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const rec = node as Record<string, unknown>;
    if ('prop' in rec && typeof rec.op === 'string') {
      if (rec.op === 'lt' || rec.op === 'gt') {
        const token = tokenOf(rec.value);
        if (token !== null) out.push(verdictOf(token, rec.op));
      } else if (rec.op === 'range' && typeof rec.value === 'object' && rec.value !== null) {
        const range = rec.value as { from?: unknown; to?: unknown };
        const from = tokenOf(range.from);
        if (from !== null) out.push(verdictOf(from, 'gte'));
        const to = tokenOf(range.to);
        if (to !== null) out.push(verdictOf(to, 'lte'));
      }
      return;
    }
    for (const child of Object.values(rec)) visit(child);
  };
  visit(ast);
  return out;
}
