// apps/server/test/fixtures/test-seed.ts
// СИНТЕТИЧЕСКИЙ СЛОВАРЬ ПРИЁМКИ §С8-26 (спека §Б4-5, «фикстурный словарь приёмки»). Правила 1, 2,
// 5, 7, 8 «дня мечты» ссылаются на сущности, которых в словаре v1 нет (звонящий, договорённость,
// участник, контакт), и спека требует ровно этого: сеять их фикстурой и проверять ВЫРАЗИМОСТЬ
// формы и вердикты, а не исполнимость (модули звонков и представительства — V3).
//
// ПОЧЕМУ `test/*`, А НЕ `user/*`: ключи гейта вехи I остались за `user/gate-*` (Р-К-10), и словарь
// приёмки обязан быть отличим от них и в грепе, и в снимках. `ownRegistryAddress`
// (`policy/confirmation.ts:260-263`) считает `test/*` ЧУЖОЙ строкой — для §С8-26 это безразлично
// (фикстуры идут мимо диспатча), но живой путь через тул дал бы запрет по объекту. Это
// ограничение фикстуры, названное вслух.

import type { GraphId } from '@orbis/shared';
import { addDays, ORBIS_NAMESPACE, TEST_IMPORT_ROUTINE_ID } from '@orbis/shared';
import { v5 as uuidv5 } from 'uuid';
import { execute } from '../../src/executor/executor';
import { appDb, type CustomAspectSpec, type CustomRoleSpec, personal } from '../helpers';

export const TEST_CONTACT_KEY = 'test/contact';
export const TEST_CALL_KEY = 'test/call';
export const TEST_ROLE_PARTICIPANT_KEY = 'participant';

/** id свойств: хелпер собирает их как `<namespace аспекта>/<имя поля>`, namespace обоих — `test`,
 *  поэтому имена полей взяты ровно те, что называет спека §Б4-5. */
export const TEST_PROPS = {
  contactKind: 'test/contact_kind',
  knownContact: 'test/known_contact',
  caller: 'test/caller',
  agreement: 'test/agreement',
} as const;

const opt = (key: string, ru: string, rank: number) => ({ key, label: { ru }, rank });

export const TEST_CONTACT_ASPECT: CustomAspectSpec = {
  key: TEST_CONTACT_KEY,
  module: null,
  label: { ru: 'Контакт (приёмка)', en: 'Contact (acceptance)' },
  description: { ru: 'Контакт словаря приёмки §С8-26.', en: 'Acceptance dictionary contact.' },
  properties: [
    {
      key: 'contact_kind',
      required: true,
      type: {
        kind: 'select',
        options: [opt('courier', 'Курьер', 1), opt('bank', 'Банк', 2), opt('person', 'Человек', 3)],
      },
    },
    { key: 'known_contact', type: { kind: 'boolean' } },
  ],
};

export const TEST_CALL_ASPECT: CustomAspectSpec = {
  key: TEST_CALL_KEY,
  module: null,
  label: { ru: 'Звонок (приёмка)', en: 'Call (acceptance)' },
  description: { ru: 'Звонок словаря приёмки §С8-26.', en: 'Acceptance dictionary call.' },
  // Множество цели — Q-AST, а не строка (форма `gf_category` фикстуры гейта). Валидатору `deref`
  // связка «caller → contact» не нужна (он смотрит только РОД базы), но цель, объявленная как
  // попало, уехала бы в снимок и всплыла бы на чтении (дочитка §3).
  properties: [
    {
      key: 'caller',
      required: true,
      type: { kind: 'ref', target: { filter: { aspect: TEST_CONTACT_KEY } } },
    },
    { key: 'agreement', type: { kind: 'ref', target: { filter: { aspect: 'orbis/financial' } } } },
  ],
};

export const TEST_ROLE_PARTICIPANT: CustomRoleSpec = {
  key: TEST_ROLE_PARTICIPANT_KEY,
  label: { ru: 'Участник', en: 'Participant' },
  sourceLabel: { ru: 'Участник', en: 'Participant' },
  targetLabel: { ru: 'Событие', en: 'Event' },
  // `created_by: 'any'` — путь тула открыт (см. докблок `seedCustomRole`).
  // `source_contract`/`target_contract` НЕ заполняются: их читателя нет до задачи 13, и
  // обещание в декларации без читателя — ровно то, что реформа запрещает (builtin-roles.ts:9-16).
  constraints: { created_by: 'any' },
  module: null,
};

