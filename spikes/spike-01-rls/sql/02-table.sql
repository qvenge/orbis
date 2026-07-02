-- Тестовая таблица спайка. Полная схема и косвенные политики (relations/chat_messages) — Веха 0/Слайс 1.
CREATE TABLE IF NOT EXISTS spike_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL, -- D11: owner_id, не user_id; FK на auth.users спайку не нужен
  title text NOT NULL
);

ALTER TABLE spike_items ENABLE ROW LEVEL SECURITY;
-- Страховка от грабли: RLS не применяется к владельцу таблицы без FORCE.
ALTER TABLE spike_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_owns_row ON spike_items;
-- Дословно шаблон PRD 01-architecture §4.10:
CREATE POLICY owner_owns_row ON spike_items
  FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON spike_items TO orbis_app;
