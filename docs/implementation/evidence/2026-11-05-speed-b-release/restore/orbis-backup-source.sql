--
-- PostgreSQL database dump
--

\restrict gzZeUnLKwfzvSrkYyMYQ9Xi1HoV96Ah3bMzE3y97cwKeDOYdOvInRLoA7rpRH7z

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: actor_owns_current_graph(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actor_owns_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind = 'owner');
END $$;


--
-- Name: actor_reads_current_graph(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actor_reads_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL);
END $$;


--
-- Name: actor_writes_current_graph(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actor_writes_current_graph() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind IN ('owner','operator'));
END $$;


--
-- Name: current_graph_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_graph_id() RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
	RETURN (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph')::uuid;
END $$;


--
-- Name: entities_body_stamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entities_body_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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
END $$;


--
-- Name: graph_members_keep_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graph_members_keep_owner() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
	-- Замок строки графа сериализует параллельные отзывы. FOR NO KEY UPDATE, а не FOR UPDATE:
	-- тот конфликтует с FK-замком (KEY SHARE) каждой записи строк графа.
	PERFORM 1 FROM public.graphs g WHERE g.id = OLD.graph_id FOR NO KEY UPDATE;
	IF NOT FOUND THEN
		RETURN NULL; -- граф снесён вместе с членством: проверять нечего
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = OLD.graph_id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'у графа % не осталось действующего гранта owner (И-1)', OLD.graph_id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;


--
-- Name: graphs_require_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.graphs_require_owner() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = NEW.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'граф % создан без действующего гранта owner (И-1)', NEW.id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;


--
-- Name: orbis_capture_change_feed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orbis_capture_change_feed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE
  source_table text := TG_TABLE_NAME;
  event_kind text;
  match_key text := 'o.id = n.id';
  presence_key text := 'id';
  -- Проекция одной стороны изменения: graph, row key, thread, affected, graph-wide.
  project text;
  pair_query text;
  is_body text := 'false';
  changed_graphs uuid[];
  global_reset boolean := TG_OP = 'TRUNCATE';
  xid xid8 := pg_catalog.pg_current_xact_id_if_assigned();
  event_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT global_reset THEN
    CASE source_table
      WHEN 'entities' THEN
        event_kind := 'entity';
        -- Сравниваем полный типизированный record с вычищенным whitelist. Новые колонки по
        -- умолчанию other. Не превращаем всё тело в JSON ради проверки неизменившихся полей.
        is_body := $sql$
          o.id IS NOT NULL AND n.id IS NOT NULL AND
          pg_catalog.jsonb_populate_record(ROW(o.*)::public.entities, cols.mask)
          IS NOT DISTINCT FROM
          pg_catalog.jsonb_populate_record(ROW(n.*)::public.entities, cols.mask)
        $sql$;
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id, pg_catalog.array_prepend((s.row_data).id, refs.entity_ids) AS entity_ids,
            refs.incomplete AS graph_wide
          FROM (VALUES (1)) anchor(n)
          CROSS JOIN LATERAL (
            SELECT CASE WHEN (s.row_data).graph_id = (s.other_side).graph_id THEN (s.other_side).body_refs
              ELSE '{}'::text[] END AS refs
          ) other_side
          CROSS JOIN LATERAL (
            SELECT CASE WHEN (s.row_data).body_refs = other_side.refs THEN '{}'::text[] ELSE ARRAY(
              SELECT pg_catalog.unnest((s.row_data).body_refs)
              EXCEPT SELECT pg_catalog.unnest(other_side.refs)
            ) END AS refs
          ) diff
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(candidate.id) FILTER (WHERE proof.same_graph), '{}'::uuid[]) AS entity_ids,
              coalesce(pg_catalog.bool_or(NOT proof.same_graph), false) AS incomplete
            FROM pg_catalog.unnest(diff.refs) changed(ref)
            CROSS JOIN LATERAL (
              SELECT CASE WHEN pg_catalog.pg_input_is_valid(changed.ref, 'uuid') THEN changed.ref::uuid END AS id
            ) candidate
            CROSS JOIN LATERAL (
              SELECT (candidate.id = (s.row_data).id OR
                public.orbis_feed_entity_graph(candidate.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
            ) proof
          ) refs
        $sql$;
      WHEN 'relations' THEN
        event_kind := 'relation';
        project := $sql$
          SELECT CASE WHEN proof.source_graph = proof.target_graph THEN proof.source_graph END AS graph_id,
            (s.row_data).id::text AS row_key, NULL::uuid AS thread_id,
            ARRAY[(s.row_data).source_id, (s.row_data).target_id] AS entity_ids, false AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.entities origin ON origin.id = (s.row_data).source_id
          LEFT JOIN public.entities destination ON destination.id = (s.row_data).target_id
          CROSS JOIN LATERAL (
            -- Если оба конца исчезли, применяем общий сброс по матрице источников.
            SELECT CASE WHEN origin.id IS NOT NULL OR destination.id IS NOT NULL THEN
              coalesce(origin.graph_id, public.orbis_feed_entity_graph((s.row_data).source_id, $1)) END AS source_graph,
              CASE WHEN origin.id IS NOT NULL OR destination.id IS NOT NULL THEN
              coalesce(destination.graph_id, public.orbis_feed_entity_graph((s.row_data).target_id, $1)) END AS target_graph
          ) proof
        $sql$;
      WHEN 'entity_versions' THEN
        event_kind := 'version';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[(s.row_data).entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            NOT proof.same_graph AS graph_wide
          FROM LATERAL (
            SELECT (public.orbis_feed_entity_graph((s.row_data).entity_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'chat_messages' THEN
        event_kind := 'message';
        project := $sql$
          SELECT thread.graph_id AS graph_id, (s.row_data).id::text AS row_key,
            (s.row_data).thread_id AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[thread.entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            thread.entity_id IS NOT NULL AND NOT proof.same_graph AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.chat_threads thread ON thread.id = (s.row_data).thread_id
          CROSS JOIN LATERAL (
            SELECT (public.orbis_feed_entity_graph(thread.entity_id, $1) = thread.graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'chat_threads' THEN
        event_kind := 'thread';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            (s.row_data).id AS thread_id,
            CASE WHEN proof.same_graph THEN ARRAY[(s.row_data).entity_id] ELSE '{}'::uuid[] END AS entity_ids,
            (s.row_data).entity_id IS NOT NULL AND NOT proof.same_graph AS graph_wide
          FROM LATERAL (
            SELECT (public.orbis_feed_entity_graph((s.row_data).entity_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
          ) proof
        $sql$;
      WHEN 'action_journal' THEN
        event_kind := 'journal';
        match_key := 'o.id = n.id AND o.graph_id = n.graph_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).id::text AS row_key,
            CASE WHEN parent.graph_id = (s.row_data).graph_id THEN (s.row_data).thread_id END AS thread_id,
            pg_catalog.array_append(resolved.entity_ids, CASE WHEN parent.anchor_ok THEN parent.entity_id END) AS entity_ids,
            resolved.incomplete OR ((s.row_data).thread_id IS NOT NULL
              AND (parent.graph_id IS DISTINCT FROM (s.row_data).graph_id OR parent.incomplete
                OR (parent.entity_id IS NOT NULL AND NOT parent.anchor_ok))) AS graph_wide
          FROM (VALUES (1)) anchor(n)
          LEFT JOIN public.chat_threads thread ON thread.id = (s.row_data).thread_id
          LEFT JOIN LATERAL (
            SELECT f.* FROM public.orbis_feed_last_event('thread', (s.row_data).thread_id::text, $1) f
            WHERE thread.id IS NULL AND f.operation = 'delete'
          ) old_thread ON true
          CROSS JOIN LATERAL (
            SELECT p.*, (p.graph_id = (s.row_data).graph_id AND
              public.orbis_feed_entity_graph(p.entity_id, $1) = p.graph_id) IS TRUE AS anchor_ok
            FROM (
              SELECT coalesce(thread.graph_id, old_thread.graph_id) AS graph_id,
                coalesce(thread.entity_id, old_thread.entity_ids[1]) AS entity_id,
                coalesce(old_thread.graph_wide, false) AS incomplete
            ) p
          ) parent
          CROSS JOIN LATERAL (
            SELECT coalesce(pg_catalog.array_agg(affected.id) FILTER (WHERE affected.same_graph), '{}'::uuid[]) AS entity_ids,
              coalesce(pg_catalog.bool_or(affected.same_graph IS NOT TRUE OR affected.id IS NULL), false) AS incomplete
            FROM (
              SELECT DISTINCT id
              FROM pg_catalog.unnest(pg_catalog.array_append((s.row_data).entity_ids, (s.row_data).entity_id)) ids(id)
              WHERE id IS NOT NULL
            ) refs
            LEFT JOIN LATERAL (
              SELECT (public.orbis_feed_entity_graph(refs.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
            ) entity ON true
            LEFT JOIN public.relations edge ON edge.id = refs.id AND NOT entity.same_graph
            CROSS JOIN LATERAL (
              SELECT (public.orbis_feed_entity_graph(edge.source_id, $1) = (s.row_data).graph_id
                AND public.orbis_feed_entity_graph(edge.target_id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
              OFFSET 0
            ) edge_proof
            LEFT JOIN LATERAL (
              SELECT f.* FROM public.orbis_feed_last_event('relation', refs.id::text, $1) f
              WHERE NOT entity.same_graph AND edge.id IS NULL AND f.operation = 'delete'
            ) old_edge ON true
            LEFT JOIN LATERAL (
              SELECT candidate.id, (public.orbis_feed_entity_graph(candidate.id, $1) = (s.row_data).graph_id) IS TRUE AS same_graph
              FROM (
                SELECT refs.id WHERE entity.same_graph
                UNION
                SELECT pg_catalog.unnest(ARRAY[edge.source_id, edge.target_id])
                WHERE edge_proof.same_graph
                UNION
                SELECT pg_catalog.unnest(f.entity_ids)
                FROM public.change_feed f
                WHERE f.kind = 'relation' AND f.tx_id = $1 AND f.row_key = refs.id::text
                  AND f.graph_id = (s.row_data).graph_id
                  AND (old_edge.graph_id = (s.row_data).graph_id OR edge_proof.same_graph)
              ) candidate
            ) affected ON true
          ) resolved
        $sql$;
      WHEN 'user_settings' THEN
        event_kind := 'settings';
        presence_key := 'graph_id';
        match_key := 'o.graph_id = n.graph_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id, (s.row_data).graph_id::text AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'registry_deltas' THEN
        event_kind := 'registry';
        match_key := 'o.graph_id = n.graph_id AND o.target_kind = n.target_kind AND o.target_id = n.target_id';
        project := $sql$
          SELECT (s.row_data).graph_id AS graph_id,
            'registry_deltas:' || (s.row_data).target_kind || ':' || (s.row_data).target_id AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'registry_system' THEN
        event_kind := 'registry';
        project := $sql$
          SELECT NULL::uuid AS graph_id, (s.row_data).id::text AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$;
      WHEN 'aspect_definitions', 'property_definitions', 'relation_role_definitions',
           'contract_definitions', 'subscription_definitions', 'action_definitions' THEN
        event_kind := 'registry';
        -- Эквивалент graph_id IS NOT DISTINCT FROM, но целиком hashable для FULL JOIN.
        -- Отдельный бит NULL отличает даже гипотетический граф с нулевым UUID.
        match_key := $sql$
          o.id = n.id AND (o.graph_id IS NULL) = (n.graph_id IS NULL)
          AND coalesce(o.graph_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(n.graph_id, '00000000-0000-0000-0000-000000000000'::uuid)
        $sql$;
        project := pg_catalog.format($sql$
          SELECT (s.row_data).graph_id AS graph_id, %L || (s.row_data).id AS row_key,
            NULL::uuid AS thread_id, '{}'::uuid[] AS entity_ids, false AS graph_wide
        $sql$, source_table || ':');
      ELSE
        RAISE EXCEPTION 'unexpected feed source: %', source_table;
    END CASE;

    -- Имена transition relations фиксированы. В SQL подставляются только литералы выше
    -- и идентификатор проверенной таблицы, никогда содержимое записей.
    CASE TG_OP
      WHEN 'INSERT' THEN
        pair_query := pg_catalog.format($sql$
          SELECT NULL::public.%1$I AS old_row, ROW(n.*)::public.%1$I AS new_row,
            false AS has_old, true AS has_new, false AS body
          FROM feed_new n
        $sql$, source_table);
      WHEN 'DELETE' THEN
        pair_query := pg_catalog.format($sql$
          SELECT ROW(o.*)::public.%1$I AS old_row, NULL::public.%1$I AS new_row,
            true AS has_old, false AS has_new, false AS body
          FROM feed_old o
        $sql$, source_table);
      WHEN 'UPDATE' THEN
        pair_query := pg_catalog.format($sql$
          SELECT ROW(o.*)::public.%1$I AS old_row, ROW(n.*)::public.%1$I AS new_row,
            o.%2$I IS NOT NULL AS has_old, n.%2$I IS NOT NULL AS has_new, (%3$s) AS body
          FROM feed_old o FULL JOIN feed_new n ON %4$s
          CROSS JOIN (VALUES ('{"body":null,"body_doc":null,"body_before_doc":null,"body_refs":null,
            "query_refs":null,"body_revision":null,"body_action_id":null,"body_changed_at":null,
            "updated_at":null}'::jsonb)) cols(mask)
          WHERE o IS DISTINCT FROM n
        $sql$, source_table, presence_key, is_body, match_key);
      ELSE
        RAISE EXCEPTION 'unexpected feed trigger operation: %', TG_OP;
    END CASE;

    EXECUTE pg_catalog.format($sql$
      WITH pairs AS (
        SELECT row_number() OVER () AS pair, matched.* FROM (%1$s) matched
      ), sides AS (
        SELECT pair, old_row AS row_data, new_row AS other_side, false AS is_new, body
          FROM pairs WHERE has_old
        UNION ALL
        SELECT pair, new_row, old_row, true, body FROM pairs WHERE has_new
      ), events AS (
        SELECT s.pair, p.graph_id, p.row_key, p.thread_id,
          CASE WHEN pg_catalog.bool_and(s.is_new) THEN 'insert'
               WHEN NOT pg_catalog.bool_or(s.is_new) THEN 'delete' ELSE 'update' END AS operation,
          CASE WHEN pg_catalog.bool_or(s.is_new) AND NOT pg_catalog.bool_and(s.is_new)
                 AND pg_catalog.bool_and(s.body) THEN 'body' ELSE 'other' END AS scope,
          coalesce(pg_catalog.array_agg(DISTINCT affected.id ORDER BY affected.id)
            FILTER (WHERE affected.id IS NOT NULL), '{}'::uuid[]) AS entity_ids,
          pg_catalog.bool_or(p.graph_wide) AS graph_wide
        FROM sides s
        CROSS JOIN LATERAL (%2$s) p
        LEFT JOIN LATERAL pg_catalog.unnest(p.entity_ids) affected(id) ON true
        GROUP BY s.pair, p.graph_id, p.row_key, p.thread_id
      ), inserted AS (
        INSERT INTO public.change_feed (tx_id, graph_id, kind, row_key, entity_ids, thread_id,
            operation, scope, at, graph_wide)
          SELECT $1, graph_id, %3$L, row_key, entity_ids, thread_id, operation, scope, $2, graph_wide
          FROM events WHERE graph_id IS NOT NULL
          -- При переносе одного ключа synthetic DELETE предшествует INSERT. Поэтому latest
          -- DELETE исчезнувшего родителя не спутать со старой стороной переноса.
          ORDER BY pair, operation
          RETURNING graph_id
      )
      SELECT ARRAY(SELECT DISTINCT graph_id FROM inserted),
        EXISTS (SELECT FROM events WHERE graph_id IS NULL)
    $sql$, pair_query, project, event_kind)
    INTO changed_graphs, global_reset USING xid, event_at;

    PERFORM pg_catalog.pg_notify('orbis_changes',
      pg_catalog.jsonb_build_object('graphId', g.id, 'txId', xid::text)::text)
      FROM pg_catalog.unnest(changed_graphs) g(id);
  END IF;

  IF global_reset THEN
    xid := pg_catalog.pg_current_xact_id();
    UPDATE public.change_feed_floor SET floor = greatest(floor, ((xid::text::numeric + 1)::text)::xid8)
      WHERE id = 1 AND floor <= xid;
    PERFORM pg_catalog.pg_notify('orbis_changes', pg_catalog.jsonb_build_object('txId', xid::text)::text);
  END IF;
  RETURN NULL;
END $_$;


--
-- Name: orbis_feed_entity_graph(uuid, xid8); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) RETURNS uuid
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT coalesce(
    (SELECT e.graph_id FROM public.entities e WHERE e.id = entity_id),
    (SELECT f.graph_id FROM public.orbis_feed_last_event('entity', entity_id::text, xid) f
      WHERE f.operation = 'delete')
  )
$$;


--
-- Name: orbis_feed_last_event(text, text, xid8); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) RETURNS TABLE(graph_id uuid, operation text, entity_ids uuid[], graph_wide boolean)
    LANGUAGE sql STABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  SELECT f.graph_id, f.operation, f.entity_ids, f.graph_wide
  FROM public.change_feed f
  WHERE f.tx_id = xid AND f.kind = event_kind AND f.row_key = event_key
    AND f.kind IN ('entity','thread','relation')
  ORDER BY f.id DESC LIMIT 1
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: action_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    params jsonb,
    precondition jsonb,
    steps jsonb,
    sensitivity jsonb,
    offered_by jsonb,
    module text,
    batch_cap integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    over jsonb,
    CONSTRAINT action_definitions_status CHECK ((status = ANY (ARRAY['active'::text, 'deprecated'::text])))
);

ALTER TABLE ONLY public.action_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: action_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_journal (
    graph_id uuid NOT NULL,
    id uuid NOT NULL,
    created_at timestamp(3) with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    entity_id uuid,
    actor_user_id uuid NOT NULL,
    actor_kind text NOT NULL,
    source text NOT NULL,
    mechanism text NOT NULL,
    actor_grant_id uuid,
    run_id uuid,
    action_id text,
    module text,
    edited_from uuid,
    thread_id uuid,
    title text NOT NULL,
    card_tool text NOT NULL,
    entity_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    operations jsonb NOT NULL,
    inverse jsonb NOT NULL,
    results jsonb,
    text_session boolean DEFAULT false NOT NULL,
    body_before jsonb,
    undoes uuid,
    pinned_version_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    card_in_reply boolean DEFAULT false NOT NULL,
    CONSTRAINT action_journal_undo_shape CHECK (((type = 'undo'::text) = (undoes IS NOT NULL)))
);

ALTER TABLE ONLY public.action_journal FORCE ROW LEVEL SECURITY;


--
-- Name: action_journal_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_journal_entities (
    graph_id uuid NOT NULL,
    action_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    created_at timestamp(3) with time zone NOT NULL
);

ALTER TABLE ONLY public.action_journal_entities FORCE ROW LEVEL SECURITY;


--
-- Name: agent_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_grants (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    client_id text,
    kind text NOT NULL,
    label text NOT NULL,
    scope text DEFAULT 'full'::text NOT NULL,
    code_hash text,
    code_challenge text,
    code_expires_at timestamp with time zone,
    code_used_at timestamp with time zone,
    redirect_uri text,
    access_hash text,
    access_expires_at timestamp with time zone,
    refresh_hash text,
    refresh_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    prev_refresh_hash text,
    issued_by uuid NOT NULL,
    CONSTRAINT agent_grants_kind CHECK ((kind = ANY (ARRAY['oauth'::text, 'pat'::text])))
);

ALTER TABLE ONLY public.agent_grants FORCE ROW LEVEL SECURITY;


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    graph_id uuid NOT NULL,
    date date NOT NULL,
    model text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    request_count integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.ai_usage FORCE ROW LEVEL SECURITY;


--
-- Name: aspect_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aspect_definitions (
    id text NOT NULL,
    graph_id uuid,
    description jsonb NOT NULL,
    ai_instructions text,
    tag_mappings text[] DEFAULT '{}'::text[] NOT NULL,
    aggregations jsonb DEFAULT '{}'::jsonb,
    view_config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key text NOT NULL,
    label jsonb NOT NULL,
    properties jsonb DEFAULT '[]'::jsonb NOT NULL,
    implements jsonb DEFAULT '[]'::jsonb NOT NULL,
    module text,
    service boolean DEFAULT false NOT NULL,
    rank integer DEFAULT 0 NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL
);

ALTER TABLE ONLY public.aspect_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: change_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_feed (
    id bigint NOT NULL,
    tx_id xid8 NOT NULL,
    graph_id uuid NOT NULL,
    kind text NOT NULL,
    row_key text NOT NULL,
    entity_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    thread_id uuid,
    operation text NOT NULL,
    scope text NOT NULL,
    at timestamp with time zone NOT NULL,
    graph_wide boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.change_feed FORCE ROW LEVEL SECURITY;


--
-- Name: change_feed_floor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_feed_floor (
    id smallint NOT NULL,
    floor xid8 NOT NULL,
    CONSTRAINT change_feed_floor_singleton CHECK ((id = 1))
);

ALTER TABLE ONLY public.change_feed_floor FORCE ROW LEVEL SECURITY;


--
-- Name: change_feed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.change_feed ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.change_feed_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.chat_messages FORCE ROW LEVEL SECURITY;


--
-- Name: chat_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_threads (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid,
    title text,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.chat_threads FORCE ROW LEVEL SECURITY;


--
-- Name: contract_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    kind text NOT NULL,
    slots jsonb,
    classes jsonb,
    sets jsonb,
    facts jsonb,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    exclusive_classes boolean DEFAULT false NOT NULL,
    CONSTRAINT contract_definitions_kind CHECK ((kind = ANY (ARRAY['slots'::text, 'facts'::text])))
);

ALTER TABLE ONLY public.contract_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    title text NOT NULL,
    emoji text,
    body text DEFAULT ''::text NOT NULL,
    body_refs text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    body_doc jsonb,
    body_before_doc text,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    aspects text[] DEFAULT '{}'::text[] NOT NULL,
    query_refs text[] DEFAULT '{}'::text[] NOT NULL,
    body_revision integer DEFAULT 1 NOT NULL,
    body_action_id uuid,
    body_changed_at timestamp(3) with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entities FORCE ROW LEVEL SECURITY;


--
-- Name: entity_origins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_origins (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    namespace text NOT NULL,
    external_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entity_origins FORCE ROW LEVEL SECURITY;


--
-- Name: entity_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_versions (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    label text NOT NULL,
    body text NOT NULL,
    body_doc jsonb,
    actor_user_id uuid NOT NULL,
    actor_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.entity_versions FORCE ROW LEVEL SECURITY;


--
-- Name: envelope_spent_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.envelope_spent_cache (
    envelope_id uuid NOT NULL,
    graph_id uuid NOT NULL,
    as_of date NOT NULL,
    spent numeric NOT NULL,
    owner_version integer NOT NULL,
    system_version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.envelope_spent_cache FORCE ROW LEVEL SECURITY;


--
-- Name: graph_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_members (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    account_id uuid NOT NULL,
    grant_kind text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by uuid NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT graph_members_grant_kind CHECK ((grant_kind = ANY (ARRAY['owner'::text, 'operator'::text, 'observer'::text])))
);

ALTER TABLE ONLY public.graph_members FORCE ROW LEVEL SECURITY;


--
-- Name: graphs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graphs (
    id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_ref uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT graphs_owner_kind CHECK ((owner_kind = ANY (ARRAY['person'::text, 'organization'::text]))),
    CONSTRAINT graphs_personal_identity CHECK ((((owner_kind = 'person'::text) AND (owner_ref IS NOT NULL) AND (id = owner_ref)) OR (owner_kind = 'organization'::text)))
);

ALTER TABLE ONLY public.graphs FORCE ROW LEVEL SECURITY;


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    client_name text NOT NULL,
    redirect_uris text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.oauth_clients FORCE ROW LEVEL SECURITY;


--
-- Name: perf_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.perf_samples (
    id bigint NOT NULL,
    account_id uuid DEFAULT auth.uid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metric text NOT NULL,
    screen text,
    kind text,
    procedure text,
    dur_ms real NOT NULL,
    server_ms real,
    db_ms real,
    device text NOT NULL,
    net text,
    app_version text NOT NULL,
    cached boolean
);

ALTER TABLE ONLY public.perf_samples FORCE ROW LEVEL SECURITY;


--
-- Name: perf_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.perf_samples ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.perf_samples_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: property_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    type jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    storage text DEFAULT 'props'::text NOT NULL,
    scope jsonb,
    merged_into text,
    module text,
    rank integer NOT NULL,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT property_definitions_status CHECK ((status = ANY (ARRAY['active'::text, 'proposed'::text, 'deprecated'::text]))),
    CONSTRAINT property_definitions_storage CHECK ((storage = ANY (ARRAY['props'::text, 'core'::text])))
);

ALTER TABLE ONLY public.property_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: registry_deltas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registry_deltas (
    id uuid NOT NULL,
    graph_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    base_version integer NOT NULL,
    delta jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT registry_deltas_target_kind CHECK ((target_kind = ANY (ARRAY['property'::text, 'aspect'::text, 'contract'::text, 'relation_role'::text, 'subscription'::text, 'action'::text])))
);

ALTER TABLE ONLY public.registry_deltas FORCE ROW LEVEL SECURITY;


--
-- Name: registry_system; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registry_system (
    id smallint NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    seeded_at timestamp with time zone,
    CONSTRAINT registry_system_singleton CHECK ((id = 1))
);

ALTER TABLE ONLY public.registry_system FORCE ROW LEVEL SECURITY;


--
-- Name: relation_role_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relation_role_definitions (
    id text NOT NULL,
    graph_id uuid,
    key text NOT NULL,
    label jsonb NOT NULL,
    description jsonb NOT NULL,
    source_label jsonb NOT NULL,
    target_label jsonb NOT NULL,
    hierarchical boolean DEFAULT false NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    "symmetric" boolean DEFAULT false NOT NULL,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL
);

ALTER TABLE ONLY public.relation_role_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relations (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    target_id uuid NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text NOT NULL,
    CONSTRAINT rel_no_self CHECK ((source_id <> target_id))
);

ALTER TABLE ONLY public.relations FORCE ROW LEVEL SECURITY;


--
-- Name: subscription_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_definitions (
    id text NOT NULL,
    graph_id uuid,
    surface text NOT NULL,
    definition jsonb NOT NULL,
    module text,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.subscription_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    graph_id uuid NOT NULL,
    plan text DEFAULT 'dev'::text NOT NULL,
    timezone text DEFAULT 'Europe/Moscow'::text NOT NULL,
    "defaultCurrency" text DEFAULT 'RUB'::text NOT NULL,
    "weekStartDay" text DEFAULT 'monday'::text NOT NULL,
    "tagColors" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "installedViews" text[] DEFAULT '{}'::text[] NOT NULL,
    "pinnedEntities" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "viewPreferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    registry_version integer DEFAULT 0 NOT NULL,
    disabled_modules text[] DEFAULT '{}'::text[] NOT NULL
);

ALTER TABLE ONLY public.user_settings FORCE ROW LEVEL SECURITY;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;
1	749b8a1e6ccda8a683a003f6ae3e396b3f07b6ea69671a1738230610183f157e	1783095811450
2	a75fb85699a23af5d4faa15d1a64132157a2ff76d56af7a035dc88bfcdabab15	1783156220278
3	eaa7b7a218876d3a5e91f044557dde5d7fa01c088ec4fa8e86ffde7fe4c6b965	1783182443251
4	def69ef0d2a6275d9f237f4e2061f1e98a0aa3512518f2fb4d13d043f5c838b5	1783583276549
5	7a6905b532c392967165c4fa96fe4b19c2b7819e2c3f098697051652cfc0365d	1786438585239
6	372e466e6be933ad3924093529e88f2b3216f65d291ad8f8a4cd6df76d9b66d0	1786438800000
7	2ca9349cf6eac60441c338882969c5b96fbed02182f6210131e77a12f355f091	1786441012985
8	56e71a3bad1b60b6731a488816bc6e0f25aea801f0c0b432667c236b8f38518c	1786705532268
9	33b767410324aa0e41598a20124110b1fd1da4f35589f6dfa07e33b98aada077	1786896217311
10	38e901a95d26e851e29ac99cb4c1c27467ec526bd6b56cfc7f150a8529e91302	1786992056804
11	4d6eee1c1c6ff53e89831d9f13a3a8cb07a258e805c21a26d1557750fe75541a	1786992060000
12	b29ccb88d9557ba9ac6a2ec932fca38488fb736a66656cf52ad502eca1260e55	1787055003882
13	f555dd3b7a2c66e8d8ed58140a3b277dbe9ccb2fd781ed088b993f73a3632d4d	1787706313929
14	ba2ec0e88c44287a0786e9285f09b69b77b789daeb90f9f31bf5d8b543ee9aef	1787711664406
15	69889c5c74d3beb30a60d9504516eeef30a11c60328bc4f7f77e95462fb64b7f	1787773459922
16	f161bc8f36814ad1f9c11957201f4b992fc2f88b91aa1ae4bba49804a64af0f1	1788310269557
17	e9313816039629c3b78ebe9a29805b06bd4d1c461fc1763529ea1b41a13a3565	1788857561166
18	9bac5fa7eb3d73fe95cef21c3a4f5065daa7a92ccbd9fec31d1c4361bcaf5a66	1789926653298
19	ad520a8a8cc2bd242512677d8560cc46692da59bb058a2a89c57e8c1e111ed81	1789931702726
20	8b37a2555d9c6321a537ea475ecc655f0bb945f51443f92916e061145c601942	1789953511990
21	8c262c478417bd72dbbfe55bf35ebd5c57fb180f21924bdcd92754eafaea5be6	1790106081535
22	0b00cda29564dfcefe7768cb1dd08e820c64cb439a80b79eaa34c1eceaf3fa33	1790680990543
23	934016f5de375db207e19da45a73587d6a39875aba50d55eab319d3d2e8a466b	1790737115410
24	ba0d5c01bc8798d8cdbfd25ee9edae5cbd47d68bda506de95704282af9446f24	1790754551426
25	7794f4316767a6917fe3240776a82cf9256f71d13782c2e7afcb4e7ab8bb2383	1790767973713
26	346bff6373b4491c18006aa8deb99630ce99cd34b6883a413c0587f82f345ac0	1793710145542
\.


--
-- Data for Name: action_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.action_definitions (id, graph_id, key, label, description, params, precondition, steps, sensitivity, offered_by, module, batch_cap, created_at, rank, status, over) FROM stdin;
finance/plan-to-fact	\N	finance/plan-to-fact	{"en": "Plan to fact", "ru": "План → факт"}	{"en": "Mark a planned money movement as actual: clear the plan flag and set the date.", "ru": "Отметить запланированное движение денег как случившееся: снять признак плана и проставить дату."}	[{"name": "occurred_on", "type": {"kind": "date"}, "required": true}]	{"op": "and", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/money-movement"}}, {"const": ["outflow", "inflow"]}]}, {"op": "not", "args": [{"op": "=", "args": [{"prop": "orbis/archived"}, {"const": true}]}]}, {"op": "=", "args": [{"prop": "orbis/planned"}, {"const": true}]}, {"op": "not", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/recurrence"}}, {"const": ["template"]}]}]}, {"op": "not", "args": [{"has_relation": {"role": "instance-of"}}]}]}	[{"tool": "entity_update", "input": {"id": {"$expr": {"ctx": "$self"}}, "props": {"orbis/planned": false, "orbis/occurred_on": {"$expr": {"param": "occurred_on"}}}}}]	["touches_money"]	[]	finance	\N	2026-11-05 02:11:06.091183+00	0	active	\N
planner/postpone_overdue	\N	core/postpone_overdue	{"en": "Postpone overdue", "ru": "Отложить просроченные"}	{"en": "Move the due date of every overdue open task to a given date.", "ru": "Перенести срок всех просроченных открытых задач на указанную дату."}	[{"name": "to", "type": {"kind": "date"}, "required": true}]	\N	[{"tool": "entity_update", "input": {"id": {"$expr": {"ctx": "$self"}}, "props": {"orbis/due_date": {"$expr": {"param": "to"}}}}}]	[]	[{"llm": true}]	\N	100	2026-11-05 02:11:06.099416+00	1	active	{"filter": {"and": [{"aspect": "orbis/task"}, {"class": {"set": "open", "contract": "orbis/completable"}}, {"op": "lt", "prop": "orbis/due_date", "value": {"token": "today"}}]}}
\.


--
-- Data for Name: action_journal; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.action_journal (graph_id, id, created_at, type, entity_id, actor_user_id, actor_kind, source, mechanism, actor_grant_id, run_id, action_id, module, edited_from, thread_id, title, card_tool, entity_ids, operations, inverse, results, text_session, body_before, undoes, pinned_version_ids, card_in_reply) FROM stdin;
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1e1-737c-b4ba-17d6b2b1fe17	2026-11-05 02:11:23.233+00	entity_created	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Restore A	entity_create	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	[{"op": "entity_create", "payload": {"id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "body": "Synthetic source body", "tags": [], "emoji": null, "props": {}, "title": "Restore A", "aspects": []}}]	[{"op": "entity_update", "payload": {"id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "archived": true}}]	\N	f	{}	\N	{}	f
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1fc-714b-8560-128a9ce0edff	2026-11-05 02:11:23.26+00	entity_created	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Restore A sibling	entity_create	{01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	[{"op": "entity_create", "payload": {"id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d", "body": "", "tags": [], "emoji": null, "props": {}, "title": "Restore A sibling", "aspects": []}}]	[{"op": "entity_update", "payload": {"id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d", "archived": true}}]	\N	f	{}	\N	{}	f
469c6a1e-320a-4d24-bdda-e8c070b816cd	01a1a979-a215-70f2-9dc9-a42d9276b1bf	2026-11-05 02:11:23.286+00	entity_created	01a1a979-a221-730f-929d-08113981f0e7	469c6a1e-320a-4d24-bdda-e8c070b816cd	owner	ui	user	\N	\N	\N	\N	\N	\N	Restore B	entity_create	{01a1a979-a221-730f-929d-08113981f0e7}	[{"op": "entity_create", "payload": {"id": "01a1a979-a221-730f-929d-08113981f0e7", "body": "Synthetic foreign graph", "tags": [], "emoji": null, "props": {}, "title": "Restore B", "aspects": []}}]	[{"op": "entity_update", "payload": {"id": "01a1a979-a221-730f-929d-08113981f0e7", "archived": true}}]	\N	f	{}	\N	{}	f
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a232-7153-99fc-fe3b00e97499	2026-11-05 02:11:23.314+00	relation_created	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Зависимость: «Restore A» → «Restore A sibling»	relation_create	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee,01a1a979-a24b-71ae-8d26-290310ab8624,01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	[{"op": "relation_create", "payload": {"id": "01a1a979-a24b-71ae-8d26-290310ab8624", "role": "dependency", "source_id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "target_id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d"}}]	[{"op": "relation_delete", "payload": {"role": "dependency", "source_id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "target_id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d"}}]	\N	f	{}	\N	{}	f
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a28b-749a-beca-01a177eae26c	2026-11-05 02:11:23.403+00	entity_updated	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Restore A	entity_update	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	[{"op": "entity_update", "payload": {"id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "textSession": true}}]	[{"op": "entity_update", "payload": {"id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee", "body": "Synthetic source body"}}]	\N	t	{"01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee": "01a1a979-a1e1-737c-b4ba-17d6b2b1fe17"}	\N	{}	f
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a2b4-73cf-9961-81eebeec3f77	2026-11-05 02:11:23.445+00	version_pinned	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Закреплена версия «Synthetic version»	entity_version_pin	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee,01a1a979-a2bf-72e3-95ae-70f910bfc1bb}	[{"op": "entity_version_pin", "payload": {"id": "01a1a979-a2bf-72e3-95ae-70f910bfc1bb", "label": "Synthetic version", "entity_id": "01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee"}}]	[{"op": "entity_version_delete", "payload": {"id": "01a1a979-a2bf-72e3-95ae-70f910bfc1bb"}}]	\N	f	{}	\N	{}	f
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-b18a-7555-a78d-7e23ee89f1b1	2026-11-05 02:11:27.242+00	entity_updated	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	ui	user	\N	\N	\N	\N	\N	\N	Restore A sibling	entity_update	{01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	[{"op": "entity_update", "payload": {"id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d", "textSession": true}}]	[{"op": "entity_update", "payload": {"id": "01a1a979-a207-726b-ac4a-4fb3a35c0b5d", "body": ""}}]	\N	t	{"01a1a979-a207-726b-ac4a-4fb3a35c0b5d": "01a1a979-a1fc-714b-8560-128a9ce0edff"}	\N	{}	f
\.


--
-- Data for Name: action_journal_entities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.action_journal_entities (graph_id, action_id, entity_id, created_at) FROM stdin;
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1e1-737c-b4ba-17d6b2b1fe17	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	2026-11-05 02:11:23.233+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1fc-714b-8560-128a9ce0edff	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	2026-11-05 02:11:23.26+00
469c6a1e-320a-4d24-bdda-e8c070b816cd	01a1a979-a215-70f2-9dc9-a42d9276b1bf	01a1a979-a221-730f-929d-08113981f0e7	2026-11-05 02:11:23.286+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a232-7153-99fc-fe3b00e97499	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	2026-11-05 02:11:23.314+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a232-7153-99fc-fe3b00e97499	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	2026-11-05 02:11:23.314+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a232-7153-99fc-fe3b00e97499	01a1a979-a24b-71ae-8d26-290310ab8624	2026-11-05 02:11:23.314+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a28b-749a-beca-01a177eae26c	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	2026-11-05 02:11:23.403+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a2b4-73cf-9961-81eebeec3f77	01a1a979-a2bf-72e3-95ae-70f910bfc1bb	2026-11-05 02:11:23.445+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a2b4-73cf-9961-81eebeec3f77	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	2026-11-05 02:11:23.445+00
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-b18a-7555-a78d-7e23ee89f1b1	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	2026-11-05 02:11:27.242+00
\.


--
-- Data for Name: agent_grants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.agent_grants (id, graph_id, client_id, kind, label, scope, code_hash, code_challenge, code_expires_at, code_used_at, redirect_uri, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at, last_used_at, revoked_at, prev_refresh_hash, issued_by) FROM stdin;
\.


--
-- Data for Name: ai_usage; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ai_usage (graph_id, date, model, input_tokens, output_tokens, request_count) FROM stdin;
\.


--
-- Data for Name: aspect_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.aspect_definitions (id, graph_id, description, ai_instructions, tag_mappings, aggregations, view_config, created_at, key, label, properties, implements, module, service, rank, rules) FROM stdin;
orbis/schedule	\N	{"en": "Binds an entity to time: an event, a meeting, a time-based deadline.", "ru": "Привязка записи ко времени: событие, встреча, дедлайн по времени."}	Применяй, когда во вводе есть дата или время события. orbis/start_at обязателен (ISO 8601 с таймзоной пользователя). orbis/recurrence задаётся только на шаблоне повторения; инстансы порождает сервер.	{schedule,event,meeting,appointment}	{}	{"icon": "📅", "keyFields": ["orbis/start_at", "orbis/end_at", "orbis/all_day"]}	2026-11-05 02:11:05.981955+00	orbis/schedule	{"en": "Schedule", "ru": "Расписание"}	[{"rank": 1, "required": true, "propertyId": "orbis/start_at"}, {"rank": 2, "required": false, "propertyId": "orbis/end_at"}, {"rank": 3, "required": false, "propertyId": "orbis/duration_min"}, {"rank": 4, "required": false, "propertyId": "orbis/all_day"}, {"rank": 5, "required": false, "propertyId": "orbis/recurrence"}, {"rank": 6, "required": false, "propertyId": "orbis/location"}, {"rank": 7, "required": false, "propertyId": "orbis/timezone"}]	[{"bind": {"end": "orbis/end_at", "moment": "orbis/start_at", "all_day": "orbis/all_day"}, "fixed": {}, "contract": "orbis/when", "value_map": []}, {"bind": {"template_marker": "orbis/recurrence"}, "fixed": {"origin_role": "instance-of"}, "contract": "orbis/recurrence", "value_map": [{"slot": "template_marker", "class": "template", "variant": "present"}, {"slot": "template_marker", "class": "instance", "variant": "absent"}]}]	\N	f	1	[{"id": "materialize", "undo": "skip", "params": {"own": {"orbis/planned": true, "orbis/recurring": true, "orbis/occurred_on": "instance_date"}, "inherit": {"orbis/schedule": ["orbis/start_at", "orbis/end_at", "orbis/duration_min", "orbis/all_day", "orbis/location", "orbis/timezone"], "orbis/financial": ["orbis/amount", "orbis/currency", "orbis/direction", "orbis/finance_category", "orbis/payment_method", "orbis/counterparty"]}, "retro_days": 92, "origin_role": "instance-of", "horizon_days": 14, "trigger_properties": ["orbis/start_at", "orbis/due_date", "orbis/occurred_on"]}, "enabled": true, "template": "materialize"}]
orbis/task	\N	{"en": "A task: an action with a status, a priority and a due date.", "ru": "Задача: действие с состоянием, приоритетом и сроком."}	Применяй к действиям. orbis/task_status по умолчанию inbox; явный срок → orbis/due_date (дата, не момент). День работы над задачей → orbis/planned_date, независимо от срока. orbis/completed_at проставляет сервер при переходе в done — не передавай его сам.	{task,todo,action,deadline}	{}	{"icon": "✅", "keyFields": ["orbis/task_status", "orbis/due_date", "orbis/priority"]}	2026-11-05 02:11:05.990258+00	orbis/task	{"en": "Task", "ru": "Задача"}	[{"rank": 1, "required": true, "propertyId": "orbis/task_status"}, {"rank": 2, "required": false, "propertyId": "orbis/priority"}, {"rank": 3, "required": false, "propertyId": "orbis/due_date"}, {"rank": 4, "required": false, "propertyId": "orbis/completed_at"}, {"rank": 5, "required": false, "propertyId": "orbis/effort_min"}, {"rank": 6, "required": false, "propertyId": "orbis/waiting_for"}, {"rank": 7, "required": false, "propertyId": "orbis/planned_date"}, {"rank": 8, "required": false, "propertyId": "orbis/plan_order"}]	[{"bind": {"status": "orbis/task_status"}, "fixed": {}, "contract": "orbis/completable", "value_map": [{"slot": "status", "class": "active", "variant": "inbox"}, {"slot": "status", "class": "active", "variant": "planned"}, {"slot": "status", "class": "active", "variant": "in_progress"}, {"slot": "status", "class": "active", "variant": "waiting"}, {"slot": "status", "class": "done", "variant": "done"}, {"slot": "status", "class": "cancelled", "variant": "cancelled"}]}, {"bind": {"done": "orbis/completed_at", "deadline": "orbis/due_date"}, "fixed": {}, "contract": "orbis/when", "value_map": []}, {"bind": {"status": "orbis/task_status", "waiting_for": "orbis/waiting_for"}, "fixed": {}, "contract": "orbis/delegable", "value_map": [{"slot": "status", "class": "new", "variant": "inbox"}, {"slot": "status", "class": "queued", "variant": "planned"}, {"slot": "status", "class": "in_progress", "variant": "in_progress"}, {"slot": "status", "class": "waiting", "variant": "waiting"}, {"slot": "status", "class": "done", "variant": "done"}]}]	\N	f	2	[{"id": "task_completed_at", "undo": "check", "params": {"set": {"value": {"prop": "orbis/updated_at"}, "property": "orbis/completed_at"}, "enter": {"in": ["done"], "slot": "status", "contract": "orbis/completable"}, "on_leave": {"unset": ["orbis/completed_at"]}}, "enabled": true, "template": "on_enter_class"}, {"id": "waiting_for", "undo": "check", "params": {"enter": {"in": ["waiting"], "slot": "status", "contract": "orbis/delegable"}, "on_leave": {"unset": ["orbis/waiting_for"]}}, "enabled": true, "template": "on_enter_class"}, {"id": "waiting_for_only_when_waiting", "undo": "check", "when": {"op": "not", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/delegable"}}, {"const": ["waiting"]}]}]}, "params": {"property": "orbis/waiting_for"}, "enabled": true, "template": "forbidden_when"}, {"id": "task_status_default", "undo": "check", "params": {"value": {"const": "inbox"}, "property": "orbis/task_status"}, "enabled": true, "template": "default"}]
orbis/financial	\N	{"en": "A financial operation: an expense or an income.", "ru": "Финансовая операция: расход или доход."}	orbis/amount — строка decimal (например "340.00"), всегда положительная; знак задаёт orbis/direction. orbis/finance_category — ссылка на сущность-категорию: резолви её через entity_query по синонимам («aspect=orbis/category, orbis/aliases=такси»). orbis/occurred_on — дата операции в таймзоне пользователя. Тождество операции банка (orbis/bank_txn_id) в этом туле не показано намеренно: его заполняет только импорт выписки.	{expense,income,payment,cost}	{}	{"icon": "💸", "keyFields": ["orbis/amount", "orbis/direction", "orbis/finance_category"]}	2026-11-05 02:11:05.994421+00	orbis/financial	{"en": "Financial", "ru": "Финансовая операция"}	[{"rank": 1, "required": true, "propertyId": "orbis/amount"}, {"rank": 2, "required": false, "propertyId": "orbis/currency"}, {"rank": 3, "required": true, "propertyId": "orbis/direction"}, {"rank": 4, "required": true, "propertyId": "orbis/finance_category"}, {"rank": 5, "required": false, "propertyId": "orbis/occurred_on"}, {"rank": 6, "required": false, "propertyId": "orbis/planned"}, {"rank": 7, "required": false, "propertyId": "orbis/recurring"}, {"rank": 8, "required": false, "propertyId": "orbis/payment_method"}, {"rank": 9, "required": false, "propertyId": "orbis/counterparty"}, {"rank": 10, "required": false, "propertyId": "orbis/bank_txn_id"}]	[{"bind": {"date": "orbis/occurred_on", "amount": "orbis/amount", "planned": "orbis/planned", "category": "orbis/finance_category", "currency": "orbis/currency", "direction": "orbis/direction", "recurring": "orbis/recurring", "bank_txn_id": "orbis/bank_txn_id", "counterparty": "orbis/counterparty"}, "fixed": {}, "contract": "orbis/money-movement", "value_map": [{"slot": "direction", "class": "outflow", "variant": "expense"}, {"slot": "direction", "class": "inflow", "variant": "income"}]}, {"bind": {}, "fixed": {"origin_role": "instance-of"}, "contract": "orbis/recurrence", "value_map": []}]	finance	f	3	[{"id": "financial_requires_occurred_on", "undo": "check", "when": {"op": "not", "args": [{"op": "=", "args": [{"prop": "orbis/recurring"}, {"const": true}]}]}, "params": {"property": "orbis/occurred_on"}, "enabled": true, "template": "requires_when"}, {"id": "financial_recurring_requires_recurrence", "undo": "check", "when": {"op": "and", "args": [{"op": "=", "args": [{"prop": "orbis/recurring"}, {"const": true}]}, {"op": "not", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/recurrence"}}, {"const": ["template"]}]}]}, {"op": "not", "args": [{"has_relation": {"role": "instance-of"}}]}]}, "params": {"property": "orbis/recurring"}, "enabled": true, "template": "forbidden_when"}]
orbis/note	\N	{"en": "A marker that the point of the entity is its text; the content lives in the entity body.", "ru": "Маркер «главное назначение — текст»; содержимое живёт в body записи."}	Применяй, когда пользователь фиксирует мысль/заметку/документ. Текст кладётся в body сущности, а не в свойства.	{note,thought,idea,journal}	{}	{"icon": "📝", "keyFields": ["orbis/content_type", "orbis/pinned"]}	2026-11-05 02:11:05.998122+00	orbis/note	{"en": "Note", "ru": "Заметка"}	[{"rank": 1, "required": false, "propertyId": "orbis/content_type"}, {"rank": 2, "required": false, "propertyId": "orbis/pinned"}]	[]	\N	f	4	[]
orbis/budget	\N	{"en": "A budget envelope: a per-category limit for a period.", "ru": "Конверт бюджета: лимит по категории на период."}	Конверт на период: orbis/finance_category, orbis/limit (decimal-строка), orbis/period_start и orbis/period_end включительно. Потраченное не хранится — сервер считает его по транзакциям конверта.	{budget,envelope,limit}	{"spent": {"published": true}, "remaining": {"published": true}}	{"icon": "✉️", "keyFields": ["orbis/limit", "orbis/period_start", "orbis/period_end"]}	2026-11-05 02:11:06.001685+00	orbis/budget	{"en": "Budget", "ru": "Конверт бюджета"}	[{"rank": 1, "required": true, "propertyId": "orbis/finance_category"}, {"rank": 2, "required": true, "propertyId": "orbis/limit"}, {"rank": 3, "required": false, "propertyId": "orbis/currency"}, {"rank": 4, "required": true, "propertyId": "orbis/period_start"}, {"rank": 5, "required": true, "propertyId": "orbis/period_end"}, {"rank": 6, "required": false, "propertyId": "orbis/carryover"}]	[{"bind": {"limit": "orbis/limit", "category": "orbis/finance_category", "currency": "orbis/currency", "carryover": "orbis/carryover", "period_end": "orbis/period_end", "period_start": "orbis/period_start"}, "fixed": {}, "contract": "orbis/envelope", "value_map": []}]	finance	f	5	[{"id": "duplicate_envelope", "undo": "check", "params": {"properties": ["orbis/finance_category", "orbis/currency", "orbis/period_start", "orbis/period_end"]}, "enabled": true, "template": "unique_among"}, {"id": "budget_rollover", "undo": "skip", "params": {"carry": {"agg": "remaining"}, "source": "exact_calendar_month"}, "enabled": true, "template": "rollover"}, {"id": "envelope_currency_default", "undo": "check", "params": {"value": {"param": "default_currency"}, "property": "orbis/currency"}, "enabled": true, "template": "default"}]
orbis/category	\N	{"en": "A category of financial operations: hierarchy, aliases, rules.", "ru": "Категория финансовых операций: иерархия, синонимы, правила."}	Категория — сущность, не строка. orbis/aliases — синонимы в нижнем регистре (рус+англ) для резолва ввода. Дерево категорий — рёбра роли category-parent (родительская категория → подкатегория), а не свойство.	{category}	{}	{"icon": "🏷️", "keyFields": ["orbis/icon", "orbis/color", "orbis/spend_class"]}	2026-11-05 02:11:06.005149+00	orbis/category	{"en": "Category", "ru": "Категория"}	[{"rank": 1, "required": false, "propertyId": "orbis/icon"}, {"rank": 2, "required": false, "propertyId": "orbis/color"}, {"rank": 3, "required": false, "propertyId": "orbis/aliases"}, {"rank": 4, "required": false, "propertyId": "orbis/spend_class"}]	[]	finance	f	6	[]
orbis/memory	\N	{"en": "AI memory: facts about the user and input-handling rules.", "ru": "Память AI: факты о пользователе и правила обработки ввода."}	orbis/memory_kind=fact — знание о пользователе (свободный текст в title/body); kind=rule — правило категоризации ввода, и вся его машиночитаемая часть лежит В СВОЙСТВАХ, а не в заголовке. У правила ОБЯЗАТЕЛЕН orbis/rule_pattern — нормализованный образец в нижнем регистре, по которому правило узнаёт ввод («пятерочка», «яндекс такси»); без него запись отвергается. orbis/rule_target — ссылка на сущность-категорию, которую правило подставляет; для правил области orbis/money-movement она обязательна. orbis/rule_scope — ссылка на КОНТРАКТ реестра (денежные правила: orbis/money-movement); пусто = правило глобально. title правила — просто подпись вида «образец → категория»: её никто не разбирает, менять смысл правила надо свойствами.	{memory,preference,rule}	{}	{"icon": "🧠", "keyFields": ["orbis/memory_kind", "orbis/rule_pattern", "orbis/rule_target"]}	2026-11-05 02:11:06.009768+00	orbis/memory	{"en": "Memory", "ru": "Память"}	[{"rank": 1, "required": true, "propertyId": "orbis/memory_kind"}, {"rank": 2, "required": false, "propertyId": "orbis/rule_scope"}, {"rank": 3, "required": false, "propertyId": "orbis/rule_pattern"}, {"rank": 4, "required": false, "propertyId": "orbis/rule_target"}]	[]	\N	f	7	[{"id": "memory_rule_pattern", "undo": "check", "when": {"op": "=", "args": [{"prop": "orbis/memory_kind"}, {"const": "rule"}]}, "scope": {"property": "orbis/memory_kind"}, "params": {"property": "orbis/rule_pattern"}, "enabled": true, "template": "requires_when"}, {"id": "memory_rule_target", "undo": "check", "when": {"op": "and", "args": [{"op": "=", "args": [{"prop": "orbis/memory_kind"}, {"const": "rule"}]}, {"op": "=", "args": [{"prop": "orbis/rule_scope"}, {"const": "orbis/money-movement"}]}]}, "scope": {"property": "orbis/memory_kind"}, "params": {"property": "orbis/rule_target"}, "enabled": true, "template": "requires_when"}]
orbis/goal	\N	{"en": "A goal with measurable progress: a target value and the query it is computed from.", "ru": "Цель с измеримым прогрессом: целевое значение и запрос, из которого он считается."}	Применяй, когда у намерения есть измеримая цель («накопить 300000», «прочитать 24 книги»). orbis/target_value — decimal-строка, строго больше нуля. orbis/progress_source описывает, ОТКУДА берётся факт: query — дерево запроса по сущностям, aggregate — count (считает сущности; field при нём ЗАПРЕЩЁН, не передавай его) либо sum/latest (field ОБЯЗАТЕЛЕН — key свойства, например orbis/amount). orbis/unit — непустая подпись единицы, если она есть. Текущего значения (orbis/current_value) в туле нет намеренно: его считает сервер, обходя граф.	{goal}	{}	{"icon": "🎯", "keyFields": ["orbis/target_value", "orbis/current_value", "orbis/unit"]}	2026-11-05 02:11:06.014128+00	orbis/goal	{"en": "Goal", "ru": "Цель"}	[{"rank": 1, "required": true, "propertyId": "orbis/progress_source"}, {"rank": 2, "required": true, "propertyId": "orbis/target_value"}, {"rank": 3, "required": false, "propertyId": "orbis/current_value"}, {"rank": 4, "required": false, "propertyId": "orbis/unit"}]	[]	goals	f	8	[]
orbis/project	\N	{"en": "An endeavour with a life cycle; tickets are child tasks.", "ru": "Затея с жизненным циклом; тикеты — дочерние задачи"}	orbis/project — проект: затея с жизненным циклом (orbis/project_stage: active|paused|done). Тикеты проекта — дочерние сущности с orbis/task, привязанные ребром роли ticket от проекта к тикету. «Сделай A, B, C» в треде проекта = создать по тикету на пункт (orbis/task_status inbox), детьми проекта. Тело проекта с живыми блоками сервер засевает сам при пустом теле — не пиши его вручную. Кодовое (репозиторий, ветка) — не здесь: у репозитория свой аспект на той же сущности.	{project,проект}	{}	{"icon": "📁", "keyFields": ["orbis/project_stage"]}	2026-11-05 02:11:06.017945+00	orbis/project	{"en": "Project", "ru": "Проект"}	[{"rank": 1, "required": true, "propertyId": "orbis/project_stage"}]	[]	projects	f	9	[{"id": "nearest_ancestor", "undo": "skip", "params": {"targets": {"root": "orbis/root_project", "parent": "orbis/parent_project"}, "depth_cap": 32}, "enabled": true, "template": "nearest_ancestor"}]
orbis/repo	\N	{"en": "Repository address and default branch.", "ru": "Адрес репозитория и ветка по умолчанию"}	orbis/repo — репозиторий код-проекта: orbis/repo_url и orbis/default_branch. Ставится на ту же сущность, что и сам проект, только если проект — про код.	{repo,репозиторий}	{}	{"icon": "🗂️", "keyFields": ["orbis/repo_url", "orbis/default_branch"]}	2026-11-05 02:11:06.021262+00	orbis/repo	{"en": "Repo", "ru": "Репозиторий"}	[{"rank": 1, "required": true, "propertyId": "orbis/repo_url"}, {"rank": 2, "required": true, "propertyId": "orbis/default_branch"}]	[]	dev	f	10	[]
orbis/assignment	\N	{"en": "The ticket executor: a human or an agent under a grant; may_close.", "ru": "Исполнитель тикета: человек или агент по гранту; may_close"}	orbis/assignment — исполнитель тикета. orbis/executor=agent требует orbis/grant — доступ из «Настройки → Агенты»; его выставляет владелец (обычно кнопкой на экране тикета) — НИКОГДА не выдумывай его и не подставляй чужой. orbis/executor=human — orbis/assignee текстом. orbis/may_close (по умолчанию false) разрешает исполнителю закрывать тикет самому — включай только по прямой просьбе.	{assignee,исполнитель}	{}	{"icon": "🎯", "keyFields": ["orbis/executor", "orbis/may_close"]}	2026-11-05 02:11:06.025148+00	orbis/assignment	{"en": "Assignment", "ru": "Исполнитель"}	[{"rank": 1, "required": true, "propertyId": "orbis/executor"}, {"rank": 2, "required": false, "propertyId": "orbis/grant"}, {"rank": 3, "required": false, "propertyId": "orbis/assignee"}, {"rank": 4, "required": false, "propertyId": "orbis/may_close"}]	[]	\N	f	11	[{"id": "assignment_grant_required", "undo": "skip", "when": {"op": "=", "args": [{"prop": "orbis/executor"}, {"const": "agent"}]}, "params": {"property": "orbis/grant"}, "enabled": true, "template": "requires_when"}, {"id": "assignment_grant_forbidden", "undo": "skip", "when": {"op": "not", "args": [{"op": "=", "args": [{"prop": "orbis/executor"}, {"const": "agent"}]}]}, "params": {"property": "orbis/grant"}, "enabled": true, "template": "forbidden_when"}]
orbis/agent-run	\N	{"en": "Service entity of an agent run: steps, outcome, usage.", "ru": "Служебная запись прогона агента: шаги, исход, расход"}	orbis/agent-run — прогон исполнителя по тикету (дочерняя сущность тикета). Создаётся и обновляется ТОЛЬКО глаголами orbis_claim_task / orbis_run_step / orbis_checkpoint / orbis_finish; вручную не создавай и не правь. Служебный: в основных выдачах не показывается, запрашивай явно через aspect=orbis/agent-run.	{}	{}	{"icon": "🤖", "keyFields": ["orbis/run_outcome", "orbis/step_count"]}	2026-11-05 02:11:06.030397+00	orbis/agent-run	{"en": "Agent run", "ru": "Прогон агента"}	[{"rank": 1, "required": false, "propertyId": "orbis/grant"}, {"rank": 2, "required": false, "propertyId": "orbis/run_routine"}, {"rank": 3, "required": false, "propertyId": "orbis/run_bucket"}, {"rank": 4, "required": false, "propertyId": "orbis/run_attempt"}, {"rank": 5, "required": false, "propertyId": "orbis/fail_note"}, {"rank": 6, "required": false, "propertyId": "orbis/run_proposal"}, {"rank": 7, "required": false, "propertyId": "orbis/undecided"}, {"rank": 8, "required": true, "propertyId": "orbis/run_outcome"}, {"rank": 9, "required": true, "propertyId": "orbis/run_started_at"}, {"rank": 10, "required": false, "propertyId": "orbis/run_finished_at"}, {"rank": 11, "required": true, "propertyId": "orbis/last_step_at"}, {"rank": 12, "required": true, "propertyId": "orbis/step_count"}, {"rank": 13, "required": true, "propertyId": "orbis/run_steps"}, {"rank": 14, "required": false, "propertyId": "orbis/session_url"}, {"rank": 15, "required": false, "propertyId": "orbis/run_report"}, {"rank": 16, "required": false, "propertyId": "orbis/run_checkpoint"}, {"rank": 17, "required": false, "propertyId": "orbis/run_reply"}, {"rank": 18, "required": false, "propertyId": "orbis/run_usage"}, {"rank": 19, "required": false, "propertyId": "orbis/abandon_note"}]	[]	\N	t	12	[{"id": "run_subject", "undo": "skip", "when": {"op": "not", "args": [{"has": "orbis/run_routine"}]}, "params": {"property": "orbis/grant"}, "enabled": true, "template": "requires_when"}, {"id": "run_subject_forbidden", "undo": "skip", "when": {"has": "orbis/run_routine"}, "params": {"property": "orbis/grant"}, "enabled": true, "template": "forbidden_when"}]
orbis/routine	\N	{"en": "Recurring work of the internal executor: schedule, mode, permissions.", "ru": "Повторяющаяся работа внутреннего исполнителя: расписание, режим, права"}	orbis/routine — рутина: повторяющаяся работа внутреннего исполнителя. ЧТО делать — в теле сущности обычным текстом, в свойствах только расписание и права. orbis/routine_at — локальное время владельца «ЧЧ:ММ» (07:00, не 7:00); orbis/routine_days — дни недели mo|tu|we|th|fr|sa|su, без свойства = каждый день. orbis/routine_mode обязателен: propose — рутина ПРЕДЛАГАЕТ изменения владельцу на подтверждение, act — применяет их сама, и тогда перечисли orbis/allowed_tools (ровно те инструменты, что ей нужны). Без явной просьбы владельца действовать самостоятельно заводи рутину с orbis/routine_mode: propose — act выдаётся только по его прямому слову. orbis/routine_stage: active — рутина работает, paused — временно отключена; «выключи рутину» — это paused, а не удаление.	{routine,рутина}	{}	{"icon": "⏰", "keyFields": ["orbis/routine_stage", "orbis/routine_at", "orbis/routine_mode"]}	2026-11-05 02:11:06.034537+00	orbis/routine	{"en": "Routine", "ru": "Рутина"}	[{"rank": 1, "required": true, "propertyId": "orbis/routine_stage"}, {"rank": 2, "required": true, "propertyId": "orbis/routine_at"}, {"rank": 3, "required": false, "propertyId": "orbis/routine_days"}, {"rank": 4, "required": true, "propertyId": "orbis/routine_mode"}, {"rank": 5, "required": false, "propertyId": "orbis/allowed_tools"}]	[]	\N	f	13	[]
orbis/page	\N	{"en": "A record shown through its body: text and blocks. With a non-empty \\"Template for\\" — a template for records carrying those aspects", "ru": "Запись, которая показывается своим телом: текст и блоки. С непустым «Шаблон для» — шаблон для записей с этими аспектами"}	orbis/page — страница и шаблон владельца. Страницы пишет владелец в интерфейсе: аспект orbis/page сам не навешивай и orbis/template_for / orbis/template_wins_over не меняй (авторство страниц агентом — позже).	{}	{}	{"icon": "📄", "keyFields": ["orbis/template_for"]}	2026-11-05 02:11:06.038271+00	orbis/page	{"en": "Page", "ru": "Страница"}	[{"rank": 1, "required": false, "propertyId": "orbis/template_for"}, {"rank": 2, "required": false, "propertyId": "orbis/template_wins_over"}, {"rank": 3, "required": false, "propertyId": "orbis/home"}]	[]	\N	f	14	[{"id": "page_wins_over_needs_template_for", "undo": "check", "when": {"op": "not", "args": [{"op": "empty", "args": [{"prop": "orbis/template_wins_over"}]}]}, "params": {"property": "orbis/template_for"}, "enabled": true, "template": "requires_when"}, {"id": "page_wins_over_not_self", "undo": "check", "when": {"op": "and", "args": [{"op": "not", "args": [{"op": "empty", "args": [{"prop": "orbis/template_wins_over"}]}]}, {"op": "in", "args": [{"ctx": "$self"}, {"prop": "orbis/template_wins_over"}]}]}, "params": {"property": "orbis/template_wins_over"}, "enabled": true, "template": "forbidden_when"}]
orbis/app	\N	{"en": "A place: home, navigation, navigation form, extensions", "ru": "Место: домашняя, навигация, форма навигации, состав расширений"}	orbis/app — приложение владельца. Аспект сам не навешивай; записи-приложения правь только по просьбе владельца обычной правкой записи (навигация, домашняя, форма); «Выключено» пишет только действие владельца.	{}	{}	{"icon": "🧩", "keyFields": ["orbis/app_home", "orbis/app_nav_form"]}	2026-11-05 02:11:06.042058+00	orbis/app	{"en": "App", "ru": "Приложение"}	[{"rank": 1, "required": false, "propertyId": "orbis/app_home"}, {"rank": 2, "required": false, "propertyId": "orbis/app_nav"}, {"rank": 3, "required": false, "propertyId": "orbis/app_nav_form"}, {"rank": 4, "required": false, "propertyId": "orbis/app_extensions"}, {"rank": 5, "required": false, "propertyId": "orbis/app_opens_over"}, {"rank": 6, "required": false, "propertyId": "orbis/app_disabled"}]	[]	\N	f	15	[{"id": "app_home_not_self", "undo": "check", "when": {"op": "=", "args": [{"ctx": "$self"}, {"prop": "orbis/app_home"}]}, "params": {"property": "orbis/app_home"}, "enabled": true, "template": "forbidden_when"}, {"id": "app_nav_not_self", "undo": "check", "when": {"op": "and", "args": [{"op": "not", "args": [{"op": "empty", "args": [{"prop": "orbis/app_nav"}]}]}, {"op": "in", "args": [{"ctx": "$self"}, {"prop": "orbis/app_nav"}]}]}, "params": {"property": "orbis/app_nav"}, "enabled": true, "template": "forbidden_when"}, {"id": "app_opens_over_not_self", "undo": "check", "when": {"op": "and", "args": [{"op": "not", "args": [{"op": "empty", "args": [{"prop": "orbis/app_opens_over"}]}]}, {"op": "in", "args": [{"ctx": "$self"}, {"prop": "orbis/app_opens_over"}]}]}, "params": {"property": "orbis/app_opens_over"}, "enabled": true, "template": "forbidden_when"}]
orbis/supply	\N	{"en": "A record brought by the host supply: the etalon key, hash and text", "ru": "Запись, которую принесла поставка хоста: ключ, отпечаток и текст эталона"}	orbis/supply — служебная метка записи поставки. Не навешивай, не снимай и не правь её свойства.	{}	{}	{"icon": "📦", "keyFields": ["orbis/supply_key"]}	2026-11-05 02:11:06.046395+00	orbis/supply	{"en": "Supply", "ru": "Поставка"}	[{"rank": 1, "required": true, "propertyId": "orbis/supply_key"}, {"rank": 2, "required": false, "propertyId": "orbis/supply_hash"}, {"rank": 3, "required": false, "propertyId": "orbis/supply_text"}, {"rank": 4, "required": false, "propertyId": "orbis/supply_declined"}]	[]	\N	f	16	[{"id": "supply_key_unique", "undo": "check", "params": {"properties": ["orbis/supply_key"]}, "enabled": true, "template": "unique_among"}]
\.


--
-- Data for Name: change_feed; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.change_feed (id, tx_id, graph_id, kind, row_key, entity_ids, thread_id, operation, scope, at, graph_wide) FROM stdin;
1	1131	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	settings	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	{}	\N	insert	other	2026-11-05 02:11:21.676657+00	f
2	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	3264a4c8-1157-5c94-b403-f3848172eb01	{3264a4c8-1157-5c94-b403-f3848172eb01}	\N	insert	other	2026-11-05 02:11:21.954533+00	f
3	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	8f118690-ee5e-53f8-920e-e4b1b5835f30	{8f118690-ee5e-53f8-920e-e4b1b5835f30}	\N	insert	other	2026-11-05 02:11:21.964417+00	f
4	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	ea686e27-80f9-5d2e-96b9-58e2ad385ead	{ea686e27-80f9-5d2e-96b9-58e2ad385ead}	\N	insert	other	2026-11-05 02:11:21.969311+00	f
5	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	63cc53ae-a75f-5561-a01d-c83bab3770e4	{63cc53ae-a75f-5561-a01d-c83bab3770e4}	\N	insert	other	2026-11-05 02:11:21.973655+00	f
6	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	fbd3291f-e490-5265-b3cb-39ba43eefe41	{fbd3291f-e490-5265-b3cb-39ba43eefe41}	\N	insert	other	2026-11-05 02:11:21.978252+00	f
7	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	0c32374a-5ffd-5747-9e43-5ee6443c72d6	{0c32374a-5ffd-5747-9e43-5ee6443c72d6}	\N	insert	other	2026-11-05 02:11:21.98262+00	f
8	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	021a2e63-6989-5413-a25a-e5a64bab8d30	{021a2e63-6989-5413-a25a-e5a64bab8d30}	\N	insert	other	2026-11-05 02:11:21.987223+00	f
9	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	42a19f18-4104-563b-b970-f7e641613d39	{42a19f18-4104-563b-b970-f7e641613d39}	\N	insert	other	2026-11-05 02:11:21.991814+00	f
10	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	b7b399e6-0ace-5a4a-9165-a255ac7b68ff	{b7b399e6-0ace-5a4a-9165-a255ac7b68ff}	\N	insert	other	2026-11-05 02:11:21.996341+00	f
11	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	de4030ff-4c9e-573e-bfc7-f1eff0977dd9	{de4030ff-4c9e-573e-bfc7-f1eff0977dd9}	\N	insert	other	2026-11-05 02:11:22.001399+00	f
12	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	c932b35c-630f-5558-9035-46dd413801ea	{c932b35c-630f-5558-9035-46dd413801ea}	\N	insert	other	2026-11-05 02:11:22.006751+00	f
13	1132	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	40a6bfe2-e168-5a98-a4ae-21a67fe0d17f	{40a6bfe2-e168-5a98-a4ae-21a67fe0d17f}	\N	insert	other	2026-11-05 02:11:22.011674+00	f
14	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	48e8e9a9-9832-55d9-9c9a-5ec447099f6d	{48e8e9a9-9832-55d9-9c9a-5ec447099f6d}	\N	insert	other	2026-11-05 02:11:22.241995+00	f
15	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	76d0f258-9065-5f64-96c6-da6f0c6278f3	{76d0f258-9065-5f64-96c6-da6f0c6278f3}	\N	insert	other	2026-11-05 02:11:22.248701+00	f
16	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	a5b240dc-ed62-5489-9fe0-29e9b7b21d8e	{a5b240dc-ed62-5489-9fe0-29e9b7b21d8e}	\N	insert	other	2026-11-05 02:11:22.255272+00	f
17	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	a45e806b-517d-5372-a5bb-a599fcab6e6b	{a45e806b-517d-5372-a5bb-a599fcab6e6b}	\N	insert	other	2026-11-05 02:11:22.262919+00	f
18	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	35fd6695-1b7b-548e-966b-3bdaae9b0446	{35fd6695-1b7b-548e-966b-3bdaae9b0446}	\N	insert	other	2026-11-05 02:11:22.268814+00	f
19	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	22732249-3f87-5802-b701-f3767ef336bd	{22732249-3f87-5802-b701-f3767ef336bd}	\N	insert	other	2026-11-05 02:11:22.277027+00	f
20	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	e57ff285-60b1-587d-9504-854fa5ada148	{e57ff285-60b1-587d-9504-854fa5ada148}	\N	insert	other	2026-11-05 02:11:22.283879+00	f
21	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	e00b101b-1d2c-5616-9a3f-2cf3f492c33d	{e00b101b-1d2c-5616-9a3f-2cf3f492c33d}	\N	insert	other	2026-11-05 02:11:22.291007+00	f
22	1133	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	8476068d-5802-521b-94b7-eca3a332ee2c	{8476068d-5802-521b-94b7-eca3a332ee2c}	\N	insert	other	2026-11-05 02:11:22.30114+00	f
23	1134	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	99a4d5f1-5ff3-546e-ac7d-7c0c6f19c753	{99a4d5f1-5ff3-546e-ac7d-7c0c6f19c753}	\N	insert	other	2026-11-05 02:11:22.365822+00	f
24	1135	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	3d71b946-c7e6-57e0-be45-dfd0e5d80bc7	{3d71b946-c7e6-57e0-be45-dfd0e5d80bc7}	\N	insert	other	2026-11-05 02:11:22.413143+00	f
25	1136	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	settings	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	{}	\N	update	other	2026-11-05 02:11:22.445864+00	f
26	1136	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	thread	6bc488b1-5f1a-5b39-a739-e4a0d9a218de	{}	6bc488b1-5f1a-5b39-a739-e4a0d9a218de	insert	other	2026-11-05 02:11:22.453445+00	f
27	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	53153bf3-d362-5584-b0e6-a800c660b3c5	{53153bf3-d362-5584-b0e6-a800c660b3c5}	\N	insert	other	2026-11-05 02:11:22.57136+00	f
28	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f5c-713a-bd6d-e7c83d12a969	{53153bf3-d362-5584-b0e6-a800c660b3c5,76d0f258-9065-5f64-96c6-da6f0c6278f3}	\N	insert	other	2026-11-05 02:11:22.590265+00	f
29	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f61-71b7-9b5e-86a973a210f1	{53153bf3-d362-5584-b0e6-a800c660b3c5,a5b240dc-ed62-5489-9fe0-29e9b7b21d8e}	\N	insert	other	2026-11-05 02:11:22.595116+00	f
30	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f65-70e9-b2e6-968201fa4d8f	{53153bf3-d362-5584-b0e6-a800c660b3c5,a45e806b-517d-5372-a5bb-a599fcab6e6b}	\N	insert	other	2026-11-05 02:11:22.598527+00	f
31	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f68-731f-9f6d-54b94c35d0bd	{35fd6695-1b7b-548e-966b-3bdaae9b0446,53153bf3-d362-5584-b0e6-a800c660b3c5}	\N	insert	other	2026-11-05 02:11:22.601977+00	f
32	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f6c-7357-a852-8e541fb861a5	{22732249-3f87-5802-b701-f3767ef336bd,53153bf3-d362-5584-b0e6-a800c660b3c5}	\N	insert	other	2026-11-05 02:11:22.606313+00	f
33	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f70-7282-baab-3df54020b575	{53153bf3-d362-5584-b0e6-a800c660b3c5,e57ff285-60b1-587d-9504-854fa5ada148}	\N	insert	other	2026-11-05 02:11:22.611011+00	f
34	1137	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-9f75-704f-95c3-46afb1447753	{53153bf3-d362-5584-b0e6-a800c660b3c5,8476068d-5802-521b-94b7-eca3a332ee2c}	\N	insert	other	2026-11-05 02:11:22.616603+00	f
35	1138	469c6a1e-320a-4d24-bdda-e8c070b816cd	settings	469c6a1e-320a-4d24-bdda-e8c070b816cd	{}	\N	insert	other	2026-11-05 02:11:22.64956+00	f
36	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	be77ec68-b273-5780-b5fa-7ef9c6fa3416	{be77ec68-b273-5780-b5fa-7ef9c6fa3416}	\N	insert	other	2026-11-05 02:11:22.819372+00	f
37	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	8ee37264-b200-5b32-82c4-320f698702ec	{8ee37264-b200-5b32-82c4-320f698702ec}	\N	insert	other	2026-11-05 02:11:22.823957+00	f
38	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	8852360d-6a9d-5944-b06e-16ddab2a9cae	{8852360d-6a9d-5944-b06e-16ddab2a9cae}	\N	insert	other	2026-11-05 02:11:22.829152+00	f
39	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	66979037-157c-50d1-bd54-5dd53f992dc6	{66979037-157c-50d1-bd54-5dd53f992dc6}	\N	insert	other	2026-11-05 02:11:22.835238+00	f
40	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	94cfb158-83e9-5e08-bafe-d64560a8a546	{94cfb158-83e9-5e08-bafe-d64560a8a546}	\N	insert	other	2026-11-05 02:11:22.840317+00	f
41	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	83096c28-5c95-58df-8fc8-ff6f4e86013a	{83096c28-5c95-58df-8fc8-ff6f4e86013a}	\N	insert	other	2026-11-05 02:11:22.84463+00	f
42	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	2c87e7f6-b0a3-59f4-aa0e-98c0a569e94b	{2c87e7f6-b0a3-59f4-aa0e-98c0a569e94b}	\N	insert	other	2026-11-05 02:11:22.848559+00	f
43	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	63a4ebcd-e245-51d4-a3af-f579e5d3d78d	{63a4ebcd-e245-51d4-a3af-f579e5d3d78d}	\N	insert	other	2026-11-05 02:11:22.852204+00	f
44	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	3e45a779-60b9-5c78-9ee3-66c2bee9a310	{3e45a779-60b9-5c78-9ee3-66c2bee9a310}	\N	insert	other	2026-11-05 02:11:22.855872+00	f
45	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	350d7431-2f27-5133-89ff-c40b43308f28	{350d7431-2f27-5133-89ff-c40b43308f28}	\N	insert	other	2026-11-05 02:11:22.860854+00	f
46	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	46432280-b294-5ce5-b26a-3b038699a534	{46432280-b294-5ce5-b26a-3b038699a534}	\N	insert	other	2026-11-05 02:11:22.865802+00	f
47	1139	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	da958d8c-4a01-598a-b37a-5b9d7af30d71	{da958d8c-4a01-598a-b37a-5b9d7af30d71}	\N	insert	other	2026-11-05 02:11:22.870206+00	f
48	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	6daf35f0-7485-5637-af4a-4d695f4caaf7	{6daf35f0-7485-5637-af4a-4d695f4caaf7}	\N	insert	other	2026-11-05 02:11:23.007981+00	f
49	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	61af277b-2ed5-592c-9074-410126aa8880	{61af277b-2ed5-592c-9074-410126aa8880}	\N	insert	other	2026-11-05 02:11:23.012058+00	f
50	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	3e2fef47-0983-5bed-939e-26a430695ca3	{3e2fef47-0983-5bed-939e-26a430695ca3}	\N	insert	other	2026-11-05 02:11:23.018838+00	f
51	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	7c3326d1-5416-51c8-b4a2-c0673b80f044	{7c3326d1-5416-51c8-b4a2-c0673b80f044}	\N	insert	other	2026-11-05 02:11:23.024209+00	f
52	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	f3cb3be0-0a48-5471-8f01-fa5308e529bd	{f3cb3be0-0a48-5471-8f01-fa5308e529bd}	\N	insert	other	2026-11-05 02:11:23.029524+00	f
53	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	18331aa2-1bc8-51c1-bd62-6dde3f83cdbe	{18331aa2-1bc8-51c1-bd62-6dde3f83cdbe}	\N	insert	other	2026-11-05 02:11:23.034916+00	f
54	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	bdddb983-03bb-5441-9fbc-250580c758b8	{bdddb983-03bb-5441-9fbc-250580c758b8}	\N	insert	other	2026-11-05 02:11:23.039161+00	f
55	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	90c49486-f103-57b8-8c5a-77744ffb85c0	{90c49486-f103-57b8-8c5a-77744ffb85c0}	\N	insert	other	2026-11-05 02:11:23.043489+00	f
56	1140	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	171a596b-921d-58d7-a834-71a80aee77c0	{171a596b-921d-58d7-a834-71a80aee77c0}	\N	insert	other	2026-11-05 02:11:23.047649+00	f
57	1141	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	f34bc6e7-3bd3-58a5-b280-bfca1b476029	{f34bc6e7-3bd3-58a5-b280-bfca1b476029}	\N	insert	other	2026-11-05 02:11:23.082078+00	f
58	1142	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	8b254405-3c6e-5e0a-a623-92e5b2529373	{8b254405-3c6e-5e0a-a623-92e5b2529373}	\N	insert	other	2026-11-05 02:11:23.112243+00	f
59	1143	469c6a1e-320a-4d24-bdda-e8c070b816cd	settings	469c6a1e-320a-4d24-bdda-e8c070b816cd	{}	\N	update	other	2026-11-05 02:11:23.130448+00	f
60	1143	469c6a1e-320a-4d24-bdda-e8c070b816cd	thread	c442fd2f-4c63-57f7-a660-cc9cd50a8e34	{}	c442fd2f-4c63-57f7-a660-cc9cd50a8e34	insert	other	2026-11-05 02:11:23.133996+00	f
61	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	{67f317ad-0e24-5b2e-9308-8707d8ef2b7d}	\N	insert	other	2026-11-05 02:11:23.187703+00	f
62	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1be-70d8-9258-1ae469a9897a	{61af277b-2ed5-592c-9074-410126aa8880,67f317ad-0e24-5b2e-9308-8707d8ef2b7d}	\N	insert	other	2026-11-05 02:11:23.200539+00	f
63	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1c2-7433-a9c5-bc1eedac7ca3	{3e2fef47-0983-5bed-939e-26a430695ca3,67f317ad-0e24-5b2e-9308-8707d8ef2b7d}	\N	insert	other	2026-11-05 02:11:23.203965+00	f
64	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1c6-740e-8126-7d7b91500e76	{67f317ad-0e24-5b2e-9308-8707d8ef2b7d,7c3326d1-5416-51c8-b4a2-c0673b80f044}	\N	insert	other	2026-11-05 02:11:23.209988+00	f
65	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1cc-72c9-bcb4-428dfa6ace99	{67f317ad-0e24-5b2e-9308-8707d8ef2b7d,f3cb3be0-0a48-5471-8f01-fa5308e529bd}	\N	insert	other	2026-11-05 02:11:23.21398+00	f
66	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1d0-7361-8c7f-41e56a307455	{18331aa2-1bc8-51c1-bd62-6dde3f83cdbe,67f317ad-0e24-5b2e-9308-8707d8ef2b7d}	\N	insert	other	2026-11-05 02:11:23.218765+00	f
67	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1d4-7778-8ac9-52fa8cadc858	{67f317ad-0e24-5b2e-9308-8707d8ef2b7d,bdddb983-03bb-5441-9fbc-250580c758b8}	\N	insert	other	2026-11-05 02:11:23.222905+00	f
68	1144	469c6a1e-320a-4d24-bdda-e8c070b816cd	relation	01a1a979-a1d9-748b-b3ec-25b98a2efc4d	{171a596b-921d-58d7-a834-71a80aee77c0,67f317ad-0e24-5b2e-9308-8707d8ef2b7d}	\N	insert	other	2026-11-05 02:11:23.227735+00	f
69	1145	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	insert	other	2026-11-05 02:11:23.246864+00	f
70	1145	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-a1e1-737c-b4ba-17d6b2b1fe17	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	insert	other	2026-11-05 02:11:23.252932+00	f
71	1146	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	{01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	\N	insert	other	2026-11-05 02:11:23.273293+00	f
72	1146	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-a1fc-714b-8560-128a9ce0edff	{01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	\N	insert	other	2026-11-05 02:11:23.278575+00	f
73	1147	469c6a1e-320a-4d24-bdda-e8c070b816cd	entity	01a1a979-a221-730f-929d-08113981f0e7	{01a1a979-a221-730f-929d-08113981f0e7}	\N	insert	other	2026-11-05 02:11:23.300819+00	f
74	1147	469c6a1e-320a-4d24-bdda-e8c070b816cd	journal	01a1a979-a215-70f2-9dc9-a42d9276b1bf	{01a1a979-a221-730f-929d-08113981f0e7}	\N	insert	other	2026-11-05 02:11:23.30721+00	f
75	1148	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	relation	01a1a979-a24b-71ae-8d26-290310ab8624	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee,01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	\N	insert	other	2026-11-05 02:11:23.341939+00	f
76	1148	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-a232-7153-99fc-fe3b00e97499	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee,01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	\N	insert	other	2026-11-05 02:11:23.348775+00	f
77	1149	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	thread	825c95bf-506f-5976-b59d-87c502e227fc	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	825c95bf-506f-5976-b59d-87c502e227fc	insert	other	2026-11-05 02:11:23.365579+00	f
78	1150	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	message	01a1a979-a279-7689-ba4f-9f36ea8220e3	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	825c95bf-506f-5976-b59d-87c502e227fc	insert	other	2026-11-05 02:11:23.396748+00	f
79	1151	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	update	body	2026-11-05 02:11:23.432147+00	f
80	1151	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-a28b-749a-beca-01a177eae26c	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	insert	other	2026-11-05 02:11:23.438006+00	f
81	1152	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	version	01a1a979-a2bf-72e3-95ae-70f910bfc1bb	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	insert	other	2026-11-05 02:11:23.463453+00	f
82	1152	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-a2b4-73cf-9961-81eebeec3f77	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	insert	other	2026-11-05 02:11:23.468874+00	t
84	5249	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	journal	01a1a979-b18a-7555-a78d-7e23ee89f1b1	{01a1a979-a207-726b-ac4a-4fb3a35c0b5d}	\N	insert	other	2026-11-05 02:11:27.259301+00	f
85	5252	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	entity	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	{01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee}	\N	update	body	2026-11-05 02:11:27.298626+00	f
\.


--
-- Data for Name: change_feed_floor; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.change_feed_floor (id, floor) FROM stdin;
1	5250
\.


--
-- Data for Name: chat_messages; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_messages (id, thread_id, role, content, metadata, created_at) FROM stdin;
01a1a979-a279-7689-ba4f-9f36ea8220e3	825c95bf-506f-5976-b59d-87c502e227fc	user	Synthetic restored message	{}	2026-11-05 02:11:23.385+00
\.


--
-- Data for Name: chat_threads; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.chat_threads (id, graph_id, entity_id, title, archived, created_at, updated_at) FROM stdin;
6bc488b1-5f1a-5b39-a739-e4a0d9a218de	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	\N	\N	f	2026-11-05 02:11:22.421118+00	2026-11-05 02:11:22.421118+00
c442fd2f-4c63-57f7-a660-cc9cd50a8e34	469c6a1e-320a-4d24-bdda-e8c070b816cd	\N	\N	f	2026-11-05 02:11:23.118755+00	2026-11-05 02:11:23.118755+00
825c95bf-506f-5976-b59d-87c502e227fc	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	\N	f	2026-11-05 02:11:23.355418+00	2026-11-05 02:11:23.355418+00
\.


--
-- Data for Name: contract_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.contract_definitions (id, graph_id, key, label, description, kind, slots, classes, sets, facts, module, rank, created_at, exclusive_classes) FROM stdin;
orbis/completable	\N	orbis/completable	{"en": "Completable", "ru": "Завершаемость"}	{"en": "An entity can be completed or cancelled: a status slot and three value classes.", "ru": "Запись можно завершить или отменить: слот-статус и три класса значений."}	slots	[{"name": "status", "type": {"kind": "select"}, "label": {"en": "Status", "ru": "Статус"}, "status": true, "required": true}]	[{"key": "done", "label": {"en": "Done", "ru": "Сделано"}}, {"key": "cancelled", "label": {"en": "Cancelled", "ru": "Отменено"}}, {"key": "active", "label": {"en": "Active", "ru": "В работе"}}]	{"open": ["active"], "closed": ["done", "cancelled"]}	\N	\N	1	2026-11-05 02:11:06.050137+00	f
orbis/when	\N	orbis/when	{"en": "When", "ru": "Когда"}	{"en": "Time binding: a moment (event) and a deadline — two distinct slots.", "ru": "Привязка ко времени: момент (событие) и срок (дедлайн) — два разных слота."}	slots	[{"name": "moment", "type": {"kind": "any_of", "kinds": ["timestamp", "date"]}, "label": {"en": "Moment", "ru": "Момент"}, "status": false, "required": false, "value_role": "plan"}, {"name": "deadline", "type": {"kind": "date"}, "label": {"en": "Deadline", "ru": "Срок"}, "status": false, "required": false, "value_role": "plan"}, {"name": "done", "type": {"kind": "any_of", "kinds": ["timestamp", "date"]}, "label": {"en": "Done", "ru": "Завершено"}, "status": false, "required": false, "value_role": "fact"}, {"name": "end", "type": {"kind": "any_of", "kinds": ["timestamp", "date"]}, "label": {"en": "End", "ru": "Конец"}, "status": false, "required": false}, {"name": "all_day", "type": {"kind": "boolean"}, "label": {"en": "All day", "ru": "Весь день"}, "status": false, "required": false}]	[]	{}	\N	\N	2	2026-11-05 02:11:06.057124+00	f
orbis/recurrence	\N	orbis/recurrence	{"en": "Recurrence", "ru": "Повторяемость"}	{"en": "A recurrence template and its instances: the marker and the origin edge role.", "ru": "Шаблон повторения и его экземпляры: признак шаблона и роль ребра порождения."}	slots	[{"name": "template_marker", "type": {"kind": "any_of", "kinds": ["boolean", "json"]}, "label": {"en": "Template marker", "ru": "Признак шаблона"}, "status": true, "required": false}, {"name": "origin_role", "type": {"kind": "relation_role"}, "label": {"en": "Origin role", "ru": "Роль порождения"}, "status": false, "required": false}]	[{"key": "template", "label": {"en": "Template", "ru": "Шаблон"}}, {"key": "instance", "label": {"en": "Instance", "ru": "Экземпляр"}}]	{"instances": ["instance"], "templates": ["template"]}	\N	\N	3	2026-11-05 02:11:06.061086+00	f
orbis/sensitivity	\N	orbis/sensitivity	{"en": "Sensitivity", "ru": "Чувствительность"}	{"en": "Closed dictionary of sensitivity facts assigned by action declarations and the §7.10 policy.", "ru": "Закрытый словарь фактов чувствительности: их назначают декларации действий и политика §7.10."}	facts	\N	\N	\N	[{"key": "touches_money", "label": {"en": "Touches money", "ru": "Затрагивает деньги"}}, {"key": "external", "label": {"en": "External effect", "ru": "Внешний эффект"}}, {"key": "irreversible", "label": {"en": "Irreversible", "ru": "Необратимо"}}, {"key": "changes_registry", "label": {"en": "Changes the registry", "ru": "Меняет реестр"}}, {"key": "grants_autonomy", "label": {"en": "Grants autonomy", "ru": "Даёт автономию"}}]	\N	4	2026-11-05 02:11:06.065341+00	f
orbis/money-movement	\N	orbis/money-movement	{"en": "Money movement", "ru": "Движение денег"}	{"en": "A money movement (actual or planned): amount, direction, category, date and import fields.", "ru": "Факт или план движения денег: сумма, направление, категория, дата и реквизиты импорта."}	slots	[{"name": "amount", "type": {"kind": "decimal"}, "label": {"en": "Amount", "ru": "Сумма"}, "status": false, "required": true}, {"name": "direction", "type": {"kind": "select"}, "label": {"en": "Direction", "ru": "Направление"}, "status": true, "required": true}, {"name": "category", "type": {"kind": "ref"}, "label": {"en": "Category", "ru": "Категория"}, "status": false, "required": true}, {"name": "date", "type": {"kind": "date"}, "label": {"en": "Date", "ru": "Дата"}, "status": false, "required": true}, {"name": "currency", "type": {"kind": "text"}, "label": {"en": "Currency", "ru": "Валюта"}, "status": false, "required": false}, {"name": "planned", "type": {"kind": "boolean"}, "label": {"en": "Planned", "ru": "План"}, "status": false, "required": false}, {"name": "recurring", "type": {"kind": "boolean"}, "label": {"en": "Recurring", "ru": "Повторяется"}, "status": false, "required": false}, {"name": "counterparty", "type": {"kind": "text"}, "label": {"en": "Counterparty", "ru": "Контрагент"}, "status": false, "required": false}, {"name": "bank_txn_id", "type": {"kind": "text"}, "label": {"en": "Bank transaction id", "ru": "Идентификатор банка"}, "status": false, "required": false}]	[{"key": "outflow", "label": {"en": "Outflow", "ru": "Расход"}}, {"key": "inflow", "label": {"en": "Inflow", "ru": "Доход"}}]	{"facts": {"op": "and", "args": [{"op": "not", "args": [{"op": "=", "args": [{"slot": "planned"}, {"const": true}]}]}, {"op": "<=", "args": [{"slot": "date"}, {"ctx": "$today"}]}, {"op": "not", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/recurrence"}}, {"const": "templates"}]}]}]}, "plans": {"op": "=", "args": [{"slot": "planned"}, {"const": true}]}, "inflow": ["inflow"], "outflow": ["outflow"]}	\N	\N	5	2026-11-05 02:11:06.070843+00	f
orbis/envelope	\N	orbis/envelope	{"en": "Envelope", "ru": "Конверт"}	{"en": "A spending limit for a category over a period — the carrier of Budget rules (§Б5-4).", "ru": "Лимит расходов по категории за период — носитель правил Budget (§Б5-4)."}	slots	[{"name": "category", "type": {"kind": "ref"}, "label": {"en": "Category", "ru": "Категория"}, "status": false, "required": true}, {"name": "limit", "type": {"kind": "decimal"}, "label": {"en": "Limit", "ru": "Лимит"}, "status": false, "required": true}, {"name": "currency", "type": {"kind": "text"}, "label": {"en": "Currency", "ru": "Валюта"}, "status": false, "required": false}, {"name": "period_start", "type": {"kind": "date"}, "label": {"en": "Period start", "ru": "Начало периода"}, "status": false, "required": true}, {"name": "period_end", "type": {"kind": "date"}, "label": {"en": "Period end", "ru": "Конец периода"}, "status": false, "required": true}, {"name": "carryover", "type": {"kind": "decimal"}, "label": {"en": "Carryover", "ru": "Перенос"}, "status": false, "required": false}]	[]	{}	\N	\N	6	2026-11-05 02:11:06.074897+00	f
orbis/delegable	\N	orbis/delegable	{"en": "Delegable", "ru": "Делегируемость"}	{"en": "Delegation ticket states: new, queued, in progress, waiting, done; and what it waits for.", "ru": "Состояния тикета делегирования: новое, в очереди, в работе, ждёт, сделано; чего ждём."}	slots	[{"name": "status", "type": {"kind": "select"}, "label": {"en": "State", "ru": "Состояние"}, "status": true, "required": true}, {"name": "waiting_for", "type": {"kind": "text"}, "label": {"en": "Waiting for", "ru": "Чего ждём"}, "status": false, "required": false}]	[{"key": "new", "label": {"en": "New", "ru": "Новый"}}, {"key": "queued", "label": {"en": "Queued", "ru": "В очереди"}}, {"key": "in_progress", "label": {"en": "In progress", "ru": "В работе"}}, {"key": "waiting", "label": {"en": "Waiting", "ru": "Ждёт"}}, {"key": "done", "label": {"en": "Done", "ru": "Сделано"}}]	{"open": ["new", "queued", "in_progress", "waiting"], "closed": ["done"]}	\N	\N	7	2026-11-05 02:11:06.079061+00	t
\.


--
-- Data for Name: entities; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entities (id, graph_id, title, emoji, body, body_refs, tags, created_at, updated_at, archived, body_doc, body_before_doc, props, aspects, query_refs, body_revision, body_action_id, body_changed_at) FROM stdin;
3264a4c8-1157-5c94-b403-f3848172eb01	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Еда	\N		{}	{category}	2026-11-05 02:11:21.85+00	2026-11-05 02:11:21.85+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🍔", "orbis/color": "#e0885a", "orbis/aliases": ["еда", "food", "продукты", "groceries", "обед", "lunch", "ужин", "завтрак", "кофе"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.951+00
8f118690-ee5e-53f8-920e-e4b1b5835f30	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Транспорт	\N		{}	{category}	2026-11-05 02:11:21.907+00	2026-11-05 02:11:21.907+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🚕", "orbis/color": "#5a9ee0", "orbis/aliases": ["транспорт", "transport", "такси", "метро"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.964+00
ea686e27-80f9-5d2e-96b9-58e2ad385ead	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Жильё	\N		{}	{category}	2026-11-05 02:11:21.91+00	2026-11-05 02:11:21.91+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🏠", "orbis/color": "#8a7ce0", "orbis/aliases": ["жильё", "housing", "аренда", "коммуналка"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.969+00
63cc53ae-a75f-5561-a01d-c83bab3770e4	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Здоровье	\N		{}	{category}	2026-11-05 02:11:21.912+00	2026-11-05 02:11:21.912+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💊", "orbis/color": "#e05a6f", "orbis/aliases": ["здоровье", "health", "аптека", "врач"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.973+00
fbd3291f-e490-5265-b3cb-39ba43eefe41	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Подписки	\N		{}	{category}	2026-11-05 02:11:21.916+00	2026-11-05 02:11:21.916+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🔁", "orbis/color": "#5ac8e0", "orbis/aliases": ["подписки", "subscriptions"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.978+00
0c32374a-5ffd-5747-9e43-5ee6443c72d6	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Развлечения	\N		{}	{category}	2026-11-05 02:11:21.918+00	2026-11-05 02:11:21.918+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🎉", "orbis/color": "#e05ab8", "orbis/aliases": ["развлечения", "entertainment", "бар", "кино"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.982+00
021a2e63-6989-5413-a25a-e5a64bab8d30	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Одежда	\N		{}	{category}	2026-11-05 02:11:21.921+00	2026-11-05 02:11:21.921+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "👕", "orbis/color": "#a3e05a", "orbis/aliases": ["одежда", "clothing"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.987+00
42a19f18-4104-563b-b970-f7e641613d39	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Образование	\N		{}	{category}	2026-11-05 02:11:21.925+00	2026-11-05 02:11:21.925+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "📚", "orbis/color": "#e0c35a", "orbis/aliases": ["образование", "education", "курсы", "книги"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.992+00
b7b399e6-0ace-5a4a-9165-a255ac7b68ff	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Путешествия	\N		{}	{category}	2026-11-05 02:11:21.929+00	2026-11-05 02:11:21.929+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "✈️", "orbis/color": "#5ae09e", "orbis/aliases": ["путешествия", "travel"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:21.996+00
de4030ff-4c9e-573e-bfc7-f1eff0977dd9	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Подарки	\N		{}	{category}	2026-11-05 02:11:21.934+00	2026-11-05 02:11:21.934+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🎁", "orbis/color": "#c95ae0", "orbis/aliases": ["подарки", "gifts"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.001+00
c932b35c-630f-5558-9035-46dd413801ea	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Зарплата	\N		{}	{category}	2026-11-05 02:11:21.937+00	2026-11-05 02:11:21.937+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💰", "orbis/color": "#6fe05a", "orbis/aliases": ["зарплата", "salary"]}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.006+00
40a6bfe2-e168-5a98-a4ae-21a67fe0d17f	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Фриланс	\N		{}	{category}	2026-11-05 02:11:21.942+00	2026-11-05 02:11:21.942+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💻", "orbis/color": "#5a6fe0", "orbis/aliases": ["фриланс", "freelance"]}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.011+00
48e8e9a9-9832-55d9-9c9a-5ec447099f6d	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Шаблон хоста	📄	{{title}}\n\n{{tags}}\n\n{{tabs}}\n{{tab: Запись}}\n{{cards: own}}\n\n{{body}}\n{{/tab}}\n{{tab: Детали}}\n{{cards}}\n\n{{versions}}\n\n{{subtasks}}\n\n{{blockers}}\n\n{{backlinks}}\n{{/tab}}\n{{tab: Тред}}\n{{thread}}\n{{/tab}}\n{{/tabs}}	{}	{}	2026-11-05 02:11:22.111+00	2026-11-05 02:11:22.111+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "recordBlock", "attrs": {"name": "title"}}, {"type": "recordBlock", "attrs": {"name": "tags"}}, {"type": "tabs", "content": [{"type": "tab", "attrs": {"label": "Запись"}, "content": [{"type": "ownCards"}, {"type": "recordBlock", "attrs": {"name": "body"}}]}, {"type": "tab", "attrs": {"label": "Детали"}, "content": [{"type": "recordBlock", "attrs": {"name": "cards"}}, {"type": "recordBlock", "attrs": {"name": "versions"}}, {"type": "recordBlock", "attrs": {"name": "subtasks"}}, {"type": "recordBlock", "attrs": {"name": "blockers"}}, {"type": "recordBlock", "attrs": {"name": "backlinks"}}]}, {"type": "tab", "attrs": {"label": "Тред"}, "content": [{"type": "recordBlock", "attrs": {"name": "thread"}}]}]}]}}	{{title}}\n\n{{tags}}\n\n{{tabs}}\n{{tab: Запись}}\n{{cards: own}}\n\n{{body}}\n{{/tab}}\n{{tab: Детали}}\n{{cards}}\n\n{{versions}}\n\n{{subtasks}}\n\n{{blockers}}\n\n{{backlinks}}\n{{/tab}}\n{{tab: Тред}}\n{{thread}}\n{{/tab}}\n{{/tabs}}	{"orbis/supply_key": "host-template", "orbis/supply_hash": "197e737993856a5c123160d536c23847bf2a038515caa181179ede9b19d500d4", "orbis/supply_text": "{\\"emoji\\":\\"📄\\",\\"title\\":\\"Шаблон хоста\\"}\\n\\n{{title}}\\n\\n{{tags}}\\n\\n{{tabs}}\\n{{tab: Запись}}\\n{{cards: own}}\\n\\n{{body}}\\n{{/tab}}\\n{{tab: Детали}}\\n{{cards}}\\n\\n{{versions}}\\n\\n{{subtasks}}\\n\\n{{blockers}}\\n\\n{{backlinks}}\\n{{/tab}}\\n{{tab: Тред}}\\n{{thread}}\\n{{/tab}}\\n{{/tabs}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:22.241+00
76d0f258-9065-5f64-96c6-da6f0c6278f3	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Домой	🏠	{{apps}}	{}	{}	2026-11-05 02:11:22.145+00	2026-11-05 02:11:22.145+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "hostBlock", "attrs": {"name": "apps"}}]}}	{{apps}}	{"orbis/supply_key": "home", "orbis/supply_hash": "b5dde645338fae89aa6eadd88bee6d93048a3985fd00604f5fe3241d6dd3b5f3", "orbis/supply_text": "{\\"emoji\\":\\"🏠\\",\\"title\\":\\"Домой\\"}\\n\\n{{apps}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:22.248+00
a5b240dc-ed62-5489-9fe0-29e9b7b21d8e	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Записи	🗂️	{{records}}	{}	{}	2026-11-05 02:11:22.152+00	2026-11-05 02:11:22.152+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "hostBlock", "attrs": {"name": "records"}}]}}	{{records}}	{"orbis/supply_key": "records", "orbis/supply_hash": "83ff6cba6a2fdf5219ee6f90e1461f4d3bb957ced5727524c83d594a7b40081c", "orbis/supply_text": "{\\"emoji\\":\\"🗂️\\",\\"title\\":\\"Записи\\"}\\n\\n{{records}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:22.255+00
a45e806b-517d-5372-a5bb-a599fcab6e6b	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Daily Planning	☀️	Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\n\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\n\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\n\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}	{}	{}	2026-11-05 02:11:22.163+00	2026-11-05 02:11:22.163+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Inbox", "filter": {"and": [{"aspect": "orbis/task"}, {"op": "eq", "prop": "orbis/task_status", "value": "inbox"}]}, "sortBy": [{"dir": "desc", "field": "orbis/created_at"}], "display": "list"}, "text": "aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Сегодня", "filter": {"and": [{"aspect": "orbis/task"}, {"or": [{"op": "eq", "prop": "orbis/due_date", "value": {"token": "today"}}, {"op": "eq", "prop": "orbis/due_date", "value": {"token": "overdue"}}]}, {"class": {"set": "open", "contract": "orbis/completable"}}, {"not": {"op": "eq", "prop": "orbis/task_status", "value": "waiting"}}, {"not": {"rel": {"via": "dependency", "kind": "has_relation", "sourceNotIn": {"set": "closed", "contract": "orbis/completable"}}}}]}, "sortBy": [{"dir": "desc", "field": "orbis/priority"}, {"dir": "asc", "field": "orbis/due_date"}], "display": "list"}, "text": "aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ожидание", "filter": {"and": [{"aspect": "orbis/task"}, {"op": "eq", "prop": "orbis/task_status", "value": "waiting"}]}, "sortBy": [{"dir": "asc", "field": "orbis/updated_at"}], "display": "compact"}, "text": "aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание"}}]}}	Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\n\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\n\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\n\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}	{"orbis/supply_key": "daily-planning", "orbis/supply_hash": "d17e7892b46a44622091e168a4d9ee7dd6857d2f5c98508f986fb6cdd097e3ef", "orbis/supply_text": "{\\"emoji\\":\\"☀️\\",\\"title\\":\\"Daily Planning\\"}\\n\\nУтренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\\n\\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\\n\\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\\n\\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}"}	{orbis/page,orbis/supply}	{orbis/created_at,orbis/task_status,orbis/task,orbis/due_date,orbis/priority,dependency,orbis/updated_at}	1	\N	2026-11-05 02:11:22.262+00
35fd6695-1b7b-548e-966b-3bdaae9b0446	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Повестка	🗓️	Всё, что во времени: встречи, сроки и сделанное — по дням.\n\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\n\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\n\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\n\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}	{}	{}	2026-11-05 02:11:22.173+00	2026-11-05 02:11:22.173+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Всё, что во времени: встречи, сроки и сделанное — по дням.", "type": "text"}]}, {"type": "paramBlock", "attrs": {"text": "{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Просрочено", "filter": {"and": [{"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"token": "overdue"}}, {"class": {"set": "open", "contract": "orbis/completable"}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "sortBy": [{"dir": "asc", "field": {"contract": "orbis/when"}}], "display": "list", "hideEmpty": true}, "text": "orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено"}}, {"type": "queryBlock", "attrs": {"ast": {"group": {"by": "day", "field": {"contract": "orbis/when"}}, "filter": {"and": [{"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "display": "list"}, "text": "orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list"}}, {"type": "queryBlock", "attrs": {"ast": {"limit": 30, "title": "Дальше", "filter": {"and": [{"op": "gt", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}, {"not": {"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "sortBy": [{"dir": "asc", "field": {"contract": "orbis/when"}}], "display": "compact"}, "text": "orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше"}}]}}	Всё, что во времени: встречи, сроки и сделанное — по дням.\n\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\n\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\n\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\n\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}	{"orbis/supply_key": "agenda", "orbis/supply_hash": "3b250681a2e6d238a4e01c3cb48def7b5085ff6f25d4d0ef418d444a4608035b", "orbis/supply_text": "{\\"emoji\\":\\"🗓️\\",\\"title\\":\\"Повестка\\"}\\n\\nВсё, что во времени: встречи, сроки и сделанное — по дням.\\n\\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\\n\\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\\n\\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\\n\\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:22.268+00
22732249-3f87-5802-b701-f3767ef336bd	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	All Tasks	📋	{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title="Все незакрытые задачи"}}	{}	{}	2026-11-05 02:11:22.183+00	2026-11-05 02:11:22.183+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "queryBlock", "attrs": {"ast": {"title": "Все незакрытые задачи", "filter": {"and": [{"aspect": "orbis/task"}, {"class": {"set": "open", "contract": "orbis/completable"}}]}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title=\\"Все незакрытые задачи\\""}}]}}	{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title="Все незакрытые задачи"}}	{"orbis/supply_key": "all-tasks", "orbis/supply_hash": "c553d69e740e9876a3143b5b214e9c46b9149d89dae0aadfabd4a36ca99de7a7", "orbis/supply_text": "{\\"emoji\\":\\"📋\\",\\"title\\":\\"All Tasks\\"}\\n\\n{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title=\\"Все незакрытые задачи\\"}}"}	{orbis/page,orbis/supply}	{orbis/updated_at,orbis/task}	1	\N	2026-11-05 02:11:22.277+00
e57ff285-60b1-587d-9504-854fa5ada148	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Год	🎯	Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\n\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\n\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}	{}	{}	2026-11-05 02:11:22.191+00	2026-11-05 02:11:22.191+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Лестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Цели", "filter": {"aspect": "orbis/goal"}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели"}}]}}	Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\n\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\n\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}	{"orbis/supply_key": "horizon-year", "orbis/supply_hash": "cec95cd1a7d51ff6e69aba761eae53b78025f1296213c79d60c887487c05c54f", "orbis/supply_text": "{\\"emoji\\":\\"🎯\\",\\"title\\":\\"Год\\"}\\n\\nГоризонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\\n\\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\\n\\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}"}	{orbis/page,orbis/supply}	{orbis/updated_at,orbis/goal}	1	\N	2026-11-05 02:11:22.283+00
8852360d-6a9d-5944-b06e-16ddab2a9cae	469c6a1e-320a-4d24-bdda-e8c070b816cd	Жильё	\N		{}	{category}	2026-11-05 02:11:22.79+00	2026-11-05 02:11:22.79+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🏠", "orbis/color": "#8a7ce0", "orbis/aliases": ["жильё", "housing", "аренда", "коммуналка"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.829+00
e00b101b-1d2c-5616-9a3f-2cf3f492c33d	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Жизнь	🧭	Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\n\n- **Ценности** — что должно остаться правдой про меня через десять лет?\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\n\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\n\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}	{}	{}	2026-11-05 02:11:22.202+00	2026-11-05 02:11:22.202+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ценности", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — что должно остаться правдой про меня через десять лет?", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Зоны ответственности", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Отказы", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — от чего отказываюсь в этом году, чтобы освободить место остальному?", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Ответы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ценности и зоны ответственности", "filter": {"tag": "life"}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "tags=life, sortBy=orbis/updated_at:desc, display=list, title=\\"Ценности и зоны ответственности\\""}}]}}	Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\n\n- **Ценности** — что должно остаться правдой про меня через десять лет?\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\n\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\n\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}	{"orbis/supply_key": "horizon-life", "orbis/supply_hash": "0a574ad0c64cc24f60e91c68cf941d86551439d38a2b6898aa4e0ad7fb7d3845", "orbis/supply_text": "{\\"emoji\\":\\"🧭\\",\\"title\\":\\"Жизнь\\"}\\n\\nГоризонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\\n\\n- **Ценности** — что должно остаться правдой про меня через десять лет?\\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\\n\\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\\n\\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title=\\"Ценности и зоны ответственности\\"}}"}	{orbis/page,orbis/supply}	{orbis/updated_at}	1	\N	2026-11-05 02:11:22.29+00
8476068d-5802-521b-94b7-eca3a332ee2c	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Рутины	⏰	Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\n\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title="Ждут ответа"}}\n\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title="Активные рутины"}}\n\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title="Пачка решений"}}	{}	{}	2026-11-05 02:11:22.22+00	2026-11-05 02:11:22.22+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ждут ответа", "filter": {"and": [{"aspect": "orbis/agent-run"}, {"op": "eq", "prop": "orbis/run_outcome", "value": "checkpoint"}]}, "sortBy": [{"dir": "asc", "field": "orbis/run_started_at"}], "display": "list"}, "text": "aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title=\\"Ждут ответа\\""}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Активные рутины", "filter": {"and": [{"aspect": "orbis/routine"}, {"op": "eq", "prop": "orbis/routine_stage", "value": "active"}]}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title=\\"Активные рутины\\""}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Пачка решений", "filter": {"and": [{"aspect": "orbis/agent-run"}, {"op": "eq", "prop": "orbis/undecided", "value": true}]}, "sortBy": [{"dir": "asc", "field": "orbis/run_started_at"}], "display": "list"}, "text": "aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title=\\"Пачка решений\\""}}]}}	Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\n\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title="Ждут ответа"}}\n\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title="Активные рутины"}}\n\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title="Пачка решений"}}	{"orbis/supply_key": "routines", "orbis/supply_hash": "3fa734d26c7a48cc20fa5c0ea10956caf0b551e9b1b6229b61d727cf060f1af6", "orbis/supply_text": "{\\"emoji\\":\\"⏰\\",\\"title\\":\\"Рутины\\"}\\n\\nРутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\\n\\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title=\\"Ждут ответа\\"}}\\n\\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title=\\"Активные рутины\\"}}\\n\\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title=\\"Пачка решений\\"}}"}	{orbis/page,orbis/supply}	{orbis/run_started_at,orbis/run_outcome,orbis/agent-run,orbis/updated_at,orbis/routine_stage,orbis/routine,orbis/undecided}	1	\N	2026-11-05 02:11:22.301+00
99a4d5f1-5ff3-546e-ac7d-7c0c6f19c753	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Садовник словаря	🌿	Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.\n\nШаг 1. Дубли.\n\n- Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).\n- Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.\n- Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.\n- Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.\n- Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.\n- За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.\n\nШаг 2. Сироты.\n\n- Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.\n- Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.\n\nШаг 3. Залежавшиеся предложения.\n\n- Возьми property_catalog со status: "proposed" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.\n- Их тоже не трогай: их судьбу решает владелец.\n\nОтчёт (финальный текст хода, его владелец прочтёт на экране прогона):\n\n- что предложил слить и почему («X» и «Y» — одно и то же, потому что …);\n- список сирот подписями, с числом носителей и значений;\n- список предложений старше 14 дней подписями, с возрастом в днях.\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.	{}	{routine}	2026-11-05 02:11:22.338+00	2026-11-05 02:11:22.338+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Шаг 1. Дубли.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 2. Сироты.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 3. Залежавшиеся предложения.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми property_catalog со status: \\"proposed\\" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Их тоже не трогай: их судьбу решает владелец.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Отчёт (финальный текст хода, его владелец прочтёт на экране прогона):", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "что предложил слить и почему («X» и «Y» — одно и то же, потому что …);", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "список сирот подписями, с числом носителей и значений;", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "список предложений старше 14 дней подписями, с возрастом в днях.\\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.", "type": "text"}]}]}]}]}}	Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.\n\nШаг 1. Дубли.\n\n- Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).\n- Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.\n- Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.\n- Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.\n- Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.\n- За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.\n\nШаг 2. Сироты.\n\n- Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.\n- Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.\n\nШаг 3. Залежавшиеся предложения.\n\n- Возьми property_catalog со status: "proposed" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.\n- Их тоже не трогай: их судьбу решает владелец.\n\nОтчёт (финальный текст хода, его владелец прочтёт на экране прогона):\n\n- что предложил слить и почему («X» и «Y» — одно и то же, потому что …);\n- список сирот подписями, с числом носителей и значений;\n- список предложений старше 14 дней подписями, с возрастом в днях.\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.	{"orbis/routine_at": "09:00", "orbis/routine_days": ["mo"], "orbis/routine_mode": "act", "orbis/allowed_tools": ["property_merge"], "orbis/routine_stage": "active"}	{orbis/routine}	{}	1	\N	2026-11-05 02:11:22.364+00
3d71b946-c7e6-57e0-be45-dfd0e5d80bc7	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Перенос остатков	🔁	Ты переносишь остатки бюджета в новый месяц.\n\nШаг 0. Календарь.\n\n- Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».\n\nШаг 1. Прошлый месяц.\n\n- Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).\n- Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.\n- Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover "0.00") и назови такие категории в отчёте.\n\nШаг 2. Перенос.\n\n- Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.\n- Суммы не округляй и не досчитывай: бери их как есть из budget_status.\n- Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.\n\nОтчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.	{}	{routine}	2026-11-05 02:11:22.397+00	2026-11-05 02:11:22.397+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Ты переносишь остатки бюджета в новый месяц.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Шаг 0. Календарь.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 1. Прошлый месяц.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover \\"0.00\\") и назови такие категории в отчёте.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 2. Перенос.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Суммы не округляй и не досчитывай: бери их как есть из budget_status.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Отчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.", "type": "text"}]}]}}	Ты переносишь остатки бюджета в новый месяц.\n\nШаг 0. Календарь.\n\n- Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».\n\nШаг 1. Прошлый месяц.\n\n- Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).\n- Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.\n- Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover "0.00") и назови такие категории в отчёте.\n\nШаг 2. Перенос.\n\n- Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.\n- Суммы не округляй и не досчитывай: бери их как есть из budget_status.\n- Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.\n\nОтчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.	{"orbis/routine_at": "09:00", "orbis/routine_mode": "act", "orbis/allowed_tools": ["budget_rollover"], "orbis/routine_stage": "paused"}	{orbis/routine}	{}	1	\N	2026-11-05 02:11:22.412+00
53153bf3-d362-5584-b0e6-a800c660b3c5	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Orbis	🪐		{}	{}	2026-11-05 02:11:22.549+00	2026-11-05 02:11:22.549+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/app_nav": ["a5b240dc-ed62-5489-9fe0-29e9b7b21d8e", "a45e806b-517d-5372-a5bb-a599fcab6e6b", "35fd6695-1b7b-548e-966b-3bdaae9b0446", "22732249-3f87-5802-b701-f3767ef336bd", "e57ff285-60b1-587d-9504-854fa5ada148", "8476068d-5802-521b-94b7-eca3a332ee2c"], "orbis/app_home": "76d0f258-9065-5f64-96c6-da6f0c6278f3", "orbis/supply_key": "host-shell", "orbis/supply_hash": "ae12b469dbce5e092f33feb1903cd4413977a5675009cb020170c37f865775f1", "orbis/supply_text": "{\\n  \\"emoji\\": \\"🪐\\",\\n  \\"props\\": {\\n    \\"orbis/app_home\\": \\"76d0f258-9065-5f64-96c6-da6f0c6278f3\\",\\n    \\"orbis/app_nav\\": [\\n      \\"a5b240dc-ed62-5489-9fe0-29e9b7b21d8e\\",\\n      \\"a45e806b-517d-5372-a5bb-a599fcab6e6b\\",\\n      \\"35fd6695-1b7b-548e-966b-3bdaae9b0446\\",\\n      \\"22732249-3f87-5802-b701-f3767ef336bd\\",\\n      \\"e57ff285-60b1-587d-9504-854fa5ada148\\",\\n      \\"8476068d-5802-521b-94b7-eca3a332ee2c\\"\\n    ],\\n    \\"orbis/app_nav_form\\": \\"header-list\\"\\n  },\\n  \\"title\\": \\"Orbis\\"\\n}", "orbis/app_nav_form": "header-list"}	{orbis/app,orbis/supply}	{}	1	\N	2026-11-05 02:11:22.571+00
be77ec68-b273-5780-b5fa-7ef9c6fa3416	469c6a1e-320a-4d24-bdda-e8c070b816cd	Еда	\N		{}	{category}	2026-11-05 02:11:22.785+00	2026-11-05 02:11:22.785+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🍔", "orbis/color": "#e0885a", "orbis/aliases": ["еда", "food", "продукты", "groceries", "обед", "lunch", "ужин", "завтрак", "кофе"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.819+00
8ee37264-b200-5b32-82c4-320f698702ec	469c6a1e-320a-4d24-bdda-e8c070b816cd	Транспорт	\N		{}	{category}	2026-11-05 02:11:22.788+00	2026-11-05 02:11:22.788+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🚕", "orbis/color": "#5a9ee0", "orbis/aliases": ["транспорт", "transport", "такси", "метро"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.824+00
66979037-157c-50d1-bd54-5dd53f992dc6	469c6a1e-320a-4d24-bdda-e8c070b816cd	Здоровье	\N		{}	{category}	2026-11-05 02:11:22.793+00	2026-11-05 02:11:22.793+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💊", "orbis/color": "#e05a6f", "orbis/aliases": ["здоровье", "health", "аптека", "врач"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.835+00
94cfb158-83e9-5e08-bafe-d64560a8a546	469c6a1e-320a-4d24-bdda-e8c070b816cd	Подписки	\N		{}	{category}	2026-11-05 02:11:22.795+00	2026-11-05 02:11:22.795+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🔁", "orbis/color": "#5ac8e0", "orbis/aliases": ["подписки", "subscriptions"], "orbis/spend_class": "fixed"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.84+00
83096c28-5c95-58df-8fc8-ff6f4e86013a	469c6a1e-320a-4d24-bdda-e8c070b816cd	Развлечения	\N		{}	{category}	2026-11-05 02:11:22.797+00	2026-11-05 02:11:22.797+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🎉", "orbis/color": "#e05ab8", "orbis/aliases": ["развлечения", "entertainment", "бар", "кино"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.844+00
2c87e7f6-b0a3-59f4-aa0e-98c0a569e94b	469c6a1e-320a-4d24-bdda-e8c070b816cd	Одежда	\N		{}	{category}	2026-11-05 02:11:22.8+00	2026-11-05 02:11:22.8+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "👕", "orbis/color": "#a3e05a", "orbis/aliases": ["одежда", "clothing"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.848+00
63a4ebcd-e245-51d4-a3af-f579e5d3d78d	469c6a1e-320a-4d24-bdda-e8c070b816cd	Образование	\N		{}	{category}	2026-11-05 02:11:22.802+00	2026-11-05 02:11:22.802+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "📚", "orbis/color": "#e0c35a", "orbis/aliases": ["образование", "education", "курсы", "книги"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.852+00
3e45a779-60b9-5c78-9ee3-66c2bee9a310	469c6a1e-320a-4d24-bdda-e8c070b816cd	Путешествия	\N		{}	{category}	2026-11-05 02:11:22.805+00	2026-11-05 02:11:22.805+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "✈️", "orbis/color": "#5ae09e", "orbis/aliases": ["путешествия", "travel"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.856+00
350d7431-2f27-5133-89ff-c40b43308f28	469c6a1e-320a-4d24-bdda-e8c070b816cd	Подарки	\N		{}	{category}	2026-11-05 02:11:22.807+00	2026-11-05 02:11:22.807+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "🎁", "orbis/color": "#c95ae0", "orbis/aliases": ["подарки", "gifts"], "orbis/spend_class": "discretionary"}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.861+00
46432280-b294-5ce5-b26a-3b038699a534	469c6a1e-320a-4d24-bdda-e8c070b816cd	Зарплата	\N		{}	{category}	2026-11-05 02:11:22.81+00	2026-11-05 02:11:22.81+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💰", "orbis/color": "#6fe05a", "orbis/aliases": ["зарплата", "salary"]}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.866+00
da958d8c-4a01-598a-b37a-5b9d7af30d71	469c6a1e-320a-4d24-bdda-e8c070b816cd	Фриланс	\N		{}	{category}	2026-11-05 02:11:22.813+00	2026-11-05 02:11:22.813+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/icon": "💻", "orbis/color": "#5a6fe0", "orbis/aliases": ["фриланс", "freelance"]}	{orbis/category}	{}	1	\N	2026-11-05 02:11:22.87+00
6daf35f0-7485-5637-af4a-4d695f4caaf7	469c6a1e-320a-4d24-bdda-e8c070b816cd	Шаблон хоста	📄	{{title}}\n\n{{tags}}\n\n{{tabs}}\n{{tab: Запись}}\n{{cards: own}}\n\n{{body}}\n{{/tab}}\n{{tab: Детали}}\n{{cards}}\n\n{{versions}}\n\n{{subtasks}}\n\n{{blockers}}\n\n{{backlinks}}\n{{/tab}}\n{{tab: Тред}}\n{{thread}}\n{{/tab}}\n{{/tabs}}	{}	{}	2026-11-05 02:11:22.922+00	2026-11-05 02:11:22.922+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "recordBlock", "attrs": {"name": "title"}}, {"type": "recordBlock", "attrs": {"name": "tags"}}, {"type": "tabs", "content": [{"type": "tab", "attrs": {"label": "Запись"}, "content": [{"type": "ownCards"}, {"type": "recordBlock", "attrs": {"name": "body"}}]}, {"type": "tab", "attrs": {"label": "Детали"}, "content": [{"type": "recordBlock", "attrs": {"name": "cards"}}, {"type": "recordBlock", "attrs": {"name": "versions"}}, {"type": "recordBlock", "attrs": {"name": "subtasks"}}, {"type": "recordBlock", "attrs": {"name": "blockers"}}, {"type": "recordBlock", "attrs": {"name": "backlinks"}}]}, {"type": "tab", "attrs": {"label": "Тред"}, "content": [{"type": "recordBlock", "attrs": {"name": "thread"}}]}]}]}}	{{title}}\n\n{{tags}}\n\n{{tabs}}\n{{tab: Запись}}\n{{cards: own}}\n\n{{body}}\n{{/tab}}\n{{tab: Детали}}\n{{cards}}\n\n{{versions}}\n\n{{subtasks}}\n\n{{blockers}}\n\n{{backlinks}}\n{{/tab}}\n{{tab: Тред}}\n{{thread}}\n{{/tab}}\n{{/tabs}}	{"orbis/supply_key": "host-template", "orbis/supply_hash": "197e737993856a5c123160d536c23847bf2a038515caa181179ede9b19d500d4", "orbis/supply_text": "{\\"emoji\\":\\"📄\\",\\"title\\":\\"Шаблон хоста\\"}\\n\\n{{title}}\\n\\n{{tags}}\\n\\n{{tabs}}\\n{{tab: Запись}}\\n{{cards: own}}\\n\\n{{body}}\\n{{/tab}}\\n{{tab: Детали}}\\n{{cards}}\\n\\n{{versions}}\\n\\n{{subtasks}}\\n\\n{{blockers}}\\n\\n{{backlinks}}\\n{{/tab}}\\n{{tab: Тред}}\\n{{thread}}\\n{{/tab}}\\n{{/tabs}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:23.008+00
61af277b-2ed5-592c-9074-410126aa8880	469c6a1e-320a-4d24-bdda-e8c070b816cd	Домой	🏠	{{apps}}	{}	{}	2026-11-05 02:11:22.932+00	2026-11-05 02:11:22.932+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "hostBlock", "attrs": {"name": "apps"}}]}}	{{apps}}	{"orbis/supply_key": "home", "orbis/supply_hash": "b5dde645338fae89aa6eadd88bee6d93048a3985fd00604f5fe3241d6dd3b5f3", "orbis/supply_text": "{\\"emoji\\":\\"🏠\\",\\"title\\":\\"Домой\\"}\\n\\n{{apps}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:23.012+00
3e2fef47-0983-5bed-939e-26a430695ca3	469c6a1e-320a-4d24-bdda-e8c070b816cd	Записи	🗂️	{{records}}	{}	{}	2026-11-05 02:11:22.94+00	2026-11-05 02:11:22.94+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "hostBlock", "attrs": {"name": "records"}}]}}	{{records}}	{"orbis/supply_key": "records", "orbis/supply_hash": "83ff6cba6a2fdf5219ee6f90e1461f4d3bb957ced5727524c83d594a7b40081c", "orbis/supply_text": "{\\"emoji\\":\\"🗂️\\",\\"title\\":\\"Записи\\"}\\n\\n{{records}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:23.019+00
01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Restore A	\N	Synthetic recent body	{}	{}	2026-11-05 02:11:23.243+00	2026-11-05 02:11:27.296+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Synthetic recent body", "type": "text"}]}]}}	Synthetic source body	{}	{}	{}	3	01a1a979-a28b-749a-beca-01a177eae26c	2026-11-05 02:11:27.298+00
7c3326d1-5416-51c8-b4a2-c0673b80f044	469c6a1e-320a-4d24-bdda-e8c070b816cd	Daily Planning	☀️	Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\n\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\n\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\n\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}	{}	{}	2026-11-05 02:11:22.949+00	2026-11-05 02:11:22.949+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Inbox", "filter": {"and": [{"aspect": "orbis/task"}, {"op": "eq", "prop": "orbis/task_status", "value": "inbox"}]}, "sortBy": [{"dir": "desc", "field": "orbis/created_at"}], "display": "list"}, "text": "aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Сегодня", "filter": {"and": [{"aspect": "orbis/task"}, {"or": [{"op": "eq", "prop": "orbis/due_date", "value": {"token": "today"}}, {"op": "eq", "prop": "orbis/due_date", "value": {"token": "overdue"}}]}, {"class": {"set": "open", "contract": "orbis/completable"}}, {"not": {"op": "eq", "prop": "orbis/task_status", "value": "waiting"}}, {"not": {"rel": {"via": "dependency", "kind": "has_relation", "sourceNotIn": {"set": "closed", "contract": "orbis/completable"}}}}]}, "sortBy": [{"dir": "desc", "field": "orbis/priority"}, {"dir": "asc", "field": "orbis/due_date"}], "display": "list"}, "text": "aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ожидание", "filter": {"and": [{"aspect": "orbis/task"}, {"op": "eq", "prop": "orbis/task_status", "value": "waiting"}]}, "sortBy": [{"dir": "asc", "field": "orbis/updated_at"}], "display": "compact"}, "text": "aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание"}}]}}	Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\n\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\n\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\n\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}	{"orbis/supply_key": "daily-planning", "orbis/supply_hash": "d17e7892b46a44622091e168a4d9ee7dd6857d2f5c98508f986fb6cdd097e3ef", "orbis/supply_text": "{\\"emoji\\":\\"☀️\\",\\"title\\":\\"Daily Planning\\"}\\n\\nУтренний обзор: разобрать Inbox, пройтись по списку «Сегодня».\\n\\n{{query:aspect=orbis/task, orbis/task_status=inbox, sortBy=orbis/created_at:desc, display=list, title=Inbox}}\\n\\n{{query:aspect=orbis/task, orbis/due_date=today|overdue, class=orbis/completable:open, orbis/task_status=!waiting, excludeBlocked=true, sortBy=orbis/priority:desc|orbis/due_date:asc, display=list, title=Сегодня}}\\n\\n{{query:aspect=orbis/task, orbis/task_status=waiting, sortBy=orbis/updated_at:asc, display=compact, title=Ожидание}}"}	{orbis/page,orbis/supply}	{orbis/created_at,orbis/task_status,orbis/task,orbis/due_date,orbis/priority,dependency,orbis/updated_at}	1	\N	2026-11-05 02:11:23.024+00
f3cb3be0-0a48-5471-8f01-fa5308e529bd	469c6a1e-320a-4d24-bdda-e8c070b816cd	Повестка	🗓️	Всё, что во времени: встречи, сроки и сделанное — по дням.\n\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\n\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\n\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\n\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}	{}	{}	2026-11-05 02:11:22.959+00	2026-11-05 02:11:22.959+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Всё, что во времени: встречи, сроки и сделанное — по дням.", "type": "text"}]}, {"type": "paramBlock", "attrs": {"text": "{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}"}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Просрочено", "filter": {"and": [{"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"token": "overdue"}}, {"class": {"set": "open", "contract": "orbis/completable"}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "sortBy": [{"dir": "asc", "field": {"contract": "orbis/when"}}], "display": "list", "hideEmpty": true}, "text": "orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено"}}, {"type": "queryBlock", "attrs": {"ast": {"group": {"by": "day", "field": {"contract": "orbis/when"}}, "filter": {"and": [{"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "display": "list"}, "text": "orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list"}}, {"type": "queryBlock", "attrs": {"ast": {"limit": 30, "title": "Дальше", "filter": {"and": [{"op": "gt", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}, {"not": {"op": "eq", "prop": {"contract": "orbis/when"}, "value": {"param": "period"}}}, {"not": {"class": {"set": "templates", "contract": "orbis/recurrence"}}}]}, "sortBy": [{"dir": "asc", "field": {"contract": "orbis/when"}}], "display": "compact"}, "text": "orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше"}}]}}	Всё, что во времени: встречи, сроки и сделанное — по дням.\n\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\n\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\n\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\n\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}	{"orbis/supply_key": "agenda", "orbis/supply_hash": "3b250681a2e6d238a4e01c3cb48def7b5085ff6f25d4d0ef418d444a4608035b", "orbis/supply_text": "{\\"emoji\\":\\"🗓️\\",\\"title\\":\\"Повестка\\"}\\n\\nВсё, что во времени: встречи, сроки и сделанное — по дням.\\n\\n{{param: period, type=period, default=next_7d, options=next_7d|next_14d, title=Горизонт}}\\n\\n{{query:orbis/when=overdue, class=orbis/completable:open, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, display=list, hide_empty, title=Просрочено}}\\n\\n{{query:orbis/when=$period, !class=orbis/recurrence:templates, group=day:orbis/when, display=list}}\\n\\n{{query:orbis/when>$period, orbis/when=!$period, !class=orbis/recurrence:templates, sortBy=orbis/when:asc, limit=30, display=compact, title=Дальше}}"}	{orbis/page,orbis/supply}	{}	1	\N	2026-11-05 02:11:23.029+00
18331aa2-1bc8-51c1-bd62-6dde3f83cdbe	469c6a1e-320a-4d24-bdda-e8c070b816cd	All Tasks	📋	{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title="Все незакрытые задачи"}}	{}	{}	2026-11-05 02:11:22.967+00	2026-11-05 02:11:22.967+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "queryBlock", "attrs": {"ast": {"title": "Все незакрытые задачи", "filter": {"and": [{"aspect": "orbis/task"}, {"class": {"set": "open", "contract": "orbis/completable"}}]}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title=\\"Все незакрытые задачи\\""}}]}}	{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title="Все незакрытые задачи"}}	{"orbis/supply_key": "all-tasks", "orbis/supply_hash": "c553d69e740e9876a3143b5b214e9c46b9149d89dae0aadfabd4a36ca99de7a7", "orbis/supply_text": "{\\"emoji\\":\\"📋\\",\\"title\\":\\"All Tasks\\"}\\n\\n{{query:aspect=orbis/task, class=orbis/completable:open, sortBy=orbis/updated_at:desc, display=list, title=\\"Все незакрытые задачи\\"}}"}	{orbis/page,orbis/supply}	{orbis/updated_at,orbis/task}	1	\N	2026-11-05 02:11:23.035+00
bdddb983-03bb-5441-9fbc-250580c758b8	469c6a1e-320a-4d24-bdda-e8c070b816cd	Год	🎯	Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\n\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\n\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}	{}	{}	2026-11-05 02:11:22.977+00	2026-11-05 02:11:22.977+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Лестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Цели", "filter": {"aspect": "orbis/goal"}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели"}}]}}	Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\n\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\n\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}	{"orbis/supply_key": "horizon-year", "orbis/supply_hash": "cec95cd1a7d51ff6e69aba761eae53b78025f1296213c79d60c887487c05c54f", "orbis/supply_text": "{\\"emoji\\":\\"🎯\\",\\"title\\":\\"Год\\"}\\n\\nГоризонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — записями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.\\n\\nЛестница горизонтов целиком: день — список «Daily Planning», неделя и две — «Повестка», год — этот список, жизнь — список «Жизнь». «Жизни» нет в навигации хоста: её находят поиском.\\n\\n{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}"}	{orbis/page,orbis/supply}	{orbis/updated_at,orbis/goal}	1	\N	2026-11-05 02:11:23.039+00
90c49486-f103-57b8-8c5a-77744ffb85c0	469c6a1e-320a-4d24-bdda-e8c070b816cd	Жизнь	🧭	Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\n\n- **Ценности** — что должно остаться правдой про меня через десять лет?\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\n\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\n\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}	{}	{}	2026-11-05 02:11:22.985+00	2026-11-05 02:11:22.985+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ценности", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — что должно остаться правдой про меня через десять лет?", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Зоны ответственности", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Отказы", "type": "text", "marks": [{"type": "bold"}]}, {"text": " — от чего отказываюсь в этом году, чтобы освободить место остальному?", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Ответы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ценности и зоны ответственности", "filter": {"tag": "life"}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "tags=life, sortBy=orbis/updated_at:desc, display=list, title=\\"Ценности и зоны ответственности\\""}}]}}	Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\n\n- **Ценности** — что должно остаться правдой про меня через десять лет?\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\n\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\n\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}	{"orbis/supply_key": "horizon-life", "orbis/supply_hash": "0a574ad0c64cc24f60e91c68cf941d86551439d38a2b6898aa4e0ad7fb7d3845", "orbis/supply_text": "{\\"emoji\\":\\"🧭\\",\\"title\\":\\"Жизнь\\"}\\n\\nГоризонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.\\n\\n- **Ценности** — что должно остаться правдой про меня через десять лет?\\n- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?\\n- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?\\n\\nОтветы держите отдельными записями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной записи, блок честно покажет «ничего не найдено».\\n\\n{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title=\\"Ценности и зоны ответственности\\"}}"}	{orbis/page,orbis/supply}	{orbis/updated_at}	1	\N	2026-11-05 02:11:23.043+00
171a596b-921d-58d7-a834-71a80aee77c0	469c6a1e-320a-4d24-bdda-e8c070b816cd	Рутины	⏰	Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\n\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title="Ждут ответа"}}\n\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title="Активные рутины"}}\n\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title="Пачка решений"}}	{}	{}	2026-11-05 02:11:22.997+00	2026-11-05 02:11:22.997+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.", "type": "text"}]}, {"type": "queryBlock", "attrs": {"ast": {"title": "Ждут ответа", "filter": {"and": [{"aspect": "orbis/agent-run"}, {"op": "eq", "prop": "orbis/run_outcome", "value": "checkpoint"}]}, "sortBy": [{"dir": "asc", "field": "orbis/run_started_at"}], "display": "list"}, "text": "aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title=\\"Ждут ответа\\""}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Активные рутины", "filter": {"and": [{"aspect": "orbis/routine"}, {"op": "eq", "prop": "orbis/routine_stage", "value": "active"}]}, "sortBy": [{"dir": "desc", "field": "orbis/updated_at"}], "display": "list"}, "text": "aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title=\\"Активные рутины\\""}}, {"type": "queryBlock", "attrs": {"ast": {"title": "Пачка решений", "filter": {"and": [{"aspect": "orbis/agent-run"}, {"op": "eq", "prop": "orbis/undecided", "value": true}]}, "sortBy": [{"dir": "asc", "field": "orbis/run_started_at"}], "display": "list"}, "text": "aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title=\\"Пачка решений\\""}}]}}	Рутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\n\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title="Ждут ответа"}}\n\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title="Активные рутины"}}\n\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title="Пачка решений"}}	{"orbis/supply_key": "routines", "orbis/supply_hash": "3fa734d26c7a48cc20fa5c0ea10956caf0b551e9b1b6229b61d727cf060f1af6", "orbis/supply_text": "{\\"emoji\\":\\"⏰\\",\\"title\\":\\"Рутины\\"}\\n\\nРутины — то, что Orbis делает сам по расписанию, и то, что ждёт вашего ответа.\\n\\n{{query:aspect=orbis/agent-run, orbis/run_outcome=checkpoint, sortBy=orbis/run_started_at:asc, display=list, title=\\"Ждут ответа\\"}}\\n\\n{{query:aspect=orbis/routine, orbis/routine_stage=active, sortBy=orbis/updated_at:desc, display=list, title=\\"Активные рутины\\"}}\\n\\n{{query:aspect=orbis/agent-run, orbis/undecided=true, sortBy=orbis/run_started_at:asc, display=list, title=\\"Пачка решений\\"}}"}	{orbis/page,orbis/supply}	{orbis/run_started_at,orbis/run_outcome,orbis/agent-run,orbis/updated_at,orbis/routine_stage,orbis/routine,orbis/undecided}	1	\N	2026-11-05 02:11:23.047+00
f34bc6e7-3bd3-58a5-b280-bfca1b476029	469c6a1e-320a-4d24-bdda-e8c070b816cd	Садовник словаря	🌿	Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.\n\nШаг 1. Дубли.\n\n- Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).\n- Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.\n- Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.\n- Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.\n- Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.\n- За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.\n\nШаг 2. Сироты.\n\n- Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.\n- Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.\n\nШаг 3. Залежавшиеся предложения.\n\n- Возьми property_catalog со status: "proposed" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.\n- Их тоже не трогай: их судьбу решает владелец.\n\nОтчёт (финальный текст хода, его владелец прочтёт на экране прогона):\n\n- что предложил слить и почему («X» и «Y» — одно и то же, потому что …);\n- список сирот подписями, с числом носителей и значений;\n- список предложений старше 14 дней подписями, с возрастом в днях.\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.	{}	{routine}	2026-11-05 02:11:23.067+00	2026-11-05 02:11:23.067+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Шаг 1. Дубли.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 2. Сироты.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 3. Залежавшиеся предложения.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми property_catalog со status: \\"proposed\\" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Их тоже не трогай: их судьбу решает владелец.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Отчёт (финальный текст хода, его владелец прочтёт на экране прогона):", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "что предложил слить и почему («X» и «Y» — одно и то же, потому что …);", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "список сирот подписями, с числом носителей и значений;", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "список предложений старше 14 дней подписями, с возрастом в днях.\\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.", "type": "text"}]}]}]}]}}	Ты — садовник словаря свойств. Раз в неделю приводишь его в порядок: сводишь дубли и рассказываешь владельцу о том, что в нём залежалось.\n\nШаг 1. Дубли.\n\n- Возьми каталог свойств владельца: property_catalog без фильтров (при большом словаре — по слову, property_catalog с q).\n- Ищи пары, у которых РАЗНЫЕ key, но один и тот же смысл: сравнивай подпись (label) и описание (description), а не написание ключа. «Усилие» и «Уровень усилия» — дубль; «Срок» и «Дата начала» — нет.\n- Сливать можно только СВОИ свойства владельца — те, чей key начинается на «user/». Свойства с key на «orbis/» встроены в систему: их не сливай ни источником, ни целью, сервер откажет и шаг пропадёт зря.\n- Направление слияния: source — то, у которого меньше носителей и значений (usage), into — то, которое остаётся. При равенстве оставляй свойство с более понятной подписью.\n- Слияние вызывай инструментом property_merge. Ответ «pending_confirmation» — это НЕ отказ: карточка ушла владельцу в пачку решений, он разберёт её сам. Продолжай работу и не повторяй тот же вызов.\n- За один прогон предлагай не больше трёх слияний: пачка владельца не резиновая, а неразобранные карточки следующий прогон увидит в истории.\n\nШаг 2. Сироты.\n\n- Возьми property_catalog с orphans: true — это свойства, которых не объявляет ни один аспект и у которых нет ни одного значения.\n- Сам с ними ничего не делай: удалять и прятать свойства — решение владельца.\n\nШаг 3. Залежавшиеся предложения.\n\n- Возьми property_catalog со status: "proposed" и olderThanDays: 14 — предложенные свойства, которые ждут решения больше двух недель.\n- Их тоже не трогай: их судьбу решает владелец.\n\nОтчёт (финальный текст хода, его владелец прочтёт на экране прогона):\n\n- что предложил слить и почему («X» и «Y» — одно и то же, потому что …);\n- список сирот подписями, с числом носителей и значений;\n- список предложений старше 14 дней подписями, с возрастом в днях.\nЕсли по какому-то из трёх разделов ничего не нашлось — так и напиши одной строкой, а не пропускай раздел молча: «сирот нет» — это тоже результат недельного обхода.	{"orbis/routine_at": "09:00", "orbis/routine_days": ["mo"], "orbis/routine_mode": "act", "orbis/allowed_tools": ["property_merge"], "orbis/routine_stage": "active"}	{orbis/routine}	{}	1	\N	2026-11-05 02:11:23.081+00
8b254405-3c6e-5e0a-a623-92e5b2529373	469c6a1e-320a-4d24-bdda-e8c070b816cd	Перенос остатков	🔁	Ты переносишь остатки бюджета в новый месяц.\n\nШаг 0. Календарь.\n\n- Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».\n\nШаг 1. Прошлый месяц.\n\n- Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).\n- Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.\n- Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover "0.00") и назови такие категории в отчёте.\n\nШаг 2. Перенос.\n\n- Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.\n- Суммы не округляй и не досчитывай: бери их как есть из budget_status.\n- Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.\n\nОтчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.	{}	{routine}	2026-11-05 02:11:23.103+00	2026-11-05 02:11:23.103+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Ты переносишь остатки бюджета в новый месяц.", "type": "text"}]}, {"type": "paragraph", "content": [{"text": "Шаг 0. Календарь.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 1. Прошлый месяц.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover \\"0.00\\") и назови такие категории в отчёте.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Шаг 2. Перенос.", "type": "text"}]}, {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Суммы не округляй и не досчитывай: бери их как есть из budget_status.", "type": "text"}]}]}, {"type": "listItem", "content": [{"type": "paragraph", "content": [{"text": "Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.", "type": "text"}]}]}]}, {"type": "paragraph", "content": [{"text": "Отчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.", "type": "text"}]}]}}	Ты переносишь остатки бюджета в новый месяц.\n\nШаг 0. Календарь.\n\n- Переносить остатки нужно ОДИН раз, в первое число месяца. Если сегодня не первое число — завершайся сразу и ничего не делай: одной строкой «не первое число — перенос не нужен».\n\nШаг 1. Прошлый месяц.\n\n- Возьми budget_status за ПРОШЛЫЙ месяц (month — прошлый месяц в виде YYYY-MM). Из его конвертов нужны: категория (category.id), лимит конверта (свойство orbis/limit конверта) и остаток (remaining).\n- Конвертов в прошлом месяце нет — переносить нечего, так и напиши и не придумывай лимиты: с каких лимитов начать, решает владелец.\n- Остаток родительской категории уже включает остатки её подкатегорий. Если среди конвертов есть и категория, и её подкатегории, остаток родителя не переноси (carryover "0.00") и назови такие категории в отчёте.\n\nШаг 2. Перенос.\n\n- Зови budget_rollover ОДИН раз: month — текущий месяц, rows — по строке на конверт прошлого месяца (categoryId — категория, limit — лимит прошлого конверта, carryover — его остаток; суммы decimal-строками как в budget_status), batchId — новый id вызова.\n- Суммы не округляй и не досчитывай: бери их как есть из budget_status.\n- Ответ «pending_confirmation» — НЕ отказ: карточка с каждой строкой ушла владельцу, он проверит суммы и подтвердит сам. Не повторяй вызов.\n\nОтчёт (финальный текст хода): сколько конвертов предложено перенести, какова суммарная сумма остатка и какие категории остались без переноса и почему.	{"orbis/routine_at": "09:00", "orbis/routine_mode": "act", "orbis/allowed_tools": ["budget_rollover"], "orbis/routine_stage": "paused"}	{orbis/routine}	{}	1	\N	2026-11-05 02:11:23.111+00
67f317ad-0e24-5b2e-9308-8707d8ef2b7d	469c6a1e-320a-4d24-bdda-e8c070b816cd	Orbis	🪐		{}	{}	2026-11-05 02:11:23.176+00	2026-11-05 02:11:23.176+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}		{"orbis/app_nav": ["3e2fef47-0983-5bed-939e-26a430695ca3", "7c3326d1-5416-51c8-b4a2-c0673b80f044", "f3cb3be0-0a48-5471-8f01-fa5308e529bd", "18331aa2-1bc8-51c1-bd62-6dde3f83cdbe", "bdddb983-03bb-5441-9fbc-250580c758b8", "171a596b-921d-58d7-a834-71a80aee77c0"], "orbis/app_home": "61af277b-2ed5-592c-9074-410126aa8880", "orbis/supply_key": "host-shell", "orbis/supply_hash": "ae12b469dbce5e092f33feb1903cd4413977a5675009cb020170c37f865775f1", "orbis/supply_text": "{\\n  \\"emoji\\": \\"🪐\\",\\n  \\"props\\": {\\n    \\"orbis/app_home\\": \\"61af277b-2ed5-592c-9074-410126aa8880\\",\\n    \\"orbis/app_nav\\": [\\n      \\"3e2fef47-0983-5bed-939e-26a430695ca3\\",\\n      \\"7c3326d1-5416-51c8-b4a2-c0673b80f044\\",\\n      \\"f3cb3be0-0a48-5471-8f01-fa5308e529bd\\",\\n      \\"18331aa2-1bc8-51c1-bd62-6dde3f83cdbe\\",\\n      \\"bdddb983-03bb-5441-9fbc-250580c758b8\\",\\n      \\"171a596b-921d-58d7-a834-71a80aee77c0\\"\\n    ],\\n    \\"orbis/app_nav_form\\": \\"header-list\\"\\n  },\\n  \\"title\\": \\"Orbis\\"\\n}", "orbis/app_nav_form": "header-list"}	{orbis/app,orbis/supply}	{}	1	\N	2026-11-05 02:11:23.187+00
01a1a979-a221-730f-929d-08113981f0e7	469c6a1e-320a-4d24-bdda-e8c070b816cd	Restore B	\N	Synthetic foreign graph	{}	{}	2026-11-05 02:11:23.297+00	2026-11-05 02:11:23.297+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Synthetic foreign graph", "type": "text"}]}]}}	Synthetic foreign graph	{}	{}	{}	1	01a1a979-a215-70f2-9dc9-a42d9276b1bf	2026-11-05 02:11:23.301+00
01a1a979-a207-726b-ac4a-4fb3a35c0b5d	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	Restore A sibling	\N	Synthetic expired event	{}	{}	2026-11-05 02:11:23.271+00	2026-11-05 02:11:27.254+00	f	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Synthetic expired event", "type": "text"}]}]}}		{}	{}	{}	2	01a1a979-b18a-7555-a78d-7e23ee89f1b1	2026-11-05 02:11:27.256+00
\.


