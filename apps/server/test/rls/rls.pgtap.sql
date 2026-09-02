-- apps/server/test/rls/rls.pgtap.sql
-- Прогон: psql $DATABASE_URL_ADMIN -v ON_ERROR_STOP=1 -f <этот файл>
-- Всё в одной транзакции с ROLLBACK: БД не мутируется.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(89);

-- Фикстуры под ролью с BYPASSRLS (обходит RLS; postgres здесь НЕ суперпользователь)
INSERT INTO entities (id, owner_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'A: задача'),
  ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'B: задача');
INSERT INTO chat_threads (id, owner_id) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a');
INSERT INTO chat_messages (id, thread_id, role, content) VALUES
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-0000000000a2', 'user', 'привет');
INSERT INTO aspect_definitions (id, owner_id, key, label, description)
  VALUES ('orbis/pgtap-probe', NULL, 'orbis/pgtap-probe', '{"ru":"Проба"}', '{"ru":"Проба"}');
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
INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES
  ('pgtap-client', 'Claude Code', ARRAY['http://localhost:8080/callback']);
INSERT INTO agent_grants (id, owner_id, client_id, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a7', '00000000-0000-4000-8000-00000000000a',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-a'),
  ('00000000-0000-7000-8000-0000000000b7', '00000000-0000-4000-8000-00000000000b',
   'pgtap-client', 'oauth', 'Claude Code', 'hash-b');
-- Закреплённые версии тела (ADE-срез 1, С11) — по одной у A и у B: без строки B
-- проверка «A видит ровно свою» была бы ложно-зелёной и при сломанном RLS.
-- body_doc не задаём: версия, снятая с ещё не сконвертированного тела, — законный случай.
INSERT INTO entity_versions (id, owner_id, entity_id, label, body, actor_user_id, actor_kind) VALUES
  ('00000000-0000-7000-8000-0000000000a8', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-7000-8000-0000000000a1', 'до правки A', 'тело A',
   '00000000-0000-4000-8000-00000000000a', 'owner'),
  ('00000000-0000-7000-8000-0000000000b8', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-7000-8000-0000000000b1', 'до правки B', 'тело B',
   '00000000-0000-4000-8000-00000000000b', 'owner');

-- Фикстуры реестров реформы (0014). У каждого — по ТРИ строки: встроенная (owner_id NULL,
-- читается всеми), строка A и строка B. Без строки B проверки «видит только своё» были бы
-- ложно-зелёными даже при полностью снятой RLS, а без встроенной — не различались бы
-- политики read_builtin_or_own и update_own.
-- Префикс id `pgtap/` отделяет пробы от 77 засеянных свойств, 11 ролей и 13 аспектов,
-- которые в базе уже лежат: счётчики ниже считают ровно пробы.
INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"П"}'::jsonb,
          '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, owner_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, owner_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO relation_role_definitions
  (id, owner_id, key, label, description, source_label, target_label, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"Р"}'::jsonb,
          '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900);
INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b', '{"ru":"К"}'::jsonb,
          '{"ru":"К"}'::jsonb, 'slots', 900);
INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
  VALUES ('pgtap/probe', NULL, 'agenda', '{}'::jsonb, 900);
INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'agenda', '{}'::jsonb, 900);
INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'agenda', '{}'::jsonb, 900);
INSERT INTO action_definitions (id, owner_id, key, label, description)
  VALUES ('pgtap/probe', NULL, 'pgtap/probe', '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO action_definitions (id, owner_id, key, label, description)
  VALUES ('pgtap/a', '00000000-0000-4000-8000-00000000000a', 'pgtap/a',
          '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO action_definitions (id, owner_id, key, label, description)
  VALUES ('pgtap/b', '00000000-0000-4000-8000-00000000000b', 'pgtap/b',
          '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb);
INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta) VALUES
  ('00000000-0000-7000-8000-0000000000aa', '00000000-0000-4000-8000-00000000000a',
   'property', 'orbis/priority', 1, '{"label":{"ru":"Своё"}}'),
  ('00000000-0000-7000-8000-0000000000bb', '00000000-0000-4000-8000-00000000000b',
   'property', 'orbis/priority', 1, '{"label":{"ru":"Чужое"}}');

-- 1) RLS включён и FORCE на всех 18 таблицах (11 исходных + 7 реестров реформы, 0014)
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname IN ('entities','relations','aspect_definitions','user_settings',
                       'chat_threads','chat_messages','ai_usage','entity_origins',
                       'agent_grants','oauth_clients','entity_versions',
                       'property_definitions','relation_role_definitions',
                       'contract_definitions','subscription_definitions',
                       'action_definitions','registry_deltas','registry_system')
     AND c.relrowsecurity AND c.relforcerowsecurity),
  18, 'RLS ENABLE+FORCE на всех восемнадцати таблицах');

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
    VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000b',
            'подлог')$$,
  '42501', NULL, 'INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entities (id, owner_id, title)
    VALUES ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000a',
            'своя')$$,
  'INSERT со своим owner_id проходит');
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
  $$INSERT INTO aspect_definitions (id, owner_id, key, label, description)
    VALUES ('orbis/pgtap-fake-builtin', NULL, 'orbis/pgtap-fake-builtin',
            '{"ru":"Подлог"}', '{"ru":"Подлог"}')$$,
  '42501', NULL, 'aspect_definitions: INSERT builtin (owner_id NULL) отклоняется WITH CHECK');
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
  $$SELECT count(*)::int FROM agent_grants WHERE owner_id = '00000000-0000-4000-8000-00000000000b'$$,
  ARRAY[0], 'чужой грант невидим');
