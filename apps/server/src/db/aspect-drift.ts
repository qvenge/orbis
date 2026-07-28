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
 * Стартовый вызов: логирует расхождение и отдаёт его наружу (index.ts кладёт результат
 * в /health). Своя ошибка чтения тоже логируется и не роняет старт — недоступность БД
 * на старте не должна отличаться от недоступности БД на первом запросе.
 */
export async function reportAspectDriftOnStartup(db: Db): Promise<AspectDrift | null> {
  try {
    const drift = await checkAspectDrift(db);
    if (!hasAspectDrift(drift)) return drift;
    console.error(
      [
        '[aspects] РЕЕСТР АСПЕКТОВ В БД РАСХОДИТСЯ С КОДОМ — часть записей будет отклоняться',
        'валидацией исполнителя (fail-closed), то есть фича приедет мёртвой:',
        ...driftReport(drift),
        'Починить (идемпотентно): DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts',
        'или с секретом из Ключницы: bun scripts/ops.ts seed-aspects',
      ].join('\n'),
    );
    return drift;
  } catch (e) {
    console.error('[aspects] проверка реестра не выполнена:', e);
    return null;
  }
}