--
-- Data for Name: entity_origins; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entity_origins (id, graph_id, entity_id, namespace, external_id, created_at) FROM stdin;
\.


--
-- Data for Name: entity_versions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.entity_versions (id, graph_id, entity_id, label, body, body_doc, actor_user_id, actor_kind, created_at) FROM stdin;
01a1a979-a2bf-72e3-95ae-70f910bfc1bb	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	Synthetic version	Synthetic updated body	{"v": 3, "doc": {"type": "doc", "content": [{"type": "paragraph", "content": [{"text": "Synthetic updated body", "type": "text"}]}]}}	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	2026-11-05 02:11:23.455+00
\.


--
-- Data for Name: envelope_spent_cache; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version, updated_at) FROM stdin;
\.


--
-- Data for Name: graph_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.graph_members (id, graph_id, account_id, grant_kind, issued_at, issued_by, revoked_at) FROM stdin;
2a044eb9-b06c-43ac-9da4-5fcff9cf4ebf	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	owner	2026-11-05 02:11:21.607424+00	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	\N
c9327784-a69f-4c9a-ba14-1f1d7533e425	469c6a1e-320a-4d24-bdda-e8c070b816cd	469c6a1e-320a-4d24-bdda-e8c070b816cd	owner	2026-11-05 02:11:21.614248+00	469c6a1e-320a-4d24-bdda-e8c070b816cd	\N
\.


