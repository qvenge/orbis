CREATE TABLE "file_assets" (
	"graph_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text,
	"byte_size" integer,
	"sha256" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "file_assets_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "file_assets_graph_id_key" UNIQUE("graph_id","id"),
	CONSTRAINT "file_assets_state" CHECK ("file_assets"."state" IN ('staging','ready','deleting','deleted')),
	CONSTRAINT "file_assets_verified" CHECK ("file_assets"."state" <> 'ready' OR ("file_assets"."media_type" IS NOT NULL AND "file_assets"."byte_size" IS NOT NULL AND "file_assets"."sha256" IS NOT NULL)),
	CONSTRAINT "file_assets_size" CHECK ("file_assets"."byte_size" >= 0),
	CONSTRAINT "file_assets_hash" CHECK ("file_assets"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "file_assets_generation" CHECK ("file_assets"."delete_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "file_commands" (
	"graph_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"grant_id" uuid,
	"request" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "file_commands_pkey" PRIMARY KEY("graph_id","id")
);
--> statement-breakpoint
CREATE TABLE "file_holds" (
	"graph_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "file_holds_pkey" PRIMARY KEY("graph_id","file_id","source_kind","source_key"),
	CONSTRAINT "file_holds_temporary" CHECK ("file_holds"."source_kind" NOT IN ('read','export') OR "file_holds"."expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "file_upload_parts" (
	"graph_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "file_upload_parts_pkey" PRIMARY KEY("graph_id","upload_id","offset"),
	CONSTRAINT "file_upload_parts_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "file_upload_parts_extent" CHECK ("file_upload_parts"."byte_size" > 0 AND "file_upload_parts"."offset" >= 0),
	CONSTRAINT "file_upload_parts_hash" CHECK ("file_upload_parts"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "file_uploads" (
	"graph_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"owner_actor" uuid NOT NULL,
	"owner_grant_id" uuid,
	"declared_size" integer NOT NULL,
	"declared_type" text,
	"state" text NOT NULL,
	"chunk_bytes" integer NOT NULL,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "file_uploads_pkey" PRIMARY KEY("graph_id","id"),
	CONSTRAINT "file_uploads_asset_key" UNIQUE("graph_id","file_id"),
	CONSTRAINT "file_uploads_state" CHECK ("file_uploads"."state" IN ('open','finishing','ready','expired','failed')),
	CONSTRAINT "file_uploads_progress" CHECK ("file_uploads"."next_offset" BETWEEN 0 AND "file_uploads"."declared_size" AND "file_uploads"."chunk_bytes" > 0 AND "file_uploads"."generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "action_journal" ADD COLUMN "body_format" smallint;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "body_format" smallint;--> statement-breakpoint
ALTER TABLE "entity_versions" ADD COLUMN "body_format" smallint;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_commands" ADD CONSTRAINT "file_commands_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_holds" ADD CONSTRAINT "file_holds_asset_fk" FOREIGN KEY ("graph_id","file_id") REFERENCES "public"."file_assets"("graph_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_upload_parts" ADD CONSTRAINT "file_upload_parts_upload_fk" FOREIGN KEY ("graph_id","upload_id") REFERENCES "public"."file_uploads"("graph_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_uploads" ADD CONSTRAINT "file_uploads_asset_fk" FOREIGN KEY ("graph_id","file_id") REFERENCES "public"."file_assets"("graph_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_assets_cleanup" ON "file_assets" USING btree ("graph_id","state");--> statement-breakpoint
CREATE INDEX "file_holds_source" ON "file_holds" USING btree ("graph_id","source_kind","source_key");--> statement-breakpoint
CREATE INDEX "file_uploads_expiry" ON "file_uploads" USING btree ("graph_id","state","expires_at");
--> statement-breakpoint
-- Inherit existing graph policies in server transactions. PostgREST can select authenticated
-- but cannot SET this sibling server role or inherit its privileges.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='orbis_files') THEN
    CREATE ROLE orbis_files NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='orbis_files' AND rolinherit AND
    NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
      WHERE m.member='orbis_files'::regrole AND r.rolname <> 'authenticated')
    OR EXISTS (SELECT FROM unnest(ARRAY['anon','authenticated','service_role','authenticator']) AS roles(r)
      WHERE pg_has_role(r,'orbis_files','MEMBER'))
  THEN
    RAISE EXCEPTION 'unexpected privileges for attachment transaction role';
  END IF;
  EXECUTE pg_catalog.format('GRANT orbis_files TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;
--> statement-breakpoint
GRANT authenticated TO orbis_files WITH INHERIT TRUE, SET FALSE;
--> statement-breakpoint
GRANT orbis_files TO orbis_app WITH SET TRUE, INHERIT FALSE;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  readable text := '(graph_id = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()))';
  writable text := '(graph_id = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))';
  can_change text;
  can_lock text;
BEGIN
  FOREACH t IN ARRAY ARRAY['file_assets','file_uploads','file_upload_parts','file_holds','file_commands'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role, orbis_app',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO orbis_files',t);
    can_change := writable;
    IF t='file_holds' THEN
      can_change := format('(%s OR (%s AND source_kind IN (''read'',''export'') AND expires_at IS NOT NULL))',writable,readable);
    END IF;
    -- FOR UPDATE requires a matching UPDATE USING policy even when the holder will only read.
    -- WITH CHECK still requires writer privileges to change the asset.
    can_lock := CASE WHEN t='file_assets' THEN readable ELSE can_change END;
    EXECUTE format('CREATE POLICY graph_select ON public.%I FOR SELECT TO orbis_files USING (%s)',t,readable);
    EXECUTE format('CREATE POLICY graph_insert ON public.%I FOR INSERT TO orbis_files WITH CHECK (%s)',t,can_change);
    EXECUTE format('CREATE POLICY graph_update ON public.%I FOR UPDATE TO orbis_files USING (%s) WITH CHECK (%s)',t,can_lock,can_change);
    EXECUTE format('CREATE POLICY graph_delete ON public.%I FOR DELETE TO orbis_files USING (%s)',t,can_change);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.file_original_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF (NEW.graph_id,NEW.id,NEW.name,NEW.object_key) IS DISTINCT FROM (OLD.graph_id,OLD.id,OLD.name,OLD.object_key)
    OR (OLD.state <> 'staging' AND (
      (NEW.byte_size,NEW.sha256,NEW.media_type) IS DISTINCT FROM (OLD.byte_size,OLD.sha256,OLD.media_type)
      OR NEW.state='staging'))
    OR (OLD.state='deleting' AND NEW.state NOT IN ('deleting','deleted'))
    OR (OLD.state='deleted' AND NEW.state <> 'deleted')
    OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
  THEN
    RAISE EXCEPTION 'immutable original or closed file' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER file_asset_immutable BEFORE UPDATE ON public.file_assets
FOR EACH ROW EXECUTE FUNCTION public.file_original_immutable();
--> statement-breakpoint
-- Identical Markdown has different meaning across the v3/v4 boundary. Keep the body
-- revision/Undo stamp atomic for this change too, including Markdown-only historical rows.
CREATE OR REPLACE FUNCTION public.entities_body_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.body_revision := 1;
  ELSIF (OLD.body, OLD.body_doc, OLD.body_format) IS DISTINCT FROM (NEW.body, NEW.body_doc, NEW.body_format) THEN
    NEW.body_revision := OLD.body_revision + 1;
  ELSE
    RETURN NEW;
  END IF;
  NEW.body_action_id := NULLIF(pg_catalog.current_setting('orbis.body_action', true), '')::uuid;
  NEW.body_changed_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER entities_body_stamp ON public.entities;
--> statement-breakpoint
CREATE TRIGGER entities_body_stamp BEFORE INSERT OR UPDATE OF body, body_doc, body_format ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.entities_body_stamp();
