/**
 * Выбор шаблона записи (спека среза 1а §4.2) и запись выбора владельца в споре (§4.3).
 *
 * Чистые функции без БД и без зависимостей: их зовёт любой клиент (экран записи, меню «⋯»),
 * и ответ «чем показать запись» у всех клиентов обязан совпадать. Логика неочевидна (ничьи,
 * противоречия, новый участник, сломанный шаблон) — поэтому она здесь, а не в экране, и закрыта
 * таблицей случаев С1а-3 (`choose-template.test.ts`).
 */
import {
  HOME_PROPERTY,
  PAGE_ASPECT,
  SUPPLY_KEY,
  TEMPLATE_FOR_PROPERTY,
  TEMPLATE_WINS_OVER_PROPERTY,
} from '../constants';
// Только тип: значение ключа — литерал ниже, чтобы модуль остался без зависимостей (корню не тяжёл).
import type { SupplyKey } from '../supply/etalons';

export interface TemplateCandidate {
  id: string;
  forAspects: readonly string[]; // S(t) — значение «Шаблон для»
  winsOver: readonly string[]; // значение «Главнее, чем»
  createdAt: string; // ISO
  /** «Дом» (срез 1б §4.3): приложение, которому шаблон принадлежит; `null` — хост (шаблоны владельца 1а). */
  home: string | null;
}
export interface ChoiceSubject {
  aspects: readonly string[];
}
export interface BrokenTemplate {
  id: string;
  reason: string;
}
export type TemplateChoice =
  | { kind: 'own-body' }
  | {
      kind: 'template';
      id: string;
      dispute: readonly string[] | null;
      broken: readonly BrokenTemplate[];
    }
  | { kind: 'host'; broken: readonly BrokenTemplate[] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Шаблон хоста (срез 1б §9.2) опознаётся ключом эталона, а не свойством: он запасной, а не
 * кандидат — рендерер берёт его сам, когда выбор ответил `host`. Окажись он среди кандидатов со
 * своим «Шаблон для», он спорил бы с шаблонами владельца и приложений как равный.
 */
const HOST_TEMPLATE_KEY: SupplyKey = 'host-template';

/**
 * Строки entity.query (aspect=orbis/page, has=orbis/template_for) → кандидаты; пустой набор — не
 * шаблон; строка шаблона хоста — не кандидат (§9.2).
 */
export function templatesFromRows(
  rows: readonly { id: string; props: Record<string, unknown>; createdAt: string }[],
): TemplateCandidate[] {
  const out: TemplateCandidate[] = [];
  for (const row of rows) {
    if (row.props[SUPPLY_KEY] === HOST_TEMPLATE_KEY) continue;
    // Набор, а не список (§4.2 шаг 4: |S(t)| — мощность набора): повторы значение принимает
    // (`uniqueItems` в схеме нет, core-тул их пропустит), и `[task, task, task]` иначе «переигрывал»
    // бы `[task, project]` по длине (финальное ревью, A-M1).
    const forAspects = [...new Set(strings(row.props[TEMPLATE_FOR_PROPERTY]))];
    // Пустой «Шаблон для» — просто страница (§3.2): шаблоном она не участвует.
    if (forAspects.length === 0) continue;
    // Самоссылку правило §3.2 запрещает, но данные, внесённые до правила, могли её сохранить.
    const winsOver = strings(row.props[TEMPLATE_WINS_OVER_PROPERTY]).filter((id) => id !== row.id);
    // «Дом» — одна ссылка (id строкой); что угодно другое (пусто, мусор) читается как хост.
    const rawHome = row.props[HOME_PROPERTY];
    const home = typeof rawHome === 'string' && rawHome !== '' ? rawHome : null;
    out.push({ id: row.id, forAspects, winsOver, createdAt: row.createdAt, home });
  }
  return out;
}

const subset = (s: readonly string[], of: readonly string[]) => s.every((a) => of.includes(a));
const earliest = (a: TemplateCandidate, b: TemplateCandidate) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id) ? a : b;

/** Шаги 2 и 4: подходящие (S(t) ⊆ A(R), не сломанные) с наибольшим |S(t)| — это M. */
function largest(
  subject: ChoiceSubject,
  templates: readonly TemplateCandidate[],
  broken: ReadonlySet<string>,
) {
  const fit = templates.filter(
    (t) => t.forAspects.length > 0 && !broken.has(t.id) && subset(t.forAspects, subject.aspects),
  );
  const max = Math.max(0, ...fit.map((t) => t.forAspects.length));
  return fit.filter((t) => t.forAspects.length === max);
}

