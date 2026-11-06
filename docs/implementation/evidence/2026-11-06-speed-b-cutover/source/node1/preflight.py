"""Same readonly P identity gates; called only after a new root-issued handoff."""
import json, os, re, subprocess, urllib.parse

def check(handoff_path, digest, private):
    import hashlib, pathlib
    assert hashlib.sha256(pathlib.Path(handoff_path).read_bytes()).hexdigest() == digest
    h = json.loads(pathlib.Path(handoff_path).read_text())
    assert h['lane'] == 'P' and h['db']['port'] == 54346 and h['db']['name'] == 'postgres'
    assert h['db']['admin'] == 'supabase_admin' and h['db']['runtime'] == 'orbis_app'
    assert re.fullmatch('[a-f0-9]{64}', h['container']['id'])
    assert h['container']['image'] == 'sha256:6501843661b1f8ff97e85c02de33edc0ee2e2693888ad596ee86222f02dc8ecc'
    c = json.loads(subprocess.check_output(['docker', 'inspect', '--type=container', 'orbis-speed-b-cutover-p-node'], text=True, timeout=10))[0]
    assert c['Id'] == h['container']['id'] and c['Image'] == h['container']['image']
    assert c['State']['Running'] and c['Config']['Labels']['orbis.cutover.lane'] == 'p-node'
    assert {k:v for k,v in c['NetworkSettings']['Ports'].items() if v is not None} == {'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'54346'}]}
    def query(role, text):
        raw = private['DATABASE_URL_ADMIN' if role == 'admin' else 'DATABASE_URL']
        u = urllib.parse.urlsplit(raw)
        assert u.scheme in ('postgres','postgresql') and u.hostname == '127.0.0.1' and u.port == 54346
        user = h['db']['admin' if role == 'admin' else 'runtime']
        assert u.username == user and u.path == '/postgres' and u.password and '?' not in raw and '#' not in raw
        return subprocess.check_output(['psql','-X','-qAt','-w','-h','127.0.0.1','-p','54346','-U',user,'-d','postgres','-v','ON_ERROR_STOP=1','-F','|','-c',text],
            env=dict(os.environ, PGPASSWORD=urllib.parse.unquote(u.password)), text=True, timeout=10).strip()
    admin = query('admin', "select current_database(),current_user,session_user,inet_server_port(),system_identifier::text,(select max(created_at)::text from drizzle.__drizzle_migrations),(select rolsuper from pg_roles where rolname='supabase_admin'),(select rolsuper from pg_roles where rolname='postgres') from pg_control_system()")
    assert admin.split('|') == ['postgres','supabase_admin','supabase_admin','5432',h['db']['systemId'],'1790767973713','t','f']
    runtime = query('runtime', "select current_database(),current_user,session_user,inet_server_port(),rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication,pg_has_role(current_user,'authenticated','MEMBER'),exists(select 1 from pg_roles p where p.rolname in ('postgres','supabase_admin','service_role','orbis_change_feed_owner') and pg_has_role(r.oid,p.oid,'MEMBER')) from pg_roles r where rolname=current_user")
    assert runtime == 'postgres|orbis_app|orbis_app|5432|f|f|f|f|f|f|t|f'
    return {'container': h['container'], 'systemId': h['db']['systemId'], 'admin': admin, 'runtime': runtime, 'migration': '0026'}
