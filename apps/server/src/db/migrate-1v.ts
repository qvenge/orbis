// apps/server/src/db/migrate-1v.ts
// Прод-операция среза 1в `migrate-1v` (спека 1в §6.5, §6.6, §3.4, §3.7, §10, §18; РП-14, В-4, В-6, Д-9,
// Д-15, Э-6) — белый список `scripts/ops.ts`; здесь вся логика, гейт подтверждения и печать, в `ops.ts` —
// только обвязка (секрет из Ключницы, пул, печать): файл `ops.ts` исполняется при импорте, и проверить
// тестом можно только то, что лежит здесь (как `reset-world`, прежний `migrate-1b`).
//
// ПОРЯДОК НА ПРОДЕ (§10): `--report` → миграция `0023` → пересев реестров → код → `--apply`. Режимы:
//  - `--report` — только чтение, ДО миграции `0023`. РЕЕСТР НЕ ГРУЗИТСЯ: в базе ещё лежит встроенная строка
//    подписки `orbis/agenda`, а загрузчик реестра нового кода (схема подписки без движка `agenda`) её не
//    разберёт и уронит весь отчёт. Поэтому отчёт — сырые чтения и чистые функции (печать и статус
//    поставки, формы с токеном-границей), а транзакция — READ ONLY (запись в отчёте упадёт, а не запишет);
//  - `--drop-agenda-rows --i-understand` — удалить строки владельца с движком `agenda` и дельты на
//    `orbis/agenda` (§6.5: ненулевой счёт — СТОП, удаление — операцией по слову владельца ДО миграции);
//  - `--apply --i-understand` — перевод графа ОДНОЙ пачкой исполнителя (§6.6, Р-7, К-3): источник
//    `system` (запись журнала скрыта из ленты, Undo есть), механизм `supply` (писатель свойств эталона),
//    подпись В-4. Создаёт Повестку; в оболочке хоста Повестка встаёт на место Upcoming; «Год» — по статусу
//    поставки; Upcoming, если не правлена, — в архив. Прочие записи, настройки и лента не трогаются;
//  - `--undo <actionId> --i-understand` — отмена пачки перевода (запись скрыта из ленты, «отмени последнее»
//    системные действия пропускает — другого пути к Undo §6.6 у владельца нет);
//  - `--rehearsal` — к любому режиму: DSN из `ORBIS_REHEARSAL_DSN` вместо Ключницы, только локальная база
//    (`localhost`/`127.0.0.1`) — репетиция на дампе прода (ранбук §4.3).
//
// ПРИЗНАК «УЖЕ ПЕРЕВЕДЁН» — запись с `orbis/supply_key = agenda`, в том числе архивная: повтор `--apply` —
// ноль записей. UNDO ПАЧКИ — законный путь назад, но не «ещё раз с начала»: отмена архивирует Повестку
// (обратное созданию) и возвращает оболочку, «Год» и Upcoming к форме 1б; архивная Повестка остаётся
// признаком, и дальше граф идёт «Обновлениями» (Повестку предложат добавить, оболочку — принять).
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  BUILTIN_PROPERTY_META,
  type GraphId,
  newId,
  SUPPLY_ASPECT,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  PARAM_NAME_RE,
  type PageNode,
  paramDeclsOf,
  parsePageText,
} from '@orbis/shared/doc/page-grammar';
import {
  maskQuotedValues,
  QUERY_DATE_TOKENS,
  type QueryDateToken,
  type TokenBoundaryForm,
  tokenBoundaryForms,
} from '@orbis/shared/query';
import { etalonOf, type SupplyEtalon } from '@orbis/shared/supply';
import { supplyStatusOf } from '@orbis/shared/supply/print';
import { and, eq, sql } from 'drizzle-orm';
import type { ISql, Sql } from 'postgres';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { undoAction } from '../executor/undo';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { bumpOwnerRegistryVersion } from '../registry/version';
import type { ExecOperation } from '../routines/propose';
import { etalonHash } from '../supply/hash';
import {
  type ResolveSupplyKey,
  supplyCreateOps,
  supplyRecordId,
  supplyTextOf,
} from '../supply/records';
import { describeRoleAccess } from './backfill-body-doc';
import type { Db } from './client';
import { entities } from './schema';
import { withIdentity } from './with-identity';

/** Подпись записи журнала прод-операции (В-4): одна пачка, в ленте скрыта (`source: 'system'`). */
export const MIGRATE_1V_LABEL = 'Повестка вместо Upcoming (срез 1в)';

/**
 * Сырой клиент postgres.js — пул или транзакция (`sql.begin`): отчёт идёт без drizzle и без реестра, а
 * тест зовёт его внутри откатываемой транзакции со строкой прежней формы.
 */
export type SqlClient = ISql;

const sink = makeChatJournalSink();

/** Id встроенной подписки Повестки (снимает миграция `0023`) и её движок (§6.5). */
const AGENDA_SUBSCRIPTION = 'orbis/agenda';
const AGENDA_ENGINE = 'agenda';
/** Снятая поверхность Повестки (§6.5): запись действия на ней с 1в — отказ (R-22). */
const AGENDA_SURFACE = 'core/agenda';
const PROGRESS_SOURCE = 'orbis/progress_source';

/** Отказ `--apply` при встроенной строке `orbis/agenda` — один текст у операции и у её предусловия. */
export const AGENDA_ROW_PRESENT =
  'встроенная подписка orbis/agenda ещё в базе: сначала migrate (0023) и пересев реестров — порядок §10 спеки 1в';
/** Отказ `--apply` при строках и дельтах владельца на Повестку (§6.5: СТОП). */
export const AGENDA_OWNER_ROWS =
  'у графа есть подписки с движком agenda или дельты на orbis/agenda: сначала --drop-agenda-rows по слову владельца';

/**
 * Предел «Навигации» оболочки — `max` типа `orbis/app_nav` в реестре: навигация длиннее отвергла бы всю
 * пачку (финал 1б, B1 m-1). Вставка Повестки в полную навигацию не делается — оболочка остаётся как есть,
 * и новый эталон оболочки приходит владельцу обычным предложением «Обновлений».
 */
export const NAV_MAX: number = (() => {
  const t = BUILTIN_PROPERTY_META.find((p) => p.id === APP_NAV)?.type as
    | { max?: number }
    | undefined;
  return typeof t?.max === 'number' ? t.max : Number.POSITIVE_INFINITY;
})();

// ─────────────────────────────── отчёт ───────────────────────────────

/**
 * Где лежит дерево или текст с формой, чей смысл 1в меняет (§3.4). `entity_versions` (закреплённые версии)
 * и `journal_prior` (тела в журнале отката, `inverse[].payload.body`) — СПРАВОЧНО (Э-6, Д-9): переписать их
 * нельзя (это история), но восстановление версии или Undo вернёт дерево со старым смыслом.
 */
export type TokenBoundaryWhere =
  | 'body_doc'
  | 'body'
  | 'progress_source'
  | 'action_over'
  | 'entity_versions'
  | 'journal_prior';

