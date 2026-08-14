ALTER TABLE "entities" ADD COLUMN "body_doc" jsonb;--> statement-breakpoint
-- Дописано руками к сгенерированной миграции, поэтому в снимок drizzle (meta/0007_snapshot.json)
-- индекс НЕ попадает: следующий `db:generate` его не видит и трогать не будет (проверено —
-- повторный прогон дал «No schema changes»). `IF NOT EXISTS` гасит дубль, если индекс всё же
-- когда-нибудь опишут в schema.ts.
--
-- Двумя миграциями подряд ради одной работы — лишний шаг в прод-процедуре, а откатывать их всё
-- равно нечем (миграции forward-only).
--
-- Префиксный поиск для slash-меню и пикеров (entity.suggest). Именно btree с text_pattern_ops,
-- а НЕ gin_trgm: запрос имеет вид `lower(title) LIKE 'куп%'`, то есть префиксный, и btree
-- обслуживает его напрямую, тогда как триграммный индекс на запросах короче трёх символов
-- бесполезен. Заодно не требуется CREATE EXTENSION — на Supabase расширения живут в схеме
-- `extensions`, и необкатанный шаг с pg_trgm мог бы упасть прямо на проде.
CREATE INDEX IF NOT EXISTS entities_title_prefix
  ON entities (lower(title) text_pattern_ops);
