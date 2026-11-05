import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright-core';

type Life = { token: string; sequence: number; type: 'pageshow' | 'pagehide'; persisted: boolean };
type Memory = { token: string; sequence: number; events: Life[] };
type Waiter = { token: string; type: Life['type']; after: number; accept: (event: Life) => void };

declare global {
  interface Window { __cutoverLifecycle?: Memory }
}

/** Record only document memory and console. Nothing is persisted to storage. */
export class LifecycleObserver {
  private readonly events = new Map<string, Life>();
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly report: (phase: string, value: object) => void) {}

  private accept(event: Life, source: 'console' | 'document-memory') {
    assert(typeof event.token === 'string' && Number.isSafeInteger(event.sequence) && event.sequence > 0);
    assert(event.type === 'pageshow' || event.type === 'pagehide');
    assert(typeof event.persisted === 'boolean');
    const key = event.token + '/' + event.sequence;
    const previous = this.events.get(key);
    if (previous) assert.deepEqual(previous, event, 'Lifecycle sequence changed contents');
    else {
      this.events.set(key, event);
      this.report('document-lifecycle', { ...event, source });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.token === event.token && waiter.type === event.type && event.sequence > waiter.after)
        waiter.accept(event);
    }
  }

  async install(context: BrowserContext) {
    context.on('page', page => page.on('console', message => {
      const text = message.text();
      if (text.startsWith('CUTOVER_LIFECYCLE '))
        this.accept(JSON.parse(text.slice('CUTOVER_LIFECYCLE '.length)), 'console');
    }));
    await context.addInitScript(() => {
      const memory: Memory = { token: crypto.randomUUID(), sequence: 0, events: [] };
      window.__cutoverLifecycle = memory;
      for (const type of ['pageshow', 'pagehide'] as const)
        addEventListener(type, event => {
          const value: Life = {
            token: memory.token, sequence: ++memory.sequence, type,
            persisted: (event as PageTransitionEvent).persisted,
          };
          memory.events.push(value);
          console.log('CUTOVER_LIFECYCLE ' + JSON.stringify(value));
        });
    });
  }

  private match(token: string, type: Life['type'], after: number) {
    let waiter: Waiter;
    const promise = new Promise<Life>(resolve => {
      waiter = { token, type, after, accept: resolve };
      this.waiters.add(waiter);
      const seen = [...this.events.values()].find(event =>
        event.token === token && event.type === type && event.sequence > after);
      if (seen) resolve(seen);
    });
    return { promise, stop: () => this.waiters.delete(waiter!) };
  }

  private async snapshot(page: Page): Promise<Memory> {
    const memory = await page.evaluate(() => window.__cutoverLifecycle);
    assert(memory, 'Lifecycle recorder is absent from this document');
    for (const event of memory.events) this.accept(event, 'document-memory');
    return memory;
  }

  async roundTrip(page: Page, neutralUrl: string, timeout: number): Promise<boolean> {
    const before = await this.snapshot(page);
    const hide = this.match(before.token, 'pagehide', before.sequence);
    const show = this.match(before.token, 'pageshow', before.sequence);
    // Both latches precede the navigation. Frozen-page console events may
    // arrive late, so a restored document may supply its own recorded events.
    try {
      await page.goto(neutralUrl);
      await page.goBack({ waitUntil: 'commit' });
      const token = await page.evaluate(() => window.__cutoverLifecycle?.token);
      if (token !== before.token) {
        this.report('bfcache-observation', { status: 'uncovered', reason: 'different-document-on-return',
          before: before.token, after: token ?? null });
        await page.goto(neutralUrl);
        return false;
      }
      const handle = await page.waitForFunction(({ token, after }) => {
        const memory = window.__cutoverLifecycle;
        return memory?.token === token && memory.events.some(event =>
          event.type === 'pageshow' && event.sequence > after);
      }, { token: before.token, after: before.sequence }, { timeout }).catch(() => undefined);
      if (!handle) {
        this.report('bfcache-observation', { status: 'uncovered', reason: 'matching-pageshow-not-observed',
          token: before.token });
        await page.goto(neutralUrl);
        return false;
      }
      await handle.dispose();
      const after = await this.snapshot(page);
      const hidden = after.events.find(event => event.type === 'pagehide' && event.sequence > before.sequence);
      const shown = after.events.find(event => event.type === 'pageshow' && event.sequence > before.sequence);
      if (!hidden || !shown) {
        this.report('bfcache-observation', { status: 'uncovered', reason: 'lifecycle-pair-not-observed',
          token: before.token });
        await page.goto(neutralUrl);
        return false;
      }
      const [hiddenEvent, shownEvent] = await Promise.all([hide.promise, show.promise]);
      assert.deepEqual(hiddenEvent, hidden);
      assert.deepEqual(shownEvent, shown);
      assert(hiddenEvent.sequence < shownEvent.sequence, 'Lifecycle order changed');
      const confirmed = hiddenEvent.persisted && shownEvent.persisted && after.token === before.token;
      this.report('bfcache-observation', {
        status: confirmed ? 'roundtrip-confirmed' : 'uncovered', token: before.token,
        pagehide: hiddenEvent, pageshow: shownEvent,
      });
      // Leave the old target away from its origin for the independent held
      // branch. This navigation alone is not a second BFCache assertion.
      await page.goto(neutralUrl);
      this.report('bfcache-candidate-away', { roundtripConfirmed: confirmed, secondHideClaimed: false });
      return confirmed;
    } finally {
      hide.stop();
      show.stop();
    }
  }
}
