-- 0014_registries.sql — реестры реформы свойств (§С6 спеки «Реформа свойств», D43).
--
-- Файл СМЕШАННЫЙ: DDL таблиц сгенерирован drizzle-kit из schema.ts, а RLS, гранты и
-- INSERT единственной строки registry_system дописаны руками в его конец — drizzle-kit
-- политик и грантов не видит (тот же порядок, что у 0005/0011/0013, но там миграции
-- рукописные целиком, а здесь генерация даёт снимок meta/0014_snapshot.json, и он нужен:
-- без него следующая генерация (0015) не увидит семи новых таблиц как «уже существующих».
--
-- РАЗРУШАЮЩИХ шагов по данным ГРАФА здесь нет: ни одна колонка entities/relations не
-- трогается. Единственное разрушение — очистка `aspect_definitions` ниже.
--
-- Приёмка RLS этой миграции — группы 12–18 в apps/server/test/rls/rls.pgtap.sql
-- (список «18 таблиц» в первой проверке файла — тоже отсюда).

-- Реестр аспектов переезжает в новую форму (§А3-1), и старые строки в неё не переводятся:
-- у сегодняшней строки нет ни `key`, ни per-locale `label`, ни списка свойств, а
-- `description` — плоский текст без локали. Восстанавливать их построчно бессмысленно —
-- ровно ту же таблицу СРАЗУ ЗА миграцией засевает `scripts/seed-registries.ts`
-- (шаг `bun run db:prepare`), и он же источник истины для встроенных строк.
--
-- Кастомные строки владельцев (owner_id IS NOT NULL) удаляются вместе со встроенными
-- намеренно: сид их не восстановит, а сохранить их нечем — у пользовательского аспекта
-- старой формы нет свойств-строк реестра, которые обязана иметь новая. Рулинг владельца
-- 23.08: пользователей нет, данные в базе можно переписывать. Интервал «реестр пустой —
-- сида не было» кричит дрейфом, как и сегодня.
DELETE FROM aspect_definitions;
--> statement-breakpoint
CREATE TABLE "action_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"params" jsonb,
	"precondition" jsonb,
	"steps" jsonb,
	"sensitivity" jsonb,
	"offered_by" jsonb,
	"module" text,
	"batch_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"kind" text NOT NULL,
	"slots" jsonb,
	"classes" jsonb,
	"sets" jsonb,
	"facts" jsonb,
	"module" text,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_definitions_kind" CHECK ("contract_definitions"."kind" IN ('slots','facts'))
);
--> statement-breakpoint
CREATE TABLE "property_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"type" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"storage" text DEFAULT 'props' NOT NULL,
	"scope" jsonb,
	"merged_into" text,
	"module" text,
	"rank" integer NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_definitions_status" CHECK ("property_definitions"."status" IN ('active','proposed','deprecated')),
	CONSTRAINT "property_definitions_storage" CHECK ("property_definitions"."storage" IN ('props','core'))
);
--> statement-breakpoint
CREATE TABLE "registry_deltas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"base_version" integer NOT NULL,
	"delta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_deltas_uniq" UNIQUE("owner_id","target_kind","target_id"),
	CONSTRAINT "registry_deltas_target_kind" CHECK ("registry_deltas"."target_kind" IN ('property','aspect','contract','relation_role','subscription','action'))
);
--> statement-breakpoint
CREATE TABLE "registry_system" (
	"id" smallint PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"seeded_at" timestamp with time zone,
	CONSTRAINT "registry_system_singleton" CHECK ("registry_system"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "relation_role_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"key" text NOT NULL,
	"label" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"source_label" jsonb NOT NULL,
	"target_label" jsonb NOT NULL,
	"hierarchical" boolean DEFAULT false NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"symmetric" boolean DEFAULT false NOT NULL,
	"module" text,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"surface" text NOT NULL,
	"definition" jsonb NOT NULL,
	"module" text,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- USING NULL, а не приведение старого текста: плоская строка описания не является
-- per-locale объектом {ru, en}, и превращать её в JSON-строку значило бы записать в
-- реестр заведомо неверную форму. Таблица очищена первым шагом миграции, поэтому
-- терять здесь нечего, а без USING приведение text -> jsonb не существует вовсе.
ALTER TABLE "aspect_definitions" ALTER COLUMN "description" SET DATA TYPE jsonb USING NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ALTER COLUMN "schema" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "properties" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "implements" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "module" text;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "registry_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_definitions_builtin_uniq" ON "action_definitions" USING btree ("id") WHERE "action_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_definitions_custom_uniq" ON "action_definitions" USING btree ("owner_id","id") WHERE "action_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_definitions_builtin_uniq" ON "contract_definitions" USING btree ("id") WHERE "contract_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_definitions_custom_uniq" ON "contract_definitions" USING btree ("owner_id","id") WHERE "contract_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_definitions_builtin_uniq" ON "property_definitions" USING btree ("id") WHERE "property_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_definitions_custom_uniq" ON "property_definitions" USING btree ("owner_id","id") WHERE "property_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_definitions_builtin_key" ON "property_definitions" USING btree ("key") WHERE "property_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "property_definitions_custom_key" ON "property_definitions" USING btree ("owner_id","key") WHERE "property_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_role_definitions_builtin_uniq" ON "relation_role_definitions" USING btree ("id") WHERE "relation_role_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "relation_role_definitions_custom_uniq" ON "relation_role_definitions" USING btree ("owner_id","id") WHERE "relation_role_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_definitions_builtin_uniq" ON "subscription_definitions" USING btree ("id") WHERE "subscription_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_definitions_custom_uniq" ON "subscription_definitions" USING btree ("owner_id","id") WHERE "subscription_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "aspect_definitions" DROP COLUMN "namespace";--> statement-breakpoint
ALTER TABLE "aspect_definitions" DROP COLUMN "icon";--> statement-breakpoint
-- ===========================================================================
-- Рукописная часть: RLS, политики, гранты, единственная строка registry_system.
-- ===========================================================================

-- FORCE — страховка от обхода владельцем таблицы (как во всех остальных таблицах, 0001).
ALTER TABLE property_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE property_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE relation_role_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE relation_role_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contract_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contract_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subscription_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE subscription_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE action_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE action_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE registry_deltas ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE registry_deltas FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE registry_system ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE registry_system FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Политики пяти реестров — ДОСЛОВНО шаблон aspect_definitions (0001:80-91), и имена те же
-- (read_builtin_or_own / write_own / update_own / delete_own), чтобы grep по политикам
-- оставался единообразным: встроенная строка (owner_id IS NULL) читается всеми и не
-- правится никем, кроме сида под админской ролью; своя — полностью своя.
-- (select auth.uid()) — InitPlan-кэширование: один вызов на запрос, а не на строку.

CREATE POLICY read_builtin_or_own ON property_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY write_own ON property_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY update_own ON property_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY delete_own ON property_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));--> statement-breakpoint

