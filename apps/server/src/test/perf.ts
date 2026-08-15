// apps/server/src/test/perf.ts
// Инструмент перф-гейта (D21): измеритель медианы + сид объёма «граф владельца через год».
// Не тест сам по себе — библиотека для src/perf.test.ts (bun test берёт только *.test.ts).
//
// Сид идёт ЧЕРЕЗ executor, а не прямыми INSERT'ами: ограничение «один путь мутаций» здесь
// не формальность — именно executor проставляет body_refs, нормализует теги и привязывает
// транзакции к конвертам бюджет-хуком. Прямые вставки дали бы граф без связей, и замер
// backlinks/overview мерил бы пустоту. Цена — батчи по BATCH_SIZE операций (не по одной
// сущности), иначе сид становится самой долгой частью прогона.
import { newId, ORBIS_NAMESPACE } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { adminDb } from '../../test/helpers';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { SEED_CATEGORIES } from '../seed/categories';
import { seedCategoryId, seedOnboarding } from '../seed/onboarding';

/**
 * Измеритель: медиана `runs` замеров `fn` в миллисекундах.
 * Печатает результат ВСЕГДА — дрейф должен быть виден глазами и на зелёном прогоне (D21),
 * иначе про регрессию узнаём только в момент, когда она уже пробила порог.
 */
export async function measureMedian(
  label: string,
  runs: number,
  fn: () => Promise<unknown>,
): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] as number;
  console.log(`perf: ${label} median=${median.toFixed(1)}ms runs=${runs}`);
  return median;
}

// --- объём фикстуры ---------------------------------------------------------
/** Сущностей вне финансов: задачи + события + заметки-упоминания. */
const TASKS = 1200;
const SCHEDULES = 600;
const MENTIONS = 200;
/** Транзакций: текущий месяц (горячий для budget.overview) + прошлый. */
const TXN_CURRENT = 800;
const TXN_PREVIOUS = 200;
/**
 * Явных related_to на хаб — вторая ветка UNION'а backlinks (§3.5.8). В верхнюю сотню
 * выдачи они, скорее всего, не попадают: секция сортируется `created_at DESC`, а связи
 * создаются РАНЬШЕ заметок-упоминаний. На стоимость запроса это не влияет (обе ветки
 * UNION'а всё равно исполняются), и как «нагрузить вторую ветку» их и хватает.
 */
const HUB_RELATIONS = 40;
/** Операций в одном batch: компромисс «мало round-trip'ов» ↔ «journal не разбухает». */
const BATCH_SIZE = 200;

/** Категории, по которым идут расходы (доходные — salary/freelance — отдельно). */
const EXPENSE_SLUGS = SEED_CATEGORIES.filter((c) => c.spendClass !== null).map((c) => c.slug);
const INCOME_SLUGS = SEED_CATEGORIES.filter((c) => c.spendClass === null).map((c) => c.slug);

/**
 * Хаб фикстуры — сущность, на которую ссылается MENTIONS заметок и HUB_RELATIONS задач.
 * Детерминирован по владельцу: тест адресует его, не получая id из сида (сигнатура
 * seedPerfFixture остаётся `Promise<void>`).
 */
export function perfHubId(ownerId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:perf-hub`, ORBIS_NAMESPACE);
}

/**
 * Цель фикстуры — ОТДЕЛЬНАЯ сущность, а не аспект на хабе. Навесить `orbis/goal` на хаб
 * было бы дешевле, но по хабу меряется порог `entity.backlinks`: аспект молча превратил бы
 * тот замер в замер другой операции (чтение + расчёт прогресса) — с прежним названием,
 * прежним порогом и зелёным гейтом.
 */
export function perfGoalId(ownerId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:perf-goal`, ORBIS_NAMESPACE);
}

/**
 * Категория, у которой в фикстуре ГАРАНТИРОВАННО есть конверт текущего месяца, — вход для
 * замера `fastpath:create`. Слаг берётся из того же списка, из которого сид строит конверты,
 * а не литералом на стороне теста: с литералом переименование слага не роняло бы ничего —
 * `entity.create` прошёл бы, просто не нашёл конверт, и замер молча съехал бы на более
 * дешёвый путь (без привязки) при зелёном гейте.
 */
export function perfEnvelopeCategoryId(ownerId: string): string {
  const slug = EXPENSE_SLUGS[0];
  if (!slug) throw new Error('perf-фикстура: в сиде не осталось расходных категорий');
  return seedCategoryId(ownerId, slug);
}

/** Таймзона сида (02-core-os §7.3) — та же, в которой сервер считает `today`. */
const TZ = 'Europe/Moscow';

