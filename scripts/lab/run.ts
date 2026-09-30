// scripts/lab/run.ts — лабораторный прогон против прода (спека скорости §3.4): base | after-a | after-b.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { PROFILE_DIR, runScenario } from './scenario';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const label = arg('--label');
const out = arg('--out');
const repeat = Number(arg('--repeat') ?? 5);
if (
  !label ||
  !['base', 'after-a', 'after-b'].includes(label) ||
  !out ||
  !Number.isInteger(repeat) ||
  repeat < 1
) {
  console.error(
    'run: bun scripts/lab/run.ts --label base|after-a|after-b --out <файл.json> [--repeat 5]',
  );
  process.exit(2);
}
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 860 },
});
try {
  const run = await runScenario(ctx, { label, repeat, log: (l) => console.log(l) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(run, null, 2));
  console.log(
    `записано: ${out} (замеров ${run.samples.length}; заметки: ${run.notes.join('; ') || 'нет'})`,
  );
  console.log(`сжатие /trpc: ${JSON.stringify(run.trpcEncoding)}`);
} finally {
  await ctx.close();
}