SELECT throws_ok(
  $$INSERT INTO agent_grants (id, owner_id, kind, label)
    VALUES ('00000000-0000-7000-8000-0000000000c7',
            '00000000-0000-4000-8000-00000000000b', 'pat', 'подлог')$$,
  '42501', NULL, 'грант с чужим owner_id отклоняется WITH CHECK');

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
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
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
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entity_versions', ARRAY[1],
  'entity_versions: A видит ровно свою версию');
SELECT throws_ok(
  $$INSERT INTO entity_versions (id, owner_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES ('00000000-0000-7000-8000-0000000000c8',
            '00000000-0000-4000-8000-00000000000b',
            '00000000-0000-7000-8000-0000000000b1', 'подлог', 'тело',
            '00000000-0000-4000-8000-00000000000b', 'owner')$$,
  '42501', NULL, 'entity_versions: INSERT с чужим owner_id отклоняется WITH CHECK');
-- Та же дыра, что закрыл 0002 у entity_origins: owner_id СВОЙ, а entity_id — ЧУЖАЯ
-- сущность (B). Предикат только по owner_id это пропускал: RI-проверка FK идёт мимо RLS
-- и чужую сущность видит. Версия чужой записи ломает сквозное владение §4.10, поэтому
-- WITH CHECK требует ещё и владения самой сущностью → 42501.
SELECT throws_ok(
  $$INSERT INTO entity_versions (id, owner_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES ('00000000-0000-7000-8000-0000000000c9',
            '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-7000-8000-0000000000b1', 'версия чужой', 'тело',
            '00000000-0000-4000-8000-00000000000a', 'owner')$$,
  '42501', NULL,
  'entity_versions: INSERT версии на чужую сущность (свой owner) отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO entity_versions (id, owner_id, entity_id, label, body, actor_user_id, actor_kind)
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
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- Группа 12: property_definitions
SELECT results_eq(
  $$SELECT count(*)::int FROM property_definitions WHERE id LIKE 'pgtap/%'$$,
  ARRAY[2],
  'property_definitions: A видит встроенную и свою — и ровно их (строка B невидима)');
SELECT lives_ok(
  $$INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  'property_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  '42501', NULL, 'property_definitions: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"П"}'::jsonb,
            '{"ru":"П"}'::jsonb, '{"kind":"text"}'::jsonb, 900)$$,
  '42501', NULL,
    'property_definitions: INSERT встроенной строки (owner_id NULL) под authenticated отклоняется');
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
  (id, owner_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  'relation_role_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO relation_role_definitions
  (id, owner_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  '42501', NULL, 'relation_role_definitions: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO relation_role_definitions
  (id, owner_id, key, label, description, source_label, target_label, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"Р"}'::jsonb,
            '{"ru":"Р"}'::jsonb, '{"ru":"И"}'::jsonb, '{"ru":"Ц"}'::jsonb, 900)$$,
  '42501', NULL,
    'relation_role_definitions: INSERT встроенной строки (owner_id NULL) отклоняется');
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
  $$INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2', '{"ru":"К"}'::jsonb,
            '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  'contract_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c', '{"ru":"К"}'::jsonb,
            '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  '42501', NULL, 'contract_definitions: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"К"}'::jsonb, '{"ru":"К"}'::jsonb, 'slots', 900)$$,
  '42501', NULL,
    'contract_definitions: INSERT встроенной строки (owner_id NULL) под authenticated отклоняется');
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
  $$INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'agenda', '{}'::jsonb, 900)$$,
  'subscription_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'agenda', '{}'::jsonb, 900)$$,
  '42501', NULL, 'subscription_definitions: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO subscription_definitions (id, owner_id, surface, definition, rank)
    VALUES ('pgtap/c', NULL, 'agenda', '{}'::jsonb, 900)$$,
  '42501', NULL,
    'subscription_definitions: INSERT встроенной строки (owner_id NULL) отклоняется');
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
  $$INSERT INTO action_definitions (id, owner_id, key, label, description)
    VALUES ('pgtap/a2', '00000000-0000-4000-8000-00000000000a', 'pgtap/a2',
            '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  'action_definitions: INSERT своей строки проходит (write_own + GRANT)');
SELECT throws_ok(
  $$INSERT INTO action_definitions (id, owner_id, key, label, description)
    VALUES ('pgtap/c', '00000000-0000-4000-8000-00000000000b', 'pgtap/c',
            '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  '42501', NULL, 'action_definitions: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT throws_ok(
  $$INSERT INTO action_definitions (id, owner_id, key, label, description)
    VALUES ('pgtap/c', NULL, 'pgtap/c', '{"ru":"Д"}'::jsonb, '{"ru":"Д"}'::jsonb)$$,
  '42501', NULL,
    'action_definitions: INSERT встроенной строки (owner_id NULL) под authenticated отклоняется');
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

-- Группа 17: registry_deltas — таблица чисто владельца (owner_owns_row FOR ALL), встроенных
-- дельт не бывает по определению.
SELECT results_eq('SELECT count(*)::int FROM registry_deltas', ARRAY[1],
  'registry_deltas: A видит ровно свою дельту');
SELECT throws_ok(
  $$INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
    VALUES ('00000000-0000-7000-8000-0000000000cc', '00000000-0000-4000-8000-00000000000b', 'property',
            'orbis/limit', 1, '{}')$$,
  '42501', NULL, 'registry_deltas: INSERT с чужим owner_id отклоняется WITH CHECK');
SELECT lives_ok(
  $$INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
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

SELECT finish();
ROLLBACK;
