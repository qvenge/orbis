-- 0021_graph_rls.sql — срез «Г — единица владения» (D44), задача Г-4.
-- Файл РУКОПИСНЫЙ (drizzle-kit политик, грантов и функций не видит), снимок — сгенерированный.
-- Изоляция: «строка ТЕКУЩЕГО графа ∧ актор держит грант» (спека §3.6). Применённые файлы не правятся:
-- 35 политик снимаются и создаются заново здесь. Bypass RLS не вводится (0013:7-8): функции —
-- SECURITY INVOKER, им хватает SELECT-политики graph_members (0020); рекурсии политик нет.
-- Вариант `graph_id = auth.uid() OR …` исключён: вечный доступ по равенству id мимо членства.

-- Текущий граф — ключ `graph` тех же claims, что и `sub` (ставит withIdentity одним set_config).
-- NULLIF — по канону auth.uid() (scripts/setup-db.ts:12-22): после отката локальной настройки на
-- соединении из пула остаётся '', а не NULL. Не выставлен — NULL, и обе половины предиката ложны.
--
-- ПОЧЕМУ ТРИ ФУНКЦИИ ГРАНТА — plpgsql, А current_graph_id() — sql. ЭТО ЗАМЕРЕНО, НЕ ВКУС.
-- Тело `LANGUAGE sql` с сублинком (`EXISTS`) планировщик НЕ инлайнит, а кеша планов у SQL-функций
-- до PostgreSQL 18 нет вовсе (локально и в CI — 17.6): тело разбирается и планируется ЗАНОВО на
-- КАЖДОМ статементе, а политика зовётся на каждом статементе транзакции. Микроцена — ≈0,3 мс на
-- статемент, и на пути записи она копится: `fastpath:create` (десяток статементов в одной
-- транзакции) давал 55–59 мс против 48–50 мс на том же теле в plpgsql (замеры Г-4, фикс-раунд 1).
-- У plpgsql план тела кешируется в сессии, а соединения живут в пуле. Семантика и свойства те же:
-- STABLE, SECURITY INVOKER, пустой search_path, все имена со схемой — обхода RLS по-прежнему нет.
-- `current_graph_id()` остаётся sql НАМЕРЕННО: без сублинка он инлайнится в предикат политики, и
-- plpgsql только отнял бы эту возможность.
-- Не возвращай эти три функции на `LANGUAGE sql` «потому что короче»: вернётся и цена на записи.

CREATE FUNCTION "public"."current_graph_id"() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
	SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_reads_current_graph"() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL);
