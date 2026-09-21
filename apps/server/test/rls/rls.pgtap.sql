-- apps/server/test/rls/rls.pgtap.sql
-- Прогон: psql $DATABASE_URL_ADMIN -v ON_ERROR_STOP=1 -f <этот файл>
-- Всё в одной транзакции с ROLLBACK: БД не мутируется.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(160);

-- Графы фикстур (0020): с FK на graphs владельца «из воздуха» не бывает. Весь файл — одна транзакция
-- с ROLLBACK, отложенные триггеры И-1 до проверки не доходят — гранты заведены ради политик.
INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'person', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b', 'person', '00000000-0000-4000-8000-00000000000b');
INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  ('00000000-0000-7000-8000-0000000000ac', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000a', 'owner', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-7000-8000-0000000000bc', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-4000-8000-00000000000b', 'owner', '00000000-0000-4000-8000-00000000000b');

-- Фикстуры «актор ≠ граф» (0021): Е — operator, Ж — observer, З — ОТОЗВАННЫЙ operator графа А; у Е есть свой личный граф.
INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000e', 'person', '00000000-0000-4000-8000-00000000000e');
INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by, revoked_at) VALUES
  ('00000000-0000-7000-8000-0000000000e9', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-4000-8000-00000000000e', 'owner', '00000000-0000-4000-8000-00000000000e', NULL),
  ('00000000-0000-7000-8000-0000000000ea', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000e', 'operator', '00000000-0000-4000-8000-00000000000a', NULL),
  ('00000000-0000-7000-8000-0000000000fa', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000f', 'observer', '00000000-0000-4000-8000-00000000000a', NULL),
  ('00000000-0000-7000-8000-00000000001b', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000001a', 'operator', '00000000-0000-4000-8000-00000000000a', now());
INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000e', 'Е: запись личного графа');
-- Строки графа Е у ЧЕТЫРЁХ производных таблиц (фикс-раунд 1, Important-2 гейт-ревью): пины UPDATE
-- переносят СУЩЕСТВУЮЩУЮ строку на чужого родителя, и без этих строк переносить было бы нечего —
-- `throws_ok` ловил бы пустой UPDATE, то есть ничего.
INSERT INTO chat_threads (id, graph_id, entity_id) VALUES
  ('00000000-0000-7000-8000-0000000000ec', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000e1');
INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind) VALUES
  ('00000000-0000-7000-8000-0000000000ed', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000e1', 'версия Е', 'тело Е',
   '00000000-0000-4000-8000-00000000000e', 'owner');
INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id) VALUES
  ('00000000-0000-7000-8000-0000000000ee', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000e1', 'telegram', 'ext-e-own');
INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version) VALUES
  ('00000000-0000-7000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000e', '2026-09-03', 5, 0, 1);

-- Фикстуры под ролью с BYPASSRLS (обходит RLS; postgres здесь НЕ суперпользователь)
INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'A: задача'),
  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'B: задача');
INSERT INTO chat_threads (id, graph_id) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a');
INSERT INTO chat_messages (id, thread_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2', 'user', 'привет');
INSERT INTO aspect_definitions (id, graph_id, key, label, description)
  VALUES ('orbis/pgtap-probe', NULL, 'orbis/pgtap-probe', '{"ru":"Проба"}', '{"ru":"Проба"}');
-- Фикстуры для обеих сторон (A и B): без строки B проверки «видит только свою»
-- были бы ложно-зелёными даже при сломанном RLS.
INSERT INTO user_settings (graph_id) VALUES
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b');
INSERT INTO ai_usage (graph_id, date, model) VALUES
  ('00000000-0000-4000-8000-00000000000a', '2026-07-01', 'pgtap-model'),
  ('00000000-0000-4000-8000-00000000000b', '2026-07-01', 'pgtap-model');
INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id) VALUES
  ('00000000-0000-7000-8000-0000000000a6', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-7000-8000-0000000000a1', 'telegram', 'ext-a'),
  ('00000000-0000-7000-8000-0000000000b6', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-b');
INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES
  ('pgtap-client', 'Claude Code', ARRAY['http://localhost:8080/callback']);
-- `issued_by` с миграции 0021 — NOT NULL (аккаунт, выдавший грант). У личного графа id аккаунта
-- и id графа совпадают, поэтому здесь это тот же uuid; без колонки файл оборвался бы на 23502
-- при ON_ERROR_STOP — ещё до первой проверки.
INSERT INTO agent_grants (id, graph_id, client_id, kind, label, access_hash, issued_by) VALUES
  ('00000000-0000-7000-8000-0000000000a7', '00000000-0000-4000-8000-00000000000a',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-a', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-7000-8000-0000000000b7', '00000000-0000-4000-8000-00000000000b',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-b', '00000000-0000-4000-8000-00000000000b');
-- Закреплённые версии тела (ADE-срез 1, С11) — по одной у A и у B: без строки B
-- проверка «A видит ровно свою» была бы ложно-зелёной и при сломанном RLS.
-- body_doc не задаём: версия, снятая с ещё не сконвертированного тела, — законный случай.
INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind) VALUES
  ('00000000-0000-7000-8000-0000000000a8', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-7000-8000-0000000000a1', 'до правки A', 'тело A',
   '00000000-0000-4000-8000-00000000000a', 'owner'),
  ('00000000-0000-7000-8000-0000000000b8', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-7000-8000-0000000000b1', 'до правки B', 'тело B',
   '00000000-0000-4000-8000-00000000000b', 'owner');

-- Фикстуры реестров реформы (0014). У каждого — по ТРИ строки: встроенная (graph_id NULL,
-- читается всеми), строка A и строка B. Без строки B проверки «видит только своё» были бы
-- ложно-зелёными даже при полностью снятой RLS, а без встроенной — не различались бы
-- политики read_builtin_or_own и update_own.
-- Префикс id `pgtap/` отделяет пробы от 77 засеянных свойств, 11 ролей и 13 аспектов,
-- которые в базе уже лежат: счётчики ниже считают ровно пробы.
INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
  VALUES ('pgtap/probe', NULL, 'agenda', '{}'::jsonb, 900);
INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'agenda', '{}'::jsonb, 900);
INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'agenda', '{}'::jsonb, 900);
INSERT INTO action_definitions (id, graph_id, key, label, description)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO action_definitions (id, graph_id, key, label, description)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a',
          '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO action_definitions (id, graph_id, key, label, description)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b',
          '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta) VALUES
  ('00000000-0000-7000-8000-0000000000aa', '00000000-0000-4000-8000-00000000000a',
   'property', 'orbis/priority', 1, '{"label":{"ru":"Своё"}}'),
  ('00000000-0000-7000-8000-0000000000bb', '00000000-0000-4000-8000-00000000000b',
   'property', 'orbis/priority', 1, '{"label":{"ru":"Чужое"}}');

-- Кэш spent (0018): по строке каждой стороне — без строки B проверка «видит только свою»
-- была бы ложно-зелёной и при вовсе снятой политике.
INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', '2026-09-01', 100, 0, 1),
  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', '2026-09-01', 200, 0, 1);

-- 1) RLS включён и FORCE на всех 21 таблице (11 исходных + 7 реестров реформы 0014 + кэш spent 0018
--    + graphs и graph_members 0020)
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname IN ('entities','relations','aspect_definitions','user_settings',
                       'chat_threads','chat_messages','ai_usage','entity_origins',
                       'agent_grants','oauth_clients','entity_versions',
                       'property_definitions','relation_role_definitions',
                       'contract_definitions','subscription_definitions',
                       'action_definitions','registry_deltas','registry_system',
                       'envelope_spent_cache','graphs','graph_members')
     AND c.relrowsecurity AND c.relforcerowsecurity),
  21, 'RLS ENABLE+FORCE на всех двадцати одной таблице');

