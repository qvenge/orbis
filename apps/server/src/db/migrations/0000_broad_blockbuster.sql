CREATE TABLE "ai_usage" (
	"owner_id" uuid NOT NULL,
	"date" date NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_owner_id_date_model_pk" PRIMARY KEY("owner_id","date","model")
);
--> statement-breakpoint
CREATE TABLE "aspect_definitions" (
	"id" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"namespace" text NOT NULL,
	"description" text,
	"icon" text,
	"schema" jsonb NOT NULL,
	"ai_instructions" text,
	"tag_mappings" text[] DEFAULT '{}' NOT NULL,
	"aggregations" jsonb DEFAULT '{}'::jsonb,
	"view_config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"entity_id" uuid,
	"title" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"emoji" text,
	"body" text DEFAULT '' NOT NULL,
	"body_refs" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aspects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_origins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_origins_uniq" UNIQUE("owner_id","namespace","external_id")
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rel_uniq" UNIQUE("source_id","target_id","relation_type"),
	CONSTRAINT "rel_no_self" CHECK ("relations"."source_id" <> "relations"."target_id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'dev' NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"defaultCurrency" text DEFAULT 'RUB' NOT NULL,
	"weekStartDay" text DEFAULT 'monday' NOT NULL,
	"tagColors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installedViews" text[] DEFAULT '{}' NOT NULL,
	"pinnedEntities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"viewPreferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_origins" ADD CONSTRAINT "entity_origins_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_source_id_entities_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_target_id_entities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aspect_definitions_builtin_uniq" ON "aspect_definitions" USING btree ("id") WHERE "aspect_definitions"."owner_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "aspect_definitions_custom_uniq" ON "aspect_definitions" USING btree ("owner_id","id") WHERE "aspect_definitions"."owner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_threads_global_uniq" ON "chat_threads" USING btree ("owner_id") WHERE "chat_threads"."entity_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_threads_entity_uniq" ON "chat_threads" USING btree ("owner_id","entity_id") WHERE "chat_threads"."entity_id" IS NOT NULL;