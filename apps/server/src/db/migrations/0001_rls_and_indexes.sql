-- 0001_rls_and_indexes.sql
-- RLS + FORCE (FORCE — страховка от обхода владельцем таблицы, findings грабля 4)
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE relations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE aspect_definitions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE aspect_definitions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chat_threads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entity_origins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE entity_origins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Политики: единый шаблон §4.10; (select auth.uid()) — InitPlan-кэширование (решение 2)
CREATE POLICY owner_owns_row ON entities FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY owner_owns_row ON user_settings FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY owner_owns_row ON chat_threads FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY owner_owns_row ON ai_usage FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY owner_owns_row ON entity_origins FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- relations: владение транзитивно — ОБЕ сущности принадлежат пользователю (§4.10)
CREATE POLICY owner_owns_both_ends ON relations FOR ALL
  USING (
    EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  );
--> statement-breakpoint
-- chat_messages: доступ только через владение тредом (§4.10)
CREATE POLICY owner_owns_thread ON chat_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id
                   AND t.owner_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id
                   AND t.owner_id = (SELECT auth.uid())));
--> statement-breakpoint
-- aspect_definitions: встроенные читаемы всеми; кастомные — по шаблону владельца;
-- встроенные изменяемы только service-role/админом (политики на запись не дают NULL-owner)
CREATE POLICY read_builtin_or_own ON aspect_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY write_own ON aspect_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY update_own ON aspect_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY delete_own ON aspect_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- Гранты: default privileges Supabase дают authenticated права на новые таблицы
-- на hosted, но для CI-образа и детерминизма фиксируем явно.
GRANT USAGE ON SCHEMA public TO authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
--> statement-breakpoint
-- Индексы §4.9 (включая FK-индексы, на которые опираются RLS-подзапросы §4.10)
CREATE INDEX entities_tags_gin ON entities USING gin (tags);
--> statement-breakpoint
CREATE INDEX entities_aspects_gin ON entities USING gin (aspects);
--> statement-breakpoint
CREATE INDEX entities_meta_gin ON entities USING gin (meta);
--> statement-breakpoint
CREATE INDEX entities_body_refs_gin ON entities USING gin (body_refs);
--> statement-breakpoint
CREATE INDEX entities_title_fts ON entities USING gin (to_tsvector('simple', title));
--> statement-breakpoint
CREATE INDEX entities_body_fts ON entities USING gin (to_tsvector('simple', body));
--> statement-breakpoint
CREATE INDEX entities_owner_updated ON entities (owner_id, updated_at DESC) WHERE NOT archived;
--> statement-breakpoint
CREATE INDEX relations_source_type ON relations (source_id, relation_type);
--> statement-breakpoint
CREATE INDEX relations_target_type ON relations (target_id, relation_type);
--> statement-breakpoint
CREATE INDEX chat_threads_owner ON chat_threads (owner_id);
--> statement-breakpoint
CREATE INDEX chat_messages_thread_created ON chat_messages (thread_id, created_at);
--> statement-breakpoint
-- Поиск action по id для Undo (решение 5 плана; jsonb_path_ops — компактный containment)
CREATE INDEX chat_messages_metadata_gin ON chat_messages USING gin (metadata jsonb_path_ops);
