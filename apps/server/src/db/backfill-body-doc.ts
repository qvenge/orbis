// Разовая конверсия существующих тел в структурную форму. Порциями: тел может быть много, а
// один долгий UPDATE держал бы блокировки дольше нужного.
//
// Не «миграция данных внутри SQL-миграции» намеренно: конверсию делает JS-парсер
// (@orbis/shared/doc), внутри postgres его нет. Запускается через `bun scripts/ops.ts` после
// наката 0007; всё, что бэкфилл не догнал, сервер конвертирует лениво при первом чтении —
// колонка nullable ровно ради этого.
import { type BodyDoc, canonicalizeBody } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/** Строка, которую бэкфилл берёт в работу. `body` может прийти NULL — см. `?? ''` ниже. */
export type BackfillRow = { id: string; body: string | null };

/**
 * Минимальный доступ к БД, который нужен циклу: взять порцию неконвертированных тел и записать
 * результат по одной строке.
 *
 * Зачем интерфейс. Цикл обязан существовать в ЕДИНСТВЕННОМ экземпляре: тест ходит в локальную
 * базу через drizzle, а прод-операция — через сырой пул `scripts/ops.ts`, и дословная вторая
 * копия цикла была бы НЕ ПОКРЫТА тестом (ревью И16) — то есть разошлась бы с проверенной на
 * первой же правке размера порции. Заодно интерфейс даёт шов: поведение порций проверяется
 * без базы вовсе.
 */
export interface BackfillIo {
  /** Строки с `body_doc IS NULL`, не больше `limit` штук. */
  selectBatch(limit: number): Promise<BackfillRow[]>;
  /** Обе колонки одной строки — они меняются только вместе (см. инвариант ниже). */
  writeRow(row: { id: string; doc: BodyDoc; body: string }): Promise<void>;
}

/** Размер порции. Меняется в ОДНОМ месте — второй копии цикла нет. */
const BATCH = 200;

/**
 * Конвертирует все тела без документа и возвращает их число.
 *
 * Идемпотентна по построению: выборка идёт по `body_doc IS NULL`, поэтому сконвертированная
 * строка сама покидает очередь, а повторный запуск честно возвращает 0.
 *
 * Ошибку конверсии НЕ глотает — и это осознанно. Каждая строка пишется своим UPDATE в
 * автокоммите, так что падение на середине оставляет уже сконвертированное сконвертированным,
 * а остальное — с NULL: чинится парсер, команда запускается снова и продолжает с того же места.
 * Проглоченная же ошибка оставила бы строку в выборке навсегда и закрутила бы цикл вечно.
 * (Пробой на 23 недружелюбных телах — html, reference-определения, черта в ячейке, сноски,
 * одинокий суррогат, 200 уровней вложенности — canonicalizeBody не бросил ни разу.)
 */
export async function backfillBodyDoc(io: BackfillIo): Promise<number> {
  let done = 0;
  for (;;) {
    const rows = await io.selectBatch(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      // `?? ''` — не про текущую схему (там body NOT NULL DEFAULT ''), а про то, что команда
      // ходит в ПРОД: его схема — та, что развёрнута, а не та, что в этом файле.
      const { doc, body } = canonicalizeBody(String(row.body ?? ''));
      // body тоже выравнивается до канона: FTS не страдает (проверено спайком на живой БД),
      // сиды не меняются (они канон — seed-canon.test.ts), а инвариант пары
      // «body === serializeBody(body_doc)» держится с первого дня, а не «после первого
      // пересохранения».
      await io.writeRow({ id: row.id, doc, body });
      done += 1;
    }
    if (rows.length < BATCH) break; // неполная порция — очередь исчерпана, лишний SELECT не нужен
  }
  return done;
}

/**
 * Адаптер поверх drizzle. Его же использует прод-операция (`scripts/ops.ts backfill-body-doc`),
 * обернув сырой пул из `withDb` — так на проде исполняется ровно тот SQL, который прогнал тест.
 */
export function drizzleBackfillIo(db: Db): BackfillIo {
  return {
    selectBatch: async (limit) =>
      (await db.execute(
        sql`SELECT id, body FROM entities WHERE body_doc IS NULL LIMIT ${limit}`,
      )) as unknown as BackfillRow[],
    writeRow: async ({ id, doc, body }) => {
      await db.execute(
        sql`UPDATE entities SET body_doc = ${JSON.stringify(doc)}::jsonb, body = ${body}
            WHERE id = ${id}`,
      );
    },
  };
}
