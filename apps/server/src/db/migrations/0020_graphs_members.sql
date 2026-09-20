-- 0020_graphs_members.sql — срез «Г — единица владения» (D44), задача Г-2.
-- Файл РУКОПИСНЫЙ, снимок meta/0020_snapshot.json — сгенерированный: бэкфилл обязан встать МЕЖДУ
-- созданием таблиц и FK, а политик, грантов и триггеров drizzle-kit не видит вовсе.
-- Bypass RLS не вводится (0013:7-8): функции триггеров — SECURITY INVOKER.
CREATE TABLE "graphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graphs_owner_kind" CHECK ("graphs"."owner_kind" IN ('person','organization')),
	CONSTRAINT "graphs_personal_identity" CHECK (("graphs"."owner_kind" = 'person' AND "graphs"."owner_ref" IS NOT NULL AND "graphs"."id" = "graphs"."owner_ref") OR "graphs"."owner_kind" = 'organization')
);
--> statement-breakpoint
CREATE TABLE "graph_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"graph_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_kind" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "graph_members_grant_kind" CHECK ("graph_members"."grant_kind" IN ('owner','operator','observer'))
);
--> statement-breakpoint
ALTER TABLE "graph_members" ADD CONSTRAINT "graph_members_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_members_active_uniq" ON "graph_members" USING btree ("graph_id","account_id") WHERE "graph_members"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "graph_members_account" ON "graph_members" USING btree ("account_id");
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "issued_by" uuid;
--> statement-breakpoint
-- BACKFILL:BEGIN — прод НЕ пуст (спека §0 п. 6). Текст между маркерами исполняет и тест
-- src/db/graphs.test.ts — второй копии у него нет.
-- У шести реестров NULL = встроенная строка: без `IS NOT NULL` NULL попал бы в PK. Дубли снимает UNION.
INSERT INTO "graphs" ("id", "owner_kind", "owner_ref")
SELECT s.g, 'person', s.g FROM (
	SELECT "graph_id" AS g FROM "entities"
	UNION SELECT "graph_id" FROM "chat_threads"
	UNION SELECT "graph_id" FROM "entity_versions"
	UNION SELECT "graph_id" FROM "entity_origins"
	UNION SELECT "graph_id" FROM "ai_usage"
	UNION SELECT "graph_id" FROM "user_settings"
	UNION SELECT "graph_id" FROM "agent_grants"
	UNION SELECT "graph_id" FROM "envelope_spent_cache"
	UNION SELECT "graph_id" FROM "registry_deltas"
	UNION SELECT "graph_id" FROM "property_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "aspect_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "relation_role_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "contract_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "subscription_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "action_definitions" WHERE "graph_id" IS NOT NULL
) s;
--> statement-breakpoint
INSERT INTO "graph_members" ("id", "graph_id", "account_id", "grant_kind", "issued_by")
SELECT gen_random_uuid(), g."id", g."id", 'owner', g."id" FROM "graphs" g;
--> statement-breakpoint
UPDATE "agent_grants" SET "issued_by" = "graph_id" WHERE "issued_by" IS NULL;
--> statement-breakpoint
-- BACKFILL:END
ALTER TABLE "entities" ADD CONSTRAINT "entities_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_origins" ADD CONSTRAINT "entity_origins_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "envelope_spent_cache" ADD CONSTRAINT "envelope_spent_cache_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "registry_deltas" ADD CONSTRAINT "registry_deltas_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "property_definitions" ADD CONSTRAINT "property_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD CONSTRAINT "aspect_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "relation_role_definitions" ADD CONSTRAINT "relation_role_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "contract_definitions" ADD CONSTRAINT "contract_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_definitions" ADD CONSTRAINT "subscription_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_definitions" ADD CONSTRAINT "action_definitions_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- И-1 (спека §3.3): у графа всегда есть действующий грант owner. Декларативно не выражается —
-- отложенные constraint-триггеры. ГРАНИЦА v1: у роли authenticated пути отзыва нет вовсе
-- (ни политик, ни права UPDATE/DELETE), триггер отзыва работает на админских и ops-путях, где
-- видит все строки. ДОЛГ СТУПЕНИ 2: под SECURITY INVOKER и политикой account_id = auth.uid()
-- он видел бы только строки вызывающего — вместе с политикой отзыва ступень 2 обязана дать
-- владельцам видимость всех строк членства своего графа.
CREATE FUNCTION "public"."graphs_require_owner"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = NEW.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'граф % создан без действующего гранта owner (И-1)', NEW.id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "graphs_require_owner" AFTER INSERT ON "graphs"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."graphs_require_owner"();
--> statement-breakpoint
CREATE FUNCTION "public"."graph_members_keep_owner"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	-- Замок строки графа сериализует параллельные отзывы. FOR NO KEY UPDATE, а не FOR UPDATE:
	-- тот конфликтует с FK-замком (KEY SHARE) каждой записи строк графа.
	PERFORM 1 FROM public.graphs g WHERE g.id = OLD.graph_id FOR NO KEY UPDATE;
	IF NOT FOUND THEN
		RETURN NULL; -- граф снесён вместе с членством: проверять нечего
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = OLD.graph_id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'у графа % не осталось действующего гранта owner (И-1)', OLD.graph_id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "graph_members_keep_owner" AFTER UPDATE OR DELETE ON "graph_members"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."graph_members_keep_owner"();
--> statement-breakpoint
ALTER TABLE "graphs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graphs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Политики новых таблиц (спека §3.6). У graphs и graph_members в v1 НЕТ политик UPDATE/DELETE
-- (И-2: неизменяемость отсутствием права; иначе — самовыдача членства в любой граф).
CREATE POLICY "member_reads_graph" ON "graphs" FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM "graph_members" m
	WHERE m."graph_id" = "graphs"."id" AND m."account_id" = (SELECT auth.uid()) AND m."revoked_at" IS NULL));
