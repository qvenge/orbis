/**
 * Встроенные контракты §Б1-2 — шесть: четыре ядра и два модуля Финансы. `orbis/progress` и
 * `orbis/categorizable` сюда НЕ входят (В-2 §8). `CONTRACT_IDS` — множество валидации
 * `registry_ref{target: contract}` и одновременно нормативный ПОРЯДОК: `rank` — позиция в нём.
 */
import type { z } from 'zod';
import {
  type ContractDefinition,
  contractDefinitionSchema,
  type contractFactsSchema,
  type contractSlotSchema,
  type contractSlotsSchema,
} from './contract-type';

export const CONTRACT_IDS = [
  'orbis/completable',
  'orbis/when',
  'orbis/recurrence',
  'orbis/sensitivity',
  'orbis/money-movement',
  'orbis/envelope',
] as const;
export type ContractId = (typeof CONTRACT_IDS)[number];

/** Закрытый словарь фактов чувствительности (§Б1-2, форма `{kind:"facts"}`). */
export const SENSITIVITY_FACTS = [
  'touches_money',
  'external',
  'irreversible',
  'changes_registry',
  'grants_autonomy',
] as const;
export type SensitivityFact = (typeof SENSITIVITY_FACTS)[number];
const FACT_LABEL: Record<SensitivityFact, { ru: string; en: string }> = {
  touches_money: { ru: 'Затрагивает деньги', en: 'Touches money' },
  external: { ru: 'Внешний эффект', en: 'External effect' },
  irreversible: { ru: 'Необратимо', en: 'Irreversible' },
  changes_registry: { ru: 'Меняет реестр', en: 'Changes the registry' },
  grants_autonomy: { ru: 'Даёт автономию', en: 'Grants autonomy' },
};

// Хелперы записи: девять слотов money-movement объектами заняли бы полсотни строк, а нормативно
// в них ровно четыре поля. Образец — `options(...)` в `builtin-properties.ts:39-41`.
type Slot = z.input<typeof contractSlotSchema>;
const s = (
  name: string,
  kind: Slot['type'],
  required: boolean,
  ru: string,
  en: string,
  status = false,
): Slot => ({ name, type: kind, required, label: { ru, en }, status });
const anyOf = (...kinds: string[]) => ({ kind: 'any_of', kinds }) as Slot['type'];
const k = (kind: string) => ({ kind }) as Slot['type'];
const c = (key: string, ru: string, en: string) => ({ key, label: { ru, en } });

// `Omit` по ВЕТКЕ, а не по union'у: `Omit<A|B, K>` не дистрибутивен и потерял бы дискриминатор —
// запись `{kind:'facts', slots:[…]}` перестала бы падать типом.
type SlotsEntry = Omit<z.input<typeof contractSlotsSchema>, 'ownerId' | 'key' | 'rank'> & {
  id: ContractId;
};
type FactsEntry = Omit<z.input<typeof contractFactsSchema>, 'ownerId' | 'key' | 'rank'> & {
  id: ContractId;
};

