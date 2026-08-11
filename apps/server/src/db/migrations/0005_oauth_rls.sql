-- 0005_oauth_rls.sql
-- RLS для таблиц §9.3 (D34). Особенность против остальных восьми таблиц:
-- аутентификация ищет грант по хешу ДО того, как владелец известен (withIdentity
-- ставит identity только когда владелец уже есть), поэтому политик две —
-- владельцу под authenticated его строки, серверной роли orbis_app полный доступ
-- для лукапа, отметки last_used_at и регистрации клиентов (клиент на момент DCR ничей).
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner_owns_row ON agent_grants FOR ALL TO authenticated
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- Клиенты DCR не принадлежат никому: владелец видит их только через свой грант,
-- поэтому под authenticated таблица закрыта целиком (политики для этой роли нет).
CREATE POLICY server_manages_grants ON agent_grants FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY server_manages_clients ON oauth_clients FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants, oauth_clients TO orbis_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants TO authenticated;