--> statement-breakpoint
-- INSERT — только свой личный граф. Сид вставляет БЕЗ RETURNING: пока нет строки членства, только
-- что вставленный граф SELECT-политику не проходит.
CREATE POLICY "person_creates_own_graph" ON "graphs" FOR INSERT TO authenticated
WITH CHECK ("owner_kind" = 'person' AND "id" = (SELECT auth.uid()) AND "owner_ref" = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY "account_reads_own_membership" ON "graph_members" FOR SELECT TO authenticated
USING ("account_id" = (SELECT auth.uid()));
--> statement-breakpoint
-- INSERT — только себя как owner собственного личного графа, РАВЕНСТВОМ id, без EXISTS по graphs
-- (курица и яйцо с политикой выше).
CREATE POLICY "account_owns_personal_graph" ON "graph_members" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT auth.uid()) AND "account_id" = (SELECT auth.uid())
	AND "grant_kind" = 'owner' AND "issued_by" = (SELECT auth.uid()));
--> statement-breakpoint
-- Планировщик рутин идёт под orbis_app БЕЗ идентичности (0013) и обязан получить пары
-- «граф, держатель гранта owner». Образец — scheduler_reads_owner_list (0013:25,35): поверхность
-- без идентичности расширена на одну таблицу без тел.
CREATE POLICY "scheduler_reads_members" ON "graph_members" FOR SELECT TO orbis_app USING (true);
--> statement-breakpoint
-- ЯВНЫЕ гранты: GRANT … ON ALL TABLES из 0001:97 на таблицы, созданные позже, не распространяется
-- (урок 0011/0014/0018). Сначала REVOKE: default ACL роли-владельца в разных окружениях разный
-- (локальный стек даёт anon/authenticated `Dxtm`, образ CI — ещё и SELECT; rls.pgtap.sql:298-322), а
-- TRUNCATE идёт мимо RLS. После него у authenticated ровно SELECT и INSERT.
REVOKE ALL ON "graphs", "graph_members" FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON "graphs", "graph_members" TO authenticated;
--> statement-breakpoint
GRANT SELECT ON "graph_members" TO orbis_app;