export interface TokenBoundaryRow {
  where: TokenBoundaryWhere;
  id: string;
  /**
   * Хранилище внутри закреплённой версии (`entity_versions`): документ и текст одной версии — две строки, как
   * `body_doc`/`body` у записи, иначе формы одного блока задваивались бы в одной строке (гейт m-5).
   */
  store?: 'body_doc' | 'body';
  /** Только формы, чей смысл 1в меняет (`changed`) или делает отказом (`refused`); прежние не печатаются. */
  forms: TokenBoundaryForm[];
}

/**
 * Литерал в сохранённом ТЕКСТЕ запроса, который 1в читает иначе (переносы R-12 и M-3): незакавыченный
 * новый токен (`orbis/x=this_month` у text/select был литералом — теперь `TYPE`) и `$<имя>` вне
 * объявленного параметра страницы (старая печать `$` в кавычки не брала — теперь `TYPE`/`PAGE_ONLY`).
 */
export interface ReservedLiteralRow {
  where: 'body' | 'progress_source';
  id: string;
  literals: string[];
}

/**
 * План `--apply`. У переведённого (`agenda: 'exists'`) и незаведённого (`'unseeded'`: оболочки хоста нет ни
 * живой, ни архивной — мира нет, его заведёт вход владельца) графа пачки нет, и прочие поля — `keep`: план
 * говорит, что будет записано, а не что записалось бы на непереведённом графе (гейт m-2, m-3).
 */
export interface Migrate1vPlan {
  agenda: 'create' | 'exists' | 'unseeded';
  shellNav: 'replace' | 'insert-after-daily' | 'append' | 'keep';
  year: 'body+etalon' | 'etalon-only' | 'absent' | 'keep';
  /** `keep-referenced` — «как в поставке», но на неё ссылается навигация или домашняя приложения (`upcomingRefs`). */
  upcoming: 'archive' | 'keep' | 'keep-referenced' | 'absent';
}

export interface Migrate1vReport {
  graph: string;
  /** id строк `subscription_definitions` графа с движком `agenda` — ненулевой: СТОП (§6.5). */
  agendaOwnerSubscriptions: string[];
  /** id дельт графа на подписку `orbis/agenda` — ненулевой: СТОП (§6.5). */
  agendaDeltas: string[];
  /** id действий графа (все статусы) на поверхности `core/agenda` — владельцу (запись станет отказом). */
  coreAgendaActions: string[];
  tokenBoundaries: TokenBoundaryRow[];
  reservedLiterals: ReservedLiteralRow[];
  /** Записи с `progress_source.aggregate = latest` и `sortBy` в запросе — смысл «последнего» меняется (§3.7). */
  goalsLatestSorted: string[];
  /**
   * Приложения (свои и оболочка хоста), где Upcoming останется домашней или разделом ПОСЛЕ пачки (у оболочки
   * хоста пачка раздел заменяет Повесткой — такая ссылка не в счёт). Ненулевой — Upcoming не архивируется:
   * архив дал бы там плашку (§6.6 п. 4; Fable Minor-4).
   */
  upcomingRefs: string[];
  plan: Migrate1vPlan;
}

/** Размер порции keyset-выборки (как у `census-v3`): чтение корпуса без памяти на весь граф. */
const BATCH = 200;
const ID_START = '00000000-0000-0000-0000-000000000000';

/** Токены, которых до 1в не было: незакавыченные, они были литералом, теперь — токен (R-12). */
const PRE_1V_TOKENS: ReadonlySet<string> = new Set(['today', 'overdue', 'next_7d', 'after_7d']);
const TOKENS_1V: ReadonlySet<string> = new Set(
  QUERY_DATE_TOKENS.filter((t) => !PRE_1V_TOKENS.has(t)),
);
const TOKENS: ReadonlySet<string> = new Set(QUERY_DATE_TOKENS);

/** Место токена-границы в тексте: оператор сравнения → форма дерева канона (как у разбора). */
const COMPARE_NODE = {
  '<': (token: QueryDateToken) => ({ op: 'lt', value: { token } }),
  '>': (token: QueryDateToken) => ({ op: 'gt', value: { token } }),
  '<=': (token: QueryDateToken) => ({ op: 'range', value: { to: { token } } }),
  '>=': (token: QueryDateToken) => ({ op: 'range', value: { from: { token } } }),
} as const;

const SEPARATOR = /[\s,]/;

/** Режет строку по разделителю вне кавычек — по маске кавычек (длина маски = длина текста). */
function splitOutside(text: string, masked: string, isSep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (isSep(masked[i] as string)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((s) => s !== '');
}

/**
 * Разбор ТЕКСТА запроса без реестра — ровно столько, сколько нужно отчёту: формы с токеном-границей и
 * литералы R-12/M-3. Образец — `displayInText` переписи v3 (`census-v3.ts`): конструкция режется по
 * разделителю вне кавычек (маска `maskQuotedValues`), оператор ищется там же. Поле — только адрес
 * свойства или контракта (namespaced key с `/` либо подпись в кавычках): слова грамматики (`class=`,
 * `title=`, `sortBy=`) токенов и литералов значения не несут. Формы считает общая
 * `tokenBoundaryForms` над узлами канона той же формы, что строит разбор, — второй копии правила краёв нет.
 */
export function textQueryFindings(
  text: string,
  declaredParams: ReadonlySet<string> = new Set(),
): { forms: TokenBoundaryForm[]; literals: string[] } {
  const nodes: unknown[] = [];
  const literals: string[] = [];
  const masked = maskQuotedValues(text);
  let offset = 0;
  const parts: Array<{ text: string; masked: string }> = [];
  for (const raw of splitOutside(text, masked, (ch) => SEPARATOR.test(ch))) {
    const at = text.indexOf(raw, offset);
    offset = at + raw.length;
    parts.push({ text: raw, masked: masked.slice(at, at + raw.length) });
  }
  for (const part of parts) {
    let body = part.text;
    let mask = part.masked;
    if (body.startsWith('!') && body[1] !== '=') {
      body = body.slice(1);
      mask = mask.slice(1);
    }
    const idx = mask.search(/[=<>!]/);
    if (idx <= 0) continue;
    const key = body.slice(0, idx);
    if (!key.includes('/') && !key.startsWith('"')) continue;
    const ch = body[idx] as string;
    const next = body[idx + 1];
    const op =
      ch === '!' ? '!=' : (ch === '<' || ch === '>') && next === '=' ? `${ch}=` : (ch as string);
    const value = body.slice(idx + op.length);
    const valueMask = mask.slice(idx + op.length);
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (TOKENS.has(value)) {
        nodes.push({ prop: key, ...COMPARE_NODE[op](value as QueryDateToken) });
      }
      continue;
    }
    if (op !== '=' && op !== '!=') continue;
    const dots = valueMask.indexOf('..');
    if (op === '=' && dots !== -1) {
      const from = value.slice(0, dots);
      const to = value.slice(dots + 2);
      const range: Record<string, unknown> = {};
      if (TOKENS.has(from)) range.from = { token: from };
      if (TOKENS.has(to)) range.to = { token: to };
      if (Object.keys(range).length > 0) nodes.push({ prop: key, op: 'range', value: range });
      continue;
    }
    for (const el of splitOutside(value, valueMask, (c) => c === '|' || c === '&')) {
      const v = el.trim();
      if (v.startsWith('"')) continue;
      if (TOKENS_1V.has(v)) literals.push(`${key}${op}${v}`);
      else if (
        v.startsWith('$') &&
        PARAM_NAME_RE.test(v.slice(1)) &&
        !declaredParams.has(v.slice(1))
      ) {
        literals.push(`${key}${op}${v}`);
      }
    }
  }
  return { forms: tokenBoundaryForms(nodes), literals };
}

