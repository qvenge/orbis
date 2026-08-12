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
-- Почему серверные политики ниже — USING (true), то есть не скоупят НИЧЕГО.
--
-- Скоупить их нечем: под ролью orbis_app сервер работает ровно там, где владелец ещё
-- неизвестен. verifyBearer ищет грант ПО ХЕШУ предъявленного токена и только из найденной
-- строки узнаёт owner_id; обмен кода и ротация refresh — так же. Условия вида
-- `owner_id = auth.uid()` под этой ролью всегда ложны (auth.uid() пуст), то есть узкая
-- политика закрыла бы саму аутентификацию.
--
-- Следствие, которое надо знать, читая код: под orbis_app RLS не подстраховывает ни одного
-- предиката в запросах сервера. Там, где строка выбирается ПО ВЛАДЕЛЬЦУ (listGrants,
-- revokeGrant в oauth/grants.ts), условие на owner_id — единственная линия, а не «вторая
-- к RLS»; снять его как мнимый дубль нельзя. Скоупит эти запросы код, и это осознанный
-- размен, а не упущение.
--
-- Чем граница держится вместо этого: DATABASE_URL с ролью orbis_app не покидает сервер,
-- а браузер владельца ходит под authenticated — и вот там политика узкая (owner_owns_row).
CREATE POLICY server_manages_grants ON agent_grants FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Клиенты DCR не принадлежат никому: владелец видит их только через свой грант,
-- поэтому под authenticated таблица закрыта целиком (политики для этой роли нет) — и
-- GRANT'а ей ниже тоже не даётся, в отличие от agent_grants. Барьеров у чужого выходит
-- два: сперва отсутствие права, за ним RLS без политики. Оба запинены поимённо в
-- test/rls/rls.pgtap.sql (группа 9) — второй проверяется выдачей GRANT'а прямо в
-- откатываемой транзакции, чтобы пин не зависел от настройки default privileges базы.
CREATE POLICY server_manages_clients ON oauth_clients FOR ALL TO orbis_app
  USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants, oauth_clients TO orbis_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants TO authenticated;
