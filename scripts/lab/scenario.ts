// scripts/lab/scenario.ts — эталонный сценарий лабораторного прогона (спека скорости §3.4, РП-25).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { LabSample } from './summary';

export const LAB_DIR = join(homedir(), '.orbis-lab');
export const PROFILE_DIR = join(LAB_DIR, 'profile');
export const RECORDS_FILE = join(LAB_DIR, 'records.json');
export const LAB_URL = (process.env.ORBIS_LAB_URL ?? 'https://orbis-64q4.onrender.com').replace(
  /\/$/,
  '',
);
/** Потолок ожидания блоков после прихода записи (§3.1). */
export const BLOCKS_CEILING_MS = 3000;
export const RECORD_KINDS = ['task', 'note', 'page-with-blocks', 'project', 'no-blocks'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export interface LabRun {
  label: string;
  url: string;
  startedAt: string;
  repeat: number;
  records: Partial<Record<RecordKind, string>>;
  samples: LabSample[];
  notes: string[];
  trpcEncoding: Record<string, string | null>;
  typing: { requests: Record<string, number>; textSurvived: boolean } | null;
}

/** Наблюдатели LCP и событий ввода — до первого скрипта страницы. INP лаборатории — максимум длительности
 *  взаимодействия (Event Timing) за шаг: один сценарий на одной машине, p98 по десяткам событий не нужен. */
const OBSERVERS = `(() => { const lab = { lcp: null, maxEvent: 0 }; window.__lab = lab; try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) lab.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) lab.maxEvent = Math.max(lab.maxEvent, e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
} catch {} })();`;

/** Экран записи готов (`recon-a-web.md` §11): место по адресу, область записи без скелетов и ожидания шаблона. */
function recordReady(id: string | null): number | false {
  const main = document.querySelector(
    id === null
      ? 'main[data-testid="screen-content"]'
      : `main[data-testid="screen-content"][data-place$="/r/${id}"]`,
  );
  const area = main?.querySelector('[data-testid="record-area"]');
  if (
    !main ||
    !area ||
    area.querySelector('[data-testid="record-view-wait"]') ||
    main.querySelector('[role="status"][aria-label="Загрузка"]')
  )
    return false;
  return performance.now();
}
/** Блоки осели: внутри области записи нет «Загрузка…» (у `SaveIndicator` тоже role=status — поэтому по тексту). */
function blocksSettled(): number | false {
  const area = document.querySelector('[data-testid="record-area"]');
  if (
    !area ||
    [...area.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes('Загрузка…'))
  )
    return false;
  return performance.now();
}

async function waitReady(
  page: Page,
  id: string | null,
  notes: string[],
  what: string,
): Promise<number> {
  const first = (await (
    await page.waitForFunction(recordReady, id, { timeout: 90_000 })
  ).jsonValue()) as number;
  try {
    return (await (
      await page.waitForFunction(blocksSettled, undefined, { timeout: BLOCKS_CEILING_MS })
    ).jsonValue()) as number;
  } catch {
    notes.push(`${what}: потолок блоков 3 с`);
    return first + BLOCKS_CEILING_MS;
  }
}

/** Клик изнутри страницы: момент нажатия — `performance.now()` страницы, без круга до Node. */
function clickAt(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`нет элемента ${sel}`);
    const t0 = performance.now();
    el.click();
    return t0;
  }, selector);
}

/** Конец ответа процедуры — по Resource Timing страницы (точнее события `response` в Node). */
function responseEnd(page: Page, procedure: string): Promise<number> {
  return page.evaluate((p) => {
    const e = performance
      .getEntriesByType('resource')
      .filter((x) => x.name.includes(`/trpc/`) && x.name.includes(p))
      .at(-1) as PerformanceResourceTiming | undefined;
    return e?.responseEnd ?? Number.NaN;
  }, procedure);
}