const meaningful = (forms: TokenBoundaryForm[]): TokenBoundaryForm[] =>
  forms.filter((f) => f.verdict !== 'same');

/** Тексты блоков данных тела (`{{query:…}}`) — препроходом грамматики страниц, на любой глубине. */
function queryTextsOf(nodes: readonly PageNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'query') out.push(node.text);
    else if (node.kind === 'columns')
      for (const part of node.parts) out.push(...queryTextsOf(part));
    else if (node.kind === 'tabs')
      for (const part of node.parts) out.push(...queryTextsOf(part.children));
  }
  return out;
}

/**
 * Находки в тексте тела: формы и литералы всех блоков данных; объявленные параметры — не литералы. Блоки
 * узнаёт ТОЛЬКО препроход грамматики страниц (`parsePageText`) — своей приметы `{{query:` здесь нет
 * (одна копия правил, `scripts/grammar-copies.test.ts`).
 */
export function bodyFindings(body: string): { forms: TokenBoundaryForm[]; literals: string[] } {
  const nodes = parsePageText(body);
  const declared = new Set(paramDeclsOf(nodes).keys());
  const forms: TokenBoundaryForm[] = [];
  const literals: string[] = [];
  for (const text of queryTextsOf(nodes)) {
    const f = textQueryFindings(text, declared);
    forms.push(...f.forms);
    literals.push(...f.literals);
  }
  return { forms, literals };
}

/** Дерево запроса в `progress_source` и его текстовая ветка `{text}` (неразобранный блок). */
function progressFindings(ps: unknown): {
  forms: TokenBoundaryForm[];
  literals: string[];
  latestSorted: boolean;
} {
  if (typeof ps !== 'object' || ps === null)
    return { forms: [], literals: [], latestSorted: false };
  const src = ps as { query?: unknown; aggregate?: unknown };
  const query = (typeof src.query === 'object' && src.query !== null ? src.query : {}) as {
    text?: unknown;
    sortBy?: unknown;
  };
  const forms = tokenBoundaryForms(src.query);
  let literals: string[] = [];
  let sorted = Array.isArray(query.sortBy) && query.sortBy.length > 0;
  if (typeof query.text === 'string') {
    const f = textQueryFindings(query.text);
    forms.push(...f.forms);
    literals = f.literals;
    sorted ||= /(?:^|[\s,])sortBy=/.test(maskQuotedValues(query.text));
  }
  return { forms, literals, latestSorted: src.aggregate === 'latest' && sorted };
}

/** Строка записи поставки — ровно то, что нужно плану (сырые чтения отчёта и чтение `--apply`). */
interface SupplyRow {
  id: string;
  title: string;
  emoji: string | null;
  body: string | null;
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  /** ISO-штамп — предусловие правок пачки; у отчёта не нужен. */
  updatedAt?: string;
}

/** Живое приложение графа (аспект «приложение»): его домашняя и навигация — ссылки места на Upcoming. */
interface AppRow {
  id: string;
  props: Record<string, unknown>;
}

interface PlanDetail {
  plan: Migrate1vPlan;
  upcomingRefs: string[];
  shell?: SupplyRow;
  /** Навигация оболочки после перевода (id), если меняется. */
  nav?: string[];
  year?: SupplyRow;
  upcoming?: SupplyRow;
  /** Ключ → id живой записи ПОСЛЕ перевода: Повестка — её id (создаётся той же пачкой). */
  resolveAfter: ResolveSupplyKey;
}

const keyOf = (r: SupplyRow): unknown => r.props[SUPPLY_KEY];
const isSupply = (r: SupplyRow): boolean => r.aspects.includes(SUPPLY_ASPECT);

/**
 * План перевода графа — ЧИСТЫЙ, по записям с ключом поставки (с архивными). Один на отчёт и на `--apply`:
 * то, что владелец прочёл в `--report`, и есть то, что запишет пачка.
 */
function planOf(graph: GraphId, rows: readonly SupplyRow[], apps: readonly AppRow[]): PlanDetail {
  const all = (k: string) => rows.filter((r) => keyOf(r) === k);
  const live = (k: string) => all(k).find((r) => !r.archived);
  const agendaId = supplyRecordId(graph, 'agenda');
  const resolveAfter: ResolveSupplyKey = (k) => (k === 'agenda' ? agendaId : (live(k)?.id ?? null));
  const upcomingIds = new Set(all('upcoming').map((r) => r.id));
  const idsIn = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  /** Приложения, где Upcoming — домашняя или раздел; `navAfter` — навигация приложения после пачки. */
  const refsTo = (navAfter: (a: AppRow) => string[]): string[] =>
    apps
      .filter(
        (a) =>
          upcomingIds.has(String(a.props[APP_HOME])) ||
          navAfter(a).some((id) => upcomingIds.has(id)),
      )
      .map((a) => a.id)
      .sort();
  const untouched = (a: AppRow) => idsIn(a.props[APP_NAV]);

  // Переведённый и незаведённый графы: пачки нет, и план говорит ровно это (гейт m-2, m-3).
  const agenda: Migrate1vPlan['agenda'] =
    all('agenda').length > 0 ? 'exists' : all('host-shell').length === 0 ? 'unseeded' : 'create';
  if (agenda !== 'create') {
    return {
      plan: { agenda, shellNav: 'keep', year: 'keep', upcoming: 'keep' },
      upcomingRefs: refsTo(untouched),
      resolveAfter,
    };
  }

  // п. 2 — оболочка хоста: только живая запись поставки (снятый аспект — решение владельца «вывести из
  // поставки», R-17: механизм в неё не пишет).
  const shell = live('host-shell');
  let shellNav: Migrate1vPlan['shellNav'] = 'keep';
  let nav: string[] | undefined;
  if (shell !== undefined && isSupply(shell)) {
    const now = idsIn(shell.props[APP_NAV]);
    const daily = live('daily-planning')?.id;
    const at = now.findIndex((id) => upcomingIds.has(id));
    if (at !== -1) {
      shellNav = 'replace';
      nav = now
        .map((id, i) => (i === at ? agendaId : id))
        .filter((id, i) => i === at || !upcomingIds.has(id));
    } else if (now.length < NAV_MAX) {
      const d = daily === undefined ? -1 : now.indexOf(daily);
      shellNav = d === -1 ? 'append' : 'insert-after-daily';
      nav = d === -1 ? [...now, agendaId] : [...now.slice(0, d + 1), agendaId, ...now.slice(d + 1)];
    }
  }

  // п. 3 — «Год»: отказ от обновления — только эталон; «как в поставке» (на эталоне 1б или прежнем) —
  // тело и эталон; «изменено вами» — только эталон (В-6).
  const y = live('horizon-year');
  const year: Migrate1vPlan['year'] =
    y === undefined || !isSupply(y)
      ? 'absent'
      : typeof y.props[SUPPLY_DECLINED] === 'string'
        ? 'etalon-only'
        : supplyStatusOf(y) === 'etalon'
          ? 'body+etalon'
          : 'etalon-only';

  // п. 4 — Upcoming: не правлена (запись поставки «как в поставке») и ни одно приложение не держит её
  // домашней или разделом после пачки — в архив; иначе остаётся страницей владельца. Ссылка оболочки хоста,
  // которую пачка заменяет Повесткой, не в счёт; оставшаяся (оболочка вне поставки, полная навигация,
  // домашняя) — в счёт (Fable Minor-4).
  const upcomingRefs = refsTo((a) =>
    shell !== undefined && a.id === shell.id && nav !== undefined ? nav : untouched(a),
  );
  const u = live('upcoming');
  const upcoming: Migrate1vPlan['upcoming'] =
    u === undefined
      ? 'absent'
      : !(isSupply(u) && supplyStatusOf(u) === 'etalon')
        ? 'keep'
        : upcomingRefs.length > 0
          ? 'keep-referenced'
          : 'archive';

  return {
    plan: { agenda, shellNav, year, upcoming },
    upcomingRefs,
    ...(shell !== undefined && { shell }),
    ...(nav !== undefined && { nav }),
    ...(y !== undefined && { year: y }),
    ...(u !== undefined && { upcoming: u }),
    resolveAfter,
  };
}