/**
 * Шаг 5: w покрывает всех прочих из M своим списком побеждённых, и никто из M не объявлен главнее w.
 * Самоссылка ничего не решает: «прочие» — без w, так что `w ∈ winsOver(w)` не покрывает никого и
 * не делает w побеждённым, — функция устойчива и в обход `templatesFromRows`.
 *
 * Общая для спора шаблонов («Главнее, чем», §4.2 1а) и спора мест («Открывать вместо», срез 1б
 * §5.3): память выбора там устроена зеркально, и две копии логики разошлись бы на первой правке
 * (противоречие, новый участник).
 */
export function winnerAmong<T extends { id: string }>(
  m: readonly T[],
  winsOver: (x: T) => readonly string[],
): T | null {
  for (const w of m) {
    const others = m.filter((x) => x.id !== w.id);
    const covers = others.every((x) => winsOver(w).includes(x.id));
    const beaten = others.some((x) => winsOver(x).includes(w.id));
    if (covers && !beaten) return w;
  }
  return null;
}

const winnerOf = (m: readonly TemplateCandidate[]) => winnerAmong(m, (t) => t.winsOver);

/** §4.2 шаги 1–7; шаг 8 (базовый вид) — забота рендерера, когда не отрисовался шаблон хоста. */
export function chooseTemplate(
  subject: ChoiceSubject,
  templates: readonly TemplateCandidate[],
  isBroken: (id: string) => string | null,
): TemplateChoice {
  if (subject.aspects.includes(PAGE_ASPECT)) return { kind: 'own-body' };
  const broken: BrokenTemplate[] = [];
  const brokenIds = new Set<string>();
  // Цикл конечен: каждый оборот либо возвращает, либо навсегда исключает ещё один шаблон.
  for (;;) {
    const m = largest(subject, templates, brokenIds);
    if (m.length === 0) return { kind: 'host', broken };
    const w = m.length === 1 ? m[0] : winnerOf(m);
    // Шаг 6: победителя нет — показ детерминированный, раньше созданный (при равенстве — по id).
    const pick = w ?? m.reduce(earliest);
    const reason = isBroken(pick.id);
    if (reason === null) {
      return {
        kind: 'template',
        id: pick.id,
        dispute: w === null ? m.map((t) => t.id).sort() : null,
        broken,
      };
    }
    broken.push({ id: pick.id, reason });
    brokenIds.add(pick.id); // шаг 7: исключить и выбрать заново с шага 2
  }
}

/**
 * M — спорящие по наибольшему набору (после исключения сломанных), если их больше одного; иначе null.
 * Запомненный выбор спорящих не отменяет: меню «Сменить выбор» показывает плашку и при нём (§4.3).
 * У страницы спора нет — шаг 1 раньше шагов 4–5.
 */
export function contendersOf(
  subject: ChoiceSubject,
  templates: readonly TemplateCandidate[],
  brokenIds: ReadonlySet<string> = new Set(),
): readonly string[] | null {
  if (subject.aspects.includes(PAGE_ASPECT)) return null;
  const m = largest(subject, templates, brokenIds);
  return m.length > 1 ? m.map((t) => t.id).sort() : null;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * §4.3: новые значения «Главнее, чем» для победителя и спорящих; id вне `templates` вычищаются (РП-21).
 *
 * Вычистка — не уборка ради уборки: архивный или снятый шаблон в значении `ref` сервер отвергает
 * («цель архивна»), и вместе с ним — всю пачку выбора. Самоссылка из данных до правила §3.2
 * вычищается по той же причине. В карту попадают только изменившиеся шаблоны — пачка не пишет
 * лишнего, и повторный выбор того же победителя даёт пустую карту.
 */
export function recordDisputeChoice(
  winner: string,
  contenders: readonly string[],
  templates: readonly TemplateCandidate[],
): ReadonlyMap<string, string[]> {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const w = byId.get(winner);
  if (w === undefined) {
    throw new Error(`победитель спора ${winner} не среди шаблонов: выбор записать нельзя`);
  }
  const keep = (self: string, ids: readonly string[]) => {
    const seen = new Set<string>();
    return ids.filter((id) => {
      if (id === self || !byId.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const out = new Map<string, string[]>();
  const next = keep(winner, [...w.winsOver, ...contenders]);
  if (!sameList(next, w.winsOver)) out.set(winner, next);
  for (const id of contenders) {
    const c = byId.get(id);
    if (c === undefined || id === winner) continue;
    const cleaned = keep(
      id,
      c.winsOver.filter((x) => x !== winner),
    );
    if (!sameList(cleaned, c.winsOver)) out.set(id, cleaned);
  }
  return out;
}