/** Чтение tRPC из контекста страницы токеном сессии профиля (GET без пачки, вход — `?input=`). */
async function trpcQuery<T>(page: Page, path: string, input: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ path, input }) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
      const token = key
        ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token
        : undefined;
      if (!token) throw new Error('в профиле нет сессии — сначала bun scripts/lab/login.ts');
      const res = await fetch(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        result?: { data: unknown };
        error?: { message?: string };
      };
      if (!res.ok || body.result === undefined)
        throw new Error(`${path}: ${body.error?.message ?? res.status}`);
      return body.result.data;
    },
    { path, input },
  )) as T;
}

type Row = { id: string; title: string };
/** Пять записей разных видов — один раз, дальше из `records.json` (сравнимость прогонов). */
async function pickRecords(
  page: Page,
  notes: string[],
): Promise<Partial<Record<RecordKind, string>>> {
  if (existsSync(RECORDS_FILE)) return JSON.parse(readFileSync(RECORDS_FILE, 'utf8'));
  const out: Partial<Record<RecordKind, string>> = {};
  const first = async (kind: RecordKind, query: string) => {
    const rows = await trpcQuery<Row[]>(page, 'entity.query', { query });
    if (rows[0]) out[kind] = rows[0].id;
    else notes.push(`нет записи вида ${kind}`);
  };
  await first('task', 'aspect=orbis/task, limit=1');
  await first('note', 'aspect=orbis/note, limit=1');
  await first('project', 'aspect=orbis/project, limit=1');
  const bodyOf = async (id: string) =>
    (await trpcQuery<{ entity: { body?: string } }>(page, 'entity.get', { id, include: ['body'] }))
      .entity.body ?? '';
  for (const p of await trpcQuery<Row[]>(page, 'entity.query', {
    query: 'aspect=orbis/page, limit=30',
  })) {
    if ((await bodyOf(p.id)).includes('{{query:')) {
      out['page-with-blocks'] = p.id;
      break;
    }
  }
  if (!out['page-with-blocks']) notes.push('нет записи вида page-with-blocks');
  const taken = new Set(Object.values(out));
  for (const r of await trpcQuery<Row[]>(page, 'entity.query', {
    query: 'aspect=orbis/note, limit=15',
  })) {
    if (!taken.has(r.id) && !(await bodyOf(r.id)).includes('{{')) {
      out['no-blocks'] = r.id;
      break;
    }
  }
  if (!out['no-blocks']) notes.push('нет записи вида no-blocks');
  writeFileSync(RECORDS_FILE, JSON.stringify(out, null, 2));
  return out;
}

const HOTKEY = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
const mark = (samples: LabSample[], s: LabSample) =>
  samples.push({ ...s, durMs: Math.round(s.durMs * 10) / 10 });
/** Процедуры запроса tRPC по адресу (`/trpc/a.b,c.d?batch=1…`); не tRPC — `null`. */
function proceduresOf(url: string): string[] | null {
  const path = new URL(url).pathname;
  const i = path.indexOf('/trpc/');
  return i < 0 ? null : decodeURIComponent(path.slice(i + 6)).split(',');
}

/** Холодный старт (§3.4 п. 1): пустой кеш — HTTP-кеш и кеш service worker (PWA) сносятся через CDP, сессия остаётся. */
async function coldStarts(
  ctx: BrowserContext,
  page: Page,
  r: number,
  out: LabSample[],
  notes: string[],
) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Storage.clearDataForOrigin', {
    origin: LAB_URL,
    storageTypes: 'cache_storage,service_workers',
  });
  await cdp.detach();
  for (const kind of ['empty', 'warm'] as const) {
    await page.goto(LAB_URL);
    mark(out, {
      metric: 'cold_start',
      kind,
      durMs: await waitReady(page, null, notes, `холодный старт ${kind}`),
      repeat: r,
    });
    const lcp = await page.evaluate(
      () => (window as unknown as { __lab: { lcp: number | null } }).__lab.lcp,
    );
    if (lcp !== null) mark(out, { metric: 'lcp', kind, durMs: lcp, repeat: r });
  }
}

