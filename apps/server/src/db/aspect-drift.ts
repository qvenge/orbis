// apps/server/src/db/aspect-drift.ts
// Стартовая проверка ловушки релиза (бэклоги фаз C и D, единственный Important
// операционного раздела): реестр аспектов в БД заполняет scripts/seed-aspects.ts,
// которого нет ни в Dockerfile, ни в render.yaml. Релиз, изменивший поле аспекта,
// без пересева выкатывается со старой схемой — исполнитель валидирует по таблице,
// и фича приезжает мёртвой (fail-closed: запись отклоняется, данные целы).
//
// Проверка НЕ роняет старт. Дрейф одного аспекта — не повод не поднимать приложение:
// всё остальное работает, а healthCheckPath Render превратил бы наблюдаемость в отказ
// деплоя. Сигнал — громкий лог с точной командой починки плюс поле в /health.
//
// ТРИ СОСТОЯНИЯ, а не два (фикс-раунд по находке ревью). «Проверка не выполнилась»
// обязано отличаться от «расхождений нет»: холодный старт Render+Supabase легко даёт
// недоступную БД в первые секунды, и раньше единственная неудачная попытка навсегда
// выключала ловушку — /health при этом отвечал ровно как на здоровом реестре, то есть
// штатная операторская проверка (runbook §1) давала ложноотрицательный ответ.
import { type AspectDrift, diffBuiltinAspects, hasAspectDrift } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * Читает встроенные (`owner_id IS NULL`) строки реестра и сравнивает с кодом.
 *
 * `SET LOCAL ROLE authenticated` обязателен: роль приложения NOINHERIT, гранты на таблицы
 * висят на `authenticated` (миграция 0001, setup-db.ts). `withIdentity` для этого не годится —
 * он требует UUID актора, а у стартовой проверки актора нет; политика чтения встроенных
 * (`owner_id IS NULL OR owner_id = auth.uid()`) при пустых claims пропускает ровно их.
 */
export async function checkAspectDrift(db: Db): Promise<AspectDrift> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return tx.execute(
      sql`SELECT id, schema, ai_instructions FROM aspect_definitions WHERE owner_id IS NULL`,
    );
  });
  return diffBuiltinAspects(
    (rows as unknown as { id: string; schema: unknown; ai_instructions: string }[]).map((r) => ({
      id: r.id,
      schema: r.schema,
      aiInstructions: r.ai_instructions,
    })),
  );
}

/** Человекочитаемые строки лога: что именно разошлось и как это чинится. */
export function driftReport(drift: AspectDrift): string[] {
  const out: string[] = [];
  for (const id of drift.missing) out.push(`  ✗ ${id}: в реестре БД НЕТ`);
  for (const d of drift.drifted) out.push(`  ✗ ${d.id}: расходится (${d.what.join(' + ')})`);
  return out;
}

/**
 * Состояние стартовой проверки для /health и логов.
 * `unknown` — проверка не выполнилась (БД недоступна на старте, снятые гранты, таймаут):
 * про реестр в этот момент НИЧЕГО не известно, и молчать об этом нельзя.
 */
export type AspectDriftStatus =
  | { status: 'ok' }
  | { status: 'drift'; drift: AspectDrift }
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
export async function reportAspectDriftOnStartup(
  db: Db,
  deps: { delays?: number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<AspectDriftStatus> {
  const delays = deps.delays ?? RETRY_DELAYS_MS;
  const wait = deps.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const drift = await checkAspectDrift(db);
      if (!hasAspectDrift(drift)) return { status: 'ok' };
      console.error(
        [
          '[aspects] РЕЕСТР АСПЕКТОВ В БД РАСХОДИТСЯ С КОДОМ — часть записей будет отклоняться',
          'валидацией исполнителя (fail-closed), то есть фича приедет мёртвой:',
          ...driftReport(drift),
          'Починить (идемпотентно): DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts',
          'или с секретом из Ключницы: bun scripts/ops.ts seed-aspects',
        ].join('\n'),
      );
      return { status: 'drift', drift };
    } catch (e) {
      const delay = delays[attempt];
      if (delay === undefined) {
        console.error(
          '[aspects] проверка реестра НЕ ВЫПОЛНЕНА — состояние реестра неизвестно, ' +
            'ловушка пересева сейчас не работает; проверьте вручную: bun scripts/ops.ts check\n' +
            'Последняя ошибка:',
          e,
        );
        return { status: 'unknown' };
      }
      console.warn(`[aspects] проверка реестра не удалась, повтор через ${delay} мс:`, e);
      await wait(delay);
    }
  }
}
