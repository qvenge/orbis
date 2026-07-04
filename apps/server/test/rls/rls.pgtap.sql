-- apps/server/test/rls/rls.pgtap.sql
-- Прогон: psql $DATABASE_URL_ADMIN -v ON_ERROR_STOP=1 -f <этот файл>
-- Всё в одной транзакции с ROLLBACK: БД не мутируется.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

-- Фикстуры под суперпользователем (обходит RLS)
INSERT INTO entities (id, owner_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'A: задача'),
  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'B: задача');
INSERT INTO chat_threads (id, owner_id) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a');
INSERT INTO chat_messages (id, thread_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2', 'user', 'привет');
INSERT INTO aspect_definitions (id, owner_id, name, namespace, schema)
  VALUES ('orbis/pgtap-probe', NULL, 'Probe', 'orbis', '{}');

-- 1) RLS включён и FORCE на всех 8 таблицах
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname IN ('entities','relations','aspect_definitions','user_settings',
                       'chat_threads','chat_messages','ai_usage','entity_origins')
     AND c.relrowsecurity AND c.relforcerowsecurity),
  8, 'RLS ENABLE+FORCE на всех восьми таблицах');

-- Как пользователь A
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[1], 'A видит ровно одну (свою) сущность');
SELECT results_eq(
  $$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000b1'$$,
  ARRAY[0], 'чужая сущность невидима');
SELECT throws_ok(
  $$INSERT INTO entities (id, owner_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000b', 'подлог')$$,
  '42501', NULL, 'INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entities (id, owner_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000a', 'своя')$$,
  'INSERT со своим owner_id проходит');
SELECT throws_ok(
  $$INSERT INTO relations (id, source_id, target_id, relation_type)
    VALUES ('00000000-0000-7000-8000-0000000000c2',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000b1', 'related_to')$$,
  '42501', NULL, 'межпользовательская relation запрещена (§4.10)');
SELECT lives_ok(
  $$INSERT INTO relations (id, source_id, target_id, relation_type)
    VALUES ('00000000-0000-7000-8000-0000000000a5',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000a4', 'related_to')$$,
  'relation между двумя своими сущностями проходит');
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[1],
  'сообщения видимы через владение тредом');
SELECT results_eq($$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], 'встроенные аспекты читаемы');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки),
-- поэтому проверяем не исключение, а неизменность встроенной строки.
UPDATE aspect_definitions SET name = 'hack' WHERE id = 'orbis/pgtap-probe';
SELECT results_eq(
  $$SELECT name FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY['Probe'::text], 'встроенные аспекты не правятся под authenticated');

-- Как пользователь B: чужой тред закрыт на чтение и вставку
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[0], 'B не видит сообщений A');
SELECT throws_ok(
  $$INSERT INTO chat_messages (id, thread_id, role, content)
    VALUES ('00000000-0000-7000-8000-0000000000c3',
            '00000000-0000-7000-8000-0000000000a2', 'user', 'вброс')$$,
  '42501', NULL, 'B не может вставить сообщение в тред A (§13.5)');

RESET ROLE;
-- Deny-by-default: без claims authenticated не видит ничего
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'без identity — 0 строк');
RESET ROLE;
-- Контроль анти-false-positive: админ видит данные обоих
SELECT cmp_ok((SELECT count(*)::int FROM entities), '>=', 3, 'админ видит строки A и B');

SELECT finish();
ROLLBACK;