/** Переход (§3.4 п. 2): ⌘K → строка поиска → попадание по id → экран записи; повтор — «из памяти»; назад — ‹. */
async function openViaSearch(page: Page, id: string, title: string): Promise<number> {
  await page.keyboard.press(HOTKEY);
  await page.fill('input[aria-label="Строка поиска"]', title.slice(0, 40));
  await page.waitForSelector(`[data-testid="search-hit-${id}"]`, { timeout: 30_000 });
  return clickAt(page, `[data-testid="search-hit-${id}"]`);
}
/** Первая запись — опорная: с неё открывается каждая следующая, «‹» возвращает на неё (поиск снимается переходом,
 *  стопка — «опорная → следующая»). Повтор — вторая запись, уже открывавшаяся в этой вкладке (цель 1 §0.3). */
async function transitions(
  page: Page,
  recs: Array<{ id: string; title: string }>,
  r: number,
  out: LabSample[],
  notes: string[],
) {
  await page.goto(LAB_URL);
  await waitReady(page, null, notes, 'домашняя');
  const [anchor, ...rest] = recs;
  if (anchor === undefined) return;
  const t0 = await openViaSearch(page, anchor.id, anchor.title);
  mark(out, {
    metric: 'transition',
    kind: 'first',
    cached: false,
    durMs: (await waitReady(page, anchor.id, notes, 'переход')) - t0,
    repeat: r,
  });
  for (const rec of rest) {
    const t1 = await openViaSearch(page, rec.id, rec.title);
    mark(out, {
      metric: 'transition',
      kind: 'first',
      cached: false,
      durMs: (await waitReady(page, rec.id, notes, 'переход')) - t1,
      repeat: r,
    });
    const back = await clickAt(page, '[data-testid="host-back"]');
    mark(out, {
      metric: 'transition',
      kind: 'back',
      cached: true,
      durMs: (await waitReady(page, anchor.id, notes, 'назад')) - back,
      repeat: r,
    });
  }
  const again = rest[0];
  if (again !== undefined) {
    const t2 = await openViaSearch(page, again.id, again.title);
    mark(out, {
      metric: 'transition',
      kind: 'repeat',
      cached: true,
      durMs: (await waitReady(page, again.id, notes, 'повтор')) - t2,
      repeat: r,
    });
  }
}

/** «＋» (§3.4 п. 3): запись или подзадача; подтверждение — конец ответа последней мутации, видимо — поле очистилось. */
async function capture(
  page: Page,
  title: string,
  r: number,
  out: LabSample[],
  kind: 'create' | 'subtask',
): Promise<string> {
  await page.click('[data-testid="host-new"]');
  await page.fill(
    'form[data-testid="quick-capture-form"] input[aria-label="Быстрая запись"]',
    title,
  );
  const created = page.waitForResponse((res) => res.url().includes('/trpc/entity.create'));
  const t0 = await clickAt(
    page,
    'form[data-testid="quick-capture-form"] button[aria-label="Добавить"]',
  );
  const body = (await (await created).json()) as unknown;
  const data = (Array.isArray(body) ? body[0] : body) as { result: { data: { id: string } } };
  const cleared = (await (
    await page.waitForFunction(
      () => {
        const el = document.querySelector<HTMLInputElement>(
          'form[data-testid="quick-capture-form"] input[aria-label="Быстрая запись"]',
        );
        return el !== null && el.value === '' ? performance.now() : false;
      },
      undefined,
      { timeout: 30_000 },
    )
  ).jsonValue()) as number;
  const last =
    kind === 'subtask'
      ? Math.max(
          await responseEnd(page, 'entity.create'),
          (await responseEnd(page, 'relation.create')) || 0,
        )
      : await responseEnd(page, 'entity.create');
  mark(out, {
    metric: 'action_confirmed',
    kind: 'create',
    durMs: last - t0,
    repeat: r,
    ...(kind === 'subtask' ? { note: 'подзадача' } : {}),
  });
  mark(out, { metric: 'action_visible', kind: 'create', durMs: cleared - t0, repeat: r });
  return data.result.data.id;
}