type RawRow = Record<string, unknown>;

async function idsOf(q: Promise<readonly RawRow[]>): Promise<string[]> {
  return (await q).map((r) => String(r.id));
}

/**
 * Отчёт `--report` по графу: только сырые чтения и чистые функции — РЕЕСТР НЕ ГРУЗИТСЯ (шапка файла).
 * Зовущий держит транзакцию READ ONLY (`runMigrate1v`).
 */
export async function reportMigrate1v(sql: SqlClient, graph: string): Promise<Migrate1vReport> {
  const g = graph.toLowerCase() as GraphId;
  const agendaOwnerSubscriptions = await idsOf(sql`
    SELECT id FROM subscription_definitions
     WHERE graph_id = ${g}::uuid AND definition ->> 'engine' = ${AGENDA_ENGINE} ORDER BY id`);
  const agendaDeltas = await idsOf(sql`
    SELECT id::text AS id FROM registry_deltas
     WHERE graph_id = ${g}::uuid AND target_kind = 'subscription' AND target_id = ${AGENDA_SUBSCRIPTION}
     ORDER BY id`);
  // Все статусы, включая `deprecated`: его откат тоже идёт через схему записи, и она откажет.
  const coreAgendaActions = await idsOf(sql`
    SELECT id FROM action_definitions
     WHERE graph_id = ${g}::uuid AND jsonb_typeof(offered_by) = 'array'
       AND offered_by @> ${JSON.stringify([{ surface: AGENDA_SURFACE }])}::jsonb
     ORDER BY id`);

  const tokenBoundaries: TokenBoundaryRow[] = [];
  const reservedLiterals: ReservedLiteralRow[] = [];
  const goalsLatestSorted: string[] = [];
  const push = (
    where: TokenBoundaryWhere,
    id: string,
    forms: TokenBoundaryForm[],
    store?: TokenBoundaryRow['store'],
  ): void => {
    const m = meaningful(forms);
    if (m.length > 0) tokenBoundaries.push({ where, id, ...(store && { store }), forms: m });
  };

  // Тела и источники прогресса записей — порциями по id. Деревья блоков — из `body_doc` одним путём
  // jsonpath (strict: `.**` в lax-режиме отдаёт узлы дважды), тексты — из `body`.
  for (let after = ID_START; ; ) {
    const rows = await sql`
      SELECT id::text AS id, body,
             COALESCE(jsonb_path_query_array(body_doc,
               'strict $.**?(@.type == "queryBlock" && exists(@.attrs.ast)).attrs.ast'), '[]'::jsonb) AS asts,
             props -> ${PROGRESS_SOURCE} AS ps
        FROM entities
       WHERE graph_id = ${g}::uuid AND id > ${after}::uuid
       ORDER BY id LIMIT ${BATCH}`;
    for (const r of rows) {
      const id = String(r.id);
      push('body_doc', id, tokenBoundaryForms(r.asts));
      if (typeof r.body === 'string') {
        const b = bodyFindings(r.body);
        push('body', id, b.forms);
        if (b.literals.length > 0)
          reservedLiterals.push({ where: 'body', id, literals: b.literals });
      }
      if (r.ps !== null && r.ps !== undefined) {
        const p = progressFindings(r.ps);
        push('progress_source', id, p.forms);
        if (p.literals.length > 0) {
          reservedLiterals.push({ where: 'progress_source', id, literals: p.literals });
        }
        if (p.latestSorted) goalsLatestSorted.push(id);
      }
    }
    if (rows.length < BATCH) break;
    after = String(rows[rows.length - 1]?.id);
  }

  for (const r of await sql`
    SELECT id, over FROM action_definitions
     WHERE graph_id = ${g}::uuid AND over IS NOT NULL ORDER BY id`) {
    push('action_over', String(r.id), tokenBoundaryForms(r.over));
  }

  // Справочно (Э-6): закреплённые версии тел и тела в журнале отката.
  for (let after = ID_START; ; ) {
    const rows = await sql`
      SELECT id::text AS id, body,
             COALESCE(jsonb_path_query_array(body_doc,
               'strict $.**?(@.type == "queryBlock" && exists(@.attrs.ast)).attrs.ast'), '[]'::jsonb) AS asts
        FROM entity_versions
       WHERE graph_id = ${g}::uuid AND id > ${after}::uuid
       ORDER BY id LIMIT ${BATCH}`;
    for (const r of rows) {
      push('entity_versions', String(r.id), tokenBoundaryForms(r.asts), 'body_doc');
      if (typeof r.body === 'string') {
        push('entity_versions', String(r.id), bodyFindings(r.body).forms, 'body');
      }
    }
    if (rows.length < BATCH) break;
    after = String(rows[rows.length - 1]?.id);
  }
  for (let after = ID_START; ; ) {
    const rows = await sql`
      SELECT m.id::text AS id,
             jsonb_path_query_array(m.metadata, 'lax $.actions[*].inverse[*].payload.body') AS bodies
        FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
       WHERE t.graph_id = ${g}::uuid AND m.metadata ? 'actions' AND m.id > ${after}::uuid
       ORDER BY m.id LIMIT ${BATCH}`;
    for (const r of rows) {
      const bodies = Array.isArray(r.bodies) ? r.bodies : [];
      const forms = bodies.flatMap((b) => (typeof b === 'string' ? bodyFindings(b).forms : []));
      push('journal_prior', String(r.id), forms);
    }
    if (rows.length < BATCH) break;
    after = String(rows[rows.length - 1]?.id);
  }

  const supply = (await sql`
    SELECT id::text AS id, title, emoji, body, aspects, props, archived FROM entities
     WHERE graph_id = ${g}::uuid AND props ? ${SUPPLY_KEY}`) as unknown as SupplyRow[];
  const apps = (await sql`
    SELECT id::text AS id, props FROM entities
     WHERE graph_id = ${g}::uuid AND aspects @> ARRAY[${APP_ASPECT}]::text[] AND NOT archived`) as unknown as AppRow[];
  const detail = planOf(g, supply, apps);

  return {
    graph: g,
    agendaOwnerSubscriptions,
    agendaDeltas,
    coreAgendaActions,
    tokenBoundaries,
    reservedLiterals,
    goalsLatestSorted,
    upcomingRefs: detail.upcomingRefs,
    plan: detail.plan,
  };
}

