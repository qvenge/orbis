-- 0026_body_revision.sql — ревизия тела и «действие текущего тела» (спека ступеней 0+1 §8.1, план А задача 7).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0026_snapshot.json — сгенерированный (обычная генерация `drizzle-kit generate --name
-- body_revision`, рулинг R-9; триггеров drizzle-kit не видит). ТРЕТЬЯ и последняя миграция плана А (§12 спеки: 0024
-- замеры, 0025 журнал, 0026 колонки тела); иная необходимость — СТОП и доклад владельцу.
--
-- Почему ТРИГГЕР, а не код: писателей тела не меньше шести (executor — три ветки правки, создание, засев в attach; сырой
-- SQL слияния свойства и его отката), и каждый забытый писатель молча ломал бы замок текста и цепочку отмены (§8.6).
-- Базу обойти нельзя по построению.
-- SECURITY INVOKER, пустой search_path (правило проекта 0020:4, «bypass RLS не вводится» 0013:7): функция меняет только
-- NEW и других таблиц не читает — привилегий сверх вызывающего ей не нужно (РП-1 плана А).
-- Защитной ветки «вернуть OLD при правке без тела» нет намеренно: засев колонки действия прод-операцией (перенос
-- журнала) иначе был бы невозможен без суперпользователя; прямую запись колонок в коде запрещает сторож путей записи.
-- Колонка действия — БЕЗ внешнего ключа на журнал (К-34): запись журнала пишется ПОСЛЕ правки в той же транзакции.
-- Триггер СТОЛБЦОВЫЙ (`UPDATE OF body, body_doc`, рулинг R-16): при UPDATE без тела в SET функция не вызывается вовсе —
-- правки свойств и тегов, кеш, пересчёт предков (тысячи строк на одну правку владельца), пометки ссылок и CTE значений
-- слияния не платят вызовом функции и сравнением тел (замер гейта: ×2 на малых телах, ×12 на телах в TOAST). Проверка
-- `IS DISTINCT FROM` внутри остаётся: тело в SET ещё не значит «тело сменилось». Цена формы: будущий BEFORE-триггер,
-- правящий `NEW.body`, этого триггера не разбудит — такой триггер обязан ставить колонки тела сам.
-- Существующие записи: ревизия 1, время изменения тела — `updated_at` (точнее у записи нет), действие — пусто до засева
-- прод-операцией переноса журнала (РП-2).
ALTER TABLE "entities"
  ADD COLUMN "body_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN "body_action_id" uuid,
  ADD COLUMN "body_changed_at" timestamptz(3);--> statement-breakpoint
UPDATE "entities" SET "body_changed_at" = "updated_at";--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "body_changed_at" SET NOT NULL,
  ALTER COLUMN "body_changed_at" SET DEFAULT now();--> statement-breakpoint
CREATE FUNCTION "public"."entities_body_stamp"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- NULLIF: после транзакции с set_config на переиспользованном соединении настройка остаётся определённой с пустым
  -- значением (проверено на Postgres 17 стенда) — пустая строка не значение (§8.1).
  IF TG_OP = 'INSERT' THEN
    NEW.body_revision := 1;
    NEW.body_action_id := NULLIF(pg_catalog.current_setting('orbis.body_action', true), '')::uuid;
    NEW.body_changed_at := pg_catalog.clock_timestamp();
  ELSIF OLD.body IS DISTINCT FROM NEW.body OR OLD.body_doc IS DISTINCT FROM NEW.body_doc THEN
    NEW.body_revision := OLD.body_revision + 1;
    NEW.body_action_id := NULLIF(pg_catalog.current_setting('orbis.body_action', true), '')::uuid;
    NEW.body_changed_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "entities_body_stamp" BEFORE INSERT OR UPDATE OF "body", "body_doc" ON "entities"
  FOR EACH ROW EXECUTE FUNCTION "public"."entities_body_stamp"();
