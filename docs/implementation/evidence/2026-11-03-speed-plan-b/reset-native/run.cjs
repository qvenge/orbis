const { mkdtemp, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const { chromium } = require(join(root, 'node_modules/playwright-core'));

async function main() {
  const { createServer } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')));
  const server = await createServer({
    root,
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'disk-reset-native-probe',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/b13-disk-smoke') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><script type="module" src="/.b13-disk-probe/scenario.ts"></script>');
        });
      },
    }],
  });
  const profile = await mkdtemp(join(tmpdir(), 'orbis-b13-disk-chrome-'));
  let context;
  const failures = [];
  try {
    await server.listen();
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, timeout: 15000 });
    console.log('BROWSER', context.browser()?.version() ?? await context.pages()[0].evaluate(() => navigator.userAgent));
    const uri = 'http://127.0.0.1:' + server.httpServer.address().port + '/b13-disk-smoke';
    const first = context.pages()[0];
    const peer = await context.newPage();
    for (const page of [first, peer]) {
      page.on('pageerror', error => console.error('PAGE', error));
      await page.goto(uri);
      await page.waitForFunction(() => !!window.diskProbe, null, { timeout: 12000 });
    }
    for (const name of ['runtimeBridge', 'lazyRewindBridge', 'sameTokenCurrent', 'sameTokenStaleWithQueuedWriter', 'freezeAfterDigest', 'freezeInsideRewind', 'strictAckAbortAndEpoch']) {
      let timeout;
      try {
        const deadline = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('native fixture deadline')), 10000);
        });
        const result = await Promise.race([deadline, first.evaluate(name => window.diskProbe[name](), name)]);
        console.log('PASS', name, JSON.stringify(result));
      } catch (error) {
        failures.push(name);
        console.error('FAIL', name, error.message);
      } finally {
        clearTimeout(timeout);
      }
    }
    try {
      await first.evaluate(() => window.diskProbe.ordinaryOpen(true));
      await peer.evaluate(() => window.diskProbe.ordinaryOpen(false));
      await first.evaluate(() => window.diskProbe.ordinaryResetThenWrite());
      console.log('PASS ordinaryCrossTabReplay', JSON.stringify(await peer.evaluate(() => window.diskProbe.ordinaryReplay())));
    } catch (error) {
      failures.push('ordinaryCrossTabReplay');
      console.error('FAIL ordinaryCrossTabReplay', error.message);
    }
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(failures.join(', '));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