/** Галочка и статус туда-обратно (§3.4 п. 3) на лаб-подзадаче; видимо — состояние контрола, подтверждено — ответ `entity.update`. */
async function toggles(page: Page, taskId: string, r: number, out: LabSample[], notes: string[]) {
  await page.goto(`${LAB_URL}/r/${taskId}`);
  await waitReady(page, taskId, notes, 'лаб-задача');
  const box = '[data-testid="native-row"] [role="checkbox"][aria-label="Готово"]';
  if (await page.$(box)) {
    for (const want of ['checked', 'unchecked']) {
      // ожидание ответа — ДО клика: ответ, пришедший раньше подписки, `waitForResponse` не увидел бы никогда
      const answered = page.waitForResponse((res) => res.url().includes('/trpc/entity.update'));
      const t0 = await clickAt(page, box);
      const seen = (await (
        await page.waitForFunction(
          ({ sel, want }) =>
            document.querySelector(sel)?.getAttribute('data-state') === want
              ? performance.now()
              : false,
          { sel: box, want },
        )
      ).jsonValue()) as number;
      await answered;
      mark(out, { metric: 'action_visible', kind: 'checkbox', durMs: seen - t0, repeat: r });
      mark(out, {
        metric: 'action_confirmed',
        kind: 'checkbox',
        durMs: (await responseEnd(page, 'entity.update')) - t0,
        repeat: r,
      });
    }
  } else notes.push('галочки на экране лаб-задачи нет');
  const details = page.getByRole('tab', { name: 'Детали' });
  if (await details.count()) await details.first().click();
  const status = 'select[data-testid="prop-orbis/task_status"]';
  if (await page.$(status)) {
    for (const value of ['waiting', 'inbox']) {
      const answered = page.waitForResponse((res) => res.url().includes('/trpc/entity.update'));
      const t0 = await page.evaluate(() => performance.now());
      await page.selectOption(status, value);
      const seen = (await (
        await page.waitForFunction(
          ({ sel, value }) =>
            (document.querySelector(sel) as HTMLSelectElement | null)?.value === value
              ? performance.now()
              : false,
          { sel: status, value },
        )
      ).jsonValue()) as number;
      await answered;
      mark(out, { metric: 'action_visible', kind: 'status', durMs: seen - t0, repeat: r });
      mark(out, {
        metric: 'action_confirmed',
        kind: 'status',
        durMs: (await responseEnd(page, 'entity.update')) - t0,
        repeat: r,
      });
    }
  } else notes.push('поля статуса на экране лаб-задачи нет');
}

/** Набор 30 с при открытом чате (§3.4 п. 4): запросы по процедурам, INP; затем закрытие вкладки и проверка текста. */
async function typing(ctx: BrowserContext, noteId: string, out: LabSample[], notes: string[]) {
  const page = await ctx.newPage();
  await page.goto(`${LAB_URL}/r/${noteId}`);
  await waitReady(page, noteId, notes, 'лаб-запись');
  await page.click('[data-testid="host-chat"]');
  if (await page.$('[data-testid="editor-preview"]'))
    await page.click('[data-testid="editor-preview"]');
  await page.click('[data-testid="body-editor"] .ProseMirror');
  const requests: Record<string, number> = {};
  const count = (url: string) => {
    const procs = proceduresOf(url);
    for (const p of procs ?? []) requests[p] = (requests[p] ?? 0) + 1;
  };
  page.on('request', (req) => count(req.url()));
  await page.evaluate(() => {
    (window as unknown as { __lab: { maxEvent: number } }).__lab.maxEvent = 0;
  });
  const marker = `лаб-${Date.now()}`;
  await page.keyboard.type(`${marker} ${'набор текста для замера '.repeat(8)}`.slice(0, 200), {
    delay: 150,
  });
  mark(out, {
    metric: 'inp',
    kind: 'typing',
    durMs: await page.evaluate(
      () => (window as unknown as { __lab: { maxEvent: number } }).__lab.maxEvent,
    ),
    repeat: 1,
  });
  await page.close({ runBeforeUnload: true });
  const again = await ctx.newPage();
  await again.goto(`${LAB_URL}/r/${noteId}`);
  await waitReady(again, noteId, notes, 'после закрытия');
  const textSurvived = ((await again.textContent('[data-testid="record-area"]')) ?? '').includes(
    marker,
  );
  await again.close();
  return { requests, textSurvived };
}

