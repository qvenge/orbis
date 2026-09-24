// Стенд §С8-30 — приёмочные сценарии и их критерии (перенос `.superpowers/probe/p3/scenarios.ts`).
//
// ОТКУДА СЦЕНАРИИ (П3 §0.1). Двенадцать сценариев таблицы П3 §3 собраны по двум нормативным
// опорам: четыре сценария живой пробы 2026-08-06 §2.1 (цель sum, цель count, страховка, чипы) и
// по одному на каждый нормативный блок промпта (одна сущность на намерение, дата → срок +
// расписание, только дедлайн, бюджет, «могу позволить», грамматика тегов, запрет выдуманных
// uuid, горизонты, правка найденного, инструкции аспекта рутины). Реплики и смысл критериев —
// дословно те же, что в П3: иначе 34/36 П3 не с чем было бы сравнивать.
//
// ЧТО ПОМЕНЯЛА РЕФОРМА. Значения лежат плоско по key свойства (`orbis/finance_category` вместо
// `category_ref`, `orbis/routine_mode` вместо `mode`), аспекты — списком, мешка `meta` нет;
// источник прогресса цели — дерево Q-AST, а не строка. Поэтому предикаты судят о РАЗОБРАННОМ
// дереве запроса (`TraceQuery.ast`), а не о тексте: «tags=» и `{tag: …}` — один и тот же отбор.
//
// Критерий каждого сценария — механический предикат по трассе исполнителя, а не мнение.
import type { QueryFilterNode } from '@orbis/shared/query';
import { SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../apps/server/src/ai/suggestions.ts';
import type { Trace } from './runner.ts';
import { CAT_TRANSPORT, TASK_GIFT, type WorldEntity } from './world.ts';

export interface Verdict {
  pass: boolean;
  fails: string[];
  notes: string[];
}

export interface Scenario {
  id: string;
  title: string;
  /** Нормативный блок — столбец таблицы П3 §3. */
  block: string;
  /**
   * Канал: чат — реплика владельца; рутина — та же реплика телом рутины-триггера
   * (`world.ts`, `triggerBody`), и ход открывает сам канал («Сработала рутина …»).
   */
  channel: 'chat' | 'routine';
  turns: string[];
  check: (t: Trace) => Verdict;
}

function created(t: Trace): WorldEntity[] {
  const seeded = new Set(t.seeded);
  return t.entities.filter((e) => !seeded.has(e.id));
}
function names(t: Trace): string[] {
  return t.calls.map((c) => c.name);
}
function carrying(t: Trace, aspectId: string): WorldEntity[] {
  return created(t).filter((e) => e.aspects.includes(aspectId));
}
function badQueries(t: Trace) {
  return t.calls.flatMap((c) => c.queries.filter((q) => !q.ok));
}
function refused(t: Trace) {
  return t.calls.filter((c) => c.error?.startsWith('VALIDATION'));
}
function num(text: string, value: number): boolean {
  const norm = text.replace(/[\s  ]/g, '');
  return norm.includes(String(value));
}

/** Все узлы дерева фильтра — плоским списком (порядок обхода не важен предикатам). */
export function nodesOf(node: QueryFilterNode | null | undefined): QueryFilterNode[] {
  if (node === null || node === undefined) return [];
  if ('and' in node) return [node, ...node.and.flatMap(nodesOf)];
  if ('or' in node) return [node, ...node.or.flatMap(nodesOf)];
  if ('not' in node) return [node, ...nodesOf(node.not)];
  return [node];
}

/** Узлы всех разобранных запросов трассы, по одному списку на запрос. */
function queryNodes(t: Trace, tools?: readonly string[]): QueryFilterNode[][] {
  return t.calls
    .filter((c) => tools === undefined || tools.includes(c.name))
    .flatMap((c) => c.queries)
    .filter((q) => q.ok && q.ast !== undefined)
    .map((q) => nodesOf(q.ast?.filter));
}
const hasAspect = (ns: QueryFilterNode[], id: string) =>
  ns.some((n) => 'aspect' in n && n.aspect === id);
const hasTag = (ns: QueryFilterNode[], tag: string) => ns.some((n) => 'tag' in n && n.tag === tag);
const hasPropEq = (ns: QueryFilterNode[], prop: string, value: string) =>
  ns.some((n) => 'prop' in n && n.prop === prop && n.op === 'eq' && n.value === value);

function verdict(fails: string[], notes: string[] = []): Verdict {
  return { pass: fails.length === 0, fails, notes };
}

/** Общие для всех сценариев отметки: чипы, отказы стадии 2, неразбираемые запросы. */
export function commonNotes(t: Trace): string[] {
  const out: string[] = [];
  for (const turn of t.turns) {
    if (!turn.converged) out.push('НЕ СОШЁЛСЯ за потолок шагов');
    else if (t.channel === 'routine')
      continue; // у раннера рутины блока продолжений нет
    else if (turn.chips === null) out.push('чипов нет');
    else {
      if (turn.chips.length > SUGGESTIONS_MAX)
        out.push(`чипов ${turn.chips.length} > ${SUGGESTIONS_MAX}`);
      if (turn.chips.some((c) => [...c].length > SUGGESTION_MAX_LEN)) {
        out.push(`чип длиннее ${SUGGESTION_MAX_LEN}`);
      }
    }
  }
  const val = refused(t);
  if (val.length > 0) out.push(`отказов стадии 2: ${val.length} (${val[0]?.error})`);
  const bad = badQueries(t);
  if (bad.length > 0) out.push(`неразбираемых запросов: ${bad.length} («${bad[0]?.text}»)`);
  return out;
}

/** Дублирующий attach аспекта, уже переданного в entity_create того же хода (Д2 v4). */
function duplicateAttach(t: Trace): string[] {
  const passed = new Set<string>();
  const out: string[] = [];
  for (const c of t.calls) {
    if (c.name === 'entity_create' && Array.isArray(c.args.aspects)) {
      for (const a of c.args.aspects) passed.add(String(a));
    }
    if (c.aspect !== undefined && passed.has(c.aspect)) out.push(`дублирующий ${c.name}`);
  }
  return out;
}

interface ProgressSource {
  aggregate?: unknown;
  field?: unknown;
  query?: { filter?: QueryFilterNode | null };
}

function goalOf(t: Trace): { goals: WorldEntity[]; source?: ProgressSource; goal?: WorldEntity } {
  const goals = carrying(t, 'orbis/goal');
  const goal = goals[0];
  return {
    goals,
    goal,
    source: goal?.props['orbis/progress_source'] as ProgressSource | undefined,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'goal-sum',
    title: 'Цель, ветка sum (field обязателен) + отбор по тегу в источнике прогресса',
    block: 'Цели; шпаргалка грамматики (Д1 пробы 06.08)',
    channel: 'chat',
    turns: [
      'хочу накопить 300000 рублей на отпуск, отслеживай прогресс по моим доходам с тегом savings',
    ],
    check: (t) => {
      const fails: string[] = [];
      const { goals, goal, source } = goalOf(t);
      if (goals.length !== 1) fails.push(`сущностей с orbis/goal: ${goals.length}, ожидалась 1`);
      if (created(t).length !== 1)
        fails.push(`создано сущностей: ${created(t).length}, ожидалась 1`);
      if (goal === undefined || source === undefined) return verdict([...fails, 'цель не создана']);
      if (source.aggregate !== 'sum')
        fails.push(`aggregate=${String(source.aggregate)}, ожидался sum`);
      if (typeof source.field !== 'string' || source.field === '')
        fails.push('field при sum не передан');
      if (goal.props['orbis/current_value'] !== undefined)
        fails.push('orbis/current_value заполнен моделью');
      const target = goal.props['orbis/target_value'];
      if (!/^\d+(\.\d+)?$/.test(String(target)))
        fails.push(`orbis/target_value=${String(target)} не decimal-строка`);
      if (!hasTag(nodesOf(source.query?.filter), 'savings')) {
        fails.push(
          `в источнике прогресса нет отбора по тегу savings (${JSON.stringify(source.query)})`,
        );
      }
      const bad = badQueries(t);
      if (bad.length > 0) fails.push(`запрос не разбирается: «${bad[0]?.text}»`);
      fails.push(...duplicateAttach(t));
      return verdict(fails);
    },
  },
  {
    id: 'goal-count',
    title: 'Цель, ветка count (field запрещён)',
    block: 'Цели; дискриминация союза',
    channel: 'chat',
    turns: ['цель: прочитать 24 книги за год, считай по заметкам с тегом book'],
    check: (t) => {
      const fails: string[] = [];
      const { goals, goal, source } = goalOf(t);
      if (goals.length !== 1) fails.push(`сущностей с orbis/goal: ${goals.length}, ожидалась 1`);
      if (goal === undefined || source === undefined) return verdict([...fails, 'цель не создана']);
      if (source.aggregate !== 'count')
        fails.push(`aggregate=${String(source.aggregate)}, ожидался count`);
      if (source.field !== undefined) fails.push('field передан при count (союз нарушен)');
      if (goal.props['orbis/current_value'] !== undefined)
        fails.push('orbis/current_value заполнен моделью');
      const bad = badQueries(t);
      if (bad.length > 0) fails.push(`запрос не разбирается: «${bad[0]?.text}»`);
      fails.push(...duplicateAttach(t));
      return verdict(fails);
    },
  },
  {
    id: 'one-entity-insurance',
    title: 'Страховка 12000 до пятницы — ОДНА сущность, сумма не потеряна',
    block: 'Одна сущность на намерение; ссылка на категорию',
    channel: 'chat',
    turns: ['оплатить страховку 12000 до пятницы'],
    check: (t) => {
      const fails: string[] = [];
      const made = created(t);
      if (made.length !== 1) fails.push(`создано сущностей: ${made.length}, ожидалась 1`);
      const e = made[0];
      if (e === undefined) return verdict([...fails, 'сущность не создана']);
      if (!e.aspects.includes('orbis/task')) fails.push('нет orbis/task');
      const financial = e.aspects.includes('orbis/financial');
      if (Number(e.props['orbis/amount']) !== 12000) {
        fails.push(`сумма 12000 потеряна: orbis/amount=${String(e.props['orbis/amount'])}`);
      }
      if (financial) {
        if (e.props['orbis/direction'] !== 'expense')
          fails.push(`orbis/direction=${String(e.props['orbis/direction'])}`);
        // Критерий П3 дословно: ссылка — на сущность мира из результата тула, а не выдуманный uuid.
        // Какая именно категория — вопрос вкуса модели, а не промпта («Страхование» или «Прочее»).
        const ref = e.props['orbis/finance_category'];
        if (typeof ref !== 'string' || !t.seeded.includes(ref)) {
          fails.push(`orbis/finance_category=${String(ref)} — не из результата тула`);
        }
      }
      if (refused(t).length > 0) fails.push(`отказ стадии 2: ${refused(t)[0]?.error}`);
      fails.push(...duplicateAttach(t));
      // Свободное свойство суммы без аспекта денег законно после реформы (§А1-2), но это другой
      // ответ, чем «задача и операция на одной сущности», — отмечается, а не проваливается.
      return verdict(fails, [financial ? 'сумма в orbis/financial' : 'сумма свободным свойством']);
    },
  },
  {
    id: 'date-task-and-schedule',
    title: '«в среду в 19:00» — И срок задачи, И запись в расписании на одной сущности',
    block: 'Дата в реплике: срок + расписание',
    channel: 'chat',
    turns: ['в среду в 19:00 позвонить маме и поздравить'],
    check: (t) => {
      const fails: string[] = [];
      const made = created(t);
      if (made.length !== 1) fails.push(`создано сущностей: ${made.length}, ожидалась 1`);
      const e = made[0];
      if (e === undefined) return verdict([...fails, 'сущность не создана']);
      if (!e.aspects.includes('orbis/task')) fails.push('нет orbis/task');
      else if (e.props['orbis/due_date'] === undefined) fails.push('нет orbis/due_date у задачи');
      if (!e.aspects.includes('orbis/schedule')) fails.push('нет orbis/schedule');
      else if (e.props['orbis/start_at'] === undefined) fails.push('нет orbis/start_at');
      fails.push(...duplicateAttach(t));
      return verdict(fails);
    },
  },
  {
    id: 'deadline-only',
    title: '«не позже конца месяца» — только срок, расписания быть не должно',
    block: 'Дата в реплике (обратная сторона)',
    channel: 'chat',
    turns: ['надо сдать годовой отчёт не позже конца месяца'],
    check: (t) => {
      const fails: string[] = [];
      const made = created(t);
      if (made.length !== 1) fails.push(`создано сущностей: ${made.length}, ожидалась 1`);
      const e = made[0];
      if (e === undefined) return verdict([...fails, 'сущность не создана']);
      if (e.props['orbis/due_date'] === undefined) fails.push('нет orbis/due_date');
      if (e.aspects.includes('orbis/schedule'))
        fails.push('лишний orbis/schedule на крайнем сроке');
      return verdict(fails);
    },
  },
  {
    id: 'budget-question',
    title: '«что по бюджету?» — через budget_status, без ручного пересчёта',
    block: 'Бюджет',
    channel: 'chat',
    turns: ['что у меня по бюджету?'],
    check: (t) => {
      const fails: string[] = [];
      if (!names(t).includes('budget_status')) fails.push('budget_status не вызван');
      if (created(t).length > 0) fails.push('создана сущность на вопросе');
      const manual = queryNodes(t, ['entity_query', 'user_query']).some((ns) =>
        hasAspect(ns, 'orbis/financial'),
      );
      if (manual) fails.push('ручной пересчёт агрегатов запросом по orbis/financial');
      if (!t.turns[0]?.final) fails.push('пустой финальный ответ');
      return verdict(fails);
    },
  },
  {
    id: 'afford',
    title: '«могу позволить 20000?» — свободные деньги без двойного вычета',
    block: 'Бюджет: свободные деньги',
    channel: 'chat',
    turns: ['могу позволить себе куртку за 20000?'],
    check: (t) => {
      const fails: string[] = [];
      if (!names(t).includes('budget_status')) fails.push('budget_status не вызван');
      if (created(t).length > 0) fails.push('создана сущность на вопросе');
      const text = t.turns[0]?.final ?? '';
      // Дискреционные остатки 12 700 + 10 800 = 23 500; минус будущие ОТТОКИ: planned 12 000
      // (страховка) и расходный comingUp 900 (интернет) = 10 600. Доход 180 000 не вычитается.
      if (!num(text, 10600)) {
        if (num(text, 11500))
          fails.push('свободные деньги 11500 — забыт расходный инстанс comingUp (900)');
        else if (num(text, -1600) || /[^\d]1600/.test(text.replace(/\s/g, '')))
          fails.push('двойной вычет recurring');
        else
          fails.push(`в ответе нет числа свободных денег 10600 (текст: «${text.slice(0, 160)}»)`);
      }
      if (num(text, 180000) && /вычит|минус\s*180|-\s*180/i.test(text))
        fails.push('вычтен будущий доход');
      return verdict(fails);
    },
  },
  {
    id: 'tags-query',
    title: '«доходы с тегом savings» — отбор по тегу и направлению',
    block: 'Шпаргалка грамматики',
    channel: 'chat',
    turns: ['покажи мои доходы с тегом savings'],
    check: (t) => {
      const fails: string[] = [];
      const all = t.calls.flatMap((c) => c.queries);
      if (all.length === 0) fails.push('запрос не сделан вовсе');
      const bad = badQueries(t);
      // Сочинённый `tag=` (Д1) разбор отвергает как неизвестное свойство — он здесь.
      if (bad.length > 0) fails.push(`запрос не разбирается: «${bad[0]?.text}»`);
      const parsed = queryNodes(t);
      const withTag = parsed.find((ns) => hasTag(ns, 'savings'));
      if (withTag === undefined)
        fails.push(`ни в одном запросе нет отбора по тегу savings («${all[0]?.text ?? '-'}»)`);
      else if (!hasPropEq(withTag, 'orbis/direction', 'income'))
        fails.push('в запросе с тегом нет orbis/direction=income');
      return verdict(fails);
    },
  },
  {
    id: 'taxi-category',
    title: '«потратил 500 на такси» — категория резолвится запросом, а не выдумывается',
    block: 'Не выдумывай uuid; инструкции orbis/financial',
    channel: 'chat',
    turns: ['потратил 500 на такси'],
    check: (t) => {
      const fails: string[] = [];
      const made = created(t);
      if (made.length !== 1) fails.push(`создано сущностей: ${made.length}, ожидалась 1`);
      const e = made[0];
      if (e === undefined) return verdict([...fails, 'сущность не создана']);
      if (!e.aspects.includes('orbis/financial')) fails.push('нет orbis/financial');
      else {
        if (Number(e.props['orbis/amount']) !== 500)
          fails.push(`orbis/amount=${String(e.props['orbis/amount'])}`);
        if (e.props['orbis/direction'] !== 'expense')
          fails.push(`orbis/direction=${String(e.props['orbis/direction'])}`);
        if (e.props['orbis/finance_category'] !== CAT_TRANSPORT) {
          fails.push(
            `orbis/finance_category=${String(e.props['orbis/finance_category'])}, ожидался uuid «Транспорт» из результата тула`,
          );
        }
      }
      const looked = queryNodes(t, ['entity_query', 'user_query']).some((ns) =>
        hasAspect(ns, 'orbis/category'),
      );
      if (!looked) fails.push('категория не искалась запросом по orbis/category');
      if (refused(t).length > 0) fails.push(`отказ стадии 2: ${refused(t)[0]?.error}`);
      return verdict(fails);
    },
  },
  {
    id: 'horizons',
    title: '«что у меня на год?» — цели из графа, несуществующих списков не предлагать',
    block: 'Цели и горизонты; преднастроенные списки',
    channel: 'chat',
    turns: ['что у меня на год?'],
    check: (t) => {
      const fails: string[] = [];
      if (!queryNodes(t).some((ns) => hasAspect(ns, 'orbis/goal'))) {
        fails.push('цели в графе не запрошены (aspect=orbis/goal)');
      }
      if (created(t).length > 0) fails.push('создана сущность на вопросе');
      const ghost = /«(Неделя|Месяц|День)»/.exec(t.turns[0]?.final ?? '');
      if (ghost) fails.push(`назван несуществующий список ${ghost[0]}`);
      return verdict(fails);
    },
  },
  {
    id: 'routine-propose',
    title:
      'Рутина без просьбы действовать самой — orbis/routine_mode: propose, orbis/routine_at «07:00»',
    block: 'Инструкции аспекта orbis/routine (слой реестра); канал рутины',
    channel: 'routine',
    turns: ['заведи рутину: каждое утро в 7 смотри мои задачи на день и присылай сводку'],
    check: (t) => {
      const fails: string[] = [];
      const rs = carrying(t, 'orbis/routine');
      if (rs.length !== 1) fails.push(`новых сущностей с orbis/routine: ${rs.length}, ожидалась 1`);
      const r = rs[0];
      if (r === undefined) return verdict([...fails, 'рутина не создана']);
      const mode = r.props['orbis/routine_mode'];
      if (mode !== 'propose')
        fails.push(`orbis/routine_mode=${String(mode)}, без прямой просьбы ожидался propose`);
      const at = r.props['orbis/routine_at'];
      if (at !== '07:00') fails.push(`orbis/routine_at=${String(at)}, ожидалось «07:00»`);
      const stage = r.props['orbis/routine_stage'];
      if (stage !== 'active') fails.push(`orbis/routine_stage=${String(stage)}`);
      if (refused(t).length > 0) fails.push(`отказ стадии 2: ${refused(t)[0]?.error}`);
      return verdict(fails);
    },
  },
  {
    id: 'edit-existing',
    title: 'Правка НАЙДЕННОЙ сущности вместо второй про то же дело',
    block: 'Одна сущность на намерение (правка найденного)',
    channel: 'chat',
    turns: ['перенеси покупку подарка маме на 2026-09-05'],
    check: (t) => {
      const fails: string[] = [];
      if (created(t).length > 0) fails.push(`создана вторая сущность (${created(t).length})`);
      if (!t.calls.some((c) => c.name === 'entity_query' || c.name === 'user_query')) {
        fails.push('сущность не искалась');
      }
      const touched = t.calls.some(
        (c) =>
          c.error === undefined &&
          ((c.name === 'entity_update' && c.args.id === TASK_GIFT) ||
            (c.aspect !== undefined && c.args.entity_id === TASK_GIFT)),
      );
      if (!touched) fails.push('найденная задача не правилась');
      const due = t.entities.find((e) => e.id === TASK_GIFT)?.props['orbis/due_date'];
      if (due !== '2026-09-05') fails.push(`orbis/due_date=${String(due)}, ожидался 2026-09-05`);
      return verdict(fails);
    },
  },
];