--
-- Data for Name: graphs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.graphs (id, owner_kind, owner_ref, created_at) FROM stdin;
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	person	6a772ba8-0c54-477b-8d3b-8a8aede2aef1	2026-11-05 02:11:21.607424+00
469c6a1e-320a-4d24-bdda-e8c070b816cd	person	469c6a1e-320a-4d24-bdda-e8c070b816cd	2026-11-05 02:11:21.614248+00
\.


--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.oauth_clients (client_id, client_name, redirect_uris, created_at) FROM stdin;
\.


--
-- Data for Name: perf_samples; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.perf_samples (id, account_id, created_at, metric, screen, kind, procedure, dur_ms, server_ms, db_ms, device, net, app_version, cached) FROM stdin;
\.


--
-- Data for Name: property_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.property_definitions (id, graph_id, key, label, description, type, status, storage, scope, merged_into, module, rank, flags, created_at, rules) FROM stdin;
orbis/start_at	\N	orbis/start_at	{"en": "Starts at", "ru": "Начало"}	{"en": "When the event begins", "ru": "Когда событие начинается"}	{"kind": "timestamp"}	active	props	\N	\N	\N	1	{}	2026-11-05 02:11:05.585421+00	[]
orbis/end_at	\N	orbis/end_at	{"en": "Ends at", "ru": "Окончание"}	{"en": "When the event ends", "ru": "Когда событие заканчивается"}	{"kind": "timestamp"}	active	props	\N	\N	\N	2	{}	2026-11-05 02:11:05.597094+00	[]
orbis/duration_min	\N	orbis/duration_min	{"en": "Duration, min", "ru": "Длительность, мин"}	{"en": "How long the event takes", "ru": "Сколько времени событие занимает"}	{"min": 1, "kind": "number", "integer": true}	active	props	\N	\N	\N	3	{}	2026-11-05 02:11:05.601147+00	[]
orbis/all_day	\N	orbis/all_day	{"en": "All day", "ru": "Весь день"}	{"en": "The event takes the whole day, with no hours", "ru": "Событие занимает день целиком, без часов"}	{"kind": "boolean"}	active	props	\N	\N	\N	4	{}	2026-11-05 02:11:05.604706+00	[]
orbis/recurrence	\N	orbis/recurrence	{"en": "Recurrence", "ru": "Повторение"}	{"en": "The rule by which the event repeats", "ru": "Правило, по которому событие повторяется"}	{"kind": "json", "schema": {"type": "object", "required": ["freq", "interval"], "properties": {"freq": {"enum": ["daily", "weekly", "monthly"], "type": "string"}, "until": {"type": "string", "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"}, "interval": {"type": "integer", "minimum": 1}, "byweekday": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}}	active	props	\N	\N	\N	5	{}	2026-11-05 02:11:05.608253+00	[]
orbis/location	\N	orbis/location	{"en": "Location", "ru": "Место"}	{"en": "Where the event takes place", "ru": "Где событие происходит"}	{"kind": "text"}	active	props	\N	\N	\N	6	{}	2026-11-05 02:11:05.612669+00	[]
orbis/timezone	\N	orbis/timezone	{"en": "Time zone", "ru": "Часовой пояс"}	{"en": "The zone in which the event time is read", "ru": "В каком поясе прочитано время события"}	{"kind": "text", "format": "iana-tz"}	active	props	\N	\N	\N	7	{}	2026-11-05 02:11:05.617139+00	[]
orbis/task_status	\N	orbis/task_status	{"en": "Task status", "ru": "Состояние задачи"}	{"en": "What stage the work is at", "ru": "На каком шаге работа над задачей"}	{"kind": "select", "options": [{"key": "inbox", "rank": 1, "label": {"en": "Inbox", "ru": "Входящие"}}, {"key": "planned", "rank": 2, "label": {"en": "Planned", "ru": "Запланирована"}}, {"key": "in_progress", "rank": 3, "label": {"en": "In progress", "ru": "В работе"}}, {"key": "waiting", "rank": 4, "label": {"en": "Waiting", "ru": "Ожидает"}}, {"key": "done", "rank": 5, "label": {"en": "Done", "ru": "Сделана"}}, {"key": "cancelled", "rank": 6, "label": {"en": "Cancelled", "ru": "Отменена"}}]}	active	props	\N	\N	\N	8	{}	2026-11-05 02:11:05.620549+00	[]
orbis/priority	\N	orbis/priority	{"en": "Priority", "ru": "Приоритет"}	{"en": "How much the task outranks the rest", "ru": "Насколько задача важнее прочих"}	{"kind": "select", "options": [{"key": "low", "rank": 1, "label": {"en": "Low", "ru": "Низкий"}}, {"key": "medium", "rank": 2, "label": {"en": "Medium", "ru": "Средний"}}, {"key": "high", "rank": 3, "label": {"en": "High", "ru": "Высокий"}}]}	active	props	\N	\N	\N	9	{}	2026-11-05 02:11:05.624367+00	[]
orbis/due_date	\N	orbis/due_date	{"en": "Due date", "ru": "Срок"}	{"en": "The day by which the task must be done", "ru": "К какому дню задача должна быть сделана"}	{"kind": "date"}	active	props	\N	\N	\N	10	{}	2026-11-05 02:11:05.627763+00	[]
orbis/completed_at	\N	orbis/completed_at	{"en": "Completed at", "ru": "Когда завершена"}	{"en": "The moment the task entered a closed state", "ru": "Момент перехода задачи в закрытое состояние"}	{"kind": "timestamp"}	active	props	\N	\N	\N	11	{}	2026-11-05 02:11:05.630891+00	[]
orbis/effort_min	\N	orbis/effort_min	{"en": "Effort, min", "ru": "Трудоёмкость, мин"}	{"en": "How much time the task is estimated to take", "ru": "Сколько времени задача, по оценке, потребует"}	{"min": 1, "kind": "number", "integer": true}	active	props	\N	\N	\N	12	{}	2026-11-05 02:11:05.63412+00	[]
orbis/waiting_for	\N	orbis/waiting_for	{"en": "Waiting for", "ru": "Ждём"}	{"en": "What or whom the task is waiting for to move on", "ru": "Чего или кого задача ждёт, чтобы сдвинуться"}	{"kind": "text"}	active	props	\N	\N	\N	13	{}	2026-11-05 02:11:05.637054+00	[]
orbis/amount	\N	orbis/amount	{"en": "Amount", "ru": "Сумма"}	{"en": "The size of the operation; the sign is carried by direction, not by the amount", "ru": "Величина операции; знак задаёт направление, а не сама сумма"}	{"kind": "decimal", "exclusiveMin": "0"}	active	props	\N	\N	\N	14	{}	2026-11-05 02:11:05.640122+00	[]
orbis/currency	\N	orbis/currency	{"en": "Currency", "ru": "Валюта"}	{"en": "The currency the money on the record is expressed in", "ru": "В какой валюте выражены деньги записи"}	{"kind": "text", "format": "currency", "maxLength": 3, "minLength": 3}	active	props	\N	\N	\N	15	{}	2026-11-05 02:11:05.643245+00	[]
orbis/direction	\N	orbis/direction	{"en": "Direction", "ru": "Направление"}	{"en": "Money comes in or goes out", "ru": "Деньги приходят или уходят"}	{"kind": "select", "options": [{"key": "income", "rank": 1, "label": {"en": "Income", "ru": "Доход"}}, {"key": "expense", "rank": 2, "label": {"en": "Expense", "ru": "Расход"}}]}	active	props	\N	\N	\N	16	{}	2026-11-05 02:11:05.646056+00	[]
orbis/finance_category	\N	orbis/finance_category	{"en": "Category", "ru": "Категория"}	{"en": "The income and expense category (Finance extension)", "ru": "Категория доходов и расходов (расширение Финансы)"}	{"kind": "ref", "target": {"filter": {"aspect": "orbis/category"}}}	active	props	\N	\N	finance	17	{}	2026-11-05 02:11:05.648903+00	[]
orbis/occurred_on	\N	orbis/occurred_on	{"en": "Occurred on", "ru": "Дата операции"}	{"en": "The day the operation happened", "ru": "День, когда операция случилась"}	{"kind": "date"}	active	props	\N	\N	\N	18	{}	2026-11-05 02:11:05.651647+00	[]
orbis/planned	\N	orbis/planned	{"en": "Planned", "ru": "Планируемая"}	{"en": "The operation has not happened yet, it is only intended", "ru": "Операция ещё не случилась, а только намечена"}	{"kind": "boolean", "default": false}	active	props	\N	\N	finance	19	{}	2026-11-05 02:11:05.654307+00	[]
orbis/recurring	\N	orbis/recurring	{"en": "Recurring", "ru": "Повторяющаяся"}	{"en": "The record is a template of a regular operation", "ru": "Запись — шаблон регулярной операции"}	{"kind": "boolean"}	active	props	\N	\N	finance	20	{}	2026-11-05 02:11:05.657293+00	[]
orbis/payment_method	\N	orbis/payment_method	{"en": "Payment method", "ru": "Способ оплаты"}	{"en": "What the payment was made with", "ru": "Чем заплачено"}	{"kind": "text"}	active	props	\N	\N	finance	21	{}	2026-11-05 02:11:05.660412+00	[]
orbis/counterparty	\N	orbis/counterparty	{"en": "Counterparty", "ru": "Контрагент"}	{"en": "Who was paid or who paid", "ru": "Кому заплачено или от кого получено"}	{"kind": "text"}	active	props	\N	\N	finance	22	{}	2026-11-05 02:11:05.665741+00	[]
orbis/bank_txn_id	\N	orbis/bank_txn_id	{"en": "Bank transaction ID", "ru": "Идентификатор операции банка"}	{"en": "Identity of the operation in the bank statement — repeats on import are caught by it", "ru": "Тождество операции в выписке банка — по нему ловится повтор при импорте"}	{"kind": "text", "maxLength": 128, "minLength": 1}	active	props	\N	\N	finance	23	{"system_writable": true}	2026-11-05 02:11:05.669451+00	[]
orbis/content_type	\N	orbis/content_type	{"en": "Content type", "ru": "Вид текста"}	{"en": "How to read the body of the record", "ru": "Как читать тело записи"}	{"kind": "select", "options": [{"key": "markdown", "rank": 1, "label": {"en": "Markdown", "ru": "Markdown"}}, {"key": "plain", "rank": 2, "label": {"en": "Plain text", "ru": "Обычный текст"}}, {"key": "checklist", "rank": 3, "label": {"en": "Checklist", "ru": "Чек-лист"}}]}	active	props	\N	\N	\N	24	{}	2026-11-05 02:11:05.673382+00	[]
orbis/pinned	\N	orbis/pinned	{"en": "Pinned", "ru": "Закреплена"}	{"en": "The record is kept at the top of lists", "ru": "Запись держится наверху списков"}	{"kind": "boolean"}	active	props	\N	\N	\N	25	{}	2026-11-05 02:11:05.677778+00	[]
orbis/limit	\N	orbis/limit	{"en": "Limit", "ru": "Лимит"}	{"en": "How much may be spent on this category within the period", "ru": "Сколько по этой категории можно потратить за период"}	{"min": "0", "kind": "decimal"}	active	props	\N	\N	finance	26	{}	2026-11-05 02:11:05.681786+00	[]
orbis/period_start	\N	orbis/period_start	{"en": "Period start", "ru": "Начало периода"}	{"en": "From which day the envelope counts", "ru": "С какого дня конверт считает"}	{"kind": "date"}	active	props	\N	\N	finance	27	{}	2026-11-05 02:11:05.685898+00	[]
orbis/period_end	\N	orbis/period_end	{"en": "Period end", "ru": "Конец периода"}	{"en": "Through which day the envelope counts, inclusive", "ru": "По какой день конверт считает включительно"}	{"kind": "date"}	active	props	\N	\N	finance	28	{}	2026-11-05 02:11:05.689713+00	[]
orbis/carryover	\N	orbis/carryover	{"en": "Carryover", "ru": "Перенос остатка"}	{"en": "The previous period remainder carried into this one", "ru": "Остаток прошлого периода, перенесённый в этот"}	{"kind": "decimal"}	active	props	\N	\N	finance	29	{"system_writable": true}	2026-11-05 02:11:05.693176+00	[]
orbis/icon	\N	orbis/icon	{"en": "Icon", "ru": "Иконка"}	{"en": "The category badge in lists", "ru": "Значок категории в списках"}	{"kind": "text"}	active	props	\N	\N	finance	30	{}	2026-11-05 02:11:05.69657+00	[]
orbis/color	\N	orbis/color	{"en": "Color", "ru": "Цвет"}	{"en": "The category color in lists and reports", "ru": "Цвет категории в списках и ведомостях"}	{"kind": "text", "format": "color"}	active	props	\N	\N	finance	31	{}	2026-11-05 02:11:05.699693+00	[]
orbis/aliases	\N	orbis/aliases	{"en": "Aliases", "ru": "Синонимы"}	{"en": "Words by which input recognises the category", "ru": "Слова, по которым ввод узнаёт категорию"}	{"kind": "text", "maxItems": 50, "cardinality": "many"}	active	props	\N	\N	finance	32	{}	2026-11-05 02:11:05.702545+00	[]
orbis/spend_class	\N	orbis/spend_class	{"en": "Spend class", "ru": "Класс траты"}	{"en": "The spend is mandatory or one that can be given up", "ru": "Трата обязательная или та, от которой можно отказаться"}	{"kind": "select", "options": [{"key": "fixed", "rank": 1, "label": {"en": "Fixed", "ru": "Обязательная"}}, {"key": "discretionary", "rank": 2, "label": {"en": "Discretionary", "ru": "Необязательная"}}]}	active	props	\N	\N	finance	33	{}	2026-11-05 02:11:05.705445+00	[]
orbis/memory_kind	\N	orbis/memory_kind	{"en": "Record kind", "ru": "Род записи"}	{"en": "A memory record is a fact about the owner or an input-handling rule", "ru": "Запись памяти — факт о владельце или правило обработки ввода"}	{"kind": "select", "options": [{"key": "fact", "rank": 1, "label": {"en": "Fact", "ru": "Факт"}}, {"key": "rule", "rank": 2, "label": {"en": "Rule", "ru": "Правило"}}]}	active	props	\N	\N	\N	34	{}	2026-11-05 02:11:05.708495+00	[]
orbis/rule_scope	\N	orbis/rule_scope	{"en": "Scope", "ru": "Область действия"}	{"en": "Which notion the memory record applies to", "ru": "К какому понятию относится запись памяти"}	{"kind": "registry_ref", "target": "contract"}	active	props	\N	\N	\N	35	{}	2026-11-05 02:11:05.711314+00	[]
orbis/rule_pattern	\N	orbis/rule_pattern	{"en": "Pattern", "ru": "Образец"}	{"en": "The text by which the rule recognises input", "ru": "Текст, по которому правило узнаёт ввод"}	{"kind": "text", "pattern": "\\\\S", "minLength": 1}	active	props	\N	\N	\N	36	{}	2026-11-05 02:11:05.714627+00	[]
orbis/rule_target	\N	orbis/rule_target	{"en": "Assigned category", "ru": "Назначаемая категория"}	{"en": "The category the rule substitutes when the pattern matches", "ru": "Категория, которую правило подставляет при совпадении образца"}	{"kind": "ref", "target": {"filter": {"aspect": "orbis/category"}}}	active	props	\N	\N	\N	37	{}	2026-11-05 02:11:05.717455+00	[]
orbis/progress_source	\N	orbis/progress_source	{"en": "Progress source", "ru": "Источник прогресса"}	{"en": "Where the current value of the goal comes from", "ru": "Откуда берётся текущее значение цели"}	{"kind": "json", "schema": {"$defs": {"node": {"anyOf": [{"type": "object", "required": ["and"], "properties": {"and": {"type": "array", "items": {"$ref": "#/$defs/node"}, "minItems": 1}}, "additionalProperties": false}, {"type": "object", "required": ["or"], "properties": {"or": {"type": "array", "items": {"$ref": "#/$defs/node"}, "minItems": 1}}, "additionalProperties": false}, {"type": "object", "required": ["not"], "properties": {"not": {"$ref": "#/$defs/node"}}, "additionalProperties": false}, {"type": "object", "required": ["prop", "op", "value"], "properties": {"op": {"enum": ["eq", "ne", "gt", "lt"]}, "prop": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "value": {"anyOf": [{"type": ["string", "number", "boolean"]}, {"type": "object", "required": ["token"], "properties": {"token": {"enum": ["today", "overdue", "next_7d", "after_7d", "this_week", "next_14d", "this_month", "last_month"]}}, "additionalProperties": false}]}}, "additionalProperties": false}, {"type": "object", "required": ["prop", "op", "value"], "properties": {"op": {"const": "in"}, "prop": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "value": {"type": "array", "items": {"type": ["string", "number", "boolean"]}, "minItems": 1}}, "additionalProperties": false}, {"type": "object", "required": ["prop", "op", "value"], "properties": {"op": {"const": "contains"}, "prop": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "value": {"type": ["string", "number", "boolean"]}}, "additionalProperties": false}, {"type": "object", "required": ["prop", "op", "value"], "properties": {"op": {"const": "range"}, "prop": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "value": {"type": "object", "properties": {"to": {"anyOf": [{"type": ["string", "number", "boolean"]}, {"type": "object", "required": ["token"], "properties": {"token": {"enum": ["today", "overdue", "next_7d", "after_7d", "this_week", "next_14d", "this_month", "last_month"]}}, "additionalProperties": false}]}, "from": {"anyOf": [{"type": ["string", "number", "boolean"]}, {"type": "object", "required": ["token"], "properties": {"token": {"enum": ["today", "overdue", "next_7d", "after_7d", "this_week", "next_14d", "this_month", "last_month"]}}, "additionalProperties": false}]}}, "minProperties": 1, "additionalProperties": false}}, "additionalProperties": false}, {"type": "object", "required": ["has"], "properties": {"has": {"type": "string", "minLength": 1}}, "additionalProperties": false}, {"type": "object", "required": ["aspect"], "properties": {"aspect": {"type": "string", "minLength": 1}}, "additionalProperties": false}, {"type": "object", "required": ["tag"], "properties": {"tag": {"type": "string", "minLength": 1}}, "additionalProperties": false}, {"type": "object", "required": ["search"], "properties": {"search": {"type": "string", "minLength": 1}}, "additionalProperties": false}, {"type": "object", "required": ["rel"], "properties": {"rel": {"anyOf": [{"type": "object", "required": ["kind", "of"], "properties": {"of": {"type": "string", "pattern": "^(this|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"}, "via": {"type": "string", "minLength": 1}, "kind": {"enum": ["children_of", "parents_of"]}}, "additionalProperties": false}, {"type": "object", "required": ["kind", "of", "via"], "properties": {"of": {"type": "string", "pattern": "^(this|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"}, "via": {"type": "string", "minLength": 1}, "kind": {"enum": ["descendants_of", "ancestors_of"]}}, "additionalProperties": false}, {"type": "object", "required": ["kind", "via"], "properties": {"via": {"type": "string", "minLength": 1}, "kind": {"const": "has_relation"}, "sourceNotIn": {"type": "object", "required": ["contract", "set"], "properties": {"set": {"type": "string", "minLength": 1}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}}, "additionalProperties": false}, {"type": "object", "required": ["kind"], "properties": {"via": {"type": "string", "minLength": 1}, "kind": {"const": "has_children"}}, "additionalProperties": false}]}}, "additionalProperties": false}, {"type": "object", "required": ["archived"], "properties": {"archived": {"enum": ["true", "any"]}}, "additionalProperties": false}, {"type": "object", "required": ["class"], "properties": {"class": {"type": "object", "required": ["contract", "set"], "properties": {"set": {"type": "string", "minLength": 1}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}}, "additionalProperties": false}]}}, "anyOf": [{"type": "object", "required": ["query", "aggregate"], "properties": {"query": {"anyOf": [{"type": "object", "allOf": [{"anyOf": [{"not": {"required": ["aggregate"], "properties": {"aggregate": {}}}}, {"required": ["display"], "properties": {"display": {"const": "tile"}}}]}, {"anyOf": [{"not": {"required": ["display"], "properties": {"display": {"const": "tile"}}}}, {"required": ["aggregate"], "properties": {"aggregate": {}}}]}, {"anyOf": [{"not": {"required": ["columns"], "properties": {"columns": {}}}}, {"required": ["display"], "properties": {"display": {"const": "table"}}}]}], "title": "Orbis Q-AST", "required": ["filter"], "properties": {"limit": {"type": "integer", "minimum": 1}, "title": {"type": "string", "minLength": 1}, "filter": {"anyOf": [{"$ref": "#/$defs/node"}, {"type": "null"}]}, "sortBy": {"type": "array", "items": {"type": "object", "required": ["field", "dir"], "properties": {"dir": {"enum": ["asc", "desc"]}, "field": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}}, "additionalProperties": false}, "minItems": 1}, "columns": {"type": "array", "items": {"type": "object", "required": ["field"], "properties": {"field": {"type": "string", "minLength": 1}}, "additionalProperties": false}, "minItems": 1}, "display": {"enum": ["compact", "list", "table", "tile"]}, "aggregate": {"anyOf": [{"type": "object", "required": ["fn"], "properties": {"fn": {"const": "count"}}, "additionalProperties": false}, {"type": "object", "required": ["fn", "field"], "properties": {"fn": {"enum": ["sum", "latest"]}, "field": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}}, "additionalProperties": false}]}, "hideEmpty": {"const": true}}, "description": "Канонический разобранный запрос Orbis (§А5-7): дерево and/or/not над предикатами и отдельные поля проекции.", "additionalProperties": false}, {"type": "object", "required": ["text"], "properties": {"text": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "aggregate": {"const": "count"}}, "additionalProperties": false}, {"type": "object", "required": ["query", "aggregate", "field"], "properties": {"field": {"type": "string", "minLength": 1}, "query": {"anyOf": [{"type": "object", "allOf": [{"anyOf": [{"not": {"required": ["aggregate"], "properties": {"aggregate": {}}}}, {"required": ["display"], "properties": {"display": {"const": "tile"}}}]}, {"anyOf": [{"not": {"required": ["display"], "properties": {"display": {"const": "tile"}}}}, {"required": ["aggregate"], "properties": {"aggregate": {}}}]}, {"anyOf": [{"not": {"required": ["columns"], "properties": {"columns": {}}}}, {"required": ["display"], "properties": {"display": {"const": "table"}}}]}], "title": "Orbis Q-AST", "required": ["filter"], "properties": {"limit": {"type": "integer", "minimum": 1}, "title": {"type": "string", "minLength": 1}, "filter": {"anyOf": [{"$ref": "#/$defs/node"}, {"type": "null"}]}, "sortBy": {"type": "array", "items": {"type": "object", "required": ["field", "dir"], "properties": {"dir": {"enum": ["asc", "desc"]}, "field": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}}, "additionalProperties": false}, "minItems": 1}, "columns": {"type": "array", "items": {"type": "object", "required": ["field"], "properties": {"field": {"type": "string", "minLength": 1}}, "additionalProperties": false}, "minItems": 1}, "display": {"enum": ["compact", "list", "table", "tile"]}, "aggregate": {"anyOf": [{"type": "object", "required": ["fn"], "properties": {"fn": {"const": "count"}}, "additionalProperties": false}, {"type": "object", "required": ["fn", "field"], "properties": {"fn": {"enum": ["sum", "latest"]}, "field": {"oneOf": [{"type": "string", "minLength": 1}, {"type": "object", "required": ["contract"], "properties": {"slot": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "contract": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}}, "additionalProperties": false}]}, "hideEmpty": {"const": true}}, "description": "Канонический разобранный запрос Orbis (§А5-7): дерево and/or/not над предикатами и отдельные поля проекции.", "additionalProperties": false}, {"type": "object", "required": ["text"], "properties": {"text": {"type": "string", "minLength": 1}}, "additionalProperties": false}]}, "aggregate": {"enum": ["sum", "latest"], "type": "string"}}, "additionalProperties": false}]}}	active	props	\N	\N	goals	38	{}	2026-11-05 02:11:05.72036+00	[]
orbis/target_value	\N	orbis/target_value	{"en": "Target value", "ru": "Целевое значение"}	{"en": "The number the goal is heading to", "ru": "Число, к которому цель идёт"}	{"kind": "decimal", "exclusiveMin": "0"}	active	props	\N	\N	goals	39	{}	2026-11-05 02:11:05.724202+00	[]
orbis/current_value	\N	orbis/current_value	{"en": "Current value", "ru": "Текущее значение"}	{"en": "How far the goal has progressed as of now", "ru": "Насколько цель продвинулась на сейчас"}	{"min": "0", "kind": "decimal"}	active	props	\N	\N	goals	40	{"model_writable": false}	2026-11-05 02:11:05.726907+00	[]
orbis/unit	\N	orbis/unit	{"en": "Unit", "ru": "Единица"}	{"en": "What the goal progress is measured in", "ru": "В чём меряется прогресс цели"}	{"kind": "text", "minLength": 1}	active	props	\N	\N	goals	41	{}	2026-11-05 02:11:05.729729+00	[]
orbis/project_stage	\N	orbis/project_stage	{"en": "Project stage", "ru": "Стадия проекта"}	{"en": "The project is running, paused or finished", "ru": "Проект идёт, стоит на паузе или завершён"}	{"kind": "select", "options": [{"key": "active", "rank": 1, "label": {"en": "Active", "ru": "Активен"}}, {"key": "paused", "rank": 2, "label": {"en": "Paused", "ru": "На паузе"}}, {"key": "done", "rank": 3, "label": {"en": "Done", "ru": "Завершён"}}]}	active	props	\N	\N	projects	42	{}	2026-11-05 02:11:05.734+00	[]
orbis/repo_url	\N	orbis/repo_url	{"en": "Repository URL", "ru": "Адрес репозитория"}	{"en": "Where the project code lives", "ru": "Где лежит код проекта"}	{"kind": "text", "format": "url", "maxLength": 512, "minLength": 1}	active	props	\N	\N	dev	43	{}	2026-11-05 02:11:05.737961+00	[]
orbis/default_branch	\N	orbis/default_branch	{"en": "Default branch", "ru": "Ветка по умолчанию"}	{"en": "Which branch the executor starts the work from", "ru": "С какой ветки исполнитель начинает работу"}	{"kind": "text", "maxLength": 128, "minLength": 1}	active	props	\N	\N	dev	44	{}	2026-11-05 02:11:05.741466+00	[]
orbis/executor	\N	orbis/executor	{"en": "Executor", "ru": "Исполнитель"}	{"en": "The work is carried out by a human or by an agent", "ru": "Работу ведёт человек или агент"}	{"kind": "select", "options": [{"key": "human", "rank": 1, "label": {"en": "Human", "ru": "Человек"}}, {"key": "agent", "rank": 2, "label": {"en": "Agent", "ru": "Агент"}}]}	active	props	\N	\N	\N	45	{}	2026-11-05 02:11:05.744569+00	[]
orbis/grant	\N	orbis/grant	{"en": "Agent grant", "ru": "Доступ агента"}	{"en": "Which owner grant the agent works under", "ru": "Каким доступом владельца работает агент"}	{"kind": "grant"}	active	props	\N	\N	\N	46	{}	2026-11-05 02:11:05.747891+00	[]
orbis/assignee	\N	orbis/assignee	{"en": "Assignee", "ru": "Кто делает"}	{"en": "The name of the person who took the work", "ru": "Имя человека, который взял работу"}	{"kind": "text", "maxLength": 200, "minLength": 1}	active	props	\N	\N	\N	47	{}	2026-11-05 02:11:05.751749+00	[]
orbis/may_close	\N	orbis/may_close	{"en": "May close", "ru": "Может закрыть"}	{"en": "The executor is allowed to close the work themselves", "ru": "Исполнителю разрешено закрыть работу самому"}	{"kind": "boolean", "default": false}	active	props	\N	\N	\N	48	{}	2026-11-05 02:11:05.755606+00	[]
orbis/run_routine	\N	orbis/run_routine	{"en": "Run routine", "ru": "Рутина прогона"}	{"en": "The routine whose schedule spawned the run", "ru": "Рутина, чьё расписание породило прогон"}	{"kind": "ref", "target": {"filter": {"aspect": "orbis/routine"}}}	active	props	\N	\N	\N	49	{"system_writable": true}	2026-11-05 02:11:05.759098+00	[]
orbis/run_bucket	\N	orbis/run_bucket	{"en": "Schedule slot", "ru": "Слот расписания"}	{"en": "The schedule slot the run answers for", "ru": "Слот расписания, за который прогон отвечает"}	{"kind": "text", "pattern": "^(\\\\d{4}-\\\\d{2}-\\\\d{2}T([01]\\\\d|2[0-3]):[0-5]\\\\d|manual:\\\\S+)$"}	active	props	\N	\N	\N	50	{"system_writable": true}	2026-11-05 02:11:05.762075+00	[]
orbis/run_attempt	\N	orbis/run_attempt	{"en": "Attempt", "ru": "Попытка"}	{"en": "Which attempt at the slot this is", "ru": "Который по счёту заход на слот"}	{"min": 1, "kind": "number", "integer": true}	active	props	\N	\N	\N	51	{"system_writable": true}	2026-11-05 02:11:05.765089+00	[]
orbis/fail_note	\N	orbis/fail_note	{"en": "Failure note", "ru": "Причина срыва"}	{"en": "Why the run ended in nothing", "ru": "Почему прогон кончился ничем"}	{"kind": "text", "maxLength": 2000}	active	props	\N	\N	\N	52	{"system_writable": true}	2026-11-05 02:11:05.768173+00	[]
orbis/run_proposal	\N	orbis/run_proposal	{"en": "Proposal", "ru": "Предложение"}	{"en": "The change card waiting for the owner word", "ru": "Карточка изменений, ждущая слова владельца"}	{"kind": "json", "schema": {"type": "object", "required": ["pending_id", "status"], "properties": {"status": {"enum": ["pending", "approved", "rejected", "superseded", "stale"], "type": "string"}, "decided_at": {"type": "string", "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"}, "mismatches": {"type": "array", "items": {"type": "object", "required": ["property", "note"], "properties": {"note": {"type": "string", "maxLength": 500}, "property": {"type": "string"}}, "additionalProperties": false}, "maxItems": 50}, "pending_id": {"type": "string", "format": "uuid"}, "edited_from": {"type": "string", "format": "uuid"}}, "additionalProperties": false}}	active	props	\N	\N	\N	53	{"system_writable": true}	2026-11-05 02:11:05.771003+00	[]
orbis/undecided	\N	orbis/undecided	{"en": "Has undecided", "ru": "Есть нерешённое"}	{"en": "The run has batch units the owner has not decided", "ru": "У прогона остались единицы пачки без решения владельца"}	{"kind": "boolean"}	active	props	\N	\N	\N	54	{"system_writable": true}	2026-11-05 02:11:05.776335+00	[]
orbis/run_outcome	\N	orbis/run_outcome	{"en": "Run outcome", "ru": "Исход прогона"}	{"en": "How the run ended", "ru": "Чем прогон кончился"}	{"kind": "select", "options": [{"key": "running", "rank": 1, "label": {"en": "Running", "ru": "Идёт"}}, {"key": "checkpoint", "rank": 2, "label": {"en": "Checkpoint", "ru": "Вопрос владельцу"}}, {"key": "finished", "rank": 3, "label": {"en": "Finished", "ru": "Завершён"}}, {"key": "abandoned", "rank": 4, "label": {"en": "Abandoned", "ru": "Брошен"}}, {"key": "failed", "rank": 5, "label": {"en": "Failed", "ru": "Сорвался"}}, {"key": "answered", "rank": 6, "label": {"en": "Answered", "ru": "Отвечен"}}, {"key": "stale", "rank": 7, "label": {"en": "Stale", "ru": "Снят"}}]}	active	props	\N	\N	\N	55	{"system_writable": true}	2026-11-05 02:11:05.780177+00	[]
orbis/run_started_at	\N	orbis/run_started_at	{"en": "Run started at", "ru": "Начало прогона"}	{"en": "When the executor took up the work", "ru": "Когда исполнитель взялся за работу"}	{"kind": "timestamp"}	active	props	\N	\N	\N	56	{"system_writable": true}	2026-11-05 02:11:05.783574+00	[]
orbis/run_finished_at	\N	orbis/run_finished_at	{"en": "Run finished at", "ru": "Конец прогона"}	{"en": "When the run stopped running", "ru": "Когда прогон перестал идти"}	{"kind": "timestamp"}	active	props	\N	\N	\N	57	{"system_writable": true}	2026-11-05 02:11:05.788302+00	[]
orbis/last_step_at	\N	orbis/last_step_at	{"en": "Last step at", "ru": "Последний шаг"}	{"en": "Liveness mark: when the run last showed signs of life", "ru": "Отметка живости: когда прогон в последний раз подавал признаки"}	{"kind": "timestamp"}	active	props	\N	\N	\N	58	{"system_writable": true}	2026-11-05 02:11:05.791866+00	[]
orbis/step_count	\N	orbis/step_count	{"en": "Step count", "ru": "Шагов"}	{"en": "How many steps the executor has already made", "ru": "Сколько шагов исполнитель уже сделал"}	{"min": 0, "kind": "number", "integer": true}	active	props	\N	\N	\N	59	{"system_writable": true}	2026-11-05 02:11:05.795236+00	[]
orbis/run_steps	\N	orbis/run_steps	{"en": "Steps", "ru": "Шаги"}	{"en": "What the executor did, in order", "ru": "Что исполнитель делал по порядку"}	{"kind": "json", "schema": {"type": "object", "required": ["seq", "at", "summary", "external"], "properties": {"at": {"type": "string", "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"}, "seq": {"type": "integer", "minimum": 1}, "summary": {"type": "string", "maxLength": 500, "minLength": 1}, "external": {"type": "boolean"}, "action_id": {"type": "string", "format": "uuid"}}, "additionalProperties": false}, "maxItems": 500}	active	props	\N	\N	\N	60	{"system_writable": true}	2026-11-05 02:11:05.798743+00	[]
orbis/session_url	\N	orbis/session_url	{"en": "Session URL", "ru": "Ссылка на сессию"}	{"en": "Where to watch the executor work from outside", "ru": "Где смотреть работу исполнителя снаружи"}	{"kind": "text", "format": "url"}	active	props	\N	\N	\N	61	{"system_writable": true}	2026-11-05 02:11:05.802422+00	[]
orbis/run_report	\N	orbis/run_report	{"en": "Report", "ru": "Отчёт"}	{"en": "What the executor did and what to check", "ru": "Что исполнитель сделал и что проверить"}	{"kind": "text", "maxLength": 20000}	active	props	\N	\N	\N	62	{"system_writable": true}	2026-11-05 02:11:05.806602+00	[]
orbis/run_checkpoint	\N	orbis/run_checkpoint	{"en": "Checkpoint", "ru": "Вопрос владельцу"}	{"en": "What the executor will not decide without the owner", "ru": "Чего исполнитель не решает без владельца"}	{"kind": "json", "schema": {"type": "object", "required": ["question", "asked_at"], "properties": {"asked_at": {"type": "string", "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"}, "question": {"type": "string", "maxLength": 4000, "minLength": 1}}, "additionalProperties": false}}	active	props	\N	\N	\N	63	{"system_writable": true}	2026-11-05 02:11:05.810668+00	[]
orbis/run_reply	\N	orbis/run_reply	{"en": "Owner reply", "ru": "Ответ владельца"}	{"en": "What the owner answered to the run question", "ru": "Что владелец ответил на вопрос прогона"}	{"kind": "json", "schema": {"type": "object", "required": ["text", "at"], "properties": {"at": {"type": "string", "pattern": "^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(\\\\.\\\\d+)?(Z|[+-]\\\\d{2}:\\\\d{2})$"}, "text": {"type": "string", "maxLength": 4000, "minLength": 1}}, "additionalProperties": false}}	active	props	\N	\N	\N	64	{"system_writable": true}	2026-11-05 02:11:05.81447+00	[]
orbis/run_usage	\N	orbis/run_usage	{"en": "Usage", "ru": "Расход"}	{"en": "What the run cost", "ru": "Во что прогон обошёлся"}	{"kind": "json", "schema": {"type": "object", "properties": {"cost_usd": {"type": "number", "minimum": 0}, "input_tokens": {"type": "integer", "minimum": 0}, "output_tokens": {"type": "integer", "minimum": 0}}, "additionalProperties": false}}	active	props	\N	\N	\N	65	{"system_writable": true}	2026-11-05 02:11:05.818529+00	[]
orbis/abandon_note	\N	orbis/abandon_note	{"en": "Abandon note", "ru": "Причина отказа"}	{"en": "Why the run was abandoned by the sweeper", "ru": "Почему прогон брошен подметанием"}	{"kind": "text", "maxLength": 2000}	active	props	\N	\N	\N	66	{"system_writable": true}	2026-11-05 02:11:05.82309+00	[]
orbis/routine_stage	\N	orbis/routine_stage	{"en": "Routine stage", "ru": "Стадия рутины"}	{"en": "The routine is working or is temporarily off", "ru": "Рутина работает или временно отключена"}	{"kind": "select", "options": [{"key": "active", "rank": 1, "label": {"en": "Active", "ru": "Активна"}}, {"key": "paused", "rank": 2, "label": {"en": "Paused", "ru": "На паузе"}}]}	active	props	\N	\N	\N	67	{}	2026-11-05 02:11:05.827048+00	[]
orbis/routine_at	\N	orbis/routine_at	{"en": "Run time", "ru": "Время запуска"}	{"en": "At what time the routine fires in the owner local time", "ru": "В котором часу рутина срабатывает по локальному времени владельца"}	{"kind": "time"}	active	props	\N	\N	\N	68	{}	2026-11-05 02:11:05.830528+00	[]
orbis/routine_days	\N	orbis/routine_days	{"en": "Weekdays", "ru": "Дни недели"}	{"en": "On which weekdays the routine fires", "ru": "По каким дням недели рутина срабатывает"}	{"kind": "select", "options": [{"key": "mo", "rank": 1, "label": {"en": "Mon", "ru": "Пн"}}, {"key": "tu", "rank": 2, "label": {"en": "Tue", "ru": "Вт"}}, {"key": "we", "rank": 3, "label": {"en": "Wed", "ru": "Ср"}}, {"key": "th", "rank": 4, "label": {"en": "Thu", "ru": "Чт"}}, {"key": "fr", "rank": 5, "label": {"en": "Fri", "ru": "Пт"}}, {"key": "sa", "rank": 6, "label": {"en": "Sat", "ru": "Сб"}}, {"key": "su", "rank": 7, "label": {"en": "Sun", "ru": "Вс"}}], "minItems": 1, "cardinality": "many"}	active	props	\N	\N	\N	69	{}	2026-11-05 02:11:05.834993+00	[]
orbis/routine_mode	\N	orbis/routine_mode	{"en": "Mode", "ru": "Режим"}	{"en": "The routine proposes changes to the owner or applies them itself", "ru": "Рутина предлагает изменения владельцу или применяет их сама"}	{"kind": "select", "options": [{"key": "propose", "rank": 1, "label": {"en": "Propose", "ru": "Предлагает"}}, {"key": "act", "rank": 2, "label": {"en": "Act", "ru": "Действует"}}]}	active	props	\N	\N	\N	70	{}	2026-11-05 02:11:05.838717+00	[]
orbis/allowed_tools	\N	orbis/allowed_tools	{"en": "Allowed tools", "ru": "Разрешённые инструменты"}	{"en": "What the routine is allowed to use", "ru": "Чем рутине позволено пользоваться"}	{"kind": "text", "maxItems": 50, "minLength": 1, "cardinality": "many"}	active	props	\N	\N	\N	71	{}	2026-11-05 02:11:05.842448+00	[]
orbis/parent_project	\N	orbis/parent_project	{"en": "Nearest project", "ru": "Ближайший проект"}	{"en": "The project closest to the record up the hierarchy", "ru": "Проект, ближайший к записи вверх по иерархии"}	{"kind": "ref", "target": {"filter": {"aspect": "orbis/project"}}}	active	props	\N	\N	projects	72	{"computed": {"rule": "nearest_ancestor"}, "model_writable": false}	2026-11-05 02:11:05.845701+00	[]
orbis/root_project	\N	orbis/root_project	{"en": "Root project", "ru": "Корневой проект"}	{"en": "The topmost project above the record", "ru": "Самый верхний проект над записью"}	{"kind": "ref", "target": {"filter": {"aspect": "orbis/project"}}}	active	props	\N	\N	projects	73	{"computed": {"rule": "nearest_ancestor"}, "model_writable": false}	2026-11-05 02:11:05.848638+00	[]
orbis/archived	\N	orbis/archived	{"en": "Archived", "ru": "В архиве"}	{"en": "The record is out of ordinary listings", "ru": "Запись убрана из обычных выдач"}	{"kind": "boolean"}	active	core	\N	\N	\N	74	{}	2026-11-05 02:11:05.851596+00	[]
orbis/title	\N	orbis/title	{"en": "Title", "ru": "Заголовок"}	{"en": "What the record is called", "ru": "Как запись называется"}	{"kind": "text"}	active	core	\N	\N	\N	75	{}	2026-11-05 02:11:05.854464+00	[]
orbis/created_at	\N	orbis/created_at	{"en": "Created at", "ru": "Создана"}	{"en": "When the record appeared", "ru": "Когда запись появилась"}	{"kind": "timestamp"}	active	core	\N	\N	\N	76	{}	2026-11-05 02:11:05.857564+00	[]
orbis/updated_at	\N	orbis/updated_at	{"en": "Updated at", "ru": "Изменена"}	{"en": "When the record was last changed", "ru": "Когда запись меняли в последний раз"}	{"kind": "timestamp"}	active	core	\N	\N	\N	77	{}	2026-11-05 02:11:05.860622+00	[]
orbis/template_for	\N	orbis/template_for	{"en": "Template for", "ru": "Шаблон для"}	{"en": "Aspect set: records carrying all of them may be shown through this page as a template", "ru": "Набор аспектов: записям, несущим их все, эта страница подходит как шаблон; пусто — просто страница"}	{"kind": "registry_ref", "target": "aspect", "minItems": 1, "cardinality": "many"}	active	props	\N	\N	\N	78	{}	2026-11-05 02:11:05.863731+00	[]
orbis/template_wins_over	\N	orbis/template_wins_over	{"en": "Wins over", "ru": "Главнее, чем"}	{"en": "Remembered owner choices in template disputes: this template wins over the listed ones", "ru": "Запомненные выборы владельца в спорах шаблонов: этот шаблон побеждает перечисленные"}	{"max": 50, "kind": "ref", "target": {"filter": {"aspect": "orbis/page"}}, "cardinality": "many"}	active	props	\N	\N	\N	79	{}	2026-11-05 02:11:05.86654+00	[]
orbis/app_home	\N	orbis/app_home	{"en": "Home page", "ru": "Домашняя"}	{"en": "What the app home button opens", "ru": "Что открывает ⌂ приложения"}	{"kind": "ref"}	active	props	\N	\N	\N	80	{}	2026-11-05 02:11:05.86959+00	[]
orbis/app_nav	\N	orbis/app_nav	{"en": "Navigation", "ru": "Навигация"}	{"en": "App sections — links to records; the value order is the section order", "ru": "Разделы приложения — ссылки на записи; порядок значения — порядок разделов"}	{"max": 30, "kind": "ref", "cardinality": "many"}	active	props	\N	\N	\N	81	{}	2026-11-05 02:11:05.873462+00	[]
orbis/app_nav_form	\N	orbis/app_nav_form	{"en": "Navigation form", "ru": "Форма навигации"}	{"en": "How the app shows its sections: a header list (the default) or the home page as a hub", "ru": "Как приложение показывает разделы: список из заголовка (без значения — он же) или домашняя как центр"}	{"kind": "select", "options": [{"key": "header-list", "rank": 1, "label": {"en": "Header list", "ru": "Список из заголовка"}}, {"key": "home-hub", "rank": 2, "label": {"en": "Home as a hub", "ru": "Домашняя как центр"}}]}	active	props	\N	\N	\N	82	{}	2026-11-05 02:11:05.877349+00	[]
orbis/app_extensions	\N	orbis/app_extensions	{"en": "Extensions", "ru": "Состав"}	{"en": "Which extensions the app offers to turn on and off together with it; does not change the mask itself", "ru": "Какие расширения приложение предлагает включать и выключать вместе с собой; маску само не меняет"}	{"kind": "select", "options": [{"key": "finance", "rank": 1, "label": {"en": "Finance", "ru": "Финансы"}}, {"key": "goals", "rank": 2, "label": {"en": "Goals", "ru": "Цели"}}, {"key": "projects", "rank": 3, "label": {"en": "Projects", "ru": "Проекты"}}, {"key": "dev", "rank": 4, "label": {"en": "Development", "ru": "Разработка"}}], "maxItems": 16, "cardinality": "many"}	active	props	\N	\N	\N	83	{}	2026-11-05 02:11:05.880667+00	[]
orbis/app_opens_over	\N	orbis/app_opens_over	{"en": "Opens over", "ru": "Открывать вместо"}	{"en": "A remembered choice of place: records open in this app rather than in the listed ones", "ru": "Запомненный выбор места: записи открываются в этом приложении, а не в перечисленных"}	{"max": 50, "kind": "ref", "target": {"filter": {"and": [{"aspect": "orbis/app"}, {"not": {"op": "eq", "prop": "orbis/supply_key", "value": "host-shell"}}]}}, "cardinality": "many"}	active	props	\N	\N	\N	84	{}	2026-11-05 02:11:05.885154+00	[]
orbis/app_disabled	\N	orbis/app_disabled	{"en": "Disabled", "ru": "Выключено"}	{"en": "A disabled app: its place is unavailable and records open in the host; set only by the owner action \\"Disable app\\"", "ru": "Выключенное приложение: его место недоступно, записи открываются в хосте; ставит только действие владельца «Выключить приложение»"}	{"kind": "boolean"}	active	props	\N	\N	\N	85	{"writer": "app-toggle"}	2026-11-05 02:11:05.890034+00	[]
orbis/home	\N	orbis/home	{"en": "Home", "ru": "Дом"}	{"en": "The app this page or template belongs to; empty means the host", "ru": "Приложение, которому принадлежит страница или шаблон; пусто — хост"}	{"kind": "ref", "target": {"filter": {"and": [{"aspect": "orbis/app"}, {"not": {"op": "eq", "prop": "orbis/supply_key", "value": "host-shell"}}]}}}	active	props	\N	\N	\N	86	{}	2026-11-05 02:11:05.89593+00	[]
orbis/supply_key	\N	orbis/supply_key	{"en": "Etalon key", "ru": "Ключ эталона"}	{"en": "Which host supply etalon this record came from; supply records and updates are found by it", "ru": "Какой эталон поставки хоста принесла эта запись; по нему ищутся записи поставки и собираются обновления"}	{"kind": "select", "options": [{"key": "host-template", "rank": 1, "label": {"en": "Host template", "ru": "Шаблон хоста"}}, {"key": "host-shell", "rank": 2, "label": {"en": "Host shell", "ru": "Оболочка хоста"}}, {"key": "home", "rank": 3, "label": {"en": "Home", "ru": "Домой"}}, {"key": "records", "rank": 4, "label": {"en": "Records", "ru": "Записи"}}, {"key": "daily-planning", "rank": 5, "label": {"en": "Daily Planning", "ru": "Daily Planning"}}, {"key": "agenda", "rank": 6, "label": {"en": "Agenda", "ru": "Повестка"}}, {"key": "all-tasks", "rank": 7, "label": {"en": "All Tasks", "ru": "All Tasks"}}, {"key": "horizon-year", "rank": 8, "label": {"en": "Year", "ru": "Год"}}, {"key": "horizon-life", "rank": 9, "label": {"en": "Life", "ru": "Жизнь"}}, {"key": "routines", "rank": 10, "label": {"en": "Routines", "ru": "Рутины"}}, {"key": "upcoming", "rank": 11, "label": {"en": "Upcoming", "ru": "Upcoming"}}]}	active	props	\N	\N	\N	87	{"writer": "supply"}	2026-11-05 02:11:05.8998+00	[]
orbis/supply_hash	\N	orbis/supply_hash	{"en": "Etalon hash", "ru": "Отпечаток эталона"}	{"en": "Hash of the etalon the record came or was updated with; a different hash in the supply is an update", "ru": "Отпечаток эталона, с которым запись пришла или была обновлена; иной отпечаток в поставке — обновление"}	{"kind": "text"}	active	props	\N	\N	\N	88	{"writer": "supply"}	2026-11-05 02:11:05.90363+00	[]
orbis/supply_text	\N	orbis/supply_text	{"en": "Etalon text", "ru": "Текст эталона"}	{"en": "The etalon as it came into the graph; the record is compared with it, and \\"Revert\\" restores it", "ru": "Эталон, каким он пришёл в граф; с ним сравнивается запись, и к нему возвращает «Вернуть как было»"}	{"kind": "text"}	active	props	\N	\N	\N	89	{"writer": "supply"}	2026-11-05 02:11:05.907935+00	[]
orbis/supply_declined	\N	orbis/supply_declined	{"en": "Declined etalon", "ru": "Отклонённый эталон"}	{"en": "Hash of the update the owner declined; the refusal holds until the next etalon", "ru": "Отпечаток обновления, от которого владелец отказался; отказ помнится до следующего эталона"}	{"kind": "text"}	active	props	\N	\N	\N	90	{"writer": "supply"}	2026-11-05 02:11:05.912266+00	[]
orbis/planned_date	\N	orbis/planned_date	{"en": "Planned day", "ru": "День в плане"}	{"en": "Day chosen to work on a task, independent of its deadline", "ru": "День, выбранный для работы над задачей; не крайний срок"}	{"kind": "date"}	active	props	\N	\N	\N	91	{}	2026-11-05 02:11:05.91681+00	[]
orbis/plan_order	\N	orbis/plan_order	{"en": "Plan order", "ru": "Порядок в плане"}	{"en": "Task position in the chosen day", "ru": "Порядок задачи в списке выбранного дня"}	{"min": 0, "kind": "number", "integer": true}	active	props	\N	\N	\N	92	{}	2026-11-05 02:11:05.920542+00	[]
orbis/inbox_state	\N	orbis/inbox_state	{"en": "Inbox state", "ru": "Разбор входящих"}	{"en": "Processing state of a raw capture", "ru": "Состояние разбора быстрой записи"}	{"kind": "select", "options": [{"key": "pending", "rank": 1, "label": {"en": "Pending", "ru": "Разобрать"}}, {"key": "processed", "rank": 2, "label": {"en": "Processed", "ru": "Разобрано"}}, {"key": "later", "rank": 3, "label": {"en": "Later", "ru": "Позже"}}]}	active	props	\N	\N	\N	93	{}	2026-11-05 02:11:05.924715+00	[]
\.


--
-- Data for Name: registry_deltas; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.registry_deltas (id, graph_id, target_kind, target_id, base_version, delta, created_at) FROM stdin;
\.


--
-- Data for Name: registry_system; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.registry_system (id, version, seeded_at) FROM stdin;
1	1	2026-11-05 02:11:06.104342+00
\.


--
-- Data for Name: relation_role_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.relation_role_definitions (id, graph_id, key, label, description, source_label, target_label, hierarchical, constraints, "symmetric", module, rank, created_at, rules) FROM stdin;
subitem	\N	subitem	{"en": "Subitem", "ru": "Подпункт"}	{"en": "Ordinary hierarchy: a part inside a whole — the default parent relation", "ru": "Обычная иерархия: часть внутри целого — дефолт для «сделай список дел»"}	{"en": "Parent", "ru": "Родитель"}	{"en": "Subitem", "ru": "Подпункт"}	t	{"created_by": "any"}	f	\N	1	2026-11-05 02:11:05.928203+00	[]
ticket	\N	ticket	{"en": "Ticket", "ru": "Тикет"}	{"en": "A unit of project work: what the executor picks up for a run", "ru": "Единица работы проекта: то, что исполнитель берёт в прогон"}	{"en": "Project", "ru": "Проект"}	{"en": "Ticket", "ru": "Тикет"}	t	{"created_by": "any", "target_contract": "orbis/completable"}	f	\N	2	2026-11-05 02:11:05.935348+00	[]
run	\N	run	{"en": "Run", "ru": "Прогон"}	{"en": "An executor run spawned by a ticket or a routine", "ru": "Прогон исполнителя, порождённый тикетом или рутиной"}	{"en": "Run subject", "ru": "Субъект прогона"}	{"en": "Run", "ru": "Прогон"}	t	{"created_by": "system"}	f	\N	3	2026-11-05 02:11:05.942605+00	[]
envelope-binding	\N	envelope-binding	{"en": "Envelope binding", "ru": "Привязка к конверту"}	{"en": "A transaction counted by a budget envelope", "ru": "Транзакция, которую считает конверт бюджета"}	{"en": "Envelope", "ru": "Конверт"}	{"en": "Transaction", "ru": "Транзакция"}	f	{"created_by": "system", "target_max_incoming": 1}	f	\N	4	2026-11-05 02:11:05.947145+00	[{"id": "envelope_binding_max_incoming", "undo": "skip", "params": {}, "enabled": true, "template": "target_max_incoming"}]
category-parent	\N	category-parent	{"en": "Category parent", "ru": "Родительская категория"}	{"en": "The finance category tree: a subcategory inside a category", "ru": "Дерево категорий финансов: подкатегория внутри категории"}	{"en": "Parent category", "ru": "Родительская категория"}	{"en": "Subcategory", "ru": "Подкатегория"}	t	{"acyclic": true, "created_by": "any"}	f	\N	5	2026-11-05 02:11:05.952347+00	[{"id": "category_parent_acyclic", "undo": "skip", "params": {}, "enabled": true, "template": "acyclic"}]
dependency	\N	dependency	{"en": "Dependency", "ru": "Зависимость"}	{"en": "Work will not start until another one is done", "ru": "Работа не начнётся, пока не сделана другая"}	{"en": "Blocking work", "ru": "Блокирующая работа"}	{"en": "Blocked work", "ru": "Заблокированная работа"}	f	{"acyclic": true, "created_by": "any"}	f	\N	6	2026-11-05 02:11:05.957276+00	[{"id": "dependency_acyclic", "undo": "skip", "params": {}, "enabled": true, "template": "acyclic"}]
mention	\N	mention	{"en": "Mention", "ru": "Упоминание"}	{"en": "A record mentions another by meaning, without subordination", "ru": "Запись упоминает другую по смыслу, без подчинения"}	{"en": "Mentions", "ru": "Упоминает"}	{"en": "Mentioned", "ru": "Упомянуто"}	f	{"created_by": "any"}	f	\N	7	2026-11-05 02:11:05.962909+00	[]
instance-of	\N	instance-of	{"en": "Instance of", "ru": "Экземпляр шаблона"}	{"en": "A record spawned by a recurrence template", "ru": "Запись порождена шаблоном повторения"}	{"en": "Template", "ru": "Шаблон"}	{"en": "Instance", "ru": "Экземпляр"}	f	{"created_by": "system"}	f	\N	8	2026-11-05 02:11:05.966469+00	[]
ref	\N	ref	{"en": "Property reference", "ru": "Ссылка свойства"}	{"en": "The graph mirror of a reference property value: the property is the truth, the edge is derived", "ru": "Зеркало значения ссылочного свойства в графе: истина — свойство, ребро производно"}	{"en": "Referrer", "ru": "Откуда ссылка"}	{"en": "Referenced", "ru": "Цель ссылки"}	f	{"created_by": "system"}	f	\N	9	2026-11-05 02:11:05.969904+00	[{"id": "mirror_ref", "undo": "skip", "params": {"meta_key": "property", "skip_computed": true}, "enabled": true, "template": "mirror_relation"}]
alternative-of	\N	alternative-of	{"en": "Alternative of", "ru": "Альтернатива"}	{"en": "Another way to achieve the same result", "ru": "Другой способ добиться того же результата"}	{"en": "Alternative", "ru": "Альтернатива"}	{"en": "Original option", "ru": "Исходный вариант"}	f	{"created_by": "any"}	f	\N	10	2026-11-05 02:11:05.974382+00	[]
supersedes	\N	supersedes	{"en": "Supersedes", "ru": "Замещает"}	{"en": "A record cancels the previous one and takes its place", "ru": "Запись отменяет прежнюю и встаёт на её место"}	{"en": "Replacement", "ru": "Замена"}	{"en": "Superseded", "ru": "Замещённое"}	f	{"created_by": "any"}	f	\N	11	2026-11-05 02:11:05.978033+00	[]
\.


--
-- Data for Name: relations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.relations (id, source_id, target_id, meta, created_at, updated_at, role) FROM stdin;
01a1a979-9f5c-713a-bd6d-e7c83d12a969	53153bf3-d362-5584-b0e6-a800c660b3c5	76d0f258-9065-5f64-96c6-da6f0c6278f3	{"property": "orbis/app_home"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f61-71b7-9b5e-86a973a210f1	53153bf3-d362-5584-b0e6-a800c660b3c5	a5b240dc-ed62-5489-9fe0-29e9b7b21d8e	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f65-70e9-b2e6-968201fa4d8f	53153bf3-d362-5584-b0e6-a800c660b3c5	a45e806b-517d-5372-a5bb-a599fcab6e6b	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f68-731f-9f6d-54b94c35d0bd	53153bf3-d362-5584-b0e6-a800c660b3c5	35fd6695-1b7b-548e-966b-3bdaae9b0446	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f6c-7357-a852-8e541fb861a5	53153bf3-d362-5584-b0e6-a800c660b3c5	22732249-3f87-5802-b701-f3767ef336bd	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f70-7282-baab-3df54020b575	53153bf3-d362-5584-b0e6-a800c660b3c5	e57ff285-60b1-587d-9504-854fa5ada148	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-9f75-704f-95c3-46afb1447753	53153bf3-d362-5584-b0e6-a800c660b3c5	8476068d-5802-521b-94b7-eca3a332ee2c	{"property": "orbis/app_nav"}	2026-11-05 02:11:22.535647+00	2026-11-05 02:11:22.535647+00	ref
01a1a979-a1be-70d8-9258-1ae469a9897a	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	61af277b-2ed5-592c-9074-410126aa8880	{"property": "orbis/app_home"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1c2-7433-a9c5-bc1eedac7ca3	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	3e2fef47-0983-5bed-939e-26a430695ca3	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1c6-740e-8126-7d7b91500e76	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	7c3326d1-5416-51c8-b4a2-c0673b80f044	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1cc-72c9-bcb4-428dfa6ace99	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	f3cb3be0-0a48-5471-8f01-fa5308e529bd	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1d0-7361-8c7f-41e56a307455	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	18331aa2-1bc8-51c1-bd62-6dde3f83cdbe	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1d4-7778-8ac9-52fa8cadc858	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	bdddb983-03bb-5441-9fbc-250580c758b8	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a1d9-748b-b3ec-25b98a2efc4d	67f317ad-0e24-5b2e-9308-8707d8ef2b7d	171a596b-921d-58d7-a834-71a80aee77c0	{"property": "orbis/app_nav"}	2026-11-05 02:11:23.165091+00	2026-11-05 02:11:23.165091+00	ref
01a1a979-a24b-71ae-8d26-290310ab8624	01a1a979-a1eb-77bd-91fc-1d9a3e6f86ee	01a1a979-a207-726b-ac4a-4fb3a35c0b5d	{}	2026-11-05 02:11:23.339+00	2026-11-05 02:11:23.339+00	dependency
\.


--
-- Data for Name: subscription_definitions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.subscription_definitions (id, graph_id, surface, definition, module, rank, created_at) FROM stdin;
orbis/budget-overview	\N	finance/budget-overview	{"cards": {"order_by": [{"deref": {"read": "orbis/title", "slot": "category"}}, {"slot": "period_start"}, {"core": "id"}]}, "lists": {"planned": {"over": "movement", "where": {"op": "and", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/money-movement"}}, {"const": "outflow"}]}, {"op": "not", "args": [{"op": "in", "args": [{"class": {"contract": "orbis/recurrence"}}, {"const": "templates"}]}]}]}, "order_by": [{"slot": "date"}, {"core": "id"}], "counted_set": "plans", "excludes_relation": {"role": "instance-of", "side": "target"}}, "coming_up": {"over": "movement", "window": {"to": {"param": "horizon_end"}, "from": {"ctx": "$today"}}, "order_by": [{"slot": "date"}, {"core": "id"}], "counted_set": "plans", "requires_relation": {"role": "instance-of", "side": "target"}}}, "alerts": {"on_raw": true, "warn_at": "0.85", "inclusive": true, "skip_phases": ["upcoming"]}, "engine": "budget", "params": ["period_start", "period_end", "horizon_end"], "phases": {"active": {"const": true}, "closed": {"op": ">", "args": [{"ctx": "$today"}, {"slot": "period_end"}]}, "upcoming": {"op": "<", "args": [{"ctx": "$today"}, {"slot": "period_start"}]}}, "rollup": {"mode": "same_currency_only", "role": "category-parent", "applies_to": ["spent", "effective_limit"]}, "sources": {"envelope": {"prefer": [], "contract": "orbis/envelope", "selector": {"match": ["category", "currency", "period"], "tie_break": ["shorter_period", "later_start", "min_id"]}, "binding_role": "envelope-binding"}, "movement": {"prefer": [], "contract": "orbis/money-movement", "counted_set": "facts"}}, "aggregates": {"spent": {"of": {"slot": "amount"}, "kind": "sum", "over": "movement", "alive": false, "scope": "envelope", "where": {"op": "in", "args": [{"class": {"contract": "orbis/money-movement"}}, {"const": "outflow"}]}, "window": "envelope_period", "currency": "same_as_envelope", "bound_via": "envelope-binding", "materialize": true}, "remaining": {"expr": {"op": "-", "args": [{"agg": "effective_limit"}, {"agg": "spent"}]}, "kind": "formula", "scope": "envelope"}, "daily_pace": {"expr": {"op": "if", "args": [{"op": "and", "args": [{"phase": "active"}, {"op": ">=", "args": [{"agg": "remaining"}, {"const": "0"}]}]}, {"op": "/", "args": [{"agg": "remaining"}, {"days_inclusive": [{"ctx": "$today"}, {"slot": "period_end"}]}]}, {"const": null}]}, "kind": "formula", "scope": "envelope"}, "unbudgeted": {"of": {"slot": "amount"}, "kind": "sum", "over": "movement", "alive": true, "scope": "period", "where": {"op": "in", "args": [{"class": {"contract": "orbis/money-movement"}}, {"const": "outflow"}]}, "window": "period", "currency": "owner_default_only", "group_by": {"slot": "category"}, "materialize": false, "unbound_via": "envelope-binding"}, "period_balance": {"of": {"slot": "amount"}, "kind": "sum", "over": "movement", "alive": false, "scope": "period", "window": "period", "currency": "owner_default_only", "group_by": {"slot": "direction"}, "materialize": false}, "effective_limit": {"expr": {"op": "+", "args": [{"slot": "limit"}, {"op": "if", "args": [{"has": "carryover"}, {"slot": "carryover"}, {"const": "0"}]}]}, "kind": "formula", "scope": "envelope"}}, "currency_rule": "owner_default_if_absent"}	finance	20	2026-11-05 02:11:06.083411+00
\.


--
-- Data for Name: user_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_settings (graph_id, plan, timezone, "defaultCurrency", "weekStartDay", "tagColors", "installedViews", "pinnedEntities", "viewPreferences", updated_at, registry_version, disabled_modules) FROM stdin;
6a772ba8-0c54-477b-8d3b-8a8aede2aef1	dev	Europe/Moscow	RUB	monday	{}	{}	[]	{}	2026-11-05 02:11:22.421118+00	0	{finance}
469c6a1e-320a-4d24-bdda-e8c070b816cd	dev	Europe/Moscow	RUB	monday	{}	{}	[]	{}	2026-11-05 02:11:23.118755+00	0	{finance}
\.


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 26, true);


--
-- Name: change_feed_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.change_feed_id_seq', 85, true);


--
-- Name: perf_samples_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.perf_samples_id_seq', 1, false);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: action_journal_entities action_journal_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_journal_entities
    ADD CONSTRAINT action_journal_entities_pkey PRIMARY KEY (graph_id, action_id, entity_id);


--
-- Name: action_journal action_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_pkey PRIMARY KEY (graph_id, id);


--
-- Name: agent_grants agent_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_graph_id_date_model_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_graph_id_date_model_pk PRIMARY KEY (graph_id, date, model);


--
-- Name: change_feed_floor change_feed_floor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_feed_floor
    ADD CONSTRAINT change_feed_floor_pkey PRIMARY KEY (id);


--
-- Name: change_feed change_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_feed
    ADD CONSTRAINT change_feed_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_threads chat_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_origins entity_origins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_pkey PRIMARY KEY (id);


--
-- Name: entity_origins entity_origins_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_uniq UNIQUE (graph_id, namespace, external_id);


--
-- Name: entity_versions entity_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_pkey PRIMARY KEY (id);


--
-- Name: envelope_spent_cache envelope_spent_cache_envelope_id_as_of_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_envelope_id_as_of_pk PRIMARY KEY (envelope_id, as_of);


--
-- Name: graph_members graph_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_members
    ADD CONSTRAINT graph_members_pkey PRIMARY KEY (id);


--
-- Name: graphs graphs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graphs
    ADD CONSTRAINT graphs_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: perf_samples perf_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.perf_samples
    ADD CONSTRAINT perf_samples_pkey PRIMARY KEY (id);


--
-- Name: registry_deltas registry_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_pkey PRIMARY KEY (id);


--
-- Name: registry_deltas registry_deltas_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_uniq UNIQUE (graph_id, target_kind, target_id);


--
-- Name: registry_system registry_system_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_system
    ADD CONSTRAINT registry_system_pkey PRIMARY KEY (id);


--
-- Name: relations rel_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT rel_uniq UNIQUE (source_id, target_id, role);


--
-- Name: relations relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (graph_id);


--
-- Name: action_definitions_builtin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_definitions_builtin_key ON public.action_definitions USING btree (key) WHERE (graph_id IS NULL);


--
-- Name: action_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_definitions_builtin_uniq ON public.action_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: action_definitions_custom_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_definitions_custom_key ON public.action_definitions USING btree (graph_id, key) WHERE (graph_id IS NOT NULL);


--
-- Name: action_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_definitions_custom_uniq ON public.action_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: action_journal_entities_probe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_journal_entities_probe ON public.action_journal_entities USING btree (graph_id, entity_id, created_at DESC);


--
-- Name: action_journal_graph_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_journal_graph_time ON public.action_journal USING btree (graph_id, created_at DESC, id DESC);


--
-- Name: action_journal_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_journal_run ON public.action_journal USING btree (graph_id, run_id) WHERE (run_id IS NOT NULL);


--
-- Name: action_journal_thread_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_journal_thread_time ON public.action_journal USING btree (graph_id, thread_id, created_at DESC, id DESC) WHERE (thread_id IS NOT NULL);


--
-- Name: action_journal_type_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_journal_type_time ON public.action_journal USING btree (graph_id, type, created_at DESC);


--
-- Name: action_journal_undoes_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX action_journal_undoes_uniq ON public.action_journal USING btree (graph_id, undoes) WHERE (undoes IS NOT NULL);


--
-- Name: agent_grants_access_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_grants_access_hash ON public.agent_grants USING btree (access_hash);


--
-- Name: agent_grants_code_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_grants_code_hash ON public.agent_grants USING btree (code_hash);


--
-- Name: agent_grants_graph; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_grants_graph ON public.agent_grants USING btree (graph_id);


--
-- Name: agent_grants_refresh_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_grants_refresh_hash ON public.agent_grants USING btree (refresh_hash);


--
-- Name: aspect_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX aspect_definitions_builtin_uniq ON public.aspect_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: aspect_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX aspect_definitions_custom_uniq ON public.aspect_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: change_feed_graph_tx_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_feed_graph_tx_id ON public.change_feed USING btree (graph_id, tx_id, id);


--
-- Name: change_feed_parent_proof; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_feed_parent_proof ON public.change_feed USING btree (tx_id, kind, row_key, id DESC) WHERE (kind = ANY (ARRAY['entity'::text, 'thread'::text, 'relation'::text]));


--
-- Name: chat_messages_metadata_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_metadata_gin ON public.chat_messages USING gin (metadata jsonb_path_ops);


--
-- Name: chat_messages_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_thread_created ON public.chat_messages USING btree (thread_id, created_at);


--
-- Name: chat_threads_entity_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_threads_entity_uniq ON public.chat_threads USING btree (graph_id, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: chat_threads_global_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_threads_global_uniq ON public.chat_threads USING btree (graph_id) WHERE (entity_id IS NULL);


--
-- Name: chat_threads_graph; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_threads_graph ON public.chat_threads USING btree (graph_id);


--
-- Name: contract_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contract_definitions_builtin_uniq ON public.contract_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: contract_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contract_definitions_custom_uniq ON public.contract_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: entities_aspects_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_aspects_gin ON public.entities USING gin (aspects);


--
-- Name: entities_body_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_body_fts ON public.entities USING gin (to_tsvector('simple'::regconfig, body));


--
-- Name: entities_body_refs_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_body_refs_gin ON public.entities USING gin (body_refs);


--
-- Name: entities_graph_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_graph_updated ON public.entities USING btree (graph_id, updated_at DESC) WHERE (NOT archived);


--
-- Name: entities_props_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_props_gin ON public.entities USING gin (props);


--
-- Name: entities_query_refs_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_query_refs_gin ON public.entities USING gin (query_refs);


--
-- Name: entities_tags_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_tags_gin ON public.entities USING gin (tags);


--
-- Name: entities_title_fts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_title_fts ON public.entities USING gin (to_tsvector('simple'::regconfig, title));


--
-- Name: entity_versions_entity_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_versions_entity_created ON public.entity_versions USING btree (entity_id, created_at DESC NULLS LAST);


--
-- Name: envelope_spent_cache_graph; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX envelope_spent_cache_graph ON public.envelope_spent_cache USING btree (graph_id, as_of);


--
-- Name: graph_members_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX graph_members_account ON public.graph_members USING btree (account_id);


--
-- Name: graph_members_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX graph_members_active_uniq ON public.graph_members USING btree (graph_id, account_id) WHERE (revoked_at IS NULL);


--
-- Name: perf_samples_account_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX perf_samples_account_created ON public.perf_samples USING btree (account_id, created_at);


--
-- Name: property_definitions_builtin_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_definitions_builtin_key ON public.property_definitions USING btree (key) WHERE (graph_id IS NULL);


--
-- Name: property_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_definitions_builtin_uniq ON public.property_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: property_definitions_custom_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_definitions_custom_key ON public.property_definitions USING btree (graph_id, key) WHERE (graph_id IS NOT NULL);


--
-- Name: property_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_definitions_custom_uniq ON public.property_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: relation_role_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX relation_role_definitions_builtin_uniq ON public.relation_role_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: relation_role_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX relation_role_definitions_custom_uniq ON public.relation_role_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: relations_source_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relations_source_role ON public.relations USING btree (source_id, role);


--
-- Name: relations_target_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relations_target_role ON public.relations USING btree (target_id, role);


--
-- Name: subscription_definitions_builtin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscription_definitions_builtin_uniq ON public.subscription_definitions USING btree (id) WHERE (graph_id IS NULL);


--
-- Name: subscription_definitions_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscription_definitions_custom_uniq ON public.subscription_definitions USING btree (graph_id, id) WHERE (graph_id IS NOT NULL);


--
-- Name: entities entities_body_stamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entities_body_stamp BEFORE INSERT OR UPDATE OF body, body_doc ON public.entities FOR EACH ROW EXECUTE FUNCTION public.entities_body_stamp();


--
-- Name: graph_members graph_members_keep_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER graph_members_keep_owner AFTER DELETE OR UPDATE ON public.graph_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.graph_members_keep_owner();


--
-- Name: graphs graphs_require_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER graphs_require_owner AFTER INSERT ON public.graphs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.graphs_require_owner();


--
-- Name: action_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.action_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.action_journal REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.aspect_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.chat_messages REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.chat_threads REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.contract_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.entities REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.entity_versions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.property_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.registry_deltas REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.registry_system REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.relation_role_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.relations REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.subscription_definitions REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_delete AFTER DELETE ON public.user_settings REFERENCING OLD TABLE AS feed_old FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.action_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.action_journal REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.aspect_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.chat_messages REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.chat_threads REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.contract_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.entities REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.entity_versions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.property_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.registry_deltas REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.registry_system REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.relation_role_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.relations REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.subscription_definitions REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_insert AFTER INSERT ON public.user_settings REFERENCING NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.action_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.action_journal FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.aspect_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.chat_messages FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.chat_threads FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.contract_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.entities FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.entity_versions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.property_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.registry_deltas FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.registry_system FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.relation_role_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.relations FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.subscription_definitions FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_truncate AFTER TRUNCATE ON public.user_settings FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.action_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_journal orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.action_journal REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: aspect_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.aspect_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_messages orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.chat_messages REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: chat_threads orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.chat_threads REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: contract_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.contract_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entities orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.entities REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: entity_versions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.entity_versions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: property_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.property_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_deltas orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.registry_deltas REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: registry_system orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.registry_system REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relation_role_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.relation_role_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: relations orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.relations REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: subscription_definitions orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.subscription_definitions REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: user_settings orbis_feed_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orbis_feed_update AFTER UPDATE ON public.user_settings REFERENCING OLD TABLE AS feed_old NEW TABLE AS feed_new FOR EACH STATEMENT EXECUTE FUNCTION public.orbis_capture_change_feed();


--
-- Name: action_definitions action_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_definitions
    ADD CONSTRAINT action_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: action_journal_entities action_journal_entities_action_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_journal_entities
    ADD CONSTRAINT action_journal_entities_action_fk FOREIGN KEY (graph_id, action_id) REFERENCES public.action_journal(graph_id, id) ON DELETE CASCADE;


--
-- Name: action_journal action_journal_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id) ON DELETE CASCADE;


--
-- Name: action_journal action_journal_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_journal
    ADD CONSTRAINT action_journal_thread_id_chat_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id) ON DELETE SET NULL;


--
-- Name: agent_grants agent_grants_client_id_oauth_clients_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_client_id_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: agent_grants agent_grants_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: ai_usage ai_usage_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: aspect_definitions aspect_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aspect_definitions
    ADD CONSTRAINT aspect_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: chat_messages chat_messages_thread_id_chat_threads_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_thread_id_chat_threads_id_fk FOREIGN KEY (thread_id) REFERENCES public.chat_threads(id);


--
-- Name: chat_threads chat_threads_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: chat_threads chat_threads_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_threads
    ADD CONSTRAINT chat_threads_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: contract_definitions contract_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_definitions
    ADD CONSTRAINT contract_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entities entities_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entity_origins entity_origins_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_origins entity_origins_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_origins
    ADD CONSTRAINT entity_origins_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: entity_versions entity_versions_entity_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_id_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_versions entity_versions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: envelope_spent_cache envelope_spent_cache_envelope_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_envelope_id_entities_id_fk FOREIGN KEY (envelope_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: envelope_spent_cache envelope_spent_cache_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.envelope_spent_cache
    ADD CONSTRAINT envelope_spent_cache_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: graph_members graph_members_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_members
    ADD CONSTRAINT graph_members_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: property_definitions property_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_definitions
    ADD CONSTRAINT property_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: registry_deltas registry_deltas_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registry_deltas
    ADD CONSTRAINT registry_deltas_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: relation_role_definitions relation_role_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relation_role_definitions
    ADD CONSTRAINT relation_role_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: relations relations_source_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_source_id_entities_id_fk FOREIGN KEY (source_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: relations relations_target_id_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relations
    ADD CONSTRAINT relations_target_id_entities_id_fk FOREIGN KEY (target_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: subscription_definitions subscription_definitions_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_definitions
    ADD CONSTRAINT subscription_definitions_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: user_settings user_settings_graph_id_graphs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_graph_id_graphs_id_fk FOREIGN KEY (graph_id) REFERENCES public.graphs(id);


--
-- Name: graph_members account_owns_personal_graph; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_owns_personal_graph ON public.graph_members FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT auth.uid() AS uid)) AND (account_id = ( SELECT auth.uid() AS uid)) AND (grant_kind = 'owner'::text) AND (issued_by = ( SELECT auth.uid() AS uid)) AND (revoked_at IS NULL)));


--
-- Name: graph_members account_reads_own_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_reads_own_membership ON public.graph_members FOR SELECT TO authenticated USING ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: action_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.action_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: action_journal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.action_journal ENABLE ROW LEVEL SECURITY;

--
-- Name: action_journal_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.action_journal_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: aspect_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aspect_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: change_feed; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_feed ENABLE ROW LEVEL SECURITY;

--
-- Name: change_feed_floor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_feed_floor ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_grants current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.agent_grants FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.ai_usage FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.chat_messages FOR DELETE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.chat_threads FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entities current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.entities FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.entity_origins FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_versions current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.entity_versions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: envelope_spent_cache current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.envelope_spent_cache FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: registry_deltas current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.registry_deltas FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.relations FOR DELETE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_delete ON public.user_settings FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.action_journal FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal_entities current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.action_journal_entities FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: agent_grants current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.agent_grants FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.ai_usage FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.chat_messages FOR INSERT TO authenticated WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.chat_threads FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND ((entity_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = chat_threads.entity_id) AND (e.graph_id = chat_threads.graph_id)))))));


--
-- Name: entities current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.entities FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.entity_origins FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_origins.entity_id) AND (e.graph_id = entity_origins.graph_id))))));


