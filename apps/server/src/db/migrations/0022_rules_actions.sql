-- 0022_rules_actions.sql — колонка правил каталога (§Б4-1) и форма строки действия (§Б6-1).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0022_snapshot.json — сгенерированный (образец и довод —
-- 0018_spent_cache_modules.sql:3-6): drizzle-kit не пишет ни политик RLS, ни грантов. Здесь их и не
-- нужно — таблицы существуют с 0014, а колонка прав не меняет; генерация нужна ради снимка и журнала.
--
-- ЕДИНСТВЕННАЯ миграция среза Б-2 (Р-18): 0023 — резерв, третья = СТОП и доклад владельцу. Бюджет тот же
-- и после Р-К-92: колонки ДЕЙСТВИЙ (веха II) и колонка КОНТРАКТА (задача 14а) кладутся ЗДЕСЬ, хотя
-- читатели у них появятся позже, — у среза один бюджет, и вторая миграция ради `rank`, `status` либо
-- `exclusive_classes` его бы исчерпала.
ALTER TABLE "property_definitions"      ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aspect_definitions"        ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_role_definitions" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Р-И-38: один вариант на класс — запись классом однозначна; флаг читает валидатор привязок.
-- Колонка, а не константа в коде: снимок собирается ИЗ СТРОК, и флаг из кода терялся бы на пересеве
-- (Р-К-92 п.2). DEFAULT false безопасен: у шести засеянных контрактов исключительности нет.
ALTER TABLE "contract_definitions" ADD COLUMN "exclusive_classes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- rank: действия — единственный реестр без него, а по нему сортирует экспорт (export.ts:74-80) и
-- каталог промпта. DEFAULT 0 безопасен: таблица пуста и в проде (§А12-1).
ALTER TABLE "action_definitions" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- status: §С3 обещает действию deprecate, а §А10-3 запрещает удалять строку реестра физически.
ALTER TABLE "action_definitions" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
-- §Б6-3 map-действие: Q результатов; nullable — у одиночного действия его нет (Р-К-15).
ALTER TABLE "action_definitions" ADD COLUMN "over" jsonb;--> statement-breakpoint
ALTER TABLE "action_definitions" ADD CONSTRAINT "action_definitions_status" CHECK ("status" IN ('active','deprecated'));--> statement-breakpoint
-- Имя тула действия собирается из `key` — два действия с одним ключом дали бы неразрешимое имя тула.
CREATE UNIQUE INDEX "action_definitions_builtin_key" ON "action_definitions" ("key") WHERE "graph_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "action_definitions_custom_key" ON "action_definitions" ("graph_id","key") WHERE "graph_id" IS NOT NULL;
