-- 0024_perf_samples.sql — полевые замеры ступени 0 (спека скорости §3.2, §12; РП-26).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0024_snapshot.json — сгенерированный (образец и довод — 0018_spent_cache_modules.sql:3-5):
-- drizzle-kit не пишет ни политик RLS, ни грантов, ни задач pg_cron. ПЕРВАЯ из трёх миграций плана А (§12 спеки:
-- 0024 замеры, 0025 журнал, 0026 колонки тела); иная необходимость — СТОП и доклад владельцу.
--
-- Снимок снят ОБЫЧНОЙ генерацией (`drizzle-kit generate --name perf_samples`), а её SQL заменён этим файлом: генерация
-- с `--custom` кладёт копию прежнего снимка БЕЗ новой таблицы, и следующая генерация (0025) увидела бы
-- `perf_samples` как «надо создать».
CREATE EXTENSION IF NOT EXISTS pg_cron;--> statement-breakpoint
CREATE TABLE "perf_samples" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"account_id" uuid DEFAULT auth.uid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metric" text NOT NULL,
	"screen" text,
	"kind" text,
	"procedure" text,
	"dur_ms" real NOT NULL,
	"server_ms" real,
	"db_ms" real,
	"device" text NOT NULL,
	"net" text,
	"app_version" text NOT NULL,
	"cached" boolean
);--> statement-breakpoint
-- Индекс — под суточный потолок (проба `count(*)` по аккаунту за сутки, РП-26) и под чистку по времени.
-- `uuid = uuid` leakproof — под RLS индекс берётся (Д-3).
CREATE INDEX "perf_samples_account_created" ON "perf_samples" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "perf_samples" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "perf_samples" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Аккаунт, не граф (§3.2 «аккаунт пишет и читает только своё»): две политики, дописываемая таблица — как graphs (0020:175).
CREATE POLICY "own_account_select" ON "perf_samples" FOR SELECT TO authenticated
  USING ("account_id" = (SELECT auth.uid()));--> statement-breakpoint
CREATE POLICY "own_account_insert" ON "perf_samples" FOR INSERT TO authenticated
  WITH CHECK ("account_id" = (SELECT auth.uid()));--> statement-breakpoint
-- Грант из 0001:97 на поздние таблицы не распространяется (0018:30-33). Сначала REVOKE — как в 0020:169-175: default ACL
-- роли-владельца в разных окружениях разный (локальный стек выдаёт anon и authenticated ВСЁ, включая UPDATE, DELETE и
-- TRUNCATE мимо RLS), и без него «правки нет» держалось бы не грантом, а одной лишь пустотой политик.
-- UPDATE/DELETE нет: замер не правится; чистку делает задача pg_cron под владельцем задачи (роль миграции), а не приложение.
REVOKE ALL ON "perf_samples" FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON "perf_samples" TO authenticated;--> statement-breakpoint
-- Хранение 30 дней (§3.2): ежедневно 03:17 UTC. Одноимённая задача перепланируется, а не дублируется (cron.schedule по
-- имени — upsert), поэтому повторный прогон миграции на стенде безопасен. Задача идёт от имени роли миграции
-- (`postgres` — BYPASSRLS в Supabase), поэтому FORCE RLS её DELETE не глушит.
SELECT cron.schedule('orbis_perf_samples_cleanup', '17 3 * * *',
  $$DELETE FROM public.perf_samples WHERE created_at < now() - interval '30 days'$$);