--
-- Name: entity_versions current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.entity_versions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_versions.entity_id) AND (e.graph_id = entity_versions.graph_id))))));


--
-- Name: envelope_spent_cache current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.envelope_spent_cache FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = envelope_spent_cache.envelope_id) AND (e.graph_id = envelope_spent_cache.graph_id))))));


--
-- Name: registry_deltas current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.registry_deltas FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.relations FOR INSERT TO authenticated WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_insert ON public.user_settings FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_journal current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.action_journal FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: action_journal_entities current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.action_journal_entities FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: agent_grants current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.agent_grants FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: ai_usage current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.ai_usage FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: change_feed current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.change_feed FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: change_feed_floor current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.change_feed_floor FOR SELECT TO authenticated USING (( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph));


--
-- Name: chat_messages current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.chat_messages FOR SELECT TO authenticated USING ((( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.chat_threads FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entities current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.entities FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entity_origins current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.entity_origins FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: entity_versions current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.entity_versions FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: envelope_spent_cache current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.envelope_spent_cache FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: registry_deltas current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.registry_deltas FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: relations current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.relations FOR SELECT TO authenticated USING ((( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_select ON public.user_settings FOR SELECT TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph)));


--
-- Name: agent_grants current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.agent_grants FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_owns_current_graph() AS actor_owns_current_graph)));


