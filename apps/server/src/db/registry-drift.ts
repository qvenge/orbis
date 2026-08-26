// apps/server/src/db/registry-drift.ts
//
// Стартовая проверка ловушки релиза, расширенная на ПЯТЬ реестров и таблицу действий
// (§А12-1 п.4; до реформы файл назывался aspect-drift.ts и знал только аспекты).
//
// Природа ловушки не изменилась: строки реестров заполняет `scripts/seed-registries.ts`,
// которого нет ни в Dockerfile, ни в render.yaml. Релиз, изменивший свойство или аспект,
// без пересева выкатывается со СТАРЫМ реестром — исполнитель валидирует по таблице,
// `attach_*`-тул собирается из таблицы, каталог промпта берёт из таблицы описания, — и фича
// приезжает мёртвой (fail-closed: запись отклоняется, данные целы).
//
// Что изменилось: сверка стала ДВУСТОРОННЕЙ (Р-23). Лишняя system-строка — запись, которой
// в коде уже нет, — теперь тоже дрейф. Раньше она жила в проде молча и продолжала
// валидировать данные.
//
// Проверка НЕ роняет старт. Дрейф одной записи — не повод не поднимать приложение: всё
// остальное работает, а healthCheckPath Render превратил бы наблюдаемость в отказ деплоя.
// Сигнал — громкий лог с точной командой починки плюс поле в /health.
//
// ТРИ СОСТОЯНИЯ, а не два. «Проверка не выполнилась» обязано отличаться от «расхождений
// нет»: холодный старт Render+Supabase легко даёт недоступную БД в первые секунды, и раньше
// единственная неудачная попытка навсегда выключала ловушку — /health при этом отвечал
// ровно как на здоровом реестре, то есть штатная операторская проверка (runbook §1) давала
// ложноотрицательный ответ.
import {
  diffBuiltinRegistries,
  hasRegistryDrift,
  REGISTRY_KINDS,
  type RegistryDbRow,
  type RegistryDbRows,
  type RegistryDrift,
  type RegistryKind,
  registryDriftReport,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * Тексты запросов сверки — ОДИН экземпляр на стартовую проверку сервера и на ручную
 * операцию `bun scripts/ops.ts check`. Общей у них была только функция сравнения, а
 * запросы жили двумя копиями (`aspect-drift.ts:33` и `ops.ts:96-97`); с шестью таблицами
 * вместо одной такая пара разъехалась бы на первой же правке состава колонок.
 *
 * ЧТО ИМЕННО ОБЩЕЕ, а что нет. Общее — определение дрейфа (`diffBuiltinRegistries`), состав
 * читаемого (эти запросы) и снапшот-семантика (обе стороны читают в REPEATABLE READ
 * READ ONLY). РАЗЛИЧАЕТСЯ роль, и намеренно: сервер читает под `authenticated`, потому что
 * под ней он и работает — снятый грант обязан всплыть именно здесь; `ops.ts check` читает
 * админской ролью, потому что отвечает на вопрос о ДАННЫХ прода и обязан ответить на него
 * даже тогда, когда гранты или политики сломаны, — иначе дефект прав приходил бы оператору
 * под видом «состояние реестров неизвестно». Это выбор, а не ограничение: админская роль
 * `SET LOCAL ROLE authenticated` умеет (проверено пробоем).
 *
 * Столбцы перечислены поимённо, а не `SELECT *`: имя столбца — это и есть содержимое поля
 * `what` в отчёте дрейфа, и `*` затащил бы туда `created_at`, который у пересеянной строки
 * законно другой.
 *
 * `"symmetric"` в кавычках: SYMMETRIC — зарезервированное слово SQL.
 *
 * У контрактов, подписок и действий выбирается ТОЛЬКО id: в срезе А ожидание для них —
 * пусто (§А12-1), сравнивать не с чем, и любая system-строка попадёт в `extra`.
 */
export const REGISTRY_DRIFT_QUERIES: Record<RegistryKind, string> = {
  properties: `SELECT id, key, label, description, type, status, storage, scope,
                      merged_into, module, rank, flags
               FROM property_definitions WHERE owner_id IS NULL`,
  aspects: `SELECT id, key, label, description, properties, ai_instructions, tag_mappings,
                   implements, view_config, module, service, rank, schema
            FROM aspect_definitions WHERE owner_id IS NULL`,
  roles: `SELECT id, key, label, description, source_label, target_label, hierarchical,
                 constraints, "symmetric", module, rank
          FROM relation_role_definitions WHERE owner_id IS NULL`,
  contracts: `SELECT id FROM contract_definitions WHERE owner_id IS NULL`,
  subscriptions: `SELECT id FROM subscription_definitions WHERE owner_id IS NULL`,
  actions: `SELECT id FROM action_definitions WHERE owner_id IS NULL`,
};

/**
 * Читает встроенные (`owner_id IS NULL`) строки шести таблиц и сравнивает с кодом.
 *
 * ЧТЕНИЕ ИДЁТ ПОД РОЛЬЮ ПРИЛОЖЕНИЯ, и это половина смысла проверки. Роль приложения
 * NOINHERIT, гранты на таблицы висят на `authenticated` (миграции 0001 и 0014,
 * setup-db.ts), поэтому забытый GRANT новой таблице даёт здесь 42501 — и проверка честно
 * скажет `unknown` вместо тихого «расхождений нет». `withIdentity` для этого не годится: он
 * требует UUID актора, а у стартовой проверки актора нет; политика чтения встроенных
 * (`owner_id IS NULL OR owner_id = auth.uid()`) при пустых claims пропускает ровно их.
 *
 * ЗАЧЕМ ТРАНЗАКЦИЯ — за `SET LOCAL`: вне транзакции он не действует (PostgreSQL применяет
 * его до конца текущей tx, а её нет). Одной транзакции для согласованности снимка МАЛО:
 * по умолчанию она READ COMMITTED, и каждый SELECT в ней берёт СВОЙ снапшот — пересев,
 * идущий параллельно, мог бы попасть между двумя запросами и дать ложный дрейф
 * (замерено пробоем: `current_setting('transaction_isolation')` внутри `db.transaction`
 * без конфига = `read committed`).
 *
 * Поэтому изоляция поднята явно до REPEATABLE READ: все шесть запросов видят ОДИН снапшот,
 * и «аспект ссылается на свойство, которого нет» больше не может быть артефактом момента
 * чтения. `READ ONLY` — не оптимизация, а забор: проверка дрейфа не имеет права писать
 * ни при какой ошибке, и это утверждение проверяет сервер, а не только ревью.
 */
export async function checkRegistryDrift(db: Db): Promise<RegistryDrift> {
  const rows = await db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      const out = {} as RegistryDbRows;
      for (const kind of REGISTRY_KINDS) {
        const result = await tx.execute(sql.raw(REGISTRY_DRIFT_QUERIES[kind]));
        out[kind] = result as unknown as RegistryDbRow[];
      }
      return out;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return diffBuiltinRegistries(rows);
}

/**
 * Состояние стартовой проверки для /health и логов.
 * `unknown` — проверка не выполнилась (БД недоступна на старте, снятые гранты, таймаут):
 * про реестры в этот момент НИЧЕГО не известно, и молчать об этом нельзя.
 */
export type RegistryDriftStatus =
  | { status: 'ok' }
  | { status: 'drift'; drift: RegistryDrift }
  | { status: 'unknown' };

/** Паузы между попытками: холодный старт БД занимает секунды, а не минуты. */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Стартовый вызов: логирует расхождение и отдаёт состояние наружу (index.ts кладёт его
 * в /health). Неудачное чтение повторяется с паузами — недоступность БД в первые секунды
 * boot'а типична и не должна навсегда снимать ловушку; исчерпав попытки, проверка честно
 * возвращает `unknown` вместо тихого «всё хорошо».
 */
export async function reportRegistryDriftOnStartup(
  db: Db,
  deps: { delays?: number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<RegistryDriftStatus> {
  const delays = deps.delays ?? RETRY_DELAYS_MS;
  const wait = deps.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const drift = await checkRegistryDrift(db);
      if (!hasRegistryDrift(drift)) return { status: 'ok' };
      console.error(
        [
          '[registry] РЕЕСТРЫ В БД РАСХОДЯТСЯ С КОДОМ — часть записей будет отклоняться',
          'валидацией исполнителя (fail-closed), то есть фича приедет мёртвой:',
          ...registryDriftReport(drift),
          'Недостающее и расходящееся чинится пересевом (идемпотентно):',
          '  DATABASE_URL_ADMIN=… bun scripts/seed-registries.ts',
          '  или с секретом из Ключницы: bun scripts/ops.ts seed-registries',
          'ЛИШНИЕ строки пересев не убирает: запись, которой нет в коде, — это либо',
          'откат кода на старую версию, либо удалённое определение, и что с ней делать,',
          'решает человек.',
        ].join('\n'),
      );
      return { status: 'drift', drift };
    } catch (e) {
      const delay = delays[attempt];
      if (delay === undefined) {
        console.error(
          '[registry] проверка реестров НЕ ВЫПОЛНЕНА — их состояние неизвестно, ' +
            'ловушка пересева сейчас не работает; проверьте вручную: bun scripts/ops.ts check\n' +
            'Последняя ошибка:',
          e,
        );
        return { status: 'unknown' };
      }
      console.warn(`[registry] проверка реестров не удалась, повтор через ${delay} мс:`, e);
      await wait(delay);
    }
  }
}
