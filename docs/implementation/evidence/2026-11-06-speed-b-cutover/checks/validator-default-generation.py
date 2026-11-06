import copy,hashlib,json,os,pathlib,subprocess,sys,time
root=pathlib.Path(__file__).resolve().parents[1]
helper=pathlib.Path(sys.argv[1]).resolve()
out=pathlib.Path(sys.argv[2]).resolve();out.mkdir()
raw=pathlib.Path('/private/tmp/orbis-cutover-node-p.shy83qv9/run')
before=json.loads((raw/'4-before-old-exit.input.json').read_text())
after=json.loads(next(raw.glob('6-*.input.json')).read_text())
manifest=pathlib.Path('/private/tmp/orbis-cutover-node2-allocation.ced608eb5f5d/manifests/current.json')
meta=json.loads(manifest.read_text());results=[]
def call(label,value,want):
 run=subprocess.run(['/Users/birzhan/.bun/bin/bun',str(helper),meta['tree'],str(manifest),'2ec1888a7d71ebd2e93bca482da11620a087a6f479403cc86968d4e71b048abe'],input=json.dumps(value),text=True,capture_output=True,cwd=meta['tree'],env={'PATH':os.environ['PATH']},timeout=5)
 answer=json.loads(run.stdout)
 (out/(label+'.json')).write_text(json.dumps({'exit':run.returncode,'answer':answer},indent=2)+'\n')
 passed=(run.returncode==0)==want and answer['ok']==want and not run.stderr
 results.append({'case':label,'expectedAccepted':want,'accepted':answer['ok'],'passed':passed})
 return answer
for key in ['a','b']:
 id=before['ids'][key]
 row=next(r for r in before['legacy'] if r['key'].endswith(':'+id))
 old=json.loads(row['raw'])
 value={'observed':copy.deepcopy(after),'owner':after['owner'],'id':id,'expected':{'doc':old['doc'],'baseRevision':old['baseRevision']}}
 result=call('real-migrated-'+key+'-default-metadata',value,True)
 if '--controls' not in sys.argv:continue
 # Every control starts with actual durable bytes and changes one relevant fact.
 matching=next(s for s in value['observed']['slots'] if s['latest']['entityId']==id)
 token=matching['snapshot']['token']
 for kind in ['foreign-account','foreign-graph','foreign-entity','wrong-generation','wrong-basis','invalid-lineage','expired','acknowledged','finished','changed-document','previous-token-disappeared','corrupt-control','nondefault-generation']:
  v=copy.deepcopy(value);slot=next(s for s in v['observed']['slots'] if s['latest']['entityId']==id);t=slot['snapshot']['token']
  if kind.startswith('foreign-'):t[{'foreign-account':'accountId','foreign-graph':'graphId','foreign-entity':'entityId'}[kind]]='foreign'
  elif kind=='wrong-generation':t['generation']='other:0'
  elif kind=='wrong-basis':t['basis']['revision']+=1
  elif kind=='invalid-lineage':slot['key'][2]='other'
  elif kind=='expired':slot['snapshot']['savedAt']='2020-01-01T00:00:00.000Z'
  elif kind=='acknowledged':slot['snapshot']['acknowledged']=True
  elif kind=='finished':v['observed']['finished'].append({'key':'orbis:body-draft-finished:'+v['owner']+':'+id+':'+t['nonce'],'raw':'1'})
  elif kind=='changed-document':slot['snapshot']['doc']={'v':3,'doc':{'type':'doc','content':[]}}
  elif kind=='previous-token-disappeared':v['previousTokens']=[dict(t,nonce='missing')]
  elif kind=='corrupt-control':v['observed']['controlRaw']='{"unexpected":true}'
  elif kind=='nondefault-generation':v['observed']['controlRaw']=json.dumps({'mode':'normal','generation':'next','inputGeneration':'next','sharedGeneration':'0','accountInput':{}})
  call(key+'-'+kind,v,False)
 v=copy.deepcopy(value);v['previousTokens']=[token];call(key+'-same-exact-token',v,True)
 v=copy.deepcopy(value);v['observed']['controlRaw']=json.dumps({'mode':'normal','generation':'0','inputGeneration':'0','sharedGeneration':'0','accountInput':{}});call(key+'-explicit-valid-default',v,True)
 v=copy.deepcopy(value);v['observed']['slots']=[];v['observed']['legacy']=[row];call(key+'-original-legacy-no-control',v,True)
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n')
for r in results:print(r['case'], 'PASS' if r['passed'] else 'FAIL', 'accepted='+str(r['accepted']))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
