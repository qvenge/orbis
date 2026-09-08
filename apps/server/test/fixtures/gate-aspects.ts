// apps/server/test/fixtures/gate-aspects.ts
// Фикстура гейта §С8-18 (ревизия 3): два ПОЛЬЗОВАТЕЛЬСКИХ аспекта, у которых нет и не будет ни
// одной строки кода под них. ЕДИНСТВЕННОЕ МЕСТО, где пишутся сами токены `gate-fin`/`gate-plain`/
// `gf_`/`gp_`: греп-доказательство задачи 10 ищет их по всему дереву и обязано находить только здесь,
// в данных снимка поверхностей и в заголовках/комментариях самого теста гейта (`gate-c8-18.test.ts`,
// Р-К-54) — больше нигде.
import { addDays, ROLE_DEPENDENCY, ROLE_ENVELOPE_BINDING } from '@orbis/shared';
import { execute } from '../../src/executor/executor';
import { appRouter } from '../../src/router';
import { createCallerFactory } from '../../src/trpc';
import { appDb, type CustomAspectSpec } from '../helpers';

export const GATE_FIN_KEY = 'user/gate-fin';
export const GATE_PLAIN_KEY = 'user/gate-plain';
export const GATE_ASPECT_KEYS = [GATE_FIN_KEY, GATE_PLAIN_KEY] as const;
export const GATE_GREP_TOKENS = ['gate-fin', 'gate-plain', 'gf_', 'gp_'] as const;

/**
 * Пути греп-доказательства §С8-18 — ДОСЛОВНО те, по которым задача 0d снимала базу сравнения
 * (шаг 13 её брифа), и подмножество `SEARCH_PATHSPEC` (`scripts/check-legacy-form.ts:67-76`).
 * Список живёт здесь, а не в тесте: команда из отчёта вехи и утверждение теста обязаны
 * искать по одному и тому же — иначе «доказано» и «проверено» расходятся молча.
 */
export const GATE_GREP_PATHSPEC = [
  'apps/server/src',
  'apps/server/test',
  'apps/server/perf',
  'packages/shared/src',
  'apps/web/src',
  'scripts',
  ':!*.snap',
] as const;

/**
 * Файлы, где токены гейта законны (§С8-18 «вне фикстуры и снимков»):
 *  — декларация фикстуры: единственное место, где токены ПИШУТСЯ (дисциплина токенов 0d);
 *  — данные снимка: слаги мира гейта уезжают в эталон как значения;
 *  — сам сквозной тест гейта: он называет аспекты в ЗАГОЛОВКАХ тестов («трата gate-fin попадает в
 *    spent…», «дела gate-plain попадают в Agenda…»), и это ТЕСТ, а не код под аспект (Р-К-54).
 *    Заголовки не переписываются на константы намеренно: имя красного теста читает человек в отчёте
 *    прогона, и `${GATE_FIN_KEY} попадает в spent` он бы там не увидел. Доказательство §С8-18 при
 *    этом не размывается: оно про `src/` — продуктовый код, — а не про имена тестов.
 */
export const GATE_GREP_ALLOWED = [
  'apps/server/test/fixtures/gate-aspects.ts',
  'apps/server/test/golden/surfaces.json',
  'apps/server/test/gate-c8-18.test.ts',
] as const;

/**
 * id свойств обоих аспектов: хелпер собирает их как `<namespace аспекта>/<имя поля>`
 * (`helpers.ts`, `seedCustomAspect`), namespace у обоих — `user`, поэтому имена полей разведены
 * префиксами `gf_`/`gp_`: одноимённое поле двух аспектов ДЕЛИЛО БЫ одно свойство.
 */
export const GATE_PROPS = {
  finAmount: 'user/gf_amount',
  finDirection: 'user/gf_direction',
  finCategory: 'user/gf_category',
  finDate: 'user/gf_date',
  finState: 'user/gf_state',
  finWhen: 'user/gf_when',
  plainState: 'user/gp_state',
  plainAt: 'user/gp_at',
} as const;

export const GATE_AMOUNT = '340.00';
export const GATE_LIMIT = '5000.00';

const opt = (key: string, ru: string, rank: number) => ({ key, label: { ru }, rank });

