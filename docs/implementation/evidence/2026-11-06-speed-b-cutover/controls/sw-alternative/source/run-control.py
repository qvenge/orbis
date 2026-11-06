#!/usr/bin/env python3
"""One root-granted static SW control only, never a P/browser-FD matrix."""
import argparse,hashlib,json,pathlib,subprocess,sys,tempfile
from supervisor import supervise
p=argparse.ArgumentParser();p.add_argument('--node',required=True);a=p.parse_args();root=pathlib.Path(__file__).parent.resolve()
node=str(pathlib.Path(a.node).resolve());v=json.loads(subprocess.check_output([node,'-p','JSON.stringify({node:process.versions.node,bun:process.versions.bun})'],text=True,timeout=5));assert v=={'node':'23.11.0'}
for line in (root/'SOURCE_SHA256SUMS').read_text().splitlines():
 digest,name=line.split('  ',1);assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest
out=pathlib.Path(tempfile.mkdtemp(prefix='orbis-cutover-sw-admission.',dir='/private/tmp'));command=[node,str(root/'control.ts'),str(out)]
(out/'run-config.json').write_text(json.dumps({'command':command,'runtime':v,'sourcePacket':hashlib.sha256((root/'SOURCE_SHA256SUMS').read_bytes()).hexdigest(),'app':False,'auth':False,'db':False,'profile':'new blank profiles only; never P profile'},indent=2)+'\n');print(out,flush=True)
sys.exit(supervise(command,out,timeout=90,cleanup_timeout=20))
