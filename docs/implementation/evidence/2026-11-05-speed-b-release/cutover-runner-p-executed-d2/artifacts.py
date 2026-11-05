"""Read-only verification, except for the explicitly requested old source preparation."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile

OLD = 'b5abb7fe70068c06b7075ed54a2a0f3c3d729d7b'
CURRENT = 'a0bff516be98680685b790908ef76cc4f949f49c'
ARCHIVED_OLD = Path('/private/tmp/orbis-b7-bundles.mrjghj/old')
AUTH = b'http://localhost:54321'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def source(repo, root, commit):
    items = {}
    for entry in subprocess.check_output(['git', '-C', repo, 'ls-tree', '-rz', commit]).split(b'\0'):
        if not entry:
            continue
        meta, name = entry.split(b'\t', 1)
        mode, kind, git_hash = meta.split()
        name = name.decode()
        assert kind == b'blob', name
        p = root / name
        data = os.readlink(p).encode() if mode == b'120000' else p.read_bytes()
        assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest().encode() == git_hash, name
        items[name] = sha(data)
    return items

def dist(root):
    return {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())}
            for p in sorted(root.rglob('*')) if p.is_file()}

def verify_auth(dist_root):
    html = (dist_root / 'index.html').read_text()
    import re
    entries = re.findall(r'src="/(assets/index-[^"]+\.js)"', html)
    assert len(entries) == 1, entries
    bundle = (dist_root / entries[0]).read_bytes()
    assert AUTH in bundle, 'Expected exact local Auth origin compiled into entry'
    return entries[0]

parser = argparse.ArgumentParser()
parser.add_argument('repo')
parser.add_argument('command', choices=['prepare-old', 'prepare-current', 'verify'])
parser.add_argument('--old')
parser.add_argument('--current')
parser.add_argument('--current-manifest')
parser.add_argument('--out')
args = parser.parse_args()
def clean_archive(repo, commit, label, installed):
    root = Path(tempfile.mkdtemp(prefix='orbis-cutover-'+label+'.', dir='/private/tmp'))
    pipe = subprocess.Popen(['git', '-C', repo, 'archive', commit], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-xf', '-', '-C', root], stdin=pipe.stdout, check=True)
    assert pipe.wait() == 0
    deps = root / 'node_modules'
    deps.mkdir()
    # Reuse package data, but put cache directories and workspace links under
    # the new root. No link to the archived app's source or dist is installed.
    for p in (installed / 'node_modules').iterdir():
        if p.name != '@orbis' and (not p.name.startswith('.') or p.name == '.bin'):
            (deps / p.name).symlink_to(p.resolve(), target_is_directory=p.is_dir())
    (deps / '@orbis').mkdir()
    for pkg, rel in {'shared':'packages/shared','web':'apps/web','server':'apps/server'}.items():
        (deps / '@orbis' / pkg).symlink_to(root / rel, target_is_directory=True)
    return root

if args.command == 'prepare-old':
    assert len(source(args.repo, ARCHIVED_OLD, OLD)) == 1425
    root = clean_archive(args.repo, OLD, 'old', ARCHIVED_OLD)
    (root / '.cutover-archived-old-dist.json').write_text(json.dumps(dist(ARCHIVED_OLD / 'apps/web/dist')))
    print(root)
    sys.exit(0)

if args.command == 'prepare-current':
    assert args.current and args.current_manifest
    frozen = Path(args.current).resolve()
    assert str(frozen).startswith('/private/tmp/orbis-')
    assert len(source(args.repo, frozen, CURRENT)) == 1519
    expected = json.loads(Path(args.current_manifest).read_text())
    assert dist(frozen / 'apps/web/dist') == expected, 'Accepted a0 dist mismatch'
    root = clean_archive(args.repo, CURRENT, 'current', frozen)
    # Copy bytes, never use the original server tree or its ignored .env.
    shutil.copytree(frozen / 'apps/web/dist', root / 'apps/web/dist')
    assert dist(root / 'apps/web/dist') == expected, 'Copied a0 dist mismatch'
    print(root)
    sys.exit(0)

assert args.old and args.current and args.current_manifest and args.out
old, current = Path(args.old).resolve(), Path(args.current).resolve()
assert all(str(p).startswith('/private/tmp/orbis-cutover-') for p in (old, current))
assert len(source(args.repo, ARCHIVED_OLD, OLD)) == 1425
assert dist(ARCHIVED_OLD / 'apps/web/dist') == json.loads((old / '.cutover-archived-old-dist.json').read_text()), 'Archived b5 dist changed'
out = Path(args.out)
assert not out.exists()
out.mkdir(mode=0o700)
for name, root, commit in [('old', old, OLD), ('current', current, CURRENT)]:
    dist_root = root / 'apps/web/dist'
    source_hashes = source(args.repo, root, commit)
    for path in (root, root / 'apps/web', root / 'apps/server'):
        assert not any(p.name != '.env.example' for p in path.glob('.env*')), 'Unexpected env file'
    assert len(source_hashes) == (1425 if name == 'old' else 1519)
    dist_hashes = dist(dist_root)
    if name == 'current':
        assert dist_hashes == json.loads(Path(args.current_manifest).read_text()), 'Accepted a0 dist mismatch'
    entry = verify_auth(dist_root)
    result = {'commit': commit, 'tree': str(root), 'dist': str(dist_root), 'entry': entry,
              'source': source_hashes, 'assets': dist_hashes}
    (out / (name+'.json')).write_text(json.dumps(result, indent=2)+'\n')
