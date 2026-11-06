#!/usr/bin/env python3
"""Prepared only. No old P resume; no implicit runtime/DB allocation."""
import argparse, hashlib, json, os, pathlib, re, subprocess, sys, tempfile
from supervisor import supervise
from preflight import check as check_preflight
p = argparse.ArgumentParser()
p.add_argument('--node', required=True)
p.add_argument('--bun', required=True)
p.add_argument('--manifests', required=True)
p.add_argument('--handoff', required=True)
p.add_argument('--private-env', required=True)
a = p.parse_args()
root = pathlib.Path(__file__).parent.resolve()
pins = json.loads((root / 'pins.json').read_text())
# Intentionally reject before version probes/processes/ports until a new allocation is reviewed.
assert re.fullmatch('[a-f0-9]{64}', pins['handoffSha']), 'New root-issued P handoff pending'
assert hashlib.sha256(pathlib.Path(a.handoff).read_bytes()).hexdigest() == pins['handoffSha']
for line in (root / 'SOURCE_SHA256SUMS').read_text().splitlines():
    digest, name = line.split('  ', 1)
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest
node, bun = (str(pathlib.Path(value).resolve()) for value in (a.node, a.bun))
assert all(pathlib.Path(value).is_absolute() for value in (a.node, a.bun)) and node != bun
version = json.loads(subprocess.check_output([node, '-p',
    'JSON.stringify({node:process.versions.node,bun:process.versions.bun})'], text=True, timeout=5))
assert not version.get('bun') and version['node'] == pins['nodeVersion']
assert subprocess.check_output([bun, '--version'], text=True, timeout=5).strip() == pins['bunVersion']
private = {}
for line in pathlib.Path(a.private_env).read_text().splitlines():
    assert line.startswith('export ')
    key, value = line[7:].split('=', 1)
    assert key in ('DATABASE_URL_ADMIN', 'DATABASE_URL')
    private[key] = value
assert set(private) == {'DATABASE_URL_ADMIN', 'DATABASE_URL'}
# Node entry retains exact handoff/DSN/container/0026/admin and Bun-app runtime checks.
# This wrapper does not choose a container/port or modify a role/database.
for name, expected in [('old', pins['oldManifestSha']), ('current', pins['currentManifestSha'])]:
    assert hashlib.sha256((pathlib.Path(a.manifests) / (name + '.json')).read_bytes()).hexdigest() == expected
out = pathlib.Path(tempfile.mkdtemp(prefix='orbis-cutover-node-p.', dir='/private/tmp'))
(out / 'preflight.json').write_text(json.dumps(check_preflight(a.handoff, pins['handoffSha'], private), indent=2) + '\n')
command = [node, str(root / 'rehearsal.ts'), 'P', a.manifests, str(out / 'run'), a.handoff, pins['handoffSha']]
# Environment is scoped to this process/owned children, never printed with credentials.
os.environ.update(private, ORBIS_CUTOVER_DISPOSABLE='1', ORBIS_CUTOVER_BUN_PATH=bun)
(out / 'run-config.json').write_text(json.dumps({'command': command, 'node': version,
    'bunPath': bun, 'source': hashlib.sha256((root / 'SOURCE_SHA256SUMS').read_bytes()).hexdigest(),
    'noResume': True}, indent=2) + '\n')
print(str(out), flush=True)
sys.exit(supervise(command, out, timeout=pins['scenarioSeconds'], cleanup_timeout=pins['cleanupSeconds']))
