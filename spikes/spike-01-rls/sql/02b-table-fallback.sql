-- FALLBACK (применяется ТОЛЬКО при провале основной механики, план Task B8):
-- identity через transaction-local application setting вместо auth.uid().
-- Использовать вместе с IDENTITY_MODE=app_setting.
DROP POLICY IF EXISTS owner_owns_row ON spike_items;
CREATE POLICY owner_owns_row ON spike_items
  FOR ALL
  USING (owner_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (owner_id = current_setting('app.user_id', true)::uuid);