--
-- Name: ai_usage current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.ai_usage FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: chat_messages current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.chat_messages FOR UPDATE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))))) WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.chat_threads t
  WHERE ((t.id = chat_messages.thread_id) AND (t.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: chat_threads current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.chat_threads FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND ((entity_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = chat_threads.entity_id) AND (e.graph_id = chat_threads.graph_id)))))));


--
-- Name: entities current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.entities FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entity_origins current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.entity_origins FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_origins.entity_id) AND (e.graph_id = entity_origins.graph_id))))));


--
-- Name: entity_versions current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.entity_versions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_versions.entity_id) AND (e.graph_id = entity_versions.graph_id))))));


--
-- Name: envelope_spent_cache current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.envelope_spent_cache FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = envelope_spent_cache.envelope_id) AND (e.graph_id = envelope_spent_cache.graph_id))))));


--
-- Name: registry_deltas current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.registry_deltas FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relations current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.relations FOR UPDATE TO authenticated USING ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))))) WITH CHECK ((( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.source_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id))))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = relations.target_id) AND (e.graph_id = ( SELECT public.current_graph_id() AS current_graph_id)))))));


--
-- Name: user_settings current_graph_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY current_graph_update ON public.user_settings FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: action_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.action_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.aspect_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.contract_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.property_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.relation_role_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delete_own ON public.subscription_definitions FOR DELETE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_origins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_origins ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: envelope_spent_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.envelope_spent_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: graph_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.graph_members ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.graphs ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs member_reads_graph; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY member_reads_graph ON public.graphs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.graph_members m
  WHERE ((m.graph_id = graphs.id) AND (m.account_id = ( SELECT auth.uid() AS uid)) AND (m.revoked_at IS NULL)))));


