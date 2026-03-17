CREATE TABLE "aspect_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"namespace" text NOT NULL,
	"schema" jsonb NOT NULL,
	"ai_instructions" text,
	"tag_mappings" text[] DEFAULT '{}'::text[] NOT NULL,
	"aggregations" jsonb DEFAULT '{}'::jsonb,
	"view_config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"emoji" text,
	"body" text DEFAULT '' NOT NULL,
	"body_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"aspects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_relations" UNIQUE("source_id","target_id","relation_type"),
	CONSTRAINT "no_self_relation" CHECK ("relations"."source_id" != "relations"."target_id")
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"last_sync_at" timestamp with time zone NOT NULL,
	"entity_count" integer,
	"conflicts" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"default_currency" text DEFAULT 'RUB' NOT NULL,
	"week_start_day" text DEFAULT 'monday' NOT NULL,
	"aspect_statuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tag_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_views" text[] DEFAULT '{}'::text[] NOT NULL,
	"pinned_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_strip_metrics" jsonb DEFAULT '[]'::jsonb,
	"view_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_source_id_entities_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_target_id_entities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_entities_user_updated" ON "entities" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_entities_tags" ON "entities" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "idx_entities_aspects" ON "entities" USING gin ("aspects");--> statement-breakpoint
CREATE INDEX "idx_entities_meta" ON "entities" USING gin ("meta");--> statement-breakpoint
CREATE INDEX "idx_entities_body_refs" ON "entities" USING gin ("body_refs");--> statement-breakpoint
CREATE INDEX "idx_entities_archived" ON "entities" USING btree ("user_id","archived");--> statement-breakpoint
CREATE INDEX "idx_relations_source" ON "relations" USING btree ("source_id","relation_type");--> statement-breakpoint
CREATE INDEX "idx_relations_target" ON "relations" USING btree ("target_id","relation_type");