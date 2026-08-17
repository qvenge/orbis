-- 0011_ade_versions_rls.sql
-- RLS для entity_versions (§2.2, ADE-срез 1, С11): владение прямое, по owner_id, плюс
-- владение самой сущностью на записи — как у entity_origins после 0002. Рукописная
-- миграция без снимка: drizzle-kit политик и грантов не видит, снимок схемы их не
-- описывает (тот же порядок, что у 0005).
ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- FORCE — страховка от обхода владельцем таблицы (как во всех остальных таблицах, 0001)
ALTER TABLE entity_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Почему WITH CHECK шире USING — прецедент 0002_entity_origins_ownership.sql.
-- Одного `owner_id = auth.uid()` мало: RI-проверка внешнего ключа идёт МИМО RLS и чужую
-- сущность прекрасно видит, поэтому под A проходила бы вставка строки со СВОИМ owner_id,
-- но entity_id ЧУЖОЙ сущности B — «версия чужой записи». Владение в §4.10 сквозное, и
-- ловить это кодом значит полагаться на один-единственный путь записи; здесь тот же фикс
-- и то же имя политики, что у entity_origins, чтобы grep по политикам был единообразен.
-- Инвариант 9 спеки среза («RLS новых таблиц запинена поимённо») закрывает группа 10
-- в test/rls/rls.pgtap.sql — там же пин и на эту, расширенную, половину WITH CHECK.
-- USING не сужаем: читаемость строки определяется владением самой строкой, и лишний
-- EXISTS на каждом чтении не нужен.
-- (select auth.uid()) — InitPlan-кэширование: один вызов на запрос, а не на строку.
CREATE POLICY owner_owns_row_and_entity ON entity_versions FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = entity_versions.entity_id
                  AND e.owner_id = (SELECT auth.uid()))
  );
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