export const GATE_FIN_ASPECT: CustomAspectSpec = {
  key: GATE_FIN_KEY,
  label: { ru: 'Трата гейта', en: 'Gate spending' },
  description: { ru: 'Финансовый аспект гейта §С8-18.', en: 'Financial gate aspect (§С8-18).' },
  // Модуль — finance: аспект владельца о деньгах обязан гаснуть вместе с модулем (§С8-22),
  // и снимок «модуль выключен» задачи 18 меряет это на нём.
  module: 'finance',
  properties: [
    { key: 'gf_amount', type: { kind: 'decimal' }, required: true },
    {
      key: 'gf_direction',
      type: {
        kind: 'select',
        options: [opt('in', 'Приход', 1), opt('out', 'Расход', 2)],
      },
      required: true,
    },
    {
      key: 'gf_category',
      type: { kind: 'ref', target: { filter: { aspect: 'orbis/category' } } },
      required: true,
    },
    { key: 'gf_date', type: { kind: 'date' }, required: true },
    {
      key: 'gf_state',
      type: {
        kind: 'select',
        options: [
          opt('todo', 'В работе', 1),
          opt('done', 'Сделано', 2),
          opt('void', 'Отменено', 3),
        ],
      },
    },
    { key: 'gf_when', type: { kind: 'timestamp' } },
  ],
  implements: [
    // `gf_date` идёт в слот `date` контракта денег, а НЕ в `when.deadline`: у гейта дата операции
    // и момент в повестке — разные величины, и слить их значило бы подсказать движку ответ.
    {
      contract: 'orbis/money-movement',
      bind: {
        amount: GATE_PROPS.finAmount,
        direction: GATE_PROPS.finDirection,
        category: GATE_PROPS.finCategory,
        date: GATE_PROPS.finDate,
      },
      value_map: [
        { slot: 'direction', variant: 'in', class: 'inflow' },
        { slot: 'direction', variant: 'out', class: 'outflow' },
      ],
      fixed: {},
    },
    {
      contract: 'orbis/completable',
      bind: { status: GATE_PROPS.finState },
      value_map: [
        { slot: 'status', variant: 'todo', class: 'active' },
        { slot: 'status', variant: 'done', class: 'done' },
        { slot: 'status', variant: 'void', class: 'cancelled' },
      ],
      fixed: {},
    },
    { contract: 'orbis/when', bind: { moment: GATE_PROPS.finWhen }, value_map: [], fixed: {} },
  ],
};

export const GATE_PLAIN_ASPECT: CustomAspectSpec = {
  key: GATE_PLAIN_KEY,
  label: { ru: 'Дело гейта', en: 'Gate item' },
  description: {
    ru: 'Нефинансовый аспект гейта §С8-18, он же фикстура §С8-21.',
    en: 'Non-financial gate aspect.',
  },
  module: null,
  properties: [
    {
      key: 'gp_state',
      type: {
        kind: 'select',
        options: [opt('open', 'Открыто', 1), opt('closed', 'Закрыто', 2)],
      },
      required: true,
    },
    { key: 'gp_at', type: { kind: 'timestamp' } },
  ],
  implements: [
    {
      contract: 'orbis/completable',
      bind: { status: GATE_PROPS.plainState },
      value_map: [
        { slot: 'status', variant: 'open', class: 'active' },
        { slot: 'status', variant: 'closed', class: 'done' },
      ],
      fixed: {},
    },
    // Тот же слот `moment`, что у `orbis/schedule`, — на этом стоит фикстура §С8-21.
    { contract: 'orbis/when', bind: { moment: GATE_PROPS.plainAt }, value_map: [], fixed: {} },
  ],
};

export interface GateWorld {
  today: string;
  month: string;
  categoryId: string;
  envelopeId: string;
  /** Трата gate-fin: дата сегодня, в конверте месяца, момент — завтра. */
  finId: string;
  /** gate-plain: момент завтра / вчера, оба открыты — окно повестки и «просроченное». */
  windowId: string;
  overdueId: string;
  /** Цель под ЗАКРЫТЫМ блокером-gate-plain: под excludeBlocked обязана быть видна. */
  blockedId: string;
  blockerClosedId: string;
  /** Контроль: цель под ОТКРЫТЫМ блокером — спрятана и сегодня, и после вехи I. */
  blockedOpenId: string;
  blockerOpenId: string;
  /** §С8-21: gate-plain + orbis/schedule на одной сущности — два `moment`. */
  ambiguousId: string;
}

/** Момент с фиксированным смещением Europe/Moscow (дефолт `user_settings.timezone`). */
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

/**
 * Мир гейта — ЧЕРЕЗ ИСПОЛНИТЕЛЯ (tRPC-ручки владельца), а не прямыми INSERT: гейт утверждает,
 * что аспект работает на боевых путях, и обстановка, положенная мимо них, этого не докажет.
 * Своё подключение — как у `seedCustomAspect`: у фикстуры транзакции на руках нет.
 */
