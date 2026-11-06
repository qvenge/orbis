// Test harness only. Node owns every Playwright/Chrome pipe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
export { readFile, writeFile } from 'node:fs/promises';
export { setTimeout as sleep } from 'node:timers/promises';
const exec = promisify(execFile);
export const sha = (data: string | ArrayBuffer | Uint8Array) => createHash('sha256')
  .update(typeof data === 'string' ? data : data instanceof ArrayBuffer ? Buffer.from(data) : data).digest('hex');
export const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
export async function exists(path: string) {
  try { await readFile(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function inventory(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + entry.name : entry.name;
    assert(!entry.isSymbolicLink(), 'Unexpected dist symlink: ' + name);
    if (entry.isDirectory()) result.push(...await inventory(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
export async function processRows() {
  const { stdout } = await exec('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='],
    { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]!, cmd: m[4]! }] : [];
  });
}
let childJournal: string | undefined;
export function recordChildrenAt(out: string) { childJournal = join(out, 'owned-children.jsonl'); }
export type OwnedChild = {
  pid: number; readonly exitCode: number | null; exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array>; stderr?: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals): boolean;
};
export async function spawnOwned(args: string[], options: {
  cwd?: string; env?: Record<string, string>; stdout?: 'pipe' | string; stderr?: 'pipe';
  input?: string;
}): Promise<OwnedChild> {
  const child = spawn(args[0]!, args.slice(1), { cwd: options.cwd, env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'] });
  // Capture before any registration await: Node flushStdio may otherwise
  // resume/discard an already-exited child's output.
  const piped = !options.stdout || options.stdout === 'pipe';
  const stdout = piped ? Readable.toWeb(child.stdout) as ReadableStream<Uint8Array> : undefined;
  const stderr = piped ? Readable.toWeb(child.stderr) as ReadableStream<Uint8Array> : undefined;
  let code: number | null = null;
  let sink: ReturnType<typeof createWriteStream> | undefined;
  let sinkError: Error | undefined;
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', reject);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      code = status ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1);
      if (sink) sink.end(() => sinkError ? reject(sinkError) : resolve(code!));
      else resolve(code);
    });
  });
  void exited.catch(() => {});
  void started.catch(() => {});
  child.stdin.on('error', error => { process.exitCode = 1; console.error('owned-child-stdin-error', String(error)); });
  try {
    if (options.stdout && options.stdout !== 'pipe') {
      sink = createWriteStream(options.stdout, { flags: 'a', mode: 0o600 });
      sink.on('error', error => { sinkError = error; process.exitCode = 1; });
      child.stdout.pipe(sink, { end: false }); child.stderr.pipe(sink, { end: false });
      await new Promise<void>((resolve, reject) => { sink!.once('open', () => resolve()); sink!.once('error', reject); });
    }
    await started;
    const row = (await processRows()).find(row => row.pid === child.pid);
    if (childJournal) await appendFile(childJournal, JSON.stringify(row
      ? { ...row, kind: 'explicit-child', executable: args[0] }
      : { pid: child.pid, endedBeforeCensus: code !== null, kind: 'short-child' }) + '\n', { mode: 0o600 });
    assert(row || code !== null, 'Owned child identity could not be established');
    child.stdin.end(options.input);
  } catch (error) {
    // We still own this unreaped ChildProcess even if census/journal registration
    // failed. Do not leave it dependent on a receipt which was never written.
    const evidence: Record<string, unknown> = { pid: child.pid, phase: 'post-spawn-registration',
      error: String(error), exitBeforeCleanup: code, cleanupComplete: false };
    const wait = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([exited.catch(() => code), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned child registration cleanup timeout')), ms);
      })]); } finally { clearTimeout(timer); }
    };
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      try { await wait(4000); } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await wait(3000);
      }
      evidence.cleanupComplete = child.exitCode !== null || child.signalCode !== null;
      evidence.exitAfterCleanup = code;
    } catch (cleanupError) { evidence.cleanupError = String(cleanupError); }
    if (childJournal) await writeFile(join(dirname(childJournal), `registration-failure-${child.pid ?? 'none'}.json`),
      JSON.stringify(evidence, null, 2)).catch(writeError => console.error('owned-registration-evidence-error', String(writeError)));
    console.error('owned-child-registration-failed', JSON.stringify(evidence));
    throw error;
  }
  return { pid: child.pid!, get exitCode() { return code ?? child.exitCode; }, exited,
    stdout, stderr,
    kill: (signal = 'SIGTERM') => child.kill(signal) };
}
