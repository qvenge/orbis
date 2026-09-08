-- 0018_spent_cache_modules.sql — кэш spent (§Б5-5) и колонка выключенных модулей (§Б8-1).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0018_snapshot.json — сгенерированный (образец и довод —
-- 0017_reform_contract.sql:3-6): drizzle-kit не пишет ни политик RLS, ни грантов, а таблица
-- без них под FORCE RLS отвечала бы «пусто» всем и всегда.
--
-- ЕДИНСТВЕННАЯ миграция среза Б-1 (Р-И-23): 0019 — резерв, третья = СТОП и доклад владельцу.

CREATE TABLE "envelope_spent_cache" (
	"envelope_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"spent" numeric NOT NULL,
	"owner_version" integer NOT NULL,
	"system_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envelope_spent_cache_envelope_id_as_of_pk" PRIMARY KEY("envelope_id","as_of")
);--> statement-breakpoint
-- ON DELETE CASCADE: снесённый конверт уносит свои строки кэша сам. Без FK строки пережили бы
-- сущность, а `reset-world` (TRUNCATE СПИСКОМ, без CASCADE — db/reset-world.ts:44-50) упал бы
-- на висячей ссылке — то есть таблица ОБЯЗАНА быть и в GRAPH_TABLES (см. шаг 5).
ALTER TABLE "envelope_spent_cache" ADD CONSTRAINT "envelope_spent_cache_envelope_id_entities_id_fk"
  FOREIGN KEY ("envelope_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "envelope_spent_cache_owner" ON "envelope_spent_cache" USING btree ("owner_id","as_of");--> statement-breakpoint
ALTER TABLE "envelope_spent_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "envelope_spent_cache" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Таблица чисто ВЛАДЕЛЬЦА: встроенных строк кэша не бывает по определению, поэтому здесь не
-- шаблон реестра (read_builtin_or_own/write_own/…), а owner_owns_row FOR ALL — как у
-- registry_deltas (0014:238-240) и entities (0001:36-42). owner_id объявлен NOT NULL, так что
-- «ничья» строка не заводится и на уровне схемы.
CREATE POLICY "owner_owns_row" ON "envelope_spent_cache" FOR ALL
  USING ("owner_id" = (SELECT auth.uid()))
  WITH CHECK ("owner_id" = (SELECT auth.uid()));--> statement-breakpoint
-- GRANT ... ON ALL TABLES из 0001:97 на таблицы, созданные ПОЗЖЕ, не распространяется
-- (0014:249-253, 0011:30): без явного гранта таблица отвечала бы 42501 ДО всякой политики,
-- то есть «нет прав» вместо «пусто». Сервер ходит под authenticated (with-identity.ts:22-23).
GRANT SELECT, INSERT, UPDATE, DELETE ON "envelope_spent_cache" TO authenticated;--> statement-breakpoint
-- А эта строка — на случай путей БЕЗ identity под серверной ролью (образец 0011:37-41).
-- Политики для orbis_app здесь нет, значит RLS вернёт 0 строк: право выдаём, чтобы такой путь
-- падал понятной пустотой, а не «permission denied».
GRANT SELECT, INSERT, UPDATE, DELETE ON "envelope_spent_cache" TO orbis_app;--> statement-breakpoint
-- §Б8-1: выключенные модули владельца. NOT NULL DEFAULT '{}' — у существующих строк настроек
-- «ничего не выключено», и обратной совместимости эта колонка не ломает.
ALTER TABLE "user_settings" ADD COLUMN "disabled_modules" text[] DEFAULT '{}' NOT NULL;
