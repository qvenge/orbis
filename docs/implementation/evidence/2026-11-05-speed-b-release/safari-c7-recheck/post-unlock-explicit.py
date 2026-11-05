import hashlib, json, time
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler
from urllib.parse import quote

root = Path(__file__).parent
out = root / 'post-unlock-explicit'
out.mkdir(exist_ok=False)
descriptor = json.loads((root / 'fixture.json').read_text())
assert descriptor['source'] == 'c7ccb9dd1f4cc1f68d43255ecf313768ebc2b315'
assert descriptor['origin'] == 'http://127.0.0.1:61071'
assert descriptor['expiresAt'] - time.time() > 120
driver = 'http://127.0.0.1:55371/session/E346253A-B974-48FF-81D2-561B19511EAE/'
source = Path('/Users/birzhan/.codex/worktrees/853d/orbis/.superpowers/sdd/2026-11-05-speed-b-release/safari-recheck-stand')
storage_script = (source / 'storage-snapshot.js').read_text()
event_script = (source / 'recovery-observation.js').read_text()
prior = root / 'recovery-client-6db6edfc'
offered = json.loads((prior / 'recovery-before-choice.json').read_text())
foreign = json.loads((prior / 'foreign-server-c.json').read_text())
opener = build_opener(ProxyHandler({}))
sequence = 0
deadline = None

def save(name, value):
    (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def call(url, payload=None, method='POST', observe=False):
    global sequence
    assert url.startswith(driver) or url == descriptor['stateURL']
    timeout = 2 if observe else (8 if deadline is None else min(8, deadline-time.monotonic()))
    if timeout <= 0: raise TimeoutError('18-second post-unlock action ended')
    sequence += 1
    save(f'{sequence:03d}-request.json', {'at':time.time(), 'url':url, 'method':method, 'body':payload})
    request = Request(url, method=method, data=None if payload is None else json.dumps(payload).encode(),
                      headers={'Content-Type':'application/json'} if payload is not None else {})
    with opener.open(request, timeout=timeout) as response:
        value = json.load(response)
        save(f'{sequence:03d}-response.json', {'status':response.status,'value':value,'at':time.time()})
    assert not isinstance(value.get('value'), dict) or 'error' not in value['value'], value
    return value

def wd(path, payload=None, method='POST', observe=False):
    return call(driver+path, payload, method, observe)['value']

def state(observe=False):
    value = call(descriptor['stateURL'], method='GET', observe=observe)
    assert value['owner'] == descriptor['owner'] and value['recordId'] == descriptor['recordId']
    return value

def snapshot(observe=False):
    return wd('execute/async', {'script':storage_script,'args':[descriptor['origin'],descriptor['owner'],descriptor['recordId']]}, observe=observe)

def inputs(value):
    copies = [item for row in value.get('inputs',{}).get('rows',[]) for item in [row.get('snapshot'),row.get('acknowledgedFallback')]]
    copies += [row.get('draft') for row in value.get('emergency',[]) if not row.get('finished')]
    return [item for item in copies if item]

def token(item):
    return item.get('token') or item.get('inputToken') or {}

pending = [item for item in inputs(offered) if not item.get('acknowledged')]
assert len(pending) == 1
expected_token, expected_doc = token(pending[0]), pending[0]['doc']
result = None
try:
    assert wd('url', method='GET') == descriptor['recordURL']
    initial, local = state(), snapshot()
    assert initial['bodyRevision'] == foreign['bodyRevision'] == 3 and initial['body'] == foreign['body']
    assert any(token(item)==expected_token and item['doc']==expected_doc for item in inputs(local))
    assert local.get('recovery')
    save('before.json', {'server':initial,'storage':local,'token':expected_token,'doc':expected_doc})
    boundary = len(initial['events'])
    deadline = time.monotonic()+18
    button = wd('element', {'using':'xpath','value':"//*[@data-testid='draft-banner']//button[normalize-space(.)='Оставить моё']"})
    wd('element/'+quote(button['element-6066-11e4-a52e-4f735466cecf'],safe='')+'/click', {})
    while True:
        actual = state()
        acks = [event['receipt'] for event in actual['events'][boundary:] if event.get('kind')=='body-ack']
        assert len(acks) <= 1
        if acks: break
        time.sleep(.1)
    ack = acks[0]
    assert ack['status']==200 and ack['bodyRevision']==4 and ack['bodyDoc']==expected_doc
    while True:
        durable = snapshot()
        rows = durable.get('responses',{}).get('rows',[])
        cached = any(row.get('data',{}).get('entity',{}).get('bodyRevision')==4 and row['data']['entity'].get('bodyDoc')==expected_doc for row in rows)
        retired = durable.get('inputs',{}).get('available') and not durable.get('emergencyError') and not any(token(item).get('nonce')==expected_token['nonce'] for item in inputs(durable))
        if cached and retired and not durable.get('recovery'): break
        time.sleep(.1)
    save('durable.json', durable)
    result = {'ok':True,'phase':'separate-post-unlock-explicit-recovery','revision':4,'exactToken':expected_token,'receipt':ack}
except Exception as error:
    result = {'ok':False,'phase':'separate-post-unlock-explicit-recovery','error':str(error)}
finally:
    for name, read in [('events',lambda:wd('execute/sync',{'script':event_script,'args':[descriptor['origin'],descriptor['recordId'],'read-stop']},observe=True)),('server',lambda:state(True)),('storage',lambda:snapshot(True))]:
        try: save('after-'+name+'.json', read())
        except Exception as error: save('after-'+name+'-error.json', {'error':str(error)})
    save('result.json', result)
    print(json.dumps({'ok':result['ok'],'phase':result['phase'],'error':result.get('error'),'revision':result.get('revision'),'evidence':str(out)}))
raise SystemExit(0 if result['ok'] else 1)
