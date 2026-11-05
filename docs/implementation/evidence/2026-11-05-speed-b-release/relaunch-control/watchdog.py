#!/usr/bin/env python3
"""One execution, independent wall-clock watchdog; exact profile/PID-start scope."""
import json, os, pathlib, re, signal, subprocess, sys, time
out = pathlib.Path(sys.argv[1]); source = pathlib.Path(__file__).with_name('control.ts').resolve()
assert str(out).startswith('/private/tmp/orbis-cutover-relaunch.') and out.is_dir()
assert not any(out.iterdir())
def census(limit=3):
    rows = subprocess.run(['/bin/ps','-ww','-axo','pid=,ppid=,lstart=,command='], capture_output=True,text=True,check=True,timeout=limit).stdout
    result=[]
    for line in rows.splitlines():
        m=re.match(r'\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)',line)
        if m: result.append(dict(pid=int(m[1]),ppid=int(m[2]),start=m[3],cmd=m[4]))
    return result
key=lambda p:(p['pid'],p['start'])
chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
observed={}; root=None; cleanup_until=None
def cleanup_budget(limit=3):
    assert cleanup_until is not None
    left=cleanup_until-time.monotonic()
    assert left>0, "Owned cleanup budget exhausted"
    return min(limit,left)
def cleanup_census():
    return census(cleanup_budget())
with (out/'trace.jsonl').open('w') as stdout, (out/'stderr.log').open('w') as stderr:
    child=subprocess.Popen(['bun','run',str(source),str(out)],stdout=stdout,stderr=stderr)
    initial=next(p for p in census() if p['pid']==child.pid)
    (out/'runner-identity.json').write_text(json.dumps(initial,indent=2)+'\n')
    until=time.monotonic()+90
    timed_out=False
    while child.poll() is None:
        rows=census()
        own=[p for p in rows if p['cmd'].startswith(chrome+' ') and '--type=' not in p['cmd'] and any(a.startswith('--user-data-dir='+str(out)+'/profile-parent/chrome.') for a in p['cmd'].split())]
        assert len(own)<=1
        if own:
            if root and key(root)!=key(own[0]): assert not any(key(p)==key(root) for p in rows)
            root=own[0]
        related=set(p['pid'] for p in rows if root and key(p)==key(root))
        for _ in rows:
            new=related|{p['pid'] for p in rows if p['ppid'] in related}
            if new==related: break
            related=new
        for p in rows:
            if p['pid'] in related: observed[key(p)]=p
        if time.monotonic()>until:
            timed_out=True
            cleanup_until=time.monotonic()+20
            (out/'external-watchdog-fail.json').write_text(json.dumps({'status':'FAIL-wall-clock-watchdog','root':root,'descendants':list(observed.values())},indent=2)+'\n')
            # No PID reuse: every signal checks PID+start and recorded ownership.
            for target in ([root] if root else [])+[initial]:
                current=next((p for p in cleanup_census() if key(p)==key(target)),None)
                if current: os.kill(current['pid'],signal.SIGTERM)
            try: child.wait(timeout=cleanup_budget(4))
            except subprocess.TimeoutExpired:
                if any(key(p)==key(initial) for p in cleanup_census()): os.kill(child.pid,signal.SIGKILL)
                child.wait(timeout=cleanup_budget())
            break
        time.sleep(.15)
    run_exit=child.wait(timeout=3)
# Remove only still-present exact identities from this disposable Chrome tree.
if cleanup_until is None: cleanup_until=time.monotonic()+20
for sig in (signal.SIGTERM,signal.SIGKILL):
    rows=cleanup_census()
    remaining=[p for p in rows if key(p) in observed]
    if not remaining: break
    (out/('watchdog-owned-cleanup-'+str(sig)+'.json')).write_text(json.dumps(remaining,indent=2)+'\n')
    for p in remaining:
        if any(key(now)==key(p) for now in cleanup_census()): os.kill(p['pid'],sig)
    time.sleep(.5)
remaining=[p for p in cleanup_census() if key(p) in observed]
(out/'watchdog-summary.json').write_text(json.dumps({'exit':run_exit,'watchdogTimedOut':timed_out,'runner':initial,'root':root,'observed':list(observed.values()),'remaining':remaining},indent=2)+'\n')
(out/'exit').write_text(str(run_exit)+'\n')
assert not remaining
sys.exit(run_exit if run_exit>=0 else 128-run_exit)