--
-- Name: oauth_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: perf_samples own_account_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_account_insert ON public.perf_samples FOR INSERT TO authenticated WITH CHECK ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: perf_samples own_account_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_account_select ON public.perf_samples FOR SELECT TO authenticated USING ((account_id = ( SELECT auth.uid() AS uid)));


--
-- Name: perf_samples; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.perf_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: graphs person_creates_own_graph; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY person_creates_own_graph ON public.graphs FOR INSERT TO authenticated WITH CHECK (((owner_kind = 'person'::text) AND (id = ( SELECT auth.uid() AS uid)) AND (owner_ref = ( SELECT auth.uid() AS uid))));


--
-- Name: property_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: registry_system read_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_all ON public.registry_system FOR SELECT USING (true);


--
-- Name: action_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.action_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: aspect_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.aspect_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: contract_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.contract_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: property_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.property_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: relation_role_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.relation_role_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: subscription_definitions read_builtin_or_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_builtin_or_own ON public.subscription_definitions FOR SELECT TO authenticated USING (((graph_id IS NULL) OR ((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_reads_current_graph() AS actor_reads_current_graph))));


--
-- Name: registry_deltas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.registry_deltas ENABLE ROW LEVEL SECURITY;

--
-- Name: registry_system; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.registry_system ENABLE ROW LEVEL SECURITY;

