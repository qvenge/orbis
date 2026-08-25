DROP INDEX IF EXISTS newf.n_props_envelope_period;
DROP INDEX IF EXISTS newf.n_props_movement_date;
DROP INDEX IF EXISTS newf.n_props_movement_catref;
DROP INDEX IF EXISTS public.p_asp_envelope_period;
DROP INDEX IF EXISTS public.p_asp_movement_date;
DROP INDEX IF EXISTS public.p_asp_movement_catref;
ANALYZE newf.entities; ANALYZE public.entities;
