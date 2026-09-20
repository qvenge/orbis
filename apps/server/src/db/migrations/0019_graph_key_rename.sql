-- 0019_graph_key_rename.sql — срез «Г — единица владения» (D44), задача Г-1.
-- Файл РУКОПИСНЫЙ, снимок meta/0019_snapshot.json — сгенерированный (образец и довод —
-- 0015_entities_props.sql:3-10, 0018_spent_cache_modules.sql:3-5): drizzle-kit выражает
-- переименование колонки как DROP + ADD и не знает индексов, созданных прямо в 0001.
--
-- Ключ строк перестаёт называться словом owner: строка принадлежит ГРАФУ, а не аккаунту (спека
-- 2026-09-19-graph-ownership-unit-design §3.4). Значения не меняются: id личного графа равен id
-- аккаунта по построению. Выражения 35 политик RLS и 17 partial-предикатов индексов Postgres
-- переписывает сам (хранятся деревом, прецедент 0015:20,23) — политик и грантов здесь нет
-- намеренно, новый предикат приезжает миграцией 0021.
ALTER TABLE "entities" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "chat_threads" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "entity_versions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "entity_origins" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "ai_usage" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "user_settings" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "agent_grants" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "envelope_spent_cache" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "registry_deltas" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "property_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "aspect_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "relation_role_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "contract_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "subscription_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "action_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
-- Имена, в которых слово owner стоит само (RENAME COLUMN их не трогает). Первые два drizzle не
-- знает вовсе — они созданы прямо в 0001_rls_and_indexes.sql:112,118.
ALTER INDEX "entities_owner_updated" RENAME TO "entities_graph_updated";
--> statement-breakpoint
ALTER INDEX "chat_threads_owner" RENAME TO "chat_threads_graph";
--> statement-breakpoint
ALTER INDEX "agent_grants_owner" RENAME TO "agent_grants_graph";
--> statement-breakpoint
ALTER INDEX "envelope_spent_cache_owner" RENAME TO "envelope_spent_cache_graph";
--> statement-breakpoint
ALTER TABLE "ai_usage" RENAME CONSTRAINT "ai_usage_owner_id_date_model_pk" TO "ai_usage_graph_id_date_model_pk";
