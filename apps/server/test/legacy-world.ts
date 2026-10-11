// apps/server/test/legacy-world.ts
import type { GraphId } from '@orbis/shared';
import {
  LEGACY_ETALON_TEXTS,
  LEGACY_SEED_LIST_SLUGS,
  SEED_SMART_LISTS,
  UPCOMING_BODY,
} from '@orbis/shared/supply';
import { sql } from 'drizzle-orm';
import { ensureGlobalThread } from '../src/chat/threads';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { SEED_CATEGORIES } from '../src/seed/categories';
import { ensurePersonalGraph } from '../src/seed/personal-graph';
import { seedCategoryId, seedSmartListId } from '../src/seed/world';
import { appDb, personal } from './helpers';

/**
 * Мир СТАРОЙ ФОРМЫ (до среза 1б) — таким его оставил прежний онбординг у владельца в проде.
 *
 * Зачем фикстура, а не прежний код сева: код сева этой формы больше не производит, а её ждёт отказ
 * `GRAPH_NEEDS_MIGRATION` на входе (заведение графа, `seed/setup-graph.ts`). Перевод данных 1б
 * `migrate-1b`, второй потребитель, исполнен в проде 28.09 и снят срезом 1в (РП-13).
 *
 * Шесть списков — ПРЕЖНИЕ (`LEGACY_SEED_LIST_SLUGS`, с Upcoming), а не нынешний сев с Повесткой
 * (срез 1в §6.3): заголовки и эмодзи — у пяти из `SEED_SMART_LISTS`, у Upcoming — свои литералы ниже
 * (её в нынешнем севе нет).
 *
 * Состав: 12 категорий (как сегодня: тег `category`, аспект Финансов); шесть списков с тегом
 * `smart-list` БЕЗ аспектов — у Daily Planning, Upcoming, All Tasks (до §Б1-2, R-39), «Года» и «Жизни»
 * (до словаря 1б) тела прежних эталонов (`LEGACY_ETALON_TEXTS`), у «Рутин» — нынешнее (её прежний
 * эталон совпадает с нынешним); строка настроек с пятью
 * закреплёнными и `installedViews: ['orbis-budget']`; глобальный тред. Маска пуста — у старого графа
 * Финансы включены. Рутин (садовник, «Перенос остатков») нет: переводу данных они не нужны, а
 * сьют, которому они понадобятся, посеет их сам.
 *
 * Путь записи — тот же, каким сеял прежний онбординг: пачка исполнителя механизмом `seed`, без
 * журнала; настройки и тред — прямой вставкой, как прежний `seedOnboarding`.
 */
export async function seedLegacyWorld(graph: GraphId): Promise<void> {
  const who = personal(graph);
  const { db, client } = appDb();
  try {
    await withIdentity(db, who, (tx) => ensurePersonalGraph(tx, who));
    const lists = LEGACY_SEED_LIST_SLUGS.map((slug) => {
      const now = SEED_SMART_LISTS.find((l) => l.slug === slug);
      const head =
        slug === 'upcoming'
          ? { title: 'Upcoming', emoji: '🗓️', body: UPCOMING_BODY }
          : { title: now?.title ?? slug, emoji: now?.emoji ?? null, body: now?.body ?? '' };
      return {
        id: seedSmartListId(graph, slug),
        title: head.title,
        emoji: head.emoji,
        body: LEGACY_ETALON_TEXTS[slug] ?? head.body,
        tags: ['smart-list'],
        props: {},
      };
    });
    const categories = SEED_CATEGORIES.map((c) => ({
      id: seedCategoryId(graph, c.slug),
      title: c.title,
      tags: ['category'],
      aspects: ['orbis/category'],
      props: {
        'orbis/icon': c.icon,
        'orbis/color': c.color,
        'orbis/aliases': [...c.aliases],
        ...(c.spendClass ? { 'orbis/spend_class': c.spendClass } : {}),
      },
    }));
    const r = await execute(db, {
      identity: who,
      actorKind: 'owner',
      source: 'system',
      mechanism: 'seed',
      batchId: crypto.randomUUID(),
      operations: [...categories, ...lists].map((input) => ({ tool: 'entity_create', input })),
    });
    if (!r.ok) throw new Error(`мир старой формы: ${JSON.stringify(r.error)}`);

    const pinned = ['daily-planning', 'upcoming', 'all-tasks', 'horizon-year', 'routines'].map(
      (slug, order) => ({ id: seedSmartListId(graph, slug), order }),
    );
    await withIdentity(db, who, async (tx) => {
      await tx.execute(sql`
        INSERT INTO user_settings (graph_id, "installedViews", "pinnedEntities")
        VALUES (${graph}::uuid, ARRAY['orbis-budget']::text[], ${JSON.stringify(pinned)}::jsonb)`);
      await ensureGlobalThread(tx, graph);
    });
  } finally {
    await client.end();
  }
}
