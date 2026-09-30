-- 0025_action_journal.sql — журнал действий отдельной таблицей (спека ступеней 0+1 §11, план А задача 5).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0025_snapshot.json — сгенерированный (drizzle-kit не пишет ни политик, ни грантов).
-- Снимок снят ОБЫЧНОЙ генерацией (`drizzle-kit generate --name action_journal`, рулинг R-9): `--custom` положил бы
-- копию прежнего снимка без новых таблиц, и следующая генерация (0026) завела бы их заново. ВТОРАЯ из трёх миграций
-- плана А (§12 спеки: 0024 замеры, 0025 журнал, 0026 колонки тела); иная необходимость — СТОП и доклад владельцу.
-- Имена внешних ключей — те же, что в снимке drizzle: иначе база и снимок расходились бы именами ограничений.
--
-- Почему таблица, а не сообщения чата: аудит и разговор — разные виды данных (§10.1); журнал в chat_messages будил
-- тред на каждом сохранении текста, забивал хвост треда служебными строками и отдавал клиенту полные копии текстов.
-- Строка покрывает ВЕСЬ ActionRecord (type, entity_id, actor_user_id, mechanism, action_id, module, results — их читают
-- эскалация, «отмени последнее», R-18 поставки), а не только перечень §11.2 (РП-7).
-- Только дописывается: политики — SELECT и INSERT, UPDATE/DELETE нет ни у одной роли приложения (образец — graphs,
-- graph_members в 0020). Отмена — отдельная строка type='undo'; «уже отменено» держит уникальность (graph_id, undoes).
CREATE TABLE "action_journal" (
  "graph_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT now(),
  "type" text NOT NULL,
  "entity_id" uuid,
  "actor_user_id" uuid NOT NULL,
  "actor_kind" text NOT NULL,
  "source" text NOT NULL,
  "mechanism" text NOT NULL,
  "actor_grant_id" uuid,
  "run_id" uuid,
  "action_id" text,
  "module" text,
  "edited_from" uuid,
  "thread_id" uuid,
  "title" text NOT NULL,
  "card_tool" text NOT NULL,
  "entity_ids" uuid[] NOT NULL DEFAULT '{}',
  "operations" jsonb NOT NULL,
  "inverse" jsonb NOT NULL,
  "results" jsonb,
  "text_session" boolean NOT NULL DEFAULT false,
  "body_before" jsonb,
  "undoes" uuid,
  "pinned_version_ids" uuid[] NOT NULL DEFAULT '{}',
  "card_in_reply" boolean NOT NULL DEFAULT false,
  CONSTRAINT "action_journal_pkey" PRIMARY KEY ("graph_id", "id"),
  CONSTRAINT "action_journal_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id")
    REFERENCES "graphs"("id") ON DELETE CASCADE,
  CONSTRAINT "action_journal_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id")
    REFERENCES "chat_threads"("id") ON DELETE SET NULL,
  CONSTRAINT "action_journal_undo_shape" CHECK (("type" = 'undo') = ("undoes" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "action_journal_undoes_uniq" ON "action_journal" ("graph_id", "undoes") WHERE "undoes" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "action_journal_graph_time" ON "action_journal" ("graph_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "action_journal_thread_time" ON "action_journal" ("graph_id", "thread_id", "created_at" DESC, "id" DESC) WHERE "thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "action_journal_run" ON "action_journal" ("graph_id", "run_id") WHERE "run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "action_journal_type_time" ON "action_journal" ("graph_id", "type", "created_at" DESC);--> statement-breakpoint
-- Пробы «по затронутой записи» (R-18 поставки, окно конфликтов отката, будущий журнал записи). Под RLS оператор
-- массива @>/&& не leakproof и индекс не возьмёт (замер routines/lifecycle.ts:1431-1443 для jsonb — та же природа);
-- равенство uuid leakproof — btree по боковой таблице работает под политикой (РП-8).
CREATE TABLE "action_journal_entities" (
  "graph_id" uuid NOT NULL,
  "action_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "action_journal_entities_pkey" PRIMARY KEY ("graph_id", "action_id", "entity_id"),
  CONSTRAINT "action_journal_entities_action_fk" FOREIGN KEY ("graph_id", "action_id")
    REFERENCES "action_journal"("graph_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "action_journal_entities_probe" ON "action_journal_entities" ("graph_id", "entity_id", "created_at" DESC);--> statement-breakpoint
ALTER TABLE "action_journal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_journal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_journal_entities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "action_journal_entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "action_journal" FOR SELECT TO authenticated
  USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "action_journal" FOR INSERT TO authenticated
  WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "action_journal_entities" FOR SELECT TO authenticated
  USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "action_journal_entities" FOR INSERT TO authenticated
  WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));--> statement-breakpoint
-- Грант из 0001:97 на поздние таблицы не распространяется (0018:30-33). Сначала REVOKE — как в 0020:169-175 и 0024:37-40:
-- default ACL роли-владельца в разных окружениях разный (локальный стек выдаёт anon и authenticated ВСЁ, включая UPDATE,
-- DELETE и TRUNCATE мимо RLS), и без него «только дописывается» держалось бы не грантом, а одной лишь пустотой политик.
REVOKE ALL ON "action_journal", "action_journal_entities" FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT, INSERT ON "action_journal", "action_journal_entities" TO authenticated;