END $$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_writes_current_graph"() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind IN ('owner','operator'));
END $$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_owns_current_graph"() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind = 'owner');
END $$;
--> statement-breakpoint
-- ── Простые таблицы строк: entities, user_settings, ai_usage, registry_deltas ──────────────────
-- ЧЕТЫРЕ покомандные политики, как у реестров, а не одна FOR ALL и не пара «SELECT + ALL»:
-- (1) у FOR ALL на DELETE работает только USING — observer с «читающим» USING удалял бы строки;
-- (2) permissive-политики одной команды склеиваются через OR, а FOR ALL применяется и к SELECT:
--     пара дала бы security qual `(graph = $0 AND $1) OR (graph = $2 AND $3)`. План SELECT от этого
--     НЕ портится (общий член `graph_id = …` планировщик выносит за скобки OR и оставляет в
--     Index Cond — проверено мутацией пробы, Ф-Г-28), а вот UPDATE получает 8–10 InitPlan вместо
--     четырёх и считает обе половины предиката дважды. У каждой команды — ровно одна политика:
--     одно правило на команду читается и проверяется, склейка двух — нет.
-- `TO authenticated`, а не PUBLIC: тела функций разбираются при ВЫЗОВЕ, а у orbis_app нет USAGE на
-- схему auth — под PUBLIC тик планировщика падал бы на auth.uid(). Обе половины предиката в обёртке
-- (SELECT …): InitPlan, один раз на запрос, не на строку («решение 2», 0001:35).
DROP POLICY "owner_owns_row" ON "entities";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "entities" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "entities" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "entities" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "entities" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "owner_owns_row" ON "user_settings";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "user_settings" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "user_settings" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "user_settings" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "user_settings" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "owner_owns_row" ON "ai_usage";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "ai_usage" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "ai_usage" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "ai_usage" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "ai_usage" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "owner_owns_row" ON "registry_deltas";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "registry_deltas" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "registry_deltas" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "registry_deltas" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "registry_deltas" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- ── Производные строки: WITH CHECK у INSERT и UPDATE сверяет граф родителя (межграфовая строгость) ──
-- chat_threads.entity_id — давняя дыра: тред со своим graph_id и entity_id ЧУЖОЙ сущности проходил
-- (RI-проверка FK идёт мимо RLS).
DROP POLICY "owner_owns_row" ON "chat_threads";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "chat_threads" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "chat_threads" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND ("chat_threads"."entity_id" IS NULL OR EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "chat_threads"."entity_id" AND e."graph_id" = "chat_threads"."graph_id")));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "chat_threads" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND ("chat_threads"."entity_id" IS NULL OR EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "chat_threads"."entity_id" AND e."graph_id" = "chat_threads"."graph_id")));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "chat_threads" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- envelope_spent_cache.envelope_id — вторая дыра того же класса (0018:33): конверт чужого графа.
DROP POLICY "owner_owns_row" ON "envelope_spent_cache";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "envelope_spent_cache" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "envelope_spent_cache" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "envelope_spent_cache"."envelope_id" AND e."graph_id" = "envelope_spent_cache"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "envelope_spent_cache" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "envelope_spent_cache"."envelope_id" AND e."graph_id" = "envelope_spent_cache"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "envelope_spent_cache" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- entity_origins (0002:10-16) и entity_versions (0011:22-28): строгость этих двух таблиц была
-- записана ещё до среза — здесь она сохранена дословно, сменился только сам ключ сравнения.
DROP POLICY "owner_owns_row_and_entity" ON "entity_origins";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "entity_origins" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "entity_origins" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "entity_origins"."entity_id" AND e."graph_id" = "entity_origins"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "entity_origins" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "entity_origins"."entity_id" AND e."graph_id" = "entity_origins"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "entity_origins" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "owner_owns_row_and_entity" ON "entity_versions";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "entity_versions" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "entity_versions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "entity_versions"."entity_id" AND e."graph_id" = "entity_versions"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "entity_versions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "entity_versions"."entity_id" AND e."graph_id" = "entity_versions"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "entity_versions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- ── Таблицы без своего ключа ──────────────────────────────────────────────────────────────────
-- relations: оба конца — в одном ТЕКУЩЕМ графе до ступени 2 (связи между графами — §6 спеки).
DROP POLICY "owner_owns_both_ends" ON "relations";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "relations" FOR SELECT TO authenticated
USING ((SELECT public.actor_reads_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "relations" FOR INSERT TO authenticated
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "relations" FOR UPDATE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())))
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "relations" FOR DELETE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
-- chat_messages: владение транзитивно через тред; граф треда обязан быть ТЕКУЩИМ.
DROP POLICY "owner_owns_thread" ON "chat_messages";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "chat_messages" FOR SELECT TO authenticated
USING ((SELECT public.actor_reads_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "chat_messages" FOR INSERT TO authenticated
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "chat_messages" FOR UPDATE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())))
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "chat_messages" FOR DELETE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
-- ── agent_grants: грант агенту выписывает ТОЛЬКО держатель гранта owner (иначе operator выдал бы full).
-- Боевая выдача идёт под orbis_app мимо этой политики (server_manages_grants) — там то же условие
-- держит код (assertHoldsOwnerGrant, oauth/grants.ts); политика закрывает путь под authenticated.
DROP POLICY "owner_owns_row" ON "agent_grants";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "agent_grants" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "agent_grants" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "agent_grants" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "agent_grants" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
-- ── Шесть реестров — СВОЯ форма: встроенные строки (graph_id IS NULL) читаемы без текущего графа ──
-- Шаблон «… AND членство» поверх всей политики спрятал бы их от стартовой проверки дрейфа, которая
-- читает под authenticated с пустыми claims (db/registry-drift.ts:101-126) — /health ушёл бы в дрейф.
DROP POLICY "read_builtin_or_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "aspect_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "aspect_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "aspect_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "aspect_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "aspect_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "read_builtin_or_own" ON "property_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "property_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "property_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "property_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "property_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "property_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "property_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "property_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "read_builtin_or_own" ON "relation_role_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "relation_role_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "relation_role_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "relation_role_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "relation_role_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "relation_role_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "relation_role_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "relation_role_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "read_builtin_or_own" ON "contract_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "contract_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "contract_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "contract_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "contract_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "contract_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "contract_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "contract_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "read_builtin_or_own" ON "subscription_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "subscription_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "subscription_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "subscription_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "subscription_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "subscription_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "subscription_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "subscription_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
DROP POLICY "read_builtin_or_own" ON "action_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "action_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "action_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "action_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "action_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "action_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "action_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "action_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- ── issued_by: писатели есть с Г-3, бэкфилл — 0020 ─────────────────────────────────────────────
ALTER TABLE "agent_grants" ALTER COLUMN "issued_by" SET NOT NULL;