/** Встроенная строка `orbis/agenda` ещё в базе (миграция `0023` не накатана)? */
export async function agendaRowPresent(sql: SqlClient): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM subscription_definitions WHERE graph_id IS NULL AND id = ${AGENDA_SUBSCRIPTION}`;
  return rows.length > 0;
}

/** Предусловие `--apply`: встроенной строки `orbis/agenda` нет, иначе отказ «сначала migrate (0023)». */
export async function assertAgendaRowGone(sql: SqlClient): Promise<void> {
  if (await agendaRowPresent(sql)) {
    throw new ExecError('VALIDATION', AGENDA_ROW_PRESENT, { id: AGENDA_SUBSCRIPTION });
  }
}

/**
 * Удалить строки владельца с движком `agenda` и дельты на `orbis/agenda` ОДНОЙ транзакцией (§6.5) — по
 * слову владельца, ДО миграции. Вход — drizzle-клиент, а не сырой `SqlClient` брифа: версия реестра
 * владельца поднимается ТЕМ ЖЕ коммитом (`bumpOwnerRegistryVersion`, §А10-1 — иначе процесс держал бы
 * в кеше определение, которого в базе нет), а её единственная реализация — на drizzle.
 */
export async function dropAgendaRows(
  db: Db,
  graph: string,
): Promise<{ subscriptions: number; deltas: number; ids: string[] }> {
  const g = graph.toLowerCase() as GraphId;
  return db.transaction(async (tx) => {
    const subs = (await tx.execute(sql`
      DELETE FROM subscription_definitions
       WHERE graph_id = ${g}::uuid AND definition ->> 'engine' = ${AGENDA_ENGINE}
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const deltas = (await tx.execute(sql`
      DELETE FROM registry_deltas
       WHERE graph_id = ${g}::uuid AND target_kind = 'subscription' AND target_id = ${AGENDA_SUBSCRIPTION}
      RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    if (subs.length + deltas.length > 0) await bumpOwnerRegistryVersion(tx, g);
    return {
      subscriptions: subs.length,
      deltas: deltas.length,
      ids: [...subs.map((r) => r.id), ...deltas.map((r) => r.id)],
    };
  });
}

// ─────────────────────────────── перевод ───────────────────────────────

/** Операции пачки по плану (§6.6 п. 1–4); `reg` — реестр графа (канон тел и печать эталонов). */
function applyOps(
  graph: GraphId,
  d: PlanDetail,
  reg: Awaited<ReturnType<typeof effectiveRegistry>>,
): ExecOperation[] {
  const since = (r: SupplyRow) => [{ property: 'orbis/updated_at', in: [r.updatedAt] }];
  // п. 1 — Повестка с эталоном кода (механизм `supply` — писатель свойств эталона).
  const ops: ExecOperation[] = supplyCreateOps(graph, ['agenda'], d.resolveAfter, reg);

  // п. 2 — навигация оболочки и ЕЁ НОВЫЙ эталон. Печать эталона — резолвером, который ВИДИТ Повестку той
  // же пачки (ре-ревью задачи 9, правило `gainedPlaceRef`): иначе печать легла бы без Повестки, и
  // «Обновления» после операции снова предложили бы оболочку.
  if (d.shell !== undefined && d.nav !== undefined) {
    const e = etalonOf('host-shell');
    ops.push({
      tool: 'entity_update',
      input: {
        id: d.shell.id,
        precondition: since(d.shell),
        props: {
          [APP_NAV]: d.nav,
          [SUPPLY_HASH]: etalonHash(e),
          [SUPPLY_TEXT]: supplyTextOf(e, reg, d.resolveAfter),
        },
      },
    });
  }

  // п. 3 — «Год».
  if (d.year !== undefined && d.plan.year !== 'absent') {
    const e = etalonOf('horizon-year') as Extract<SupplyEtalon, { kind: 'page' | 'template' }>;
    const supply = {
      [SUPPLY_HASH]: etalonHash(e),
      [SUPPLY_TEXT]: supplyTextOf(e, reg, d.resolveAfter),
    };
    ops.push({
      tool: 'entity_update',
      input:
        d.plan.year === 'body+etalon'
          ? // Как «принять» механизма поставки, но без закрепления версии: тело владельцем не правлено,
            // сберегать нечего (его прежний текст хранит журнал для Undo).
            {
              id: d.year.id,
              expectedUpdatedAt: d.year.updatedAt,
              title: e.title,
              emoji: e.emoji,
              body: e.text,
              props: supply,
            }
          : { id: d.year.id, precondition: since(d.year), props: supply },
    });
  }

  // п. 4 — Upcoming не правлена: в архив (обратимо). Ссылок оболочки на неё уже нет (п. 2 выше).
  if (d.upcoming !== undefined && d.plan.upcoming === 'archive') {
    ops.push({
      tool: 'entity_update',
      input: { id: d.upcoming.id, precondition: since(d.upcoming), archived: true },
    });
  }
  return ops;
}

/**
 * Перевести граф: предусловия → план → ОДНА пачка исполнителя (`source: 'system'`, механизм `supply`,
 * `actorKind: 'owner'`, подпись В-4). Граф с записью Повестки (с архивной) — «уже переведён», граф без
 * оболочки хоста — «не заведён» (одинокая Повестка без мира была бы мусором; мир заведёт вход владельца уже
 * с Повесткой): оба — ноль записей.
 */
export async function applyMigrate1v(
  db: Db,
  who: Identity,
): Promise<{ actionId: string; plan: Migrate1vPlan } | { already: true } | { unseeded: true }> {
  const graph = who.graph;
  const read = await withIdentity(db, who, async (tx) => {
    // Предусловия — ДО загрузки реестра: и встроенная строка прежней формы, и подписка владельца с
    // движком `agenda` уронили бы загрузчик невнятной ошибкой разбора вместо шага процедуры.
    const builtin = await tx.execute(sql`
      SELECT 1 FROM subscription_definitions WHERE graph_id IS NULL AND id = ${AGENDA_SUBSCRIPTION}`);
    if (builtin.length > 0) {
      throw new ExecError('VALIDATION', AGENDA_ROW_PRESENT, { id: AGENDA_SUBSCRIPTION });
    }
    const own = await tx.execute(sql`
      SELECT id FROM subscription_definitions
       WHERE graph_id = ${graph}::uuid AND definition ->> 'engine' = ${AGENDA_ENGINE}
      UNION ALL
      SELECT id::text FROM registry_deltas
       WHERE graph_id = ${graph}::uuid AND target_kind = 'subscription' AND target_id = ${AGENDA_SUBSCRIPTION}`);
    if (own.length > 0) {
      throw new ExecError('VALIDATION', AGENDA_OWNER_ROWS, {
        graph,
        ids: own.map((r) => String(r.id)),
      });
    }
    const rows = await tx
      .select({
        id: entities.id,
        title: entities.title,
        emoji: entities.emoji,
        body: entities.body,
        aspects: entities.aspects,
        props: entities.props,
        archived: entities.archived,
        updatedAt: entities.updatedAt,
      })
      .from(entities)
      .where(and(eq(entities.graphId, graph), sql`${entities.props} ? ${SUPPLY_KEY}`));
    const apps = await tx
      .select({ id: entities.id, props: entities.props })
      .from(entities)
      .where(
        and(
          eq(entities.graphId, graph),
          eq(entities.archived, false),
          sql`${entities.aspects} @> ARRAY[${APP_ASPECT}]::text[]`,
        ),
      );
    const reg = await effectiveRegistry(tx, graph);
    return {
      apps: apps.map(
        (a): AppRow => ({ id: a.id, props: (a.props ?? {}) as Record<string, unknown> }),
      ),
      rows: rows.map(
        (r): SupplyRow => ({
          ...r,
          props: (r.props ?? {}) as Record<string, unknown>,
          updatedAt: r.updatedAt.toISOString(),
        }),
      ),
      reg,
    };
  });
  const detail = planOf(graph, read.rows, read.apps);
  if (detail.plan.agenda === 'exists') return { already: true };
  if (detail.plan.agenda === 'unseeded') return { unseeded: true };
  const r = await execute(
    db,
    {
      identity: who,
      actorKind: 'owner',
      source: 'system',
      mechanism: 'supply',
      batchId: newId(),
      batchLabel: MIGRATE_1V_LABEL,
      operations: applyOps(graph, detail, read.reg),
    },
    { sink },
  );
  if (!r.ok) throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  return { actionId: r.actionId, plan: detail.plan };
}

/**
 * Отменить пачку перевода (Fable I-1): запись журнала скрыта из ленты (`source: 'system'`), а «отмени
 * последнее» системные действия пропускает (`executor/undo.ts`) — у владельца другого пути к Undo §6.6 нет.
 * Механизм тот же, что у любого Undo (`undoAction`: обратные операции одной пачкой, отметка «отменено» в
 * журнале); отменяется ТОЛЬКО пачка этой операции — запись журнала графа с источником `system` и подписью
 * В-4. `{found: false}` — в журнале графа такого действия нет (операция обходит графы).
 */
export async function undoMigrate1v(
  db: Db,
  who: Identity,
  actionId: string,
): Promise<{ undone: true } | { found: false }> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const meta = await withIdentity(db, who, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT m.metadata FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
       WHERE t.graph_id = ${who.graph}::uuid AND m.metadata @> ${probe}::jsonb LIMIT 1`);
    return rows[0]?.metadata as
      | { actions?: Array<{ source?: string }>; cards?: Array<{ title?: string }> }
      | undefined;
  });
  if (meta === undefined) return { found: false };
  if (meta.actions?.[0]?.source !== 'system' || meta.cards?.[0]?.title !== MIGRATE_1V_LABEL) {
    throw new ExecError(
      'VALIDATION',
      `действие ${actionId} — не пачка migrate-1v («${MIGRATE_1V_LABEL}»): эта операция отменяет только её`,
      { actionId },
    );
  }
  const r = await undoAction(db, { identity: who, actionId });
  if (!r.ok) throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  return { undone: true };
}