export interface TestWorld {
  today: string;
  month: string;
  categoryId: string;
  envelopeId: string;
  /** Договорённость правила 2: сумма, с которой сравнивается предоплата. */
  agreementId: string;
  contactFamilyId: string;
  contactCourierId: string;
  contactStrangerId: string;
  prepaymentId: string;
  bigSpendId: string;
  smallSpendId: string;
  callCourierId: string;
  callStrangerId: string;
  eventSoloId: string;
  eventSharedId: string;
  taskId: string;
  /** Рутина импорта правила 6 — id прибит константой словаря (`TEST_IMPORT_ROUTINE_ID`). */
  routineId: string;
}

/** id сущности мира — uuidv5 от владельца и слага: воспроизводим без обращения к БД. */
const testEntityId = (graphId: GraphId, slug: string): string =>
  uuidv5(`${graphId.toLowerCase()}:test-seed-world:${slug}`, ORBIS_NAMESPACE);

/**
 * Мир §С8-26 — ЧЕРЕЗ ИСПОЛНИТЕЛЬ, тем же путём, что и боевые записи: обстановка, положенная
 * прямыми INSERT, не доказала бы, что правило видит настоящую запись (довод `seedGateWorld`).
 */
export async function seedTestWorld(graphId: GraphId): Promise<TestWorld> {
  const { db, client } = appDb();
  try {
    const id = (slug: string) => testEntityId(graphId, slug);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    const month = today.slice(0, 7);
    const [y, m] = month.split('-').map(Number) as [number, number];
    const periodEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const tomorrow = addDays(today, 1);
    const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

    /** Одна операция = один `execute`: отказ обязан называть СВОЮ операцию, а не «пачка упала». */
    const run = async (tool: string, input: Record<string, unknown>): Promise<void> => {
      const r = await execute(db, {
        identity: personal(graphId),
        actorKind: 'owner',
        source: 'ui',
        operations: [{ tool, input }],
      });
      if (!r.ok) {
        throw new Error(
          `мир §С8-26 ${tool} ${String(input.id ?? '')}: ${r.error.code} — ${r.error.message}`,
        );
      }
    };
    const entity = (
      slug: string,
      title: string,
      form: { tags?: string[]; aspects?: string[]; props?: Record<string, unknown> },
    ) => run('entity_create', { id: id(slug), title, tags: form.tags ?? [], ...form });

    // 1. Категория и конверт: правила 4 и 9 читают `agg_via(envelope-binding, remaining)`, а его
    //    даёт только настоящая привязка — её ставит хук бюджета на создании транзакции.
    await entity('category', 'Категория приёмки', { aspects: ['orbis/category'] });
    await entity('envelope', 'Конверт приёмки', {
      aspects: ['orbis/budget'],
      props: {
        'orbis/finance_category': id('category'),
        // ЛИМИТ 30000, А НЕ 20000: хук привязывает к конверту ВСЕ четыре расхода мира
        // (5000 + 9000 + 12000 + 340 = 26340), и при 20000 остаток был бы −6340 — правила 4 и 9
        // оказались бы ложны на каждой записи, то есть непроверяемы. При 30000 остаток 3660:
        // мелкий расход в него укладывается (позитив), крупный 12000 — нет (негатив).
        'orbis/limit': '30000.00',
        'orbis/period_start': `${month}-01`,
        'orbis/period_end': periodEnd,
      },
    });

    // 2. Три контакта: семья (правило 1), курьер (5), незнакомый (7).
    await entity('contact-family', 'Мама', {
      tags: ['семья'],
      aspects: [TEST_CONTACT_KEY],
      props: { [TEST_PROPS.contactKind]: 'person', [TEST_PROPS.knownContact]: true },
    });
    await entity('contact-courier', 'Курьер', {
      aspects: [TEST_CONTACT_KEY],
      props: { [TEST_PROPS.contactKind]: 'courier', [TEST_PROPS.knownContact]: true },
    });
    await entity('contact-stranger', 'Незнакомый', {
      aspects: [TEST_CONTACT_KEY],
      props: { [TEST_PROPS.contactKind]: 'person', [TEST_PROPS.knownContact]: false },
    });

    const fin = (over: Record<string, unknown>) => ({
      'orbis/amount': '340.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': id('category'),
      'orbis/occurred_on': today,
      ...over,
    });

    // 3. Договорённость (правило 2) — сумма, с которой сравнивается предоплата.
    await entity('agreement', 'Договорённость о предоплате', {
      aspects: ['orbis/financial'],
      props: fin({ 'orbis/amount': '5000.00' }),
    });
    // 4. Предоплата ВЫШЕ договорённой: запись несёт ОБА аспекта — правило 2 положено на `test/call`,
    //    а сумму и класс движения денег даёт `orbis/financial` на той же записи (§А1-2: значение
    //    свойства и носитель — разные вещи, одна запись может быть и звонком, и тратой).
    await entity('prepayment', 'Предоплата по звонку', {
      aspects: ['orbis/financial', TEST_CALL_KEY],
      props: fin({
        'orbis/amount': '9000.00',
        [TEST_PROPS.caller]: id('contact-family'),
        [TEST_PROPS.agreement]: id('agreement'),
      }),
    });
    // 5. Крупный расход (правило 3, порог '10000') и мелкий в пределах конверта (правила 4 и 9).
    await entity('big-spend', 'Крупный расход', {
      aspects: ['orbis/financial'],
      props: fin({ 'orbis/amount': '12000.00' }),
    });
    await entity('small-spend', 'Мелкий расход', {
      aspects: ['orbis/financial'],
      props: fin({ 'orbis/amount': '340.00' }),
    });
    // 6. Звонки курьера и незнакомого (правила 5 и 7) — без финансов.
    await entity('call-courier', 'Звонок курьера', {
      aspects: [TEST_CALL_KEY],
      props: { [TEST_PROPS.caller]: id('contact-courier') },
    });
    await entity('call-stranger', 'Звонок незнакомого', {
      aspects: [TEST_CALL_KEY],
      props: { [TEST_PROPS.caller]: id('contact-stranger') },
    });

    // 7. Два события (правила 8a/8b): одно без участников, второе — с ребром `participant`.
    //    Направление ребра: участник — ИСТОЧНИК, событие — ЦЕЛЬ. Так его и читает правило:
    //    `has_relation` оценочной области считает ВХОДЯЩИЕ рёбра записи-цели (Р-И-7).
    await entity('event-solo', 'Встреча наедине', {
      aspects: ['orbis/schedule'],
      props: { 'orbis/start_at': at(tomorrow, '11:00') },
    });
    await entity('event-shared', 'Встреча с участником', {
      aspects: ['orbis/schedule'],
      props: { 'orbis/start_at': at(tomorrow, '15:00') },
    });
    await run('relation_create', {
      source_id: id('contact-family'),
      target_id: id('event-shared'),
      role: TEST_ROLE_PARTICIPANT_KEY,
    });

    // 8. Задача со сроком (правило 11: перенос `orbis/due_date` рутиной).
    await entity('task', 'Задача со сроком', {
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'planned', 'orbis/due_date': tomorrow },
    });

    // 9. Рутина импорта: АКТОР правила 6 и одновременно ОБЪЕКТ правил 10a/10b (носитель —
    //    аспект `orbis/routine`, Р-К-20). id прибит константой словаря: `ruleActorSchema`
    //    принимает `{routine: <uuid>}` литералом, вывести его из владельца негде.
    //    Форма свойств — проверенная (`seed/gardener.ts`, GARDENER_PROPS).
    await run('entity_create', {
      id: TEST_IMPORT_ROUTINE_ID,
      title: 'Импорт выписки',
      tags: ['routine'],
      aspects: ['orbis/routine'],
      props: {
        'orbis/routine_stage': 'active',
        'orbis/routine_at': '09:00',
        'orbis/routine_days': ['mo'],
        'orbis/routine_mode': 'act',
        'orbis/allowed_tools': ['entity_create', 'entity_update'],
      },
    });

    return {
      today,
      month,
      categoryId: id('category'),
      envelopeId: id('envelope'),
      agreementId: id('agreement'),
      contactFamilyId: id('contact-family'),
      contactCourierId: id('contact-courier'),
      contactStrangerId: id('contact-stranger'),
      prepaymentId: id('prepayment'),
      bigSpendId: id('big-spend'),
      smallSpendId: id('small-spend'),
      callCourierId: id('call-courier'),
      callStrangerId: id('call-stranger'),
      eventSoloId: id('event-solo'),
      eventSharedId: id('event-shared'),
      taskId: id('task'),
      routineId: TEST_IMPORT_ROUTINE_ID,
    };
  } finally {
    await client.end();
  }
}
