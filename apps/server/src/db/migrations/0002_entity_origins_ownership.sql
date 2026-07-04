-- 0002_entity_origins_ownership.sql
-- Ужесточение записи в entity_origins (находка ревью Task 2).
-- Дыра: owner_owns_row проверял только owner_id — под A проходил
-- INSERT origins с entity_id ЧУЖОЙ сущности. FK NO ACTION + RI мимо RLS
-- давали кросс-пользовательский примитив: загрязнение provenance и блокировка
-- будущего hard-delete чужой строкой. Фикс: WITH CHECK дополнительно требует
-- владения самой сущностью. USING не сужаем (читаемость строк не меняется).
DROP POLICY owner_owns_row ON entity_origins;
--> statement-breakpoint
CREATE POLICY owner_owns_row_and_entity ON entity_origins FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    AND EXISTS (SELECT 1 FROM entities e WHERE e.id = entity_origins.entity_id
                  AND e.owner_id = (SELECT auth.uid()))
  );