// ─────────────────────────────── печать ───────────────────────────────

const PLAN_WORD = {
  agenda: {
    create: 'создать «Повестка»',
    exists: '«Повестка» уже есть — граф переведён, --apply ничего не запишет',
    unseeded:
      'граф не заведён (оболочки хоста нет) — --apply его пропустит; мир с Повесткой заведёт вход владельца',
  },
  shellNav: {
    replace: 'Повестка на месте Upcoming',
    'insert-after-daily': 'Upcoming в навигации нет — Повестка после Daily Planning',
    append: 'ни Upcoming, ни Daily Planning в навигации нет — Повестка в конец',
    keep: 'не трогается (граф переведён или не заведён; оболочки нет, она выведена из поставки или навигация полна — новый эталон придёт «Обновлениями»)',
  },
  year: {
    'body+etalon': 'как в поставке — тело и эталон новые',
    'etalon-only': 'изменено вами или отказ от обновления — только эталон, тело не трогается (В-6)',
    absent: 'записи поставки нет — не трогается',
    keep: 'не трогается (граф переведён или не заведён)',
  },
  upcoming: {
    archive: 'не правлена — в архив (обратимо)',
    keep: 'правлена (или граф переведён/не заведён) — не трогается',
    'keep-referenced':
      'не правлена, но приложения держат её домашней или разделом — не архивируется (иначе там была бы плашка)',
    absent: 'записи нет — не трогается',
  },
} as const;

const FORM_TEXT = { lt: '<', gt: '>', gte: '>= (from)', lte: '<= (to)' } as const;
const VERDICT_TEXT = {
  changed: 'смысл меняется',
  refused: 'станет отказом',
  same: 'прежний',
} as const;
const WHERE_TEXT: Record<TokenBoundaryWhere, string> = {
  body_doc: 'документ тела',
  body: 'текст тела',
  progress_source: 'источник прогресса',
  action_over: 'over действия',
  entity_versions: 'закреплённая версия (справочно)',
  journal_prior: 'тело в журнале отката (справочно)',
};

/** СТОП процедуры (§6.5, §10 п. 1): строки или дельты владельца на подписку Повестки. */
export function reportStops(r: Migrate1vReport): boolean {
  return r.agendaOwnerSubscriptions.length > 0 || r.agendaDeltas.length > 0;
}