--
-- Name: relation_role_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.relation_role_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: relations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.relations ENABLE ROW LEVEL SECURITY;

--
-- Name: graph_members scheduler_reads_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scheduler_reads_members ON public.graph_members FOR SELECT TO orbis_app USING (true);


--
-- Name: user_settings scheduler_reads_owner_list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scheduler_reads_owner_list ON public.user_settings FOR SELECT TO orbis_app USING (true);


--
-- Name: oauth_clients server_manages_clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY server_manages_clients ON public.oauth_clients TO orbis_app USING (true) WITH CHECK (true);


--
-- Name: agent_grants server_manages_grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY server_manages_grants ON public.agent_grants TO orbis_app USING (true) WITH CHECK (true);


--
-- Name: subscription_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: action_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.action_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.aspect_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.contract_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.property_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.relation_role_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own ON public.subscription_definitions FOR UPDATE TO authenticated USING (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph))) WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: action_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.action_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: aspect_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.aspect_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: contract_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.contract_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: property_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.property_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: relation_role_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.relation_role_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- Name: subscription_definitions write_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_own ON public.subscription_definitions FOR INSERT TO authenticated WITH CHECK (((graph_id = ( SELECT public.current_graph_id() AS current_graph_id)) AND ( SELECT public.actor_writes_current_graph() AS actor_writes_current_graph)));


--
-- PostgreSQL database dump complete
--

\unrestrict gzZeUnLKwfzvSrkYyMYQ9Xi1HoV96Ah3bMzE3y97cwKeDOYdOvInRLoA7rpRH7z