/** Холодный старт без сети (§3.4 п. 5): содержимое экрана за 10 с или заметка. */
async function offlineStart(ctx: BrowserContext, out: LabSample[], notes: string[]) {
  await ctx.setOffline(true);
  const page = await ctx.newPage();
  try {
    await page.goto(LAB_URL).catch(() => {});
    const at = (await (
      await page.waitForFunction(
        () =>
          document.querySelector('main[data-testid="screen-content"] [data-testid="record-area"]')
            ? performance.now()
            : false,
        undefined,
        { timeout: 10_000 },
      )
    ).jsonValue()) as number;
    mark(out, { metric: 'cold_start', kind: 'offline', durMs: at, repeat: 1 });
  } catch {
    notes.push('без сети: содержимого за 10 с нет');
  } finally {
    await page.close();
    await ctx.setOffline(false);
  }
}

async function archive(page: Page, id: string, notes: string[]) {
  await page.goto(`${LAB_URL}/r/${id}`);
  await waitReady(page, id, notes, 'архив лаб-записи');
  await page.click('button[data-testid="screen-menu"]');
  const done = page.waitForResponse((res) => res.url().includes('/trpc/entity.update'));
  await page.getByRole('menuitem', { name: 'Архивировать' }).click();
  await done;
}

export async function runScenario(
  ctx: BrowserContext,
  o: { label: string; repeat: number; log: (l: string) => void },
): Promise<LabRun> {
  await ctx.addInitScript(OBSERVERS);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const samples: LabSample[] = [];
  const notes: string[] = [];
  const trpcEncoding: Record<string, string | null> = {};
  // Сжатие на краю сети (§9, §3.4): заголовок ответа по каждой пачке процедур.
  ctx.on('response', (res) => {
    const procs = proceduresOf(res.url());
    if (procs !== null) trpcEncoding[procs.join(',')] = res.headers()['content-encoding'] ?? null;
  });
  await page.goto(LAB_URL);
  await waitReady(page, null, notes, 'первый вход');
  const records = await pickRecords(page, notes);
  const titled: Row[] = [];
  for (const kind of RECORD_KINDS) {
    const id = records[kind];
    if (id)
      titled.push({
        id,
        title: (await trpcQuery<{ entity: { title: string } }>(page, 'entity.get', { id })).entity
          .title,
      });
  }
  const stamp = new Date().toISOString().slice(0, 16);
  const labNote = await capture(page, `Лаб-запись ${stamp}`, 1, samples, 'create'); // В-5: две лаб-записи за прогон
  await page.goto(`${LAB_URL}/r/${labNote}`);
  await waitReady(page, labNote, notes, 'лаб-запись');
  const labTask = await capture(page, `Лаб-подзадача ${stamp}`, 1, samples, 'subtask');
  for (let r = 1; r <= o.repeat; r++) {
    o.log(`повтор ${r}/${o.repeat}`);
    await coldStarts(ctx, page, r, samples, notes);
    await transitions(page, titled, r, samples, notes);
    await toggles(page, labTask, r, samples, notes);
  }
  const typed = await typing(ctx, labNote, samples, notes);
  await offlineStart(ctx, samples, notes);
  await archive(page, labTask, notes);
  await archive(page, labNote, notes);
  return {
    label: o.label,
    url: LAB_URL,
    startedAt: new Date().toISOString(),
    repeat: o.repeat,
    records,
    samples,
    notes,
    trpcEncoding,
    typing: typed,
  };
}
