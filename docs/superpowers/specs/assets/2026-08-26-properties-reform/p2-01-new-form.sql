-- Проба П2, новая форма (путь С): props jsonb по id свойства (Р6) + roles text[] (Р1/Р6),
-- relations.role text NOT NULL (Б4, relation_type удалён), индексы — по образцу прод-схемы
-- (0001_rls_and_indexes.sql: GIN по jsonb и по массиву, btree по (source_id|target_id, роль)).
-- ЗАМЕЧАНИЕ ОБ ИМЕНИ: в задании колонка названа `aspects text[]`; здесь она называется
-- `roles text[]` — по нормативу Р1/Р6 («роль — то, что сегодня называется аспектом»).
-- Это та же колонка: массив id ролей.
CREATE SCHEMA newf;

CREATE TABLE newf.entities (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  title text NOT NULL,
  emoji text,
  body text NOT NULL DEFAULT '',
  body_refs text[] NOT NULL DEFAULT '{}',
  body_doc jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  props jsonb NOT NULL DEFAULT '{}',
  roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived boolean NOT NULL DEFAULT false
);

CREATE TABLE newf.relations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES newf.entities(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES newf.entities(id) ON DELETE CASCADE,
  role text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rel_uniq UNIQUE (source_id, target_id, role),
  CONSTRAINT rel_no_self CHECK (source_id <> target_id)
);

CREATE TABLE newf.user_settings (
  owner_id uuid PRIMARY KEY,
  plan text NOT NULL DEFAULT 'dev',
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  "defaultCurrency" text NOT NULL DEFAULT 'RUB',
  "weekStartDay" text NOT NULL DEFAULT 'monday',
  "tagColors" jsonb NOT NULL DEFAULT '{}',
  "installedViews" text[] NOT NULL DEFAULT '{}',
  "pinnedEntities" jsonb NOT NULL DEFAULT '[]',
  "viewPreferences" jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS — дословно шаблон 0001 (§4.10), чтобы обе формы мерились под одинаковыми политиками
ALTER TABLE newf.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE newf.entities FORCE ROW LEVEL SECURITY;
ALTER TABLE newf.relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE newf.relations FORCE ROW LEVEL SECURITY;
ALTER TABLE newf.user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE newf.user_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_owns_row ON newf.entities FOR ALL
  USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_row ON newf.user_settings FOR ALL
  USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY owner_owns_both_ends ON newf.relations FOR ALL
  USING (
    EXISTS (SELECT 1 FROM newf.entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM newf.entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM newf.entities e WHERE e.id = relations.source_id
              AND e.owner_id = (SELECT auth.uid()))
    AND EXISTS (SELECT 1 FROM newf.entities e WHERE e.id = relations.target_id
              AND e.owner_id = (SELECT auth.uid()))
  );

GRANT USAGE ON SCHEMA newf TO authenticated, orbis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA newf TO authenticated, orbis_app;

-- Индексы по образцу прод-схемы (0001:100-116)
CREATE INDEX n_entities_tags_gin ON newf.entities USING gin (tags);
CREATE INDEX n_entities_props_gin ON newf.entities USING gin (props);
CREATE INDEX n_entities_roles_gin ON newf.entities USING gin (roles);
CREATE INDEX n_entities_body_refs_gin ON newf.entities USING gin (body_refs);
CREATE INDEX n_entities_title_fts ON newf.entities USING gin (to_tsvector('simple', title));
CREATE INDEX n_entities_body_fts ON newf.entities USING gin (to_tsvector('simple', body));
CREATE INDEX n_entities_owner_updated ON newf.entities (owner_id, updated_at DESC) WHERE NOT archived;
CREATE INDEX n_relations_source_role ON newf.relations (source_id, role);
CREATE INDEX n_relations_target_role ON newf.relations (target_id, role);
