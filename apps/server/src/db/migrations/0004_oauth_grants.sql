CREATE TABLE "agent_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" text,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"scope" text DEFAULT 'full' NOT NULL,
	"code_hash" text,
	"code_challenge" text,
	"code_expires_at" timestamp with time zone,
	"code_used_at" timestamp with time zone,
	"redirect_uri" text,
	"access_hash" text,
	"access_expires_at" timestamp with time zone,
	"refresh_hash" text,
	"refresh_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_grants_kind" CHECK ("agent_grants"."kind" IN ('oauth','pat'))
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_access_hash" ON "agent_grants" USING btree ("access_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_refresh_hash" ON "agent_grants" USING btree ("refresh_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grants_code_hash" ON "agent_grants" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "agent_grants_owner" ON "agent_grants" USING btree ("owner_id");