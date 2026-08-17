CREATE TABLE "entity_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"label" text NOT NULL,
	"body" text NOT NULL,
	"body_doc" jsonb,
	"actor_user_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_versions_entity_created" ON "entity_versions" USING btree ("entity_id","created_at" DESC NULLS LAST);