CREATE POLICY read_builtin_or_own ON relation_role_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY write_own ON relation_role_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY update_own ON relation_role_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY delete_own ON relation_role_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));--> statement-breakpoint

-- Контракты, подписки и действия в срезе А ПУСТЫ (§А12-1), но политики у них те же и
-- сразу: таблица без политик под FORCE RLS отдаёт ноль строк всем и всегда, и первый же
-- сид среза Б-1 отлаживался бы не против формы доступа, а против её отсутствия.
CREATE POLICY read_builtin_or_own ON contract_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY write_own ON contract_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY update_own ON contract_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY delete_own ON contract_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));--> statement-breakpoint

CREATE POLICY read_builtin_or_own ON subscription_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY write_own ON subscription_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY update_own ON subscription_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY delete_own ON subscription_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));--> statement-breakpoint

CREATE POLICY read_builtin_or_own ON action_definitions FOR SELECT
  USING (owner_id IS NULL OR owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY write_own ON action_definitions FOR INSERT
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY update_own ON action_definitions FOR UPDATE
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY delete_own ON action_definitions FOR DELETE
  USING (owner_id = (SELECT auth.uid()));--> statement-breakpoint

-- registry_deltas — таблица чисто ВЛАДЕЛЬЦА: встроенных дельт не бывает по определению
-- (дельта это и есть отличие пользователя от системы), поэтому здесь не шаблон реестра,
-- а owner_owns_row FOR ALL — как у entities и user_settings (0001:36-42). owner_id
-- объявлен NOT NULL, так что «ничья» строка не заводится и на уровне схемы.
CREATE POLICY owner_owns_row ON registry_deltas FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));--> statement-breakpoint

-- registry_system — глобальная версия system-реестров: читают ВСЕ (по ней сверяется кеш
-- эффективных определений в каждой транзакции, §А10-1), пишет ТОЛЬКО сид под админской
-- ролью. Отсюда единственная политика — на чтение; политик INSERT/UPDATE/DELETE нет
-- НАМЕРЕННО, и это и есть запрет: под FORCE RLS отсутствие политики на команду означает
-- отказ 42501, а не тихий ноль строк (тихий ноль бывает только у USING на SELECT/UPDATE).
CREATE POLICY read_all ON registry_system FOR SELECT USING (true);--> statement-breakpoint

-- GRANT ... ON ALL TABLES из 0001:97 на таблицы, созданные ПОЗЖЕ, не распространяется
-- (см. 0005:47-49, 0011:30): без явного гранта каждая из семи отвечала бы 42501 ДО всякой
-- политики, то есть «нет прав» вместо «пусто». Сервер ходит в графе под ролью authenticated
-- (SET LOCAL ROLE authenticated в withIdentity, src/db/with-identity.ts:22-23) — там же
-- политики выше и скоупят строки.
--
-- registry_system получает полный набор прав НАРЯДУ с остальными, хотя писать её никто,
-- кроме сида, не должен: запрет обязан приходить от RLS (её и пинит pgTAP-группа 18), а не
-- от отсутствующего гранта. Иначе снятая политика прошла бы мимо теста, прикрытая
-- отсутствием права, — ровно тот молчаливый отказ, ради различения которого заводился
-- отдельный слой политик.
GRANT SELECT, INSERT, UPDATE, DELETE ON property_definitions TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON relation_role_definitions TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_definitions TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_definitions TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON action_definitions TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON registry_deltas TO authenticated;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON registry_system TO authenticated;--> statement-breakpoint

-- Единственная строка версии system-реестров. Кладётся ЗДЕСЬ, а не сидом: сид её
-- инкрементирует (`version = version + 1`), и без строки его UPDATE молча не тронул бы ни
-- одной записи — версия навсегда осталась бы нулевой, а кеши перестали бы инвалидироваться.
-- 0 — «сида ещё не было»; первый же прогон seed-registries сделает 1.
INSERT INTO registry_system (id, version) VALUES (1, 0);
