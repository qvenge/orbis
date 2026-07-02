-- Рабочая роль приложения: LOGIN, без суперправ и без BYPASSRLS (AUTH-09, carried в 04-decision-log).
-- Пароль подставляется setup-db.ts из env (__APP_PASSWORD__ — плейсхолдер, в git пароля нет).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orbis_app') THEN
    CREATE ROLE orbis_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
      PASSWORD '__APP_PASSWORD__';
  ELSE
    ALTER ROLE orbis_app PASSWORD '__APP_PASSWORD__';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO orbis_app;
-- Политики вызывают auth.uid() от имени подключённой роли:
GRANT USAGE ON SCHEMA auth TO orbis_app;
GRANT EXECUTE ON FUNCTION auth.uid() TO orbis_app;
