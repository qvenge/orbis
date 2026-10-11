// apps/server/test/agenda-page.ts
// ПОВЕСТКА КАК СТРАНИЦА (спека 1в §6.1, §6.5) — одна правда для сьютов и перфа: три блока тела записи
// поставки «Повестка» (`AGENDA_BODY`) в порядке тела и пачка `entity.blocks` с параметром горизонта.
//
// До 1в Повестку читали движком подписки (`agendaListOf`); движок снят, и «Повестка не шелохнулась»
// теперь значит «пачка трёх блоков её тела отдаёт то же самое». Тексты — разбором эталона, а не
// литералами: сьют держит ровно то, что сеет поставка, и правка тела не разойдётся с проверкой.
import type { EntityBlocksResult } from '@orbis/shared';
import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { AGENDA_BODY } from '@orbis/shared/supply';
import type { Db } from '../src/db/client';
import type { Identity } from '../src/identity';
import { runBlocks } from '../src/routers/entity-blocks';

/** Тексты трёх блоков тела Повестки по порядку: «Просрочено», лента по дням, «Дальше». */
export const AGENDA_PAGE_TEXTS: readonly string[] = parsePageText(AGENDA_BODY).flatMap((n) =>
  n.kind === 'query' ? [n.text] : [],
);
if (AGENDA_PAGE_TEXTS.length !== 3) {
  throw new Error(`в теле Повестки ${AGENDA_PAGE_TEXTS.length} блоков, а не 3`);
}

/** Вход пачки `entity.blocks`: три блока с параметром горизонта — как их шлёт экран записи. */
export function agendaPageBlocks(period = 'next_7d') {
  return AGENDA_PAGE_TEXTS.map((text, i) => ({ key: String(i), text, params: { period } }));
}

/** Пачка трёх блоков Повестки владельца — тем же путём, что ручка `entity.blocks`. */
export function agendaPage(
  db: Db,
  identity: Identity,
  period = 'next_7d',
  now: Date = new Date(),
): Promise<EntityBlocksResult> {
  return runBlocks(db, identity, agendaPageBlocks(period), now);
}

/**
 * Id записей во всех трёх блоках пачки — по порядку блоков. Блок с ошибкой — отказ сьюта: сравнение
 * «до/после» на двух одинаковых ошибках было бы зелёным при сломанной Повестке.
 */
export function agendaPageIds(res: EntityBlocksResult): string[] {
  return AGENDA_PAGE_TEXTS.flatMap((_, i) => {
    const r = res.results[String(i)];
    if (r === undefined || !r.ok) throw new Error(`блок ${i} Повестки: ${JSON.stringify(r)}`);
    if (r.kind === 'rows') return r.rows.map((x) => x.id);
    if (r.kind === 'groups') return r.groups.flatMap((g) => g.rows.map((x) => x.entity.id));
    throw new Error(`блок ${i} Повестки: вид ${r.kind}`);
  });
}
