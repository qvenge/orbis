-- Те же индексы для СТАРОЙ формы — контроль: выигрыш даёт форма или индекс?
CREATE INDEX IF NOT EXISTS p_asp_envelope_period ON public.entities
  ((aspects->'orbis/budget'->>'period_start'), (aspects->'orbis/budget'->>'period_end'))
  WHERE aspects ? 'orbis/budget' AND NOT archived;

CREATE INDEX IF NOT EXISTS p_asp_movement_date ON public.entities
  (owner_id, (aspects->'orbis/financial'->>'occurred_on'))
  WHERE aspects ? 'orbis/financial' AND NOT archived;

CREATE INDEX IF NOT EXISTS p_asp_movement_catref ON public.entities
  ((aspects->'orbis/financial'->>'category_ref'))
  WHERE aspects ? 'orbis/financial' AND NOT archived;

ANALYZE public.entities;