-- Как пользователь A
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;

SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[1], 'A видит ровно одну (свою) сущность');
SELECT results_eq(
  $$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000b1'$$,
  ARRAY[0], 'чужая сущность невидима');
SELECT throws_ok(
  $$INSERT INTO entities (id, graph_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000b',
            'подлог')$$,
  '42501', NULL, 'INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entities (id, graph_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000a',
            'своя')$$,
  'INSERT со своим graph_id проходит');
SELECT throws_ok(
  $$INSERT INTO relations (id, source_id, target_id, role)
    VALUES ('00000000-0000-7000-8000-0000000000c2',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000b1', 'mention')$$,
  '42501', NULL, 'межпользовательская relation запрещена (§4.10)');
SELECT lives_ok(
  $$INSERT INTO relations (id, source_id, target_id, role)
    VALUES ('00000000-0000-7000-8000-0000000000a5',
            '00000000-0000-7000-8000-0000000000a1',
            '00000000-0000-7000-8000-0000000000a4', 'mention')$$,
  'relation между двумя своими сущностями проходит');
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[1],
  'сообщения видимы через владение тредом');
SELECT results_eq($$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], 'встроенные аспекты читаемы');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки),
-- поэтому проверяем не исключение, а неизменность встроенной строки.
UPDATE aspect_definitions SET label = '{"ru":"взлом"}' WHERE id = 'orbis/pgtap-probe';
SELECT results_eq(
  $$SELECT label->>'ru' FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY['Проба'::text], 'встроенные аспекты не правятся под authenticated');

-- Группа 1: user_settings — A видит только свою строку (в фикстурах есть и строка B)
SELECT results_eq(
  'SELECT graph_id::text FROM user_settings',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'user_settings: A видит только свою строку');
-- owner C — третий пользователь без своей строки: PK user_settings = graph_id,
-- поэтому чужой B дал бы неоднозначность «WITH CHECK vs PK-конфликт»
SELECT throws_ok(
  $$INSERT INTO user_settings (graph_id)
    VALUES ('00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'user_settings: INSERT с чужим graph_id отклоняется WITH CHECK');

-- Группа 2: ai_usage — только свои строки; чужой INSERT запрещён
SELECT results_eq(
  'SELECT graph_id::text FROM ai_usage',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'ai_usage: A видит только свои строки');
-- другая дата — чтобы не пересечься с PK (graph_id, date, model) строки B
SELECT throws_ok(
  $$INSERT INTO ai_usage (graph_id, date, model)
    VALUES ('00000000-0000-4000-8000-00000000000b', '2026-07-02', 'pgtap-model')$$,
  '42501', NULL, 'ai_usage: INSERT с чужим graph_id отклоняется WITH CHECK');

-- Группа 3: entity_origins — только свои строки; чужой INSERT запрещён
SELECT results_eq(
  'SELECT graph_id::text FROM entity_origins',
  ARRAY['00000000-0000-4000-8000-00000000000a'],
  'entity_origins: A видит только свои строки');
-- external_id новый — уникальность (owner, namespace, external_id) не задета
SELECT throws_ok(
  $$INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id)
    VALUES ('00000000-0000-7000-8000-0000000000c6',
            '00000000-0000-4000-8000-00000000000b',
            '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-c')$$,
  '42501', NULL, 'entity_origins: INSERT с чужим graph_id отклоняется WITH CHECK');
-- Дыра из ревью Task 2: graph_id свой, но entity_id — ЧУЖАЯ сущность (B).
-- Старая политика (только graph_id) это пропускала → загрязнение provenance,
-- а FK NO ACTION блокировал бы будущий hard-delete чужой строки. Новая WITH CHECK
-- требует владения entity_id → 42501. external_id новый — уникальность не задета.
SELECT throws_ok(
  $$INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id)
    VALUES ('00000000-0000-7000-8000-0000000000c7',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000b1', 'telegram', 'ext-cross')$$,
  '42501', NULL,
  'entity_origins: INSERT origins на чужую сущность (свой owner) отклоняется WITH CHECK');
-- Позитив-пара: origins на СВОЮ сущность (a1) проходит — WITH CHECK не сузил
-- легитимный путь. Новый external_id, чтобы не пересечься с фикстурной ext-a.
SELECT lives_ok(
  $$INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id)
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

-- Группа 6: builtin-аспекты (graph_id NULL) закрыты на запись под authenticated
SELECT throws_ok(
  $$INSERT INTO aspect_definitions (id, graph_id, key, label, description)
    VALUES ('orbis/pgtap-fake-builtin', NULL, 'orbis/pgtap-fake-builtin',
            '{"ru":"Подлог"}', '{"ru":"Подлог"}')$$,
  '42501', NULL, 'aspect_definitions: INSERT builtin (graph_id NULL) отклоняется WITH CHECK');
-- DELETE строки, отфильтрованной USING, — молчаливый «DELETE 0» (не ошибка),
-- поэтому проверяем сохранность строки, а не исключение.
DELETE FROM aspect_definitions WHERE id = 'orbis/pgtap-probe';
SELECT results_eq(
  $$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], 'aspect_definitions: builtin не удаляется под authenticated (DELETE 0)');

-- Группа 8: agent_grants — владелец видит только свои гранты (§9.3, D34).
-- Вторая политика (для orbis_app) здесь не срабатывает: роль authenticated
-- к orbis_app отношения не имеет, так что владельца проверяем изолированно.
SELECT results_eq('SELECT count(*)::int FROM agent_grants', ARRAY[1],
  'A видит ровно свой грант');
SELECT results_eq(
  $$SELECT count(*)::int FROM agent_grants WHERE graph_id = '00000000-0000-4000-8000-00000000000b'$$,
  ARRAY[0], 'чужой грант невидим');
-- `issued_by` заполнен НАРОЧНО: без него с 0021 строка упала бы на NOT NULL (23502), и пин
-- перестал бы различать механизм — отказ обязан приходить от политики, а не от колонки.
SELECT throws_ok(
  $$INSERT INTO agent_grants (id, graph_id, kind, label, issued_by)
    VALUES ('00000000-0000-7000-8000-0000000000c7',
            '00000000-0000-4000-8000-00000000000b', 'pat', 'подлог',
            '00000000-0000-4000-8000-00000000000a')$$,
  '42501', NULL, 'грант с чужим graph_id отклоняется WITH CHECK');

-- Как пользователь B: чужой тред закрыт на чтение и вставку
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000b"}', true);
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[0], 'B не видит сообщений A');
SELECT throws_ok(
  $$INSERT INTO chat_messages (id, thread_id, role, content)
    VALUES ('00000000-0000-7000-8000-0000000000c3',
            '00000000-0000-7000-8000-0000000000a2', 'user', 'вброс')$$,
  '42501', NULL, 'B не может вставить сообщение в тред A (§13.5)');
