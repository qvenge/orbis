--
-- PostgreSQL database dump
--

\restrict lCTttPRad4G3FD0WLZJxXj07jTm9SL9V1Mp7bb4HkKqZgJ5ssnHnow1eWGKLIds

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
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO orbis_change_feed_owner;


--
-- Name: FUNCTION actor_owns_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_owns_current_graph() TO service_role;


--
-- Name: FUNCTION actor_reads_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_reads_current_graph() TO service_role;


--
-- Name: FUNCTION actor_writes_current_graph(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO postgres;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO anon;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO authenticated;
GRANT ALL ON FUNCTION public.actor_writes_current_graph() TO service_role;


--
-- Name: FUNCTION current_graph_id(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.current_graph_id() TO postgres;
GRANT ALL ON FUNCTION public.current_graph_id() TO anon;
GRANT ALL ON FUNCTION public.current_graph_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_graph_id() TO service_role;


--
-- Name: FUNCTION entities_body_stamp(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.entities_body_stamp() TO postgres;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO anon;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO authenticated;
GRANT ALL ON FUNCTION public.entities_body_stamp() TO service_role;


--
-- Name: FUNCTION graph_members_keep_owner(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO postgres;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO anon;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO authenticated;
GRANT ALL ON FUNCTION public.graph_members_keep_owner() TO service_role;


--
-- Name: FUNCTION graphs_require_owner(); Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON FUNCTION public.graphs_require_owner() TO postgres;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO anon;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO authenticated;
GRANT ALL ON FUNCTION public.graphs_require_owner() TO service_role;


--
-- Name: FUNCTION orbis_capture_change_feed(); Type: ACL; Schema: public; Owner: orbis_change_feed_owner
--

REVOKE ALL ON FUNCTION public.orbis_capture_change_feed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_capture_change_feed() TO postgres;


--
-- Name: FUNCTION orbis_feed_entity_graph(entity_id uuid, xid xid8); Type: ACL; Schema: public; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) TO postgres;
GRANT ALL ON FUNCTION public.orbis_feed_entity_graph(entity_id uuid, xid xid8) TO orbis_change_feed_owner;


--
-- Name: FUNCTION orbis_feed_last_event(event_kind text, event_key text, xid xid8); Type: ACL; Schema: public; Owner: supabase_admin
--

REVOKE ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) FROM PUBLIC;
GRANT ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) TO postgres;
GRANT ALL ON FUNCTION public.orbis_feed_last_event(event_kind text, event_key text, xid xid8) TO orbis_change_feed_owner;


--
-- Name: TABLE action_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_definitions TO postgres;
GRANT ALL ON TABLE public.action_definitions TO anon;
GRANT ALL ON TABLE public.action_definitions TO authenticated;
GRANT ALL ON TABLE public.action_definitions TO service_role;


--
-- Name: TABLE action_journal; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_journal TO postgres;
GRANT ALL ON TABLE public.action_journal TO service_role;
GRANT SELECT,INSERT ON TABLE public.action_journal TO authenticated;


--
-- Name: TABLE action_journal_entities; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.action_journal_entities TO postgres;
GRANT ALL ON TABLE public.action_journal_entities TO service_role;
GRANT SELECT,INSERT ON TABLE public.action_journal_entities TO authenticated;


--
-- Name: TABLE agent_grants; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.agent_grants TO postgres;
GRANT ALL ON TABLE public.agent_grants TO anon;
GRANT ALL ON TABLE public.agent_grants TO authenticated;
GRANT ALL ON TABLE public.agent_grants TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_grants TO orbis_app;


--
-- Name: TABLE ai_usage; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.ai_usage TO postgres;
GRANT ALL ON TABLE public.ai_usage TO anon;
GRANT ALL ON TABLE public.ai_usage TO authenticated;
GRANT ALL ON TABLE public.ai_usage TO service_role;


--
-- Name: TABLE aspect_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.aspect_definitions TO postgres;
GRANT ALL ON TABLE public.aspect_definitions TO anon;
GRANT ALL ON TABLE public.aspect_definitions TO authenticated;
GRANT ALL ON TABLE public.aspect_definitions TO service_role;


--
-- Name: TABLE change_feed; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.change_feed TO postgres;
GRANT SELECT ON TABLE public.change_feed TO authenticated;
GRANT INSERT ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.tx_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(tx_id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.kind; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(kind) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.row_key; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(row_key) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.entity_ids; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(entity_ids) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.operation; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(operation) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed.graph_wide; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_wide) ON TABLE public.change_feed TO orbis_change_feed_owner;


--
-- Name: TABLE change_feed_floor; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.change_feed_floor TO postgres;
GRANT SELECT ON TABLE public.change_feed_floor TO authenticated;


--
-- Name: COLUMN change_feed_floor.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.change_feed_floor TO orbis_change_feed_owner;


--
-- Name: COLUMN change_feed_floor.floor; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(floor),UPDATE(floor) ON TABLE public.change_feed_floor TO orbis_change_feed_owner;


--
-- Name: SEQUENCE change_feed_id_seq; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON SEQUENCE public.change_feed_id_seq TO postgres;


--
-- Name: TABLE chat_messages; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.chat_messages TO postgres;
GRANT ALL ON TABLE public.chat_messages TO anon;
GRANT ALL ON TABLE public.chat_messages TO authenticated;
GRANT ALL ON TABLE public.chat_messages TO service_role;


--
-- Name: TABLE chat_threads; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.chat_threads TO postgres;
GRANT ALL ON TABLE public.chat_threads TO anon;
GRANT ALL ON TABLE public.chat_threads TO authenticated;
GRANT ALL ON TABLE public.chat_threads TO service_role;


--
-- Name: COLUMN chat_threads.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: COLUMN chat_threads.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: COLUMN chat_threads.entity_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(entity_id) ON TABLE public.chat_threads TO orbis_change_feed_owner;


--
-- Name: TABLE contract_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.contract_definitions TO postgres;
GRANT ALL ON TABLE public.contract_definitions TO anon;
GRANT ALL ON TABLE public.contract_definitions TO authenticated;
GRANT ALL ON TABLE public.contract_definitions TO service_role;


--
-- Name: TABLE entities; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entities TO postgres;
GRANT ALL ON TABLE public.entities TO anon;
GRANT ALL ON TABLE public.entities TO authenticated;
GRANT ALL ON TABLE public.entities TO service_role;


--
-- Name: COLUMN entities.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.entities TO orbis_change_feed_owner;


--
-- Name: COLUMN entities.graph_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(graph_id) ON TABLE public.entities TO orbis_change_feed_owner;


--
-- Name: TABLE entity_origins; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entity_origins TO postgres;
GRANT ALL ON TABLE public.entity_origins TO anon;
GRANT ALL ON TABLE public.entity_origins TO authenticated;
GRANT ALL ON TABLE public.entity_origins TO service_role;


--
-- Name: TABLE entity_versions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.entity_versions TO postgres;
GRANT ALL ON TABLE public.entity_versions TO anon;
GRANT ALL ON TABLE public.entity_versions TO authenticated;
GRANT ALL ON TABLE public.entity_versions TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entity_versions TO orbis_app;


--
-- Name: TABLE envelope_spent_cache; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.envelope_spent_cache TO postgres;
GRANT ALL ON TABLE public.envelope_spent_cache TO anon;
GRANT ALL ON TABLE public.envelope_spent_cache TO authenticated;
GRANT ALL ON TABLE public.envelope_spent_cache TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.envelope_spent_cache TO orbis_app;


--
-- Name: TABLE graph_members; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.graph_members TO postgres;
GRANT ALL ON TABLE public.graph_members TO service_role;
GRANT SELECT,INSERT ON TABLE public.graph_members TO authenticated;
GRANT SELECT ON TABLE public.graph_members TO orbis_app;


--
-- Name: TABLE graphs; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.graphs TO postgres;
GRANT ALL ON TABLE public.graphs TO service_role;
GRANT SELECT,INSERT ON TABLE public.graphs TO authenticated;


--
-- Name: TABLE oauth_clients; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.oauth_clients TO postgres;
GRANT ALL ON TABLE public.oauth_clients TO anon;
GRANT ALL ON TABLE public.oauth_clients TO authenticated;
GRANT ALL ON TABLE public.oauth_clients TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oauth_clients TO orbis_app;


--
-- Name: TABLE perf_samples; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.perf_samples TO postgres;
GRANT ALL ON TABLE public.perf_samples TO service_role;
GRANT SELECT,INSERT ON TABLE public.perf_samples TO authenticated;


--
-- Name: SEQUENCE perf_samples_id_seq; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO postgres;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO anon;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.perf_samples_id_seq TO service_role;


--
-- Name: TABLE property_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.property_definitions TO postgres;
GRANT ALL ON TABLE public.property_definitions TO anon;
GRANT ALL ON TABLE public.property_definitions TO authenticated;
GRANT ALL ON TABLE public.property_definitions TO service_role;


--
-- Name: TABLE registry_deltas; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.registry_deltas TO postgres;
GRANT ALL ON TABLE public.registry_deltas TO anon;
GRANT ALL ON TABLE public.registry_deltas TO authenticated;
GRANT ALL ON TABLE public.registry_deltas TO service_role;


--
-- Name: TABLE registry_system; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.registry_system TO postgres;
GRANT ALL ON TABLE public.registry_system TO anon;
GRANT ALL ON TABLE public.registry_system TO authenticated;
GRANT ALL ON TABLE public.registry_system TO service_role;


--
-- Name: TABLE relation_role_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.relation_role_definitions TO postgres;
GRANT ALL ON TABLE public.relation_role_definitions TO anon;
GRANT ALL ON TABLE public.relation_role_definitions TO authenticated;
GRANT ALL ON TABLE public.relation_role_definitions TO service_role;


--
-- Name: TABLE relations; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.relations TO postgres;
GRANT ALL ON TABLE public.relations TO anon;
GRANT ALL ON TABLE public.relations TO authenticated;
GRANT ALL ON TABLE public.relations TO service_role;


--
-- Name: COLUMN relations.id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: COLUMN relations.source_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(source_id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: COLUMN relations.target_id; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT SELECT(target_id) ON TABLE public.relations TO orbis_change_feed_owner;


--
-- Name: TABLE subscription_definitions; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.subscription_definitions TO postgres;
GRANT ALL ON TABLE public.subscription_definitions TO anon;
GRANT ALL ON TABLE public.subscription_definitions TO authenticated;
GRANT ALL ON TABLE public.subscription_definitions TO service_role;


--
-- Name: TABLE user_settings; Type: ACL; Schema: public; Owner: supabase_admin
--

GRANT ALL ON TABLE public.user_settings TO postgres;
GRANT ALL ON TABLE public.user_settings TO anon;
GRANT ALL ON TABLE public.user_settings TO authenticated;
GRANT ALL ON TABLE public.user_settings TO service_role;
GRANT SELECT ON TABLE public.user_settings TO orbis_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict lCTttPRad4G3FD0WLZJxXj07jTm9SL9V1Mp7bb4HkKqZgJ5ssnHnow1eWGKLIds