/** Отчёт графа — строками, как их прочтёт владелец. */
export function formatMigrate1vReport(r: Migrate1vReport): string[] {
  const out = [`граф ${r.graph}:`];
  const list = (ids: readonly string[]) =>
    ids.length === 0 ? '0' : `${ids.length}: ${ids.join(', ')}`;
  out.push(`  подписки графа с движком agenda: ${list(r.agendaOwnerSubscriptions)}`);
  out.push(`  дельты на ${AGENDA_SUBSCRIPTION}: ${list(r.agendaDeltas)}`);
  if (reportStops(r)) {
    out.push(
      '  СТОП (§6.5): до миграции 0023 — --drop-agenda-rows --i-understand по слову владельца',
    );
  }
  out.push(`  действия графа на ${AGENDA_SURFACE}: ${list(r.coreAgendaActions)}`);
  if (r.coreAgendaActions.length > 0) {
    out.push('    владельцу: поверхность снята — их запись и откат с 1в получат отказ');
  }
  const own = r.tokenBoundaries.filter(
    (t) => t.where !== 'entity_versions' && t.where !== 'journal_prior',
  );
  const ref = r.tokenBoundaries.filter((t) => !own.includes(t));
  out.push(`  формы с токеном-границей, чей смысл меняется (§3.4): ${own.length}`);
  for (const t of [...own, ...ref]) {
    const forms = t.forms
      .map((f) => `${FORM_TEXT[f.form]}${f.token} — ${VERDICT_TEXT[f.verdict]}`)
      .join('; ');
    const store =
      t.store === undefined ? '' : ` (${t.store === 'body_doc' ? 'документ' : 'текст'})`;
    out.push(`    ${WHERE_TEXT[t.where]}${store} ${t.id}: ${forms}`);
  }
  out.push(
    `  литералы, которые 1в читает иначе (новые токены, $имя без параметра): ${r.reservedLiterals.length}`,
  );
  for (const l of r.reservedLiterals) out.push(`    ${l.where} ${l.id}: ${l.literals.join(', ')}`);
  out.push(`  цели с «последним» и sortBy (§3.7): ${list(r.goalsLatestSorted)}`);
  out.push(
    `  приложения, где Upcoming останется домашней или разделом после --apply: ${list(r.upcomingRefs)}`,
  );
  if (r.plan.upcoming === 'keep-referenced') {
    out.push(
      '    владельцу: Upcoming из-за них не архивируется — уберите ссылки сами, если она не нужна',
    );
  }
  out.push('  план --apply (одна пачка, источник system):');
  out.push(`    Повестка: ${PLAN_WORD.agenda[r.plan.agenda]}`);
  out.push(`    навигация хоста: ${PLAN_WORD.shellNav[r.plan.shellNav]}`);
  out.push(`    «Год»: ${PLAN_WORD.year[r.plan.year]}`);
  out.push(`    Upcoming: ${PLAN_WORD.upcoming[r.plan.upcoming]}`);
  return out;
}

// ─────────────────────────────── обвязка ops.ts ───────────────────────────────

export type Migrate1vMode = 'report' | 'apply' | 'drop' | 'undo';

export type Migrate1vGate =
  | { proceed: true; mode: Migrate1vMode; rehearsal: boolean; actionId?: string }
  | { proceed: false; code: number; lines: string[] };

const USAGE = [
  '  bun scripts/ops.ts migrate-1v --report                           # только чтение, до миграции 0023',
  '  bun scripts/ops.ts migrate-1v --drop-agenda-rows --i-understand  # удалить подписки/дельты владельца на Повестку',
  '  bun scripts/ops.ts migrate-1v --apply --i-understand             # перевод: одна пачка на граф',
  '  bun scripts/ops.ts migrate-1v --undo <actionId> --i-understand   # отменить пачку перевода',
  '  ORBIS_REHEARSAL_DSN=<DSN локальной базы> bun scripts/ops.ts migrate-1v --rehearsal <режим>',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Подтверждение: ровно один режим; пишущие (`--apply`, `--drop-agenda-rows`, `--undo <actionId>`) — только с
 * `--i-understand`; `--rehearsal` — к любому режиму. Незнакомый флаг — отказ, а не «пропустим» (как
 * `resetWorldGate`): опечатка иначе означала бы согласие, которого не давали. Отказ — кодом 2 ДО чтения DSN
 * и базы.
 */
export function migrate1vGate(args: readonly string[]): Migrate1vGate {
  const refuse = (line: string): Migrate1vGate => ({
    proceed: false,
    code: 2,
    lines: [line, ...USAGE],
  });
  const flags = new Set<string>();
  let actionId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === '--undo') {
      const v = args[i + 1];
      if (v === undefined || !UUID_RE.test(v)) {
        return refuse('migrate-1v: --undo ждёт id действия пачки (uuid из печати --apply).');
      }
      actionId = v;
      flags.add(a);
      i += 1;
      continue;
    }
    if (
      !['--report', '--apply', '--drop-agenda-rows', '--i-understand', '--rehearsal'].includes(a)
    ) {
      return refuse(`migrate-1v: неизвестный аргумент «${a}».`);
    }
    flags.add(a);
  }
  const modes = (['--report', '--apply', '--drop-agenda-rows', '--undo'] as const).filter((m) =>
    flags.has(m),
  );
  if (modes.length === 0) return refuse('migrate-1v: укажите режим.');
  if (modes.length > 1) return refuse(`migrate-1v: режим один, а указано: ${modes.join(', ')}.`);
  const understand = flags.has('--i-understand');
  const rehearsal = flags.has('--rehearsal');
  if (modes[0] === '--report') {
    if (understand) {
      return refuse('migrate-1v: --report ничего не пишет — --i-understand не нужен.');
    }
    return { proceed: true, mode: 'report', rehearsal };
  }
  if (!understand) {
    return refuse(`migrate-1v: ${modes[0]} пишет в базу — нужно подтверждение --i-understand.`);
  }
  if (modes[0] === '--undo') return { proceed: true, mode: 'undo', rehearsal, actionId };
  return { proceed: true, mode: modes[0] === '--apply' ? 'apply' : 'drop', rehearsal };
}

/** Хосты репетиции: только локальная база (Д-15). */
const REHEARSAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Отказ DSN репетиции или `null`. Хост — после ПОСЛЕДНЕГО `@` (пароль может содержать `@`), до порта или
 * пути; хост в параметрах (`?host=`) и несколько хостов через запятую — отказ: их разбирает драйвер, и
 * сторож, прочитавший «localhost» в одном месте, пустил бы на прод через другое.
 */
