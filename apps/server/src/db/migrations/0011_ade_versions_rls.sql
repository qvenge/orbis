-- 0011_ade_versions_rls.sql
-- RLS для entity_versions (§2.2, ADE-срез 1, С11): владение прямое, по owner_id, —
-- как у entity_origins в 0001. Рукописная миграция без снимка: drizzle-kit политик и
-- грантов не видит, снимок схемы их не описывает (тот же порядок, что у 0005).
ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- FORCE — страховка от обхода владельцем таблицы (как во всех остальных таблицах, 0001)
ALTER TABLE entity_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- (select auth.uid()) — InitPlan-кэширование: один вызов на запрос, а не на строку
CREATE POLICY owner_owns_row ON entity_versions FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
--> statement-breakpoint
-- GRANT ... ON ALL TABLES из 0001 на таблицы, созданные позже, не распространяется (см. 0005:47-49)
--
-- Рабочий доступ даёт строка ниже про authenticated: сервер ходит в графе под этой ролью
-- (SET LOCAL ROLE authenticated в withIdentity, src/db/with-identity.ts:22-23), и именно
-- там политика выше и скоупит строки.
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO authenticated;
--> statement-breakpoint
-- А эта строка — на случай запросов БЕЗ identity, которые идут под серверной ролью
-- (так устроен, например, лукап гранта по хешу в 0005). Сегодня таких путей к версиям нет,
-- и права одного GRANT'а мало: политики для orbis_app здесь нет, значит RLS вернёт 0 строк.
-- Право выдаём, чтобы такой путь падал понятной пустотой, а не «permission denied».
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO orbis_app;
