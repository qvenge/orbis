/**
 * Выбор шаблона записи (спека среза 1а §4.2) и запись выбора владельца в споре (§4.3).
 *
 * Чистые функции без БД и без зависимостей: их зовёт любой клиент (экран записи, меню «⋯»),
 * и ответ «чем показать запись» у всех клиентов обязан совпадать. Логика неочевидна (ничьи,
 * противоречия, новый участник, сломанный шаблон) — поэтому она здесь, а не в экране, и закрыта
 * таблицей случаев С1а-3 (`choose-template.test.ts`).
 */
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY } from '../constants';

export interface TemplateCandidate {
  id: string;
  forAspects: readonly string[]; // S(t) — значение «Шаблон для»
  winsOver: readonly string[]; // значение «Главнее, чем»
  createdAt: string; // ISO
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

/** Строки entity.query (aspect=orbis/page, has=orbis/template_for) → кандидаты; пустой набор — не шаблон. */
export function templatesFromRows(
  rows: readonly { id: string; props: Record<string, unknown>; createdAt: string }[],
): TemplateCandidate[] {
  const out: TemplateCandidate[] = [];
  for (const row of rows) {
    const forAspects = strings(row.props[TEMPLATE_FOR_PROPERTY]);
    // Пустой «Шаблон для» — просто страница (§3.2): шаблоном она не участвует.
    if (forAspects.length === 0) continue;
    // Самоссылку правило §3.2 запрещает, но данные, внесённые до правила, могли её сохранить.
    const winsOver = strings(row.props[TEMPLATE_WINS_OVER_PROPERTY]).filter((id) => id !== row.id);
    out.push({ id: row.id, forAspects, winsOver, createdAt: row.createdAt });
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
 * Шаг 5: w покрывает всех прочих из M своим «Главнее, чем», и никто из M не объявлен главнее w.
 * Самоссылка ничего не решает: «прочие» — без w, так что `w ∈ w.winsOver` не покрывает никого и
 * не делает w побеждённым, — функция устойчива и в обход `templatesFromRows`.
 */
function winnerOf(m: readonly TemplateCandidate[]): TemplateCandidate | null {
  for (const w of m) {
    const others = m.filter((x) => x.id !== w.id);
    const covers = others.every((x) => w.winsOver.includes(x.id));
    const beaten = others.some((x) => x.winsOver.includes(w.id));
    if (covers && !beaten) return w;
  }
  return null;
}

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