-- Группа 1 (продолжение): строка настроек A невидима под B
SELECT results_eq(
  $$SELECT count(*)::int FROM user_settings
    WHERE graph_id = '00000000-0000-4000-8000-00000000000a'$$,
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
-- Новая таблица §9.3 в том же перечне: authenticated права на неё имеет явным GRANT'ом
-- (0005), поэтому «ничего не видно» здесь обеспечивает именно RLS, а не отсутствие права.
SELECT results_eq('SELECT count(*)::int FROM agent_grants', ARRAY[0],
  'без identity: agent_grants — 0 строк');
RESET ROLE;

-- Группа 9: oauth_clients закрыта для чужих — оба барьера поимённо (§9.3, D34).
--
-- Спека слайса обещала проверку «anon не видит ничего», и обоснованием называла default
-- privileges Supabase: якобы они автоматически выдают anon/authenticated права на новые
-- таблицы public, и RLS без политики остаётся единственным барьером. На этой базе это
-- НЕ ТАК, проверено каталогом: у default ACL роли postgres в схеме public для anon,
-- authenticated и service_role стоит `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) —
-- SELECT/INSERT/UPDATE/DELETE там нет. Полный набор раздаёт только default ACL роли
-- supabase_admin, а наши миграции идут под postgres. Поэтому у agent_grants права
-- authenticated взялись из явного GRANT'а миграции 0005, а у oauth_clients их нет вовсе.
--
-- Отсюда — форма проверок: сначала пиним ПЕРВЫЙ барьер (права нет), затем ВТОРОЙ (RLS),
-- выдав GRANT прямо здесь. Транзакция всё равно откатывается, зато проверка перестаёт
-- зависеть от того, чем именно настроены default privileges на конкретной базе: пусть
-- на hosted они однажды окажутся шире — вторая половина группы держит тот же итог.
-- Первый барьер (что права нет вовсе) НЕ пинится намеренно, и это выяснилось красным
-- прогоном CI на первом же пуше: у роли-владельца таблиц default privileges различаются
-- между локальным стеком Supabase CLI и standalone-образом `supabase/postgres`, которым
-- поднимается CI, — там `anon`/`authenticated` право SELECT получают. Пин по правам
-- проверял бы, чем настроена конкретная база, а не что делает наш код: на одной он
-- зелёный, на другой красный при том же коде и той же схеме.
--
-- Закрытость таблиц от этого не зависит и держится ниже: мы САМИ выдаём GRANT и всё
-- равно требуем ноль строк. Такая проверка верна в любом окружении — и там, где право
-- пришло из default ACL, и там, где его нет.
GRANT SELECT ON oauth_clients, agent_grants TO anon;
GRANT SELECT ON oauth_clients TO authenticated;

SET LOCAL ROLE anon;
SELECT results_eq('SELECT count(*)::int FROM oauth_clients', ARRAY[0],
  'oauth_clients: даже с GRANT''ом anon видит 0 строк (RLS без политики для этой роли)');
SELECT results_eq('SELECT count(*)::int FROM agent_grants', ARRAY[0],
  'agent_grants: даже с GRANT''ом anon видит 0 строк');
RESET ROLE;

-- И под живым владельцем тоже: клиенты DCR ничьи, владелец видит их только через свой
-- грант — политики для authenticated на этой таблице нет по замыслу (0005).
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM oauth_clients', ARRAY[0],
  'oauth_clients: даже с GRANT''ом владелец видит 0 строк');
RESET ROLE;

-- Контроль анти-false-positive: админ видит данные обоих
SELECT cmp_ok((SELECT count(*)::int FROM entities), '>=', 3, 'админ видит строки A и B');

-- Группа 10: entity_versions — закреплённые версии тела (ADE-срез 1, С11).
-- Identity ставим ЗАНОВО и явно: выше (группа 9) сброшена только РОЛЬ, а GUC
-- request.jwt.claims живёт до конца транзакции — без явной установки проверки
-- ушли бы под админа, который RLS обходит, и были бы ложно-зелёными.
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entity_versions', ARRAY[1],
  'entity_versions: A видит ровно свою версию');
SELECT throws_ok(
  $$INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES ('00000000-0000-7000-8000-0000000000c8',
            '00000000-0000-4000-8000-00000000000b',
            '00000000-0000-7000-8000-0000000000b1', 'подлог', 'тело',
            '00000000-0000-4000-8000-00000000000b', 'owner')$$,
  '42501', NULL, 'entity_versions: INSERT с чужим graph_id отклоняется WITH CHECK');
-- Та же дыра, что закрыл 0002 у entity_origins: graph_id СВОЙ, а entity_id — ЧУЖАЯ
-- сущность (B). Предикат только по graph_id это пропускал: RI-проверка FK идёт мимо RLS
-- и чужую сущность видит. Версия чужой записи ломает сквозное владение §4.10, поэтому
-- WITH CHECK требует ещё и владения самой сущностью → 42501.
SELECT throws_ok(
  $$INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES ('00000000-0000-7000-8000-0000000000c9',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000b1', 'версия чужой', 'тело',
            '00000000-0000-4000-8000-00000000000a', 'owner')$$,
  '42501', NULL,
  'entity_versions: INSERT версии на чужую сущность (свой owner) отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES ('00000000-0000-7000-8000-0000000000a9',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000a1', 'своя', 'тело A2',
            '00000000-0000-4000-8000-00000000000a', 'owner')$$,
  'entity_versions: INSERT своей версии проходит');
RESET ROLE;
-- Deny-by-default и здесь: claims чистим ЯВНО, иначе проверка унаследует identity A выше.
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entity_versions', ARRAY[0],
  'без identity: entity_versions — 0 строк');
RESET ROLE;

-- Группа 11: список владельцев для тика планировщика рутин (V1.13, инвариант 14,
-- миграция 0013). Планировщик обходит владельцев БЕЗ identity (он не «чей-то»), а всю
-- работу ведёт под withIdentity(владелец); bypass RLS не вводится нигде.
--
-- Проверки здесь СТРУКТУРНЫЕ — форма политики и права, а не поведение под ролью.
-- Поведение (что orbis_app видит чужих владельцев, не пишет настройки и не видит графа)
-- пинится в apps/server/src/routines/queries.test.ts: он и так идёт под подключением
-- orbis_app (DATABASE_URL), то есть в тех же условиях, что планировщик.
--
-- ПОЧЕМУ НЕ SET ROLE ЗДЕСЬ. Админский DSN не может SET ROLE orbis_app: роль postgres в
-- этой базе не суперпользователь (rolsuper=f, она BYPASSRLS), а неявный грант роли её
-- создателю с PostgreSQL 16 идёт с SET FALSE — ADMIN OPTION есть, SET нет. Выдать право
-- себе прямо здесь (`GRANT orbis_app TO CURRENT_USER`) нельзя: на сборке образа CI
-- supabase/postgres:17.6.1.140 ровно это выражение РОНЯЕТ БЭКЕНД сегфолтом (signal 11,
-- воспроизведено локально на том же образе; крэш даёт именно грантополучатель
-- CURRENT_USER, с именованной ролью выражение проходит). Постоянный грант членства
-- админу — изменение состояния ролей ради теста, чего мы не делаем; поэтому роль
-- проверяет тот, кто под ней уже подключён, — серверный сьют.
SELECT policy_cmd_is('public', 'user_settings', 'scheduler_reads_owner_list', 'SELECT',
  'user_settings: scheduler_reads_owner_list — только FOR SELECT (планировщик настройки не пишет)');
SELECT policy_roles_are('public', 'user_settings', 'scheduler_reads_owner_list',
  ARRAY['orbis_app']::name[],
  'user_settings: scheduler_reads_owner_list — ровно для служебной роли, не для authenticated');
-- Второй барьер: orbis_app NOINHERIT, а гранты на таблицы public висят на authenticated
-- (0001), поэтому без собственного гранта политика выше не спасла бы — было бы 42501.
-- Пиним НАЛИЧИЕ нужного права; отсутствие лишних не пиним (урок группы 9: default
-- privileges различаются между локальным стеком Supabase CLI и образом CI), запрет записи
-- проверяется поведением в queries.test.ts.
SELECT ok(has_table_privilege('orbis_app', 'public.user_settings', 'SELECT'),
  'user_settings: у orbis_app есть SELECT (грант 0013 — без него политика бесполезна)');


-- Группы 12–16: пять реестров реформы (§С6). Форма проверок одна на все пять — политики у
-- них тоже одни (read_builtin_or_own / write_own / update_own / delete_own), и расходиться
-- им незачем.
--
-- Identity ставим ЗАНОВО и явно: группа 11 работала под админом, а GUC request.jwt.claims
-- живёт до конца транзакции — без явной установки проверки ушли бы под роль, которая RLS
-- обходит, и были бы ложно-зелёными.
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;

-- Группа 12: property_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM property_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'property_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  'property_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  '42501', NULL, 'property_definitions: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  '42501', NULL,
    'property_definitions: INSERT встроенной строки (graph_id NULL) под authenticated отклоняется');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки), поэтому здесь
-- проверяется не исключение, а НЕИЗМЕННОСТЬ встроенной строки.
UPDATE property_definitions SET module = 'взлом' WHERE id = 'pgtap/probe';
SELECT is((SELECT module FROM property_definitions WHERE id = 'pgtap/probe'), NULL,
  'property_definitions: встроенная строка не правится под authenticated');
-- Положительный контроль update_own В ТОМ ЖЕ ТЕСТЕ: без него проверка выше проходила бы и
-- при вовсе отсутствующей политике UPDATE.
UPDATE property_definitions SET module = 'своё' WHERE id = 'pgtap/a';
SELECT is((SELECT module FROM property_definitions WHERE id = 'pgtap/a'), 'своё',
  'property_definitions: свою строку владелец правит (update_own)');
DELETE FROM property_definitions WHERE id = 'pgtap/a2';
SELECT results_eq(
  $$SELECT count(*)::int FROM property_definitions WHERE id = 'pgtap/a2'$$,
  ARRAY[0],
  'property_definitions: свою строку владелец удаляет (delete_own)');

-- Группа 13: relation_role_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM relation_role_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'relation_role_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  'relation_role_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  '42501', NULL, 'relation_role_definitions: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO relation_role_definitions
  (id, graph_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  '42501', NULL,
    'relation_role_definitions: INSERT встроенной строки (graph_id NULL) отклоняется');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки), поэтому здесь
-- проверяется не исключение, а НЕИЗМЕННОСТЬ встроенной строки.
UPDATE relation_role_definitions SET module = 'взлом' WHERE id = 'pgtap/probe';
SELECT is((SELECT module FROM relation_role_definitions WHERE id = 'pgtap/probe'), NULL,
  'relation_role_definitions: встроенная строка не правится под authenticated');
-- Положительный контроль update_own В ТОМ ЖЕ ТЕСТЕ: без него проверка выше проходила бы и
-- при вовсе отсутствующей политике UPDATE.
UPDATE relation_role_definitions SET module = 'своё' WHERE id = 'pgtap/a';
SELECT is((SELECT module FROM relation_role_definitions WHERE id = 'pgtap/a'), 'своё',
  'relation_role_definitions: свою строку владелец правит (update_own)');
DELETE FROM relation_role_definitions WHERE id = 'pgtap/a2';
SELECT results_eq(
  $$SELECT count(*)::int FROM relation_role_definitions WHERE id = 'pgtap/a2'$$,
  ARRAY[0],
  'relation_role_definitions: свою строку владелец удаляет (delete_own)');

-- Группа 14: contract_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM contract_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'contract_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"К"}'::jsonb,
            '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  'contract_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"К"}'::jsonb,
            '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  '42501', NULL, 'contract_definitions: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"К"}'::jsonb, '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  '42501', NULL,
    'contract_definitions: INSERT встроенной строки (graph_id NULL) под authenticated отклоняется');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки), поэтому здесь
-- проверяется не исключение, а НЕИЗМЕННОСТЬ встроенной строки.
UPDATE contract_definitions SET module = 'взлом' WHERE id = 'pgtap/probe';
SELECT is((SELECT module FROM contract_definitions WHERE id = 'pgtap/probe'), NULL,
  'contract_definitions: встроенная строка не правится под authenticated');
-- Положительный контроль update_own В ТОМ ЖЕ ТЕСТЕ: без него проверка выше проходила бы и
-- при вовсе отсутствующей политике UPDATE.
UPDATE contract_definitions SET module = 'своё' WHERE id = 'pgtap/a';
SELECT is((SELECT module FROM contract_definitions WHERE id = 'pgtap/a'), 'своё',
  'contract_definitions: свою строку владелец правит (update_own)');
DELETE FROM contract_definitions WHERE id = 'pgtap/a2';
SELECT results_eq(
  $$SELECT count(*)::int FROM contract_definitions WHERE id = 'pgtap/a2'$$,
  ARRAY[0],
  'contract_definitions: свою строку владелец удаляет (delete_own)');

-- Группа 15: subscription_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM subscription_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'subscription_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'agenda', '{}'::jsonb, 900)$$,
  'subscription_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'agenda', '{}'::jsonb, 900)$$,
  '42501', NULL, 'subscription_definitions: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
    VALUES ('pgtap/c', NULL, 'agenda', '{}'::jsonb, 900)$$,
  '42501', NULL,
    'subscription_definitions: INSERT встроенной строки (graph_id NULL) отклоняется');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки), поэтому здесь
-- проверяется не исключение, а НЕИЗМЕННОСТЬ встроенной строки.
UPDATE subscription_definitions SET module = 'взлом' WHERE id = 'pgtap/probe';
SELECT is((SELECT module FROM subscription_definitions WHERE id = 'pgtap/probe'), NULL,
  'subscription_definitions: встроенная строка не правится под authenticated');
-- Положительный контроль update_own В ТОМ ЖЕ ТЕСТЕ: без него проверка выше проходила бы и
-- при вовсе отсутствующей политике UPDATE.
UPDATE subscription_definitions SET module = 'своё' WHERE id = 'pgtap/a';
SELECT is((SELECT module FROM subscription_definitions WHERE id = 'pgtap/a'), 'своё',
  'subscription_definitions: свою строку владелец правит (update_own)');
DELETE FROM subscription_definitions WHERE id = 'pgtap/a2';
SELECT results_eq(
  $$SELECT count(*)::int FROM subscription_definitions WHERE id = 'pgtap/a2'$$,
  ARRAY[0],
  'subscription_definitions: свою строку владелец удаляет (delete_own)');

-- Группа 16: action_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM action_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'action_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO action_definitions (id, graph_id, key, label, description)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2',
            '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  'action_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO action_definitions (id, graph_id, key, label, description)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c',
            '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  '42501', NULL, 'action_definitions: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO action_definitions (id, graph_id, key, label, description)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  '42501', NULL,
    'action_definitions: INSERT встроенной строки (graph_id NULL) под authenticated отклоняется');
-- RLS молча фильтрует строки, не прошедшие USING (0 строк, без ошибки), поэтому здесь
-- проверяется не исключение, а НЕИЗМЕННОСТЬ встроенной строки.
UPDATE action_definitions SET module = 'взлом' WHERE id = 'pgtap/probe';
SELECT is((SELECT module FROM action_definitions WHERE id = 'pgtap/probe'), NULL,
  'action_definitions: встроенная строка не правится под authenticated');
-- Положительный контроль update_own В ТОМ ЖЕ ТЕСТЕ: без него проверка выше проходила бы и
-- при вовсе отсутствующей политике UPDATE.
UPDATE action_definitions SET module = 'своё' WHERE id = 'pgtap/a';
SELECT is((SELECT module FROM action_definitions WHERE id = 'pgtap/a'), 'своё',
  'action_definitions: свою строку владелец правит (update_own)');
DELETE FROM action_definitions WHERE id = 'pgtap/a2';
SELECT results_eq($$SELECT count(*)::int FROM action_definitions WHERE id = 'pgtap/a2'$$, ARRAY[0],
  'action_definitions: свою строку владелец удаляет (delete_own)');

-- Группа 17: registry_deltas — таблица чисто графа (четыре политики current_graph_*), встроенных
-- дельт не бывает по определению.
SELECT results_eq('SELECT count(*)::int FROM registry_deltas', ARRAY[1],
  'registry_deltas: A видит ровно свою дельту');
SELECT throws_ok(
  $$INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES ('00000000-0000-7000-8000-0000000000cc', '00000000-0000-4000-8000-00000000000b', 'property',
            'orbis/limit', 1, '{}')$$,
  '42501', NULL, 'registry_deltas: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES ('00000000-0000-7000-8000-0000000000dd', '00000000-0000-4000-8000-00000000000a', 'property',
            'orbis/limit', 1, '{}')$$,
  'registry_deltas: INSERT своей дельты проходит');

-- Группа 18: registry_system — глобальная версия system-реестров. Читают все, пишет только
-- сид под админской ролью: политики INSERT/UPDATE на таблице НЕТ намеренно.
SELECT results_eq('SELECT count(*)::int FROM registry_system', ARRAY[1],
  'registry_system: строка версии читается любым владельцем (read_all)');
UPDATE registry_system SET version = -777 WHERE id = 1;
SELECT results_eq('SELECT count(*)::int FROM registry_system WHERE version = -777', ARRAY[0],
  'registry_system: версия не правится под authenticated (политики UPDATE нет)');
SELECT throws_ok(
  $$INSERT INTO registry_system (id, version) VALUES (2, 0)$$,
  '42501', NULL,
    'registry_system: вторая строка под authenticated отклоняется (политики INSERT нет)');

-- Группа 19: envelope_spent_cache — таблица чисто графа (четыре политики current_graph_*, 0021),
-- встроенных строк кэша не бывает по определению.
SELECT results_eq('SELECT count(*)::int FROM envelope_spent_cache', ARRAY[1],
  'envelope_spent_cache: A видит ровно свою строку кэша');
SELECT throws_ok(
  $$INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version)
    VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b',
            '2026-09-02', 1, 0, 1)$$,
  '42501', NULL, 'envelope_spent_cache: INSERT с чужим graph_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version)
    VALUES ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a',
            '2026-09-02', 1, 0, 1)$$,
  'envelope_spent_cache: INSERT своей строки проходит');
-- Политика на каждую команду своя (0021), и пин на INSERT/SELECT про UPDATE и DELETE не
-- говорит НИЧЕГО: покомандную четвёрку можно однажды недосоздать и потерять половину, не уронив
-- ни одного теста. Чужая строка обязана давать НОЛЬ задетых (её прячет USING), своя — одну.
SELECT results_eq(
  $$WITH u AS (UPDATE envelope_spent_cache SET spent = 999
               WHERE envelope_id = '00000000-0000-7000-8000-0000000000b1' RETURNING 1)
    SELECT count(*)::int FROM u$$,
  ARRAY[0], 'envelope_spent_cache: UPDATE чужой строки задевает ноль строк (USING)');
SELECT results_eq(
  $$WITH d AS (DELETE FROM envelope_spent_cache
               WHERE envelope_id = '00000000-0000-7000-8000-0000000000b1' RETURNING 1)
    SELECT count(*)::int FROM d$$,
  ARRAY[0], 'envelope_spent_cache: DELETE чужой строки задевает ноль строк (USING)');
SELECT results_eq(
  $$WITH u AS (UPDATE envelope_spent_cache SET spent = 7
               WHERE envelope_id = '00000000-0000-7000-8000-0000000000a1'
                 AND as_of = '2026-09-02' RETURNING 1)
    SELECT count(*)::int FROM u$$,
  ARRAY[1], 'envelope_spent_cache: свою строку владелец правит');
SELECT results_eq(
  $$WITH d AS (DELETE FROM envelope_spent_cache
               WHERE envelope_id = '00000000-0000-7000-8000-0000000000a1'
                 AND as_of = '2026-09-02' RETURNING 1)
    SELECT count(*)::int FROM d$$,
  ARRAY[1], 'envelope_spent_cache: свою строку владелец удаляет');
-- Роль приложения: грант есть (миграция 0018 выдаёт все четыре права), политики для неё НЕТ —
-- значит RLS вернёт пусто, а не 42501. Проверка СТРУКТУРНАЯ по той же причине, что у
-- `user_settings` выше: SET ROLE orbis_app из админского DSN недоступен (см. разбор группы 11).
SELECT ok(
  has_table_privilege('orbis_app', 'public.envelope_spent_cache', 'SELECT')
    AND has_table_privilege('orbis_app', 'public.envelope_spent_cache', 'INSERT')
    AND has_table_privilege('orbis_app', 'public.envelope_spent_cache', 'UPDATE')
    AND has_table_privilege('orbis_app', 'public.envelope_spent_cache', 'DELETE'),
  'envelope_spent_cache: у orbis_app все четыре права (0018) — путь без identity падает пустотой, не 42501');
RESET ROLE;

-- Deny-by-default для реестров: claims чистим ЯВНО, иначе проверки унаследуют identity A.
-- Ожидание здесь НЕ «ноль строк»: встроенные строки читаемы и без identity — на этом стоит
-- стартовая проверка дрейфа (db/registry-drift.ts ходит без актора). Ноль обязан быть у
-- строк ВЛАДЕЛЬЦЕВ.
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT count(*)::int FROM property_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[1], 'без identity: из проб property_definitions видна только встроенная');
SELECT results_eq('SELECT count(*)::int FROM registry_deltas', ARRAY[0],
  'без identity: registry_deltas — 0 строк');
RESET ROLE;

-- ── Пины имён после 0019 (5 проверок; правка 21.09 по гейт-ревью Г-1, Р-ИГ-5) ────────────────
-- Пять имён, которых RENAME COLUMN не касается (Ф-Г-7), переименованы миграцией 0019 поимённо, и до
-- этого блока их не держало НИЧТО в CI: drizzle-kit generate CI не гоняет, perf-сьюты вне CI (Ф-Г-19),
-- а `chat_threads_graph` не пинил вообще никто. Ошибка в имени тиха: индекс остаётся, запрос работает,
-- расходится только docblock и пин перфа — и находится это через месяцы.
SELECT has_index('public', 'entities', 'entities_graph_updated', 'индекс упорядоченного чтения списка');
SELECT has_index('public', 'chat_threads', 'chat_threads_graph', 'индекс тредов по графу');
SELECT has_index('public', 'agent_grants', 'agent_grants_graph', 'индекс грантов агентов по графу');
SELECT has_index('public', 'envelope_spent_cache', 'envelope_spent_cache_graph', 'индекс кэша конвертов по графу');
SELECT col_is_pk('public', 'ai_usage', ARRAY['graph_id','date','model'], 'PK ai_usage — по графу, дате и модели');

-- ── Группа 20: graphs (спека §3.6) ─────────────────────────────────────────────────────────
RESET ROLE;
-- И-2 держит ОТСУТСТВИЕ ПОЛИТИК, а не отсутствие права: право выдаём здесь (транзакция откатится) и
-- требуем ноль задетых строк — такая проверка верна в любом окружении (урок группы 9, :298-322).
GRANT UPDATE, DELETE ON graphs, graph_members TO authenticated;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
    AND tablename IN ('graphs','graph_members') AND cmd IN ('UPDATE','DELETE','ALL')),
  0, 'И-2: у graphs и graph_members нет ни одной политики UPDATE/DELETE/ALL');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'person', '00000000-0000-4000-8000-0000000000d2')$$,
  '23514', NULL, 'CHECK: у личного графа id = owner_ref');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'person', NULL)$$,
  '23514', NULL, 'CHECK: person с пустым owner_ref — отказ (без IS NOT NULL выражение дало бы NULL)');
SELECT lives_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d3', 'organization', NULL)$$,
  'organization с NULL в owner_ref зарезервирован для ступени 2');
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM graphs', ARRAY[1], 'A видит ровно свой граф');
SELECT results_eq($$SELECT count(*)::int FROM graphs WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  ARRAY[0], 'граф без гранта невидим');
WITH u AS (UPDATE graphs SET owner_kind = 'organization' RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'И-2: даже с правом UPDATE граф неизменяем — политики нет');
WITH d AS (DELETE FROM graphs RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'И-2: даже с правом DELETE граф не удалить — политики нет');
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000c"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d4', 'person', '00000000-0000-4000-8000-0000000000d4')$$,
  '42501', NULL, 'INSERT чужого личного графа — отказ политики');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000c', 'organization', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'INSERT organization под authenticated — отказ политики (v1 — только person)');
SELECT lives_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000c', 'person', '00000000-0000-4000-8000-00000000000c')$$,
  'В заводит свой личный граф: id = owner_ref = auth.uid()');

-- ── Группа 21: graph_members ───────────────────────────────────────────────────────────────
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c',
   'operator', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'себя можно вписать только как owner');
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'самовыдача членства в ЧУЖОЙ граф — отказ');
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000b',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'вписать ДРУГОЙ аккаунт в свой граф — отказ (приглашения — ступень 2)');
-- Строка-ГРАНТ рождается действующей. Без `revoked_at IS NULL` в WITH CHECK эта вставка проходила
-- (измерено фикс-волной на живой базе): частичный уникальный индекс отозванные не считает, а
-- триггер И-1 на INSERT не смотрит — доступа не даёт, но даёт неограниченный мусор в членстве.
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by, revoked_at)
  VALUES (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c',
   'owner', '00000000-0000-4000-8000-00000000000c', now())$$,
  '42501', NULL, 'вписать себе ЗАРАНЕЕ ОТОЗВАННУЮ строку owner — отказ (грант рождается действующим)');
SELECT lives_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  'В вписывает себя owner своего личного графа');
SELECT results_eq('SELECT count(*)::int FROM graph_members', ARRAY[1], 'В видит ровно свою строку членства');
SELECT results_eq('SELECT count(*)::int FROM graphs', ARRAY[1], 'после гранта свой граф виден');
WITH u AS (UPDATE graph_members SET revoked_at = now() RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'пути отзыва у authenticated в v1 нет: политики UPDATE нет');
WITH d AS (DELETE FROM graph_members RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'и политики DELETE нет — иначе самовыдача и самоотзыв членства');
RESET ROLE;
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a',
   'owner', '00000000-0000-4000-8000-00000000000a')$$,
  '23505', NULL, 'второй ДЕЙСТВУЮЩИЙ грант той же пары — отказ частичной уникальности');

-- ── Группа 22: планировщик читает членство (структурно — образец группы 11, :388-417) ────────
SELECT policy_cmd_is('public', 'graph_members', 'scheduler_reads_members', 'SELECT',
  'политика планировщика — только SELECT');
SELECT policy_roles_are('public', 'graph_members', 'scheduler_reads_members', ARRAY['orbis_app']::name[],
  'политика планировщика выдана ровно orbis_app');
SELECT ok(has_table_privilege('orbis_app', 'public.graph_members', 'SELECT'),
  'orbis_app читает graph_members (без гранта — 42501 до всякой политики)');
-- Пиним НАЛИЧИЕ нужного права; отсутствие лишних не пиним (правило :411-415) — запрет записи под
-- orbis_app держит поведением серверный тест db/graphs-policies.test.ts.

-- ── Группа 23: актор ≠ граф — «текущий граф ∧ членство» (спека §3.5–§3.6) ───────────────
RESET ROLE;
-- Е — operator графа А; текущий граф — А
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1'$$,
  ARRAY[1], 'operator читает строки текущего графа');
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000e1'$$,
  ARRAY[0], 'строки СВОЕГО личного графа в чужом текущем графе не видны: «все мои графы» умолчанием не бывает');
SELECT lives_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e2', '00000000-0000-4000-8000-00000000000a', 'Е пишет в граф А')$$,
  'operator пишет в текущий граф');
SELECT throws_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000e', 'мимо текущего графа')$$,
  '42501', NULL, 'запись в НЕтекущий граф — отказ, даже если грант в нём есть');
SELECT throws_ok($$INSERT INTO agent_grants (id, graph_id, issued_by, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000e7', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000e', 'pat', 'агент оператора', 'hash-e')$$,
  '42501', NULL, 'грант агенту выписывает только держатель гранта owner (иначе operator выдал бы full)');
-- Ж — observer графа А
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000f","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1'$$,
  ARRAY[1], 'observer читает');
SELECT throws_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000f2', '00000000-0000-4000-8000-00000000000a', 'observer пишет')$$,
  '42501', NULL, 'observer не вставляет');
WITH u AS (UPDATE entities SET title = 'перехват' WHERE id = '00000000-0000-7000-8000-0000000000a1' RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'observer не правит: UPDATE не задевает ни одной строки');
WITH d AS (DELETE FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1' RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'observer не удаляет: политика записи стоит и на DELETE');
-- Б — без гранта в графе А; З — с отозванным
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'текущий граф без гранта — пусто');
-- Половина «актор держит грант» — НЕ только на entities (Important-3 гейт-ревью: мутация «снять
-- actor_reads у user_settings» проходила pgTAP 148/148 и весь серверный сьют). Ниже — две формы
-- политик, отличные от простой: производная таблица (владение через тред) и реестр (`IS NULL OR`).
-- Замечено при мутационной проверке: у ПРОИЗВОДНОЙ таблицы половина «грант» защищена ДВАЖДЫ —
-- своей политикой и политикой РОДИТЕЛЯ (RLS действует и внутри выражения политики, поэтому тред
-- без гранта не виден изнутри EXISTS). Одной снятой половины мало, мутация на этот пин двойная.
SELECT results_eq('SELECT count(*)::int FROM chat_messages', ARRAY[0],
  'и на ПРОИЗВОДНОЙ таблице: тред графа А — текущий, но гранта нет — сообщений не видно');
SELECT results_eq($$SELECT count(*)::int FROM property_definitions WHERE id = 'pgtap/a'$$,
  ARRAY[0], 'и у РЕЕСТРА, где форма другая (graph_id IS NULL OR …): строка графа А без гранта не видна');
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000001a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'отозванный грант — пусто (revoked_at IS NULL в функциях)');
-- А без текущего графа: fail-closed, кроме встроенных строк реестров
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'текущий граф не выставлен — пусто, даже у владельца');
SELECT results_eq($$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], '…кроме встроенных строк реестров: стартовая проверка дрейфа читает их без идентичности');
SELECT results_eq($$SELECT count(*)::int FROM property_definitions WHERE id = 'pgtap/a'$$,
  ARRAY[0], 'своя строка реестра без текущего графа не видна');
-- А — owner в своём графе: грант агенту выписывается
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO agent_grants (id, graph_id, issued_by, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a0', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000a', 'pat', 'агент владельца', 'hash-a0')$$,
  'держатель гранта owner выписывает грант агенту');
-- Межграфовая строгость: Е в СВОЁМ графе цепляет строки к сущности графа А (в нём у Е грант есть!)
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000e"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO chat_threads (id, graph_id, entity_id) VALUES
  ('00000000-0000-7000-8000-0000000000e4', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1')$$,
  '42501', NULL, 'тред графа Е на сущности графа А — отказ (давняя дыра chat_threads.entity_id закрыта)');
SELECT throws_ok($$INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000e', '2026-09-02', 1, 0, 1)$$,
  '42501', NULL, 'кэш графа Е на конверте графа А — отказ (вторая дыра того же класса)');
SELECT throws_ok($$INSERT INTO relations (id, source_id, target_id, role) VALUES
  ('00000000-0000-7000-8000-0000000000e5', '00000000-0000-7000-8000-0000000000e1',
   '00000000-0000-7000-8000-0000000000a1', 'mention')$$,
  '42501', NULL, 'связь между графами — отказ: оба конца в одном текущем графе до ступени 2');
SELECT throws_ok($$INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind) VALUES
  ('00000000-0000-7000-8000-0000000000e8', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1', 'чужое тело', 'т', '00000000-0000-4000-8000-00000000000e', 'owner')$$,
  '42501', NULL, 'версия графа Е на сущности графа А — отказ (строгость 0011 сохранена)');
SELECT throws_ok($$INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id) VALUES
  ('00000000-0000-7000-8000-0000000000e6', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1', 'telegram', 'ext-e')$$,
  '42501', NULL, 'provenance графа Е на сущности графа А — отказ (строгость 0002 сохранена)');
-- UPDATE-половина тех же дыр (Important-2 гейт-ревью). Пять INSERT-ов выше не говорят о UPDATE
-- НИЧЕГО: мутации «снять хвост EXISTS из WITH CHECK у current_graph_update» на chat_threads и
-- envelope_spent_cache проходили 148/148 зелёными, то есть перецепить УЖЕ СУЩЕСТВУЮЩУЮ строку на
-- сущность чужого графа было можно, и не узнал бы никто. Строка создаётся в своём графе честно, а
-- чужой становится ОДНИМ UPDATE-ом — это и есть дешёвый путь утечки.
SELECT throws_ok($$UPDATE chat_threads SET entity_id = '00000000-0000-7000-8000-0000000000a1'
  WHERE id = '00000000-0000-7000-8000-0000000000ec'$$,
  '42501', NULL, 'тред графа Е нельзя ПЕРЕЦЕПИТЬ UPDATE-ом на сущность графа А');
SELECT throws_ok($$UPDATE envelope_spent_cache SET envelope_id = '00000000-0000-7000-8000-0000000000a1'
  WHERE envelope_id = '00000000-0000-7000-8000-0000000000e1' AND as_of = '2026-09-03'$$,
  '42501', NULL, 'кэш графа Е нельзя перецепить UPDATE-ом на конверт графа А');
SELECT throws_ok($$UPDATE entity_versions SET entity_id = '00000000-0000-7000-8000-0000000000a1'
  WHERE id = '00000000-0000-7000-8000-0000000000ed'$$,
  '42501', NULL, 'версию графа Е нельзя перецепить UPDATE-ом на сущность графа А');
SELECT throws_ok($$UPDATE entity_origins SET entity_id = '00000000-0000-7000-8000-0000000000a1'
  WHERE id = '00000000-0000-7000-8000-0000000000ee'$$,
  '42501', NULL, 'provenance графа Е нельзя перецепить UPDATE-ом на сущность графа А');
-- Перенос САМОЙ строки в другой граф — несущее утверждение среза: граф строки не метка, а владелец.
-- МЕХАНИЗМ НАЗВАН ПО ЗАМЕРУ, а не по догадке (Ф-Г-37: не путать «отказ пришёл» с «отказ пришёл
-- отсюда»). Барьеров ДВА и они независимы: (1) `WITH CHECK` политики `current_graph_update`;
-- (2) под `FORCE ROW LEVEL SECURITY` PostgreSQL требует, чтобы строка ПОСЛЕ правки осталась видна
-- своей же SELECT-политике — иначе её можно было бы «обновить в невидимость». Пробито в psql:
-- при `WITH CHECK (true)` у UPDATE перенос всё равно даёт 42501 (`ExecWithCheckOptions`), и
-- проходит он только когда ослаблены ОБЕ политики. Поэтому мутация на этот пин — двойная, и это
-- записано честно: пин утверждает СВОЙСТВО (перенести нельзя), а держат его два барьера.
SELECT throws_ok($$UPDATE entities SET graph_id = '00000000-0000-4000-8000-00000000000a'
  WHERE id = '00000000-0000-7000-8000-0000000000e1'$$,
  '42501', NULL, 'строку нельзя ПЕРЕНЕСТИ в другой граф: граф строки — единица владения, а не метка');
-- Структурные пины
RESET ROLE;
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('current_graph_id','actor_reads_current_graph','actor_writes_current_graph','actor_owns_current_graph')
    AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']),
  4, 'четыре функции политик — SECURITY INVOKER с пустым search_path: обхода RLS нет (0013:7-8)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
    AND tablename NOT IN ('graphs','graph_members')
    AND (coalesce(qual, '') LIKE '%auth.uid()%' OR coalesce(with_check, '') LIKE '%auth.uid()%')),
  0, 'ни одна политика строк не сравнивает ключ с auth.uid(): вечного доступа по равенству id нет');
SELECT col_not_null('public', 'agent_grants', 'issued_by', 'у гранта агента всегда есть выдавший аккаунт');
-- ФОРМА ВСЕХ 68 ПОЛИТИК СТРОК — по каталогу, а не по тексту миграции (Important-3 гейт-ревью).
-- Поведением обе половины проверены на `entities` (группа 23 целиком) и на двух формах-исключениях
-- — производной таблице и реестре, — но потерю половины на любой из остальных таблиц не поймал бы
-- НИКТО: мутация «снять actor_reads у user_settings.current_graph_select» проходила pgTAP 148/148 и
-- полный серверный сьют. Это ровно тот отказ, ради которого затеян срез: любой, кто выставил
-- `graph` в claims, читал бы чужой граф. Проверка «ни одна политика не сравнивает ключ с auth.uid()»
-- такое не ловит — она ищет `auth.uid()`, а его там и не будет.
--
-- ТРИ ЧИСЛА, А НЕ ОДНО, и обе добавки — по ре-ревью, каждая закрывает свой обход пина:
-- (1) СЧЁТ политик. Прежние два пина считали СОВПАВШИЕ политики, а не все, поэтому заведённая
--     сверх набора `rogue_extra … USING (true)` оставляла их зелёными: «68 штук спрашивают граф»
--     не значит «все спрашивают». Здесь число сверяется с 17 таблицами × 4 команды.
-- (2) КЛАУЗЫ ПО ОТДЕЛЬНОСТИ. Склейка `qual || with_check` слепа к потере половины в ОДНОЙ клаузе:
--     мутация «`entities.current_graph_update` без половины графа в WITH CHECK» проходила 157/157.
--     Живой утечки там нет (перенос строки отбивает SELECT-политика на новую строку — см. пин
--     переноса выше), но пин обещал больше, чем проверял. Теперь у КАЖДОЙ политики каждая
--     ПРИСУТСТВУЮЩАЯ клауза обязана нести обе половины: `qual` у SELECT/DELETE, `with_check` у
--     INSERT, ОБЕ у UPDATE.
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
    AND roles = '{authenticated}' AND tablename NOT IN ('graphs','graph_members')),
  68, 'политик строк ровно 68 — 17 таблиц × 4 команды, ни одной лишней и ни одной пропавшей');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public'
    AND p.roles = '{authenticated}' AND p.tablename NOT IN ('graphs','graph_members')
    AND NOT (p.qual IS NULL AND p.with_check IS NULL)
    AND (p.qual IS NULL OR p.qual LIKE '%current_graph_id()%')
    AND (p.with_check IS NULL OR p.with_check LIKE '%current_graph_id()%')),
  68, 'и КАЖДАЯ КЛАУЗА каждой из них спрашивает ТЕКУЩИЙ граф');
-- Мало назвать функцию — важно, ЧТОБЫ КОМАНДЕ СООТВЕТСТВОВАЛА СВОЯ: чтение довольствуется любым
-- грантом, запись требует owner|operator, а гранты агентов — только owner. Подмена одной на другую
-- (`actor_writes` в INSERT `agent_grants`) даёт operator'у право выписать себе полный доступ.
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public'
    AND p.roles = '{authenticated}' AND p.tablename NOT IN ('graphs','graph_members')
    AND NOT (p.qual IS NULL AND p.with_check IS NULL)
    AND (p.qual IS NULL OR p.qual LIKE '%' || CASE WHEN p.cmd = 'SELECT' THEN 'actor_reads_current_graph()'
           WHEN p.tablename = 'agent_grants' THEN 'actor_owns_current_graph()'
           ELSE 'actor_writes_current_graph()' END || '%')
    AND (p.with_check IS NULL OR p.with_check LIKE '%' || CASE WHEN p.cmd = 'SELECT' THEN 'actor_reads_current_graph()'
           WHEN p.tablename = 'agent_grants' THEN 'actor_owns_current_graph()'
           ELSE 'actor_writes_current_graph()' END || '%')),
  68, 'и КАЖДАЯ КЛАУЗА — СВОЮ половину «актор держит грант»: SELECT — actor_reads, запись — actor_writes, гранты агентов — actor_owns');
-- СОСТАВ ПОЛИТИК СЛУЖЕБНЫХ РОЛЕЙ — ПОИМЁННО (финальное ревью ветки, линза RLS, Important-1).
-- Три пина выше считают и разбирают ТОЛЬКО политики `{authenticated}` — они и заведены под них.
-- Поэтому политика, выданная ДРУГОЙ роли, для всего файла невидима: мутация
-- `CREATE POLICY rogue ON entities FOR SELECT TO orbis_app USING (true)` давала 158 ok / 0 not ok
-- (измерено фикс-волной), и серверный `routines/queries.test.ts:114-128` тоже молчал — он
-- принимает 42501 как «не видно», а без `GRANT … TO orbis_app` лишняя политика именно 42501 и
-- даёт. Сегодня утечки нет; она появилась бы с первым же грантом служебной роли на эту таблицу
-- под какую-нибудь фичу — и не сказал бы никто.
--
-- Пин ПОИМЁННЫЙ, а не счётный: «пять штук» разрешало бы подменить одну другой. Пять — это
-- поверхность БЕЗ идентичности целиком (спека §3.6, PRD §4.10): четыре под `orbis_app` (гранты
-- агентов и клиенты OAuth — сервер; список графов и членство — тик планировщика) и одна под
-- `public` — встроенные строки реестра, общие для всех графов. Шестой в этом списке быть не
-- должно: `TO public` сверх `registry_system` ловится здесь же структурно, а не поведением.
-- `COLLATE "C"` — не украшение: у `pg_policies.tablename`/`policyname` тип `name` (сортировка C),
-- и склейка с литералом даёт «could not determine which collation» ещё до сверки (измерено).
SELECT is((SELECT string_agg(tablename::text || '.' || policyname::text || ' ' || cmd::text
      || ' ' || roles::text COLLATE "C", ', ' ORDER BY (tablename::text || policyname::text) COLLATE "C")
    FROM pg_policies WHERE schemaname = 'public' AND roles <> '{authenticated}'),
  'agent_grants.server_manages_grants ALL {orbis_app}, '
  || 'graph_members.scheduler_reads_members SELECT {orbis_app}, '
  || 'oauth_clients.server_manages_clients ALL {orbis_app}, '
  || 'registry_system.read_all SELECT {public}, '
  || 'user_settings.scheduler_reads_owner_list SELECT {orbis_app}',
  'политики НЕ-`authenticated` ролей — ровно эти пять и никаких больше (поверхность без идентичности)');

SELECT finish();
ROLLBACK;