export async function seedGateWorld(ownerId: string): Promise<GateWorld> {
  const { db, client } = appDb();
  try {
    const caller = createCallerFactory(appRouter)({
      actorUserId: ownerId,
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    const month = today.slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const periodEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    // Сущность §С8-21 стоит за пределами окна повестки (8 дней) и не просрочена НАМЕРЕННО:
    // двойная привязка слота `moment` даёт `SLOT_AMBIGUOUS` в движке (задача 5), и попади она
    // в выдачу Agenda — отказ уронил бы тесты гейта вместо своей проверки.
    const far = addDays(today, 30);

    const mk = async (
      title: string,
      form: { props?: Record<string, unknown>; aspects?: string[] },
    ) => (await caller.entity.create({ input: { title, tags: [], ...form }, source: 'ui' })).id;

    const categoryId = await mk('Категория гейта', { aspects: ['orbis/category'] });
    const envelopeId = await mk('Конверт гейта', {
      aspects: ['orbis/budget'],
      props: {
        'orbis/finance_category': categoryId,
        'orbis/limit': GATE_LIMIT,
        'orbis/period_start': `${month}-01`,
        'orbis/period_end': periodEnd,
      },
    });
    const finId = await mk('Трата гейта', {
      aspects: [GATE_FIN_KEY],
      props: {
        [GATE_PROPS.finAmount]: GATE_AMOUNT,
        [GATE_PROPS.finDirection]: 'out',
        [GATE_PROPS.finCategory]: categoryId,
        [GATE_PROPS.finDate]: today,
        [GATE_PROPS.finState]: 'todo',
        [GATE_PROPS.finWhen]: at(tomorrow, '12:00'),
      },
    });
    // Пишущая половина привязки — остаток вехи I: обобщение бюджет-хука по слотам
    // `orbis/money-movement` в карте файлов Б-1 не значится, и гейт §С8-18 проверяет ЧИТАЮЩУЮ
    // половину. Ребро кладёт фикстура; механизм `seed` — потому что роль `envelope-binding`
    // системная (`created_by: 'system'`), и тот же вызов механизмом `user` упал бы
    // `ROLE_SYSTEM_ONLY`. Фикстуры — названное исключение «только через исполнитель».
    // Задача 11 обобщает хук и снимает эти строки (Р-К-39).
    const bound = await execute(db, {
      actorUserId: ownerId,
      actorKind: 'owner',
      source: 'ui',
      mechanism: 'seed',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: envelopeId, target_id: finId, role: ROLE_ENVELOPE_BINDING },
        },
      ],
    });
    if (!bound.ok) throw new Error(`привязка гейта: ${bound.error.code} — ${bound.error.message}`);

    const windowId = await mk('Дело гейта в окне', {
      aspects: [GATE_PLAIN_KEY],
      props: { [GATE_PROPS.plainState]: 'open', [GATE_PROPS.plainAt]: at(tomorrow, '10:00') },
    });
    const overdueId = await mk('Дело гейта просрочено', {
      aspects: [GATE_PLAIN_KEY],
      props: { [GATE_PROPS.plainState]: 'open', [GATE_PROPS.plainAt]: at(yesterday, '10:00') },
    });
    const blockedId = await mk('Цель под закрытым блокером', {});
    const blockerClosedId = await mk('Закрытый блокер гейта', {
      aspects: [GATE_PLAIN_KEY],
      props: { [GATE_PROPS.plainState]: 'closed' },
    });
    const blockedOpenId = await mk('Цель под открытым блокером', {});
    const blockerOpenId = await mk('Открытый блокер гейта', {
      aspects: [GATE_PLAIN_KEY],
      props: { [GATE_PROPS.plainState]: 'open' },
    });
    const ambiguousId = await mk('Дело гейта и событие', {
      aspects: [GATE_PLAIN_KEY, 'orbis/schedule'],
      props: {
        [GATE_PROPS.plainState]: 'open',
        [GATE_PROPS.plainAt]: at(far, '09:00'),
        'orbis/start_at': at(far, '09:00'),
      },
    });
    // Тип пар назван явно (`readonly [string, string]`), иначе литерал выводится в
    // `string[][]`, и под `noUncheckedIndexedAccess` разбор даёт `string | undefined`.
    const edges: ReadonlyArray<readonly [string, string]> = [
      [blockerClosedId, blockedId],
      [blockerOpenId, blockedOpenId],
    ];
    for (const [source_id, target_id] of edges) {
      // Направление — по `QUERY_REL_ANCHOR` (`query/ast.ts`): блокер — ИСТОЧНИК ребра,
      // заблокированная работа — цель (`sourceNotIn` смотрит на источник).
      await caller.relation.create({ source_id, target_id, role: ROLE_DEPENDENCY });
    }
    return {
      today,
      month,
      categoryId,
      envelopeId,
      finId,
      windowId,
      overdueId,
      blockedId,
      blockerClosedId,
      blockedOpenId,
      blockerOpenId,
      ambiguousId,
    };
  } finally {
    await client.end();
  }
}