const ENTRIES: readonly (SlotsEntry | FactsEntry)[] = [
  {
    id: 'orbis/completable',
    kind: 'slots',
    label: { ru: 'Завершаемость', en: 'Completable' },
    description: {
      ru: 'Сущность можно завершить или отменить: слот-статус и три класса значений.',
      en: 'An entity can be completed or cancelled: a status slot and three value classes.',
    },
    slots: [s('status', k('select'), true, 'Статус', 'Status', true)],
    classes: [
      c('done', 'Сделано', 'Done'),
      c('cancelled', 'Отменено', 'Cancelled'),
      c('active', 'В работе', 'Active'),
    ],
    // Один набор вместо семи мест `!done && !cancelled` двух зон (§Б1-2, первые потребители).
    sets: { closed: ['done', 'cancelled'], open: ['active'] },
    module: null,
  },

  {
    id: 'orbis/when',
    kind: 'slots',
    label: { ru: 'Когда', en: 'When' },
    description: {
      ru: 'Привязка ко времени: момент (событие) и срок (дедлайн) — два разных слота.',
      en: 'Time binding: a moment (event) and a deadline — two distinct slots.',
    },
    // Оба НЕобязательны: аспект вправе реализовать один из двух (задача — срок, событие — момент),
    // а §Б2-3 делает членство в контракте динамическим.
    slots: [
      s('moment', anyOf('timestamp', 'date'), false, 'Момент', 'Moment'),
      s('deadline', k('date'), false, 'Срок', 'Deadline'),
    ],
    module: null,
  },

  {
    id: 'orbis/recurrence',
    kind: 'slots',
    label: { ru: 'Повторяемость', en: 'Recurrence' },
    description: {
      ru: 'Шаблон повторения и его экземпляры: признак шаблона и роль ребра порождения.',
      en: 'A recurrence template and its instances: the marker and the origin edge role.',
    },
    slots: [
      // any_of(boolean|json): слот реализуют ОБА — `financial.recurring` (boolean) и
      // `schedule.recurrence` (json, наличие = шаблон), рамка §4-5.
      s(
        'template_marker',
        anyOf('boolean', 'json'),
        false,
        'Признак шаблона',
        'Template marker',
        true,
      ),
      // Значение даёт `fixed` привязки (роль `instance-of`), а не свойство сущности: обязательность
      // здесь ничего не проверяла бы, а будущую привязку без роли заставила бы врать.
      s('origin_role', k('relation_role'), false, 'Роль порождения', 'Origin role'),
    ],
    classes: [c('template', 'Шаблон', 'Template'), c('instance', 'Экземпляр', 'Instance')],
    sets: { templates: ['template'], instances: ['instance'] },
    // Ядро по В6: понятие нужно Финансам и Планировщику сразу, а «модуль требует модуль» в v1 нет.
    module: null,
  },

  {
    id: 'orbis/sensitivity',
    kind: 'facts',
    label: { ru: 'Чувствительность', en: 'Sensitivity' },
    description: {
      ru: 'Закрытый словарь фактов чувствительности: их назначают декларации действий и политика §7.10.',
      en: 'Closed dictionary of sensitivity facts assigned by action declarations and the §7.10 policy.',
    },
    facts: SENSITIVITY_FACTS.map((key) => ({ key, label: FACT_LABEL[key] })),
    module: null,
  },

  {
    id: 'orbis/money-movement',
    kind: 'slots',
    label: { ru: 'Движение денег', en: 'Money movement' },
    description: {
      ru: 'Факт или план движения денег: сумма, направление, категория, дата и реквизиты импорта.',
      en: 'A money movement (actual or planned): amount, direction, category, date and import fields.',
    },
    slots: [
      s('amount', k('decimal'), true, 'Сумма', 'Amount'),
      s('direction', k('select'), true, 'Направление', 'Direction', true),
      s('category', k('ref'), true, 'Категория', 'Category'),
      s('date', k('date'), true, 'Дата', 'Date'),
      s('currency', k('text'), false, 'Валюта', 'Currency'),
      s('planned', k('boolean'), false, 'План', 'Planned'),
      s('recurring', k('boolean'), false, 'Повторяется', 'Recurring'),
      // Последние два — не украшение: без них не работает импорт выписки (inv §3).
      s('counterparty', k('text'), false, 'Контрагент', 'Counterparty'),
      s('bank_txn_id', k('text'), false, 'Идентификатор банка', 'Bank transaction id'),
    ],
    classes: [c('outflow', 'Расход', 'Outflow'), c('inflow', 'Доход', 'Inflow')],
    sets: {
      outflow: ['outflow'],
      inflow: ['inflow'],
      // «Случившееся движение денег» (§Б5-4) — по СЛОТАМ контракта, не по свойствам аспекта.
      facts: {
        op: 'and',
        args: [
          // ПОЧЕМУ `not(planned = true)`, а не буквальное `planned = false` из §Б5-4:
          // `orbis/planned` объявлен `default: false`, и умолчание на записи НЕ
          // материализуется (`executor/executor.test.ts:1433` — «absent при заданном default
          // остаётся absent»), поэтому боевые движения обычно лежат БЕЗ этого слота вовсе. По
          // §Б3-4 сравнение с отсутствующим — false, и `planned = false` выбросило бы такое
          // движение из `facts`, а с ним из `spent`; оракул же считает
          // `coalesce(planned,false) = false` (`budget/aggregates.ts:205`) и такие движения
          // тратой СЧИТАЕТ. Форма `not(= true)` тотальна в обоих бэкендах одинаково
          // (отсутствующее: `=` → false → `not` → true), совпадает с оракулом слово в слово и
          // не требует слота `planned` у привязки вообще — частичная привязка §Б2-3
          // (аспект гейта §С8-18 слот `planned` не связывает вовсе).
          { op: 'not', args: [{ op: '=', args: [{ slot: 'planned' }, { const: true }] }] },
          // Слот `date` обязателен у контракта, но у конкретной сущности может быть пуст:
          // сравнение с отсутствующим — false, и фактом такое движение не становится (§Б3-4).
          // Здесь отсутствие ОБЯЗАНО ронять членство — это и есть правило R2 «будущий факт не
          // тратит», у которого нет даты вовсе.
          { op: '<=', args: [{ slot: 'date' }, { ctx: '$today' }] },
          // Правый операнд `in` — ИМЯ НАБОРА (`'templates'`, Р-И-11), не перечисление его
          // классов: состав набора уже назван контрактом `orbis/recurrence`, и второй раз его
          // здесь не пишут. Перечисление (`{const:['template']}`) законно и остаётся для
          // деклараций владельца.
          {
            op: 'not',
            args: [
              {
                op: 'in',
                args: [{ class: { contract: 'orbis/recurrence' } }, { const: 'templates' }],
              },
            ],
          },
        ],
      },
      // Списки §Б5-4 (`coming_up`/`planned`) считают ПЛАНЫ — зеркало `facts` ровно по одному
      // слоту. Ни даты, ни направления, ни отсечения шаблонов здесь НЕТ, и это решение, а не
      // недосмотр: окно списка объявлено полем `window` (Р-К-12 — условие по дате внутри
      // предиката невидимо окну материализации), направление и шаблоны — своим `where` того
      // списка, которому они нужны. Отсеки набор шаблоны — и `coming_up` потерял бы
      // материализованные экземпляры повторения, то есть владелец перестал бы видеть
      // ближайшие списания.
      plans: { op: '=', args: [{ slot: 'planned' }, { const: true }] },
    },
    module: 'finance',
  },

  {
    id: 'orbis/envelope',
    kind: 'slots',
    label: { ru: 'Конверт', en: 'Envelope' },
    description: {
      ru: 'Лимит расходов по категории за период — носитель правил Budget (§Б5-4).',
      en: 'A spending limit for a category over a period — the carrier of Budget rules (§Б5-4).',
    },
    slots: [
      s('category', k('ref'), true, 'Категория', 'Category'),
      s('limit', k('decimal'), true, 'Лимит', 'Limit'),
      s('currency', k('text'), false, 'Валюта', 'Currency'),
      s('period_start', k('date'), true, 'Начало периода', 'Period start'),
      s('period_end', k('date'), true, 'Конец периода', 'Period end'),
      s('carryover', k('decimal'), false, 'Перенос', 'Carryover'),
    ],
    module: 'finance',
  },
];

/** Шесть встроенных контрактов §Б1-2 в нормативном порядке `CONTRACT_IDS`. */
export const BUILTIN_CONTRACT_DEFS: readonly ContractDefinition[] = ENTRIES.map((entry, index) =>
  contractDefinitionSchema.parse({
    ...entry,
    ownerId: null,
    key: entry.id /* у встроенных key = id (§А2-1) */,
    rank: index + 1,
  }),
);

// Порядок записей обязан совпадать с нормативным списком: `rank` выводится из позиции.
if (ENTRIES.map((e) => e.id).join(',') !== CONTRACT_IDS.join(',')) {
  throw new Error('BUILTIN_CONTRACT_DEFS разошёлся с CONTRACT_IDS');
}
