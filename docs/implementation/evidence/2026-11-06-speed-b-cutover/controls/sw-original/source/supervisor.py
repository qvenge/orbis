"""Bounded local process supervisor; never retries a browser launch."""
import json
import os
import pathlib
import re
import signal
import subprocess
import time

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

def census(limit=10):
    output = subprocess.run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,lstart=,command='],
                            capture_output=True, text=True, check=True, timeout=limit).stdout
    rows = []
    for line in output.splitlines():
        match = re.match(r'\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)', line)
        if match:
            rows.append(dict(pid=int(match[1]), ppid=int(match[2]), start=match[3], cmd=match[4]))
    return rows

def identity(row):
    return row['pid'], row['start']

def supervise(command, out, timeout=90, cleanup_timeout=20, read_processes=census):
    out = pathlib.Path(out)
    prefix = '--user-data-dir=' + str(out) + '/profile-parent/chrome.'
    observed = {}
    runner = None
    runner_identity = None
    timed_out = False
    monitor_error = None
    cleanup_errors = []
    forced_runner = False
    forced_browser = False
    remaining = None
    run_exit = None

    def observe(rows):
        owned = {p['pid'] for p in rows if any(a.startswith(prefix) for a in p['cmd'].split())}
        roots = [p for p in rows if p['pid'] in owned and p['cmd'].startswith(CHROME + ' ')
                 and not any(a.startswith('--type=') for a in p['cmd'].split())]
        # Include surviving recorded identities and discover children before roots disappear.
        owned |= {p['pid'] for p in rows if identity(p) in observed}
        while True:
            more = owned | {p['pid'] for p in rows if p['ppid'] in owned}
            if more == owned:
                break
            owned = more
        for row in rows:
            if row['pid'] in owned:
                observed[identity(row)] = row
        return roots

    with (out / 'trace.jsonl').open('w') as stdout, (out / 'stderr.log').open('w') as stderr:
        try:
            # Full census before Popen: a restricted execution must not orphan a child.
            read_processes(10)
            deadline = time.monotonic() + timeout
            runner = subprocess.Popen(command, stdout=stdout, stderr=stderr)
            while runner.poll() is None:
                left = deadline - time.monotonic()
                if left <= 0:
                    timed_out = True
                    break
                rows = read_processes(min(10, left))
                roots = observe(rows)
                if runner_identity is None:
                    runner_identity = next((p for p in rows if p['pid'] == runner.pid), None)
                if len(roots) > 1:
                    raise RuntimeError('Multiple browser roots in this control profile')
                time.sleep(min(.15, max(0, deadline - time.monotonic())))
            # A last census can consume the deadline while the child exits cleanly.
            timed_out = timed_out or time.monotonic() >= deadline
        except BaseException as error:
            monitor_error = type(error).__name__ + ': ' + str(error)
        finally:
            cleanup_deadline = time.monotonic() + cleanup_timeout
            if runner is not None:
                if runner.poll() is None:
                    forced_runner = True
                    # Popen owns this unreaped child and checks poll before signalling.
                    try:
                        runner.terminate()
                        runner.wait(timeout=min(4, cleanup_timeout / 2))
                    except subprocess.TimeoutExpired:
                        runner.kill()
                    except ProcessLookupError:
                        pass
                try:
                    run_exit = runner.wait(timeout=max(.1, cleanup_deadline - time.monotonic()))
                except subprocess.TimeoutExpired as error:
                    cleanup_errors.append(str(error))
            # Always reconcile by profile + recorded PID/start. Never kill by name alone.
            while time.monotonic() < cleanup_deadline:
                try:
                    rows = read_processes(min(10, max(.1, cleanup_deadline - time.monotonic())))
                    observe(rows)
                    remaining = [p for p in rows if identity(p) in observed]
                    if not remaining:
                        break
                    sig = signal.SIGKILL if forced_browser else signal.SIGTERM
                    forced_browser = True
                    # Check fresh identities immediately before each signal.
                    for target in remaining:
                        left = cleanup_deadline - time.monotonic()
                        if left <= 0:
                            break
                        fresh = read_processes(min(10, left))
                        if any(identity(p) == identity(target) for p in fresh):
                            try:
                                os.kill(target['pid'], sig)
                            except ProcessLookupError:
                                pass
                    time.sleep(min(.15, max(0, cleanup_deadline - time.monotonic())))
                except Exception as error:
                    remaining = None  # Unknown is never success.
                    cleanup_errors.append(type(error).__name__ + ': ' + str(error))
                    time.sleep(min(.15, max(0, cleanup_deadline - time.monotonic())))

    failed = (timed_out or monitor_error is not None or forced_runner or forced_browser
              or cleanup_errors or remaining != [] or run_exit != 0)
    exit_code = 1 if failed else 0
    summary = dict(exit=exit_code, runnerExit=run_exit, watchdogTimedOut=timed_out,
                   monitorError=monitor_error, cleanupErrors=cleanup_errors,
                   forcedRunnerCleanup=forced_runner, forcedBrowserCleanup=forced_browser,
                   runner=runner_identity, runnerPid=runner.pid if runner else None,
                   observed=list(observed.values()), remaining=remaining)
    (out / 'watchdog-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    (out / 'exit').write_text(str(exit_code) + '\n')
    return exit_code
