-- apps/server/test/rls/rls.pgtap.sql
-- Прогон: psql $DATABASE_URL_ADMIN -v ON_ERROR_STOP=1 -f <этот файл>
-- Всё в одной транзакции с ROLLBACK: БД не мутируется.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(31);

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
-- Фикстуры для обеих сторон (A и B): без строки B проверки «видит только свою»
-- были бы ложно-зелёными даже при сломанном RLS.
INSERT INTO user_settings (owner_id) VALUES
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b');
INSERT INTO ai_usage (owner_id, date, model) VALUES
  ('00000000-0000-4000-8000-00000000000a', '2026-07-01', 'pgtap-model'),
  ('00000000-0000-4000-8000-00000000000b', '2026-07-01', 'pgtap-model');
INSERT INTO entity_origins (id, owner_id, entity_id, namespace, external_id) VALUES
  ('00000000-0000-7000-8000-0000000000a6', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-7000-8000-0000000000a1', 'telegram', 'ext-a'),
  ('00000000-0000-7000-8000-0000000000b6', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-b');

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

-- Группа 1: user_settings — A видит только свою строку (в фикстурах есть и строка B)
SELECT results_eq(
  'SELECT owner_id::text FROM user_settings',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'user_settings: A видит только свою строку');
-- owner C — третий пользователь без своей строки: PK user_settings = owner_id,
-- поэтому чужой B дал бы неоднозначность «WITH CHECK vs PK-конфликт»
SELECT throws_ok(
  $$INSERT INTO user_settings (owner_id)
    VALUES ('00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'user_settings: INSERT с чужим owner_id отклоняется WITH CHECK');

-- Группа 2: ai_usage — только свои строки; чужой INSERT запрещён
SELECT results_eq(
  'SELECT owner_id::text FROM ai_usage',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'ai_usage: A видит только свои строки');
-- другая дата — чтобы не пересечься с PK (owner_id, date, model) строки B
SELECT throws_ok(
  $$INSERT INTO ai_usage (owner_id, date, model)
    VALUES ('00000000-0000-4000-8000-00000000000b', '2026-07-02', 'pgtap-model')$$,
  '42501', NULL, 'ai_usage: INSERT с чужим owner_id отклоняется WITH CHECK');

-- Группа 3: entity_origins — только свои строки; чужой INSERT запрещён
SELECT results_eq(
  'SELECT owner_id::text FROM entity_origins',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'entity_origins: A видит только свои строки');
-- external_id новый — уникальность (owner, namespace, external_id) не задета
SELECT throws_ok(
  $$INSERT INTO entity_origins (id, owner_id, entity_id, namespace, external_id)
    VALUES ('00000000-0000-7000-8000-0000000000c6',
            '00000000-0000-4000-8000-00000000000b',
            '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-c')$$,
  '42501', NULL, 'entity_origins: INSERT с чужим owner_id отклоняется WITH CHECK');
-- Дыра из ревью Task 2: owner_id свой, но entity_id — ЧУЖАЯ сущность (B).
-- Старая политика (только owner_id) это пропускала → загрязнение provenance,
-- а FK NO ACTION блокировал бы будущий hard-delete чужой строки. Новая WITH CHECK
-- требует владения entity_id → 42501. external_id новый — уникальность не задета.
SELECT throws_ok(
  $$INSERT INTO entity_origins (id, owner_id, entity_id, namespace, external_id)
    VALUES ('00000000-0000-7000-8000-0000000000c7',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-cross')$$,
  '42501', NULL,
  'entity_origins: INSERT origins на чужую сущность (свой owner) отклоняется WITH CHECK');
-- Позитив-пара: origins на СВОЮ сущность (a1) проходит — WITH CHECK не сузил
-- легитимный путь. Новый external_id, чтобы не пересечься с фикстурной ext-a.
SELECT lives_ok(
  $$INSERT INTO entity_origins (id, owner_id, entity_id, namespace, external_id)
    VALUES ('00000000-0000-7000-8000-0000000000a7',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000a1', 'telegram', 'ext-a-own')$$,
  'entity_origins: INSERT origins на свою сущность проходит');

-- Группа 5: перенацеливание relation на чужую сущность.
-- Строка a5 (A-A) видна через USING, но НОВОЕ значение target — сущность B —
-- нарушает WITH CHECK: эмпирически это 42501 (ExecWithCheckOptions), а не «UPDATE 0».
SELECT throws_ok(
  $$UPDATE relations SET target_id = '00000000-0000-7000-8000-0000000000b1'
    WHERE id = '00000000-0000-7000-8000-0000000000a5'$$,
  '42501', NULL, 'relations: перенацеливание на чужую сущность отклоняется WITH CHECK');
SELECT results_eq(
  $$SELECT target_id::text FROM relations
    WHERE id = '00000000-0000-7000-8000-0000000000a5'$$,
  ARRAY['00000000-0000-7000-8000-0000000000a4'],
  'relations: target не изменился после отклонённого перенацеливания');

-- Группа 6: builtin-аспекты (owner_id NULL) закрыты на запись под authenticated
SELECT throws_ok(
  $$INSERT INTO aspect_definitions (id, owner_id, name, namespace, schema)
    VALUES ('orbis/pgtap-fake-builtin', NULL, 'Fake', 'orbis', '{}')$$,
  '42501', NULL, 'aspect_definitions: INSERT builtin (owner_id NULL) отклоняется WITH CHECK');
-- DELETE строки, отфильтрованной USING, — молчаливый «DELETE 0» (не ошибка),
-- поэтому проверяем сохранность строки, а не исключение.
DELETE FROM aspect_definitions WHERE id = 'orbis/pgtap-probe';
SELECT results_eq(
  $$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], 'aspect_definitions: builtin не удаляется под authenticated (DELETE 0)');

-- Как пользователь B: чужой тред закрыт на чтение и вставку
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[0], 'B не видит сообщений A');
SELECT throws_ok(
  $$INSERT INTO chat_messages (id, thread_id, role, content)
    VALUES ('00000000-0000-7000-8000-0000000000c3',
            '00000000-0000-7000-8000-0000000000a2', 'user', 'вброс')$$,
  '42501', NULL, 'B не может вставить сообщение в тред A (§13.5)');
-- Группа 1 (продолжение): строка настроек A невидима под B
SELECT results_eq(
  $$SELECT count(*)::int FROM user_settings
    WHERE owner_id = '00000000-0000-4000-8000-00000000000a'$$,
  ARRAY[0], 'user_settings: B не видит строку A');
-- Группа 4: связи A-A (сущности A созданы выше) невидимы под B — USING требует оба конца
SELECT results_eq('SELECT count(*)::int FROM relations', ARRAY[0],
  'relations: связь A-A невидима под B');

RESET ROLE;
-- Deny-by-default: без claims authenticated не видит ничего
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'без identity — 0 строк');
-- Группа 7: deny-by-default шире — не только entities
SELECT results_eq('SELECT count(*)::int FROM user_settings', ARRAY[0],
  'без identity: user_settings — 0 строк');
SELECT results_eq('SELECT count(*)::int FROM chat_threads', ARRAY[0],
  'без identity: chat_threads — 0 строк');
SELECT results_eq('SELECT count(*)::int FROM relations', ARRAY[0],
  'без identity: relations — 0 строк');
RESET ROLE;
-- Контроль анти-false-positive: админ видит данные обоих
SELECT cmp_ok((SELECT count(*)::int FROM entities), '>=', 3, 'админ видит строки A и B');

SELECT finish();
ROLLBACK;
