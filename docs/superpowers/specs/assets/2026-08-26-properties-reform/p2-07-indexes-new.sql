-- Проба П2 — экспрессионные индексы по props для НОВОЙ формы (что спека обязана завести).
-- Заводятся отдельным шагом, чтобы в отчёте были ОБА замера: «только индексы по образцу
-- прод-схемы (GIN)» и «плюс эти».
CREATE INDEX IF NOT EXISTS n_props_envelope_period ON newf.entities
  ((props->>'orbis/period_start'), (props->>'orbis/period_end'))
  WHERE roles @> ARRAY['orbis/budget']::text[] AND NOT archived;

CREATE INDEX IF NOT EXISTS n_props_movement_date ON newf.entities
  (owner_id, (props->>'orbis/occurred_on'))
  WHERE roles @> ARRAY['orbis/financial']::text[] AND NOT archived;

CREATE INDEX IF NOT EXISTS n_props_movement_catref ON newf.entities
  (((props->>'orbis/category_ref')::uuid))
  WHERE roles @> ARRAY['orbis/financial']::text[] AND NOT archived;

ANALYZE newf.entities;