function todayInSeedTz(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

type Op = { tool: string; input: unknown };

async function runBatches(db: Db, ownerId: string, ops: Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const chunk = ops.slice(i, i + BATCH_SIZE);
    const r = await execute(db, {
      actorUserId: ownerId,
      actorKind: 'owner',
      source: 'ui',
      operations: chunk,
      batchId: newId(),
    });
    if (!r.ok) {
      throw new Error(`seedPerfFixture: ${r.error.code} — ${r.error.message}`);
    }
  }
}

const TASK_STATUSES = ['inbox', 'planned', 'in_progress', 'waiting', 'done'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

/**
 * Сид объёма: 2000 сущностей (задачи/события/заметки), 1000 транзакций, 12 конвертов,
 * плюс две адресуемые по id сущности — хаб связей и цель (perfHubId/perfGoalId).
 * Числа взяты как «год активного использования», а не как стресс-тест: гейт ловит грубую
 * регрессию (потерянный индекс, N+1) на правдоподобном объёме.
 *
 * Все даты — ОТНОСИТЕЛЬНО реального «сегодня» в таймзоне сида: запросы гейта (`next_7d`,
 * месяц бюджета) резолвятся сервером по ней же, фиксированные даты сделали бы фикстуру
 * протухающей.
 */
export async function seedPerfFixture(db: Db, ownerId: string): Promise<void> {
  await withIdentity(db, ownerId, (tx) => seedOnboarding(tx, ownerId));

  const today = todayInSeedTz();
  const curStart = monthStart(today);
  const curEnd = monthEnd(today);
  const prevEnd = addDaysISO(curStart, -1);
  const prevStart = monthStart(prevEnd);
  const hubId = perfHubId(ownerId);

  // Хаб — до всего остального: заметки ссылаются на него в body, задачи — связью.
  await runBatches(db, ownerId, [
    {
      tool: 'entity_create',
      input: {
        id: hubId,
        title: 'Проект-хаб перф-фикстуры',
        tags: ['project'],
        body: 'Узел, вокруг которого собран граф замера.',
        aspects: {},
      },
    },
  ]);

  // 12 конвертов: 10 расходных категорий текущего месяца + 2 прошлого (rollover/тренд).
  const envelopes: Op[] = EXPENSE_SLUGS.map((slug) => ({
    tool: 'entity_create',
    input: {
      id: newId(),
      title: `Конверт ${slug} ${curStart}`,
      tags: [],
      aspects: {
        'orbis/budget': {
          category_ref: seedCategoryId(ownerId, slug),
          limit: '30000.00',
          period_start: curStart,
          period_end: curEnd,
        },
      },
    },
  }));
  for (const slug of EXPENSE_SLUGS.slice(0, 2)) {
    envelopes.push({
      tool: 'entity_create',
      input: {
        id: newId(),
        title: `Конверт ${slug} ${prevStart}`,
        tags: [],
        aspects: {
          'orbis/budget': {
            category_ref: seedCategoryId(ownerId, slug),
            limit: '28000.00',
            period_start: prevStart,
            period_end: prevEnd,
          },
        },
      },
    });
  }
  await runBatches(db, ownerId, envelopes);

  // Задачи: статусы и приоритеты по кругу, срок разложен в окне ±60 дней вокруг сегодня —
  // ни один горячий запрос не должен попадать в вырожденный «все строки подходят».
  const taskIds: string[] = [];
  const tasks: Op[] = Array.from({ length: TASKS }, (_, i) => {
    const id = newId();
    taskIds.push(id);
    return {
      tool: 'entity_create',
      input: {
        id,
        title: `Задача фикстуры ${i}`,
        tags: ['task'],
        aspects: {
          'orbis/task': {
            status: TASK_STATUSES[i % TASK_STATUSES.length],
            priority: PRIORITIES[i % PRIORITIES.length],
            due_date: addDaysISO(today, (i % 121) - 60),
          },
        },
      },
    };
  });
  await runBatches(db, ownerId, tasks);

  // События: половина — в окне [сегодня; +7д] (горизонт Agenda), остальные размазаны
  // на ±30 дней, чтобы окно реально отсекало, а не возвращало всё подряд.
  const schedules: Op[] = Array.from({ length: SCHEDULES }, (_, i) => {
    const day = i % 2 === 0 ? addDaysISO(today, i % 8) : addDaysISO(today, (i % 61) - 30);
    const hour = String(8 + (i % 12)).padStart(2, '0');
    // Смещение зоны сида фиксированное: в Москве нет перехода на летнее время.
    return {
      tool: 'entity_create',
      input: {
        id: newId(),
        title: `Событие фикстуры ${i}`,
        tags: ['event'],
        aspects: { 'orbis/schedule': { start_at: `${day}T${hour}:00:00+03:00` } },
      },
    };
  });
  await runBatches(db, ownerId, schedules);

  // Заметки-упоминания: body_refs → хаб (ветка GIN в backlinks). Их больше, чем потолок
  // секции «Связанное» (100), — замер идёт по усечённой выдаче, как на живом detail.
  const mentions: Op[] = Array.from({ length: MENTIONS }, (_, i) => ({
    tool: 'entity_create',
    input: {
      id: newId(),
      title: `Заметка фикстуры ${i}`,
      tags: ['note'],
      body: `Разбор по [[entity:${hubId}]] — пункт ${i}.`,
      aspects: { 'orbis/note': {} },
    },
  }));
  await runBatches(db, ownerId, mentions);

  // Явные related_to на хаб — вторая ветка UNION'а backlinks.
  await runBatches(
    db,
    ownerId,
    taskIds.slice(0, HUB_RELATIONS).map((id) => ({
      tool: 'relation_create',
      input: { source_id: hubId, target_id: id, relation_type: 'related_to' },
    })),
  );

  // Транзакции. Бюджет-хук привязывает их к конвертам ТЕМ ЖЕ tx — spent в overview
  // считается по реальным связям, а не по пустому графу. Часть — доходные и по
  // категориям без конверта: overview обязан посчитать и balance, и unbudgeted.
  const txnOps = (count: number, from: string, span: number): Op[] =>
    Array.from({ length: count }, (_, i) => {
      const income = i % 25 === 0;
      const slugs = income ? INCOME_SLUGS : EXPENSE_SLUGS;
      return {
        tool: 'entity_create',
        input: {
          id: newId(),
          title: `${income ? 'Доход' : 'Расход'} фикстуры ${i}`,
          tags: [],
          aspects: {
            'orbis/financial': {
              amount: `${100 + (i % 900)}.00`,
              direction: income ? 'income' : 'expense',
              category_ref: seedCategoryId(ownerId, slugs[i % slugs.length] as string),
              occurred_on: addDaysISO(from, i % span),
            },
          },
        },
      };
    });
  await runBatches(db, ownerId, txnOps(TXN_CURRENT, curStart, 28));
  await runBatches(db, ownerId, txnOps(TXN_PREVIOUS, prevStart, 28));

  // Цель — после транзакций, потому что считает именно их. Агрегат источника — `sum`, а не
  // `count`, хотя счётчик по задачам был бы проще: `count` компилируется тем же
  // compileCount, что уже меряется бейджем (`entity.count:badge`), и седьмая строка гейта
  // повторяла бы вторую с точностью до накладной расчёта. `compileSum` же не исполняет ни
  // одна другая операция гейта — это и есть непокрытый кусок goal-пути.
  //
  // Выборка взята самая широкая из осмысленных (все расходы фикстуры), и польза от ширины
  // ровно одна: чем больше строк проходит агрегат, тем дороже становится регрессия, которая
  // делает работу НА КАЖДУЮ СТРОКУ, — N+1 или чтение всего графа вместо выборки. Ловить
  // широкой выборкой потерянный индекс — самообман: замерено на фикстуре, расходов 966 при
  // 3037 сущностях владельца, то есть треть таблицы, и на такой селективности планировщик
  // индекс не возьмёт и сегодня (тот же довод — в шапке perf.test.ts про list50/badge).
  await runBatches(db, ownerId, [
    {
      tool: 'entity_create',
      input: {
        id: perfGoalId(ownerId),
        title: 'Цель перф-фикстуры: расходы года',
        tags: ['goal'],
        aspects: {
          'orbis/goal': {
            progress_source: {
              query: 'aspect=orbis/financial, direction=expense',
              aggregate: 'sum',
              field: 'amount',
            },
            target_value: '1000000.00',
          },
        },
      },
    },
  ]);

  // ANALYZE — не украшение, а условие осмысленности замера (найдено при калибровке).
  // TRUNCATE обнуляет статистику планировщика, и на свежезалитой таблице он выбирает план
  // по умолчаниям: budget.overview на одной и той же фикстуре давал то 64 мс, то 464 мс —
  // в 7 раз, чисто от того, успел ли autovacuum проанализировать таблицу. В проде
  // статистика поддерживается autovacuum'ом непрерывно, так что без ANALYZE гейт мерил бы
  // неведение планировщика, а не код, и мигал бы красным случайным образом.
  // Требует прав владельца таблиц — идёт по админ-DSN, как truncateAll.
  const admin = adminDb();
  try {
    await admin.db.execute(sql`ANALYZE entities, relations`);
  } finally {
    await admin.client.end();
  }
}
