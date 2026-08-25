-- Проба П2 — материализованный вариант агрегата spent (клапан §4.3 PRD / Б7).
-- Таблица-кеш, а не MATERIALIZED VIEW: matview в Postgres нельзя обновить частично
-- (REFRESH пересчитывает всё) и он живёт вне RLS владельца — обе черты для Orbis
-- неприемлемы. Кеш — обычная таблица под той же политикой, что и остальные.
DROP TABLE IF EXISTS newf.envelope_spent_cache;
CREATE TABLE newf.envelope_spent_cache (
  envelope_id uuid PRIMARY KEY REFERENCES newf.entities(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  spent numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX n_spent_cache_owner ON newf.envelope_spent_cache (owner_id);
ALTER TABLE newf.envelope_spent_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE newf.envelope_spent_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_owns_row ON newf.envelope_spent_cache FOR ALL
  USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON newf.envelope_spent_cache TO authenticated, orbis_app;