export function rehearsalDsnRefusal(dsn: string | undefined): string | null {
  const local = 'migrate-1v: репетиция — только локальная база (localhost или 127.0.0.1)';
  if (dsn === undefined || dsn.trim() === '') {
    return 'migrate-1v: --rehearsal без ORBIS_REHEARSAL_DSN — DSN локальной базы репетиции не задан';
  }
  const m = /^postgres(?:ql)?:\/\/(.*)$/.exec(dsn.trim());
  if (m === null) return `${local}: DSN не postgres://…`;
  const rest = m[1] as string;
  const authority = rest.slice(rest.lastIndexOf('@') + 1);
  const host = /^([^:/?#]*)/.exec(authority)?.[1] ?? '';
  const query = authority.includes('?') ? authority.slice(authority.indexOf('?')) : '';
  if (!REHEARSAL_HOSTS.has(host) || /[?&]host=/i.test(query))
    return `${local}; получен хост «${host}»`;
  return null;
}

/** Ввод-вывод операции — инъекция, как у `reset-world` (тест без Ключницы и без прода). */
export interface Migrate1vIo {
  /** Прод-DSN из Ключницы; значение не логируется ни при каком исходе. Не зовётся при `--rehearsal`. */
  readDsn(): string;
  /** `ORBIS_REHEARSAL_DSN` (в `ops.ts` — из окружения). */
  rehearsalDsn(): string | undefined;
  /** Пул: сырой клиент (отчёт) и drizzle (перевод, удаление). Зовётся ТОЛЬКО после подтверждения. */
  open(dsn: string): { sql: Sql; db: Db; close(): Promise<void> };
  /** Пары «граф, владелец» (в `ops.ts` — `identitiesForScheduler`: графы со строкой настроек). */
  identities(db: Db): Promise<Identity[]>;
  log(line: string): void;
  error(line: string): void;
}

/** Печать `--apply` до пачки: как отменить и чем отмена является (шапка файла). */
export const UNDO_NOTE =
  'Отмена: bun scripts/ops.ts migrate-1v --undo <действие> --i-understand — оболочка, «Год» и Upcoming вернутся ' +
  'к форме 1б, Повестка уйдёт в архив; повторный --apply после отмены — «уже переведён», дальше — «Обновления». ' +
  'Полный откат — восстановление дампа (ранбук §4.3).';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Операция целиком: подтверждение → DSN (Ключница или репетиция) → режим по каждому графу → печать. Код 0 —
 * всё прошло; 1 — СТОП отчёта, сбой графа, предусловия или роли; 2 — отказ подтверждения или DSN.
 */
export async function runMigrate1v(args: readonly string[], io: Migrate1vIo): Promise<number> {
  const gate = migrate1vGate(args);
  if (!gate.proceed) {
    for (const line of gate.lines) io.error(line);
    return gate.code;
  }
  const candidate = io.rehearsalDsn();
  let dsn: string;
  if (gate.rehearsal) {
    const refusal = rehearsalDsnRefusal(candidate);
    if (refusal !== null) {
      io.error(refusal);
      return 2;
    }
    dsn = candidate as string;
    io.log('репетиция: локальная база из ORBIS_REHEARSAL_DSN');
  } else if (candidate !== undefined && candidate.trim() !== '') {
    // Оператор, задавший DSN репетиции и забывший флаг, иначе ушёл бы в прод через Ключницу, думая, что
    // репетирует (Fable Minor-2).
    io.error(
      'migrate-1v: переменная репетиции ORBIS_REHEARSAL_DSN задана без --rehearsal — ' +
        'добавьте --rehearsal или уберите переменную (прод идёт только без неё).',
    );
    return 2;
  } else {
    dsn = io.readDsn();
  }
  const { sql: pool, db, close } = io.open(dsn);
  let failed = 0;
  try {
    if (gate.mode === 'report' || gate.mode === 'drop') {
      // Сырой пул мимо идентичности: под FORCE RLS роль без BYPASSRLS видит ноль строк молча — отчёт из
      // нулей выглядел бы как «всё чисто», а удаление ничего бы не удалило (Fable Minor-1; образец —
      // `censusV3Op`).
      const who = await describeRoleAccess(db);
      if (!who.bypassRls) {
        io.error(
          `migrate-1v: роль ${who.role} НЕ несёт BYPASSRLS — под FORCE RLS она видит ноль строк, ` +
            'и счёты были бы ложными нулями. Нужен DSN роли с BYPASSRLS (на Supabase — postgres).',
        );
        return 1;
      }
    }
    if (gate.mode === 'apply') {
      try {
        await assertAgendaRowGone(pool);
      } catch (e) {
        io.error(`migrate-1v: ${message(e)}`);
        return 1;
      }
    } else if (gate.mode === 'report') {
      io.log(
        (await agendaRowPresent(pool))
          ? 'встроенная подписка orbis/agenda в базе — миграция 0023 ещё не накатана (так и должно быть до неё)'
          : 'встроенной подписки orbis/agenda нет — миграция 0023 накатана',
      );
    }
    const whos = await io.identities(db);
    if (whos.length === 0) io.log('графов со строкой настроек нет — делать нечего');
    if (gate.mode === 'apply' && whos.length > 0) io.log(UNDO_NOTE);
    let undone = 0;
    for (const who of whos) {
      // Сбой одного графа печатается и считается в код 1; прочие графы идут дальше.
      try {
        if (gate.mode === 'report') {
          const r = await pool.begin('read only', (tx) => reportMigrate1v(tx, who.graph));
          for (const line of formatMigrate1vReport(r)) io.log(line);
          if (reportStops(r)) failed += 1;
        } else if (gate.mode === 'drop') {
          const r = await dropAgendaRows(db, who.graph);
          io.log(
            `граф ${who.graph}: удалено подписок ${r.subscriptions}, дельт ${r.deltas}` +
              (r.ids.length > 0 ? ` (${r.ids.join(', ')})` : ''),
          );
        } else if (gate.mode === 'undo') {
          const r = await undoMigrate1v(db, who, gate.actionId as string);
          if ('undone' in r) {
            undone += 1;
            io.log(`граф ${who.graph}: пачка ${gate.actionId} отменена`);
          }
        } else {
          const out = await applyMigrate1v(db, who);
          if ('already' in out) {
            io.log(`граф ${who.graph}: уже переведён (Повестка есть) — ничего не записано`);
          } else if ('unseeded' in out) {
            io.log(
              `граф ${who.graph}: не заведён (оболочки хоста нет) — пропущен, ничего не записано`,
            );
          } else {
            io.log(
              `граф ${who.graph}: переведён одной пачкой — действие ${out.actionId} («${MIGRATE_1V_LABEL}»); ` +
                `навигация: ${PLAN_WORD.shellNav[out.plan.shellNav]}; «Год»: ${PLAN_WORD.year[out.plan.year]}; ` +
                `Upcoming: ${PLAN_WORD.upcoming[out.plan.upcoming]}`,
            );
          }
        }
      } catch (e) {
        failed += 1;
        io.error(`граф ${who.graph}: ${message(e)}`);
      }
    }
    if (gate.mode === 'undo' && undone === 0 && failed === 0) {
      io.error(
        `migrate-1v: действия ${gate.actionId} нет в журнале ни одного графа — отменять нечего`,
      );
      failed += 1;
    }
    if (gate.mode === 'report') io.log('\nРежим --report: ничего не записано.');
  } finally {
    await close();
  }
  return failed === 0 ? 0 : 1;
}
