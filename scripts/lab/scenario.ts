// scripts/lab/scenario.ts — эталонный сценарий лабораторного прогона (спека скорости §3.4, РП-25).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
// Текст запросов поиска хоста — тот же модуль, что строит их окну поиска: проверка «поиск найдёт запись»
// обязана спрашивать ровно то, что спросит окно (группы, потолки, квотирование строки), а не свою копию.
import { SEARCH_GROUPS, searchBlockTexts } from '../../apps/web/src/features/search/search-query';
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
/** Потолок ожидания текста, набранного перед закрытием вкладки, на её новом открытии (I-4). */
export const SURVIVE_CEILING_MS = 10_000;
/** Длина строки поиска по заголовку, знаков (кодовых точек) — если первое слово длиннее, берётся оно целиком. */
export const SEARCH_TEXT_MAX = 40;
/**
 * Набор (§3.4 п. 4, R-5): очередями с паузой ДЛИННЕЕ паузы сохранения тела (`SAVE_DEBOUNCE_MS` = 2 с,
 * `useBodySave.ts`; таймер перезаводится на каждую правку) — ожидается одно сохранение на очередь. Запросы
 * считаются по временным окнам (N1/R99: поздний зависимый запрос может попасть в следующее окно, причинная
 * принадлежность сохранению этим счётом не доказана; общий счёт верен). Сплошной
 * набор не дал бы ни одного сохранения за все 30 с. Латиница — клавиши US-раскладки: кириллицу Playwright
 * вставляет `insertText` без keydown/keyup, и у таких событий нет `interactionId` — INP мерил бы одни пробелы.
 */
export const TYPING = {
  bursts: 8,
  burstText: 'quick brown fox jumps on ',
  charDelayMs: 70,
  pauseMs: 2500,
} as const;
export const RECORD_KINDS = ['task', 'note', 'page-with-blocks', 'project', 'no-blocks'] as const;
/** Все CSS-селекторы и доступные имена сценария; сторож сверяет их с реальными производителями web.
 * `${*}` обозначает переменную часть адреса, а не отдельный селектор для каждой лабораторной записи.
 * Вкладку «Детали» поставляет общий эталон: web рисует подпись дерева, поэтому сторож проверяет и этот источник.
 */
export const LAB_SELECTORS = [
  ['main[data-testid="screen-content"]', ['app/router.tsx', '<main data-testid="screen-content"']],
  [
    'main[data-testid="screen-content"][data-place$="/r/${*}"]',
    ['app/router.tsx', 'data-place={place}'],
  ],
  [
    '[data-testid="record-area"]',
    ['features/entity-detail/DetailScreen.tsx', 'data-testid="record-area"'],
  ],
  [
    '[data-testid="record-view-wait"]',
    ['features/page/RecordView.tsx', 'data-testid="record-view-wait"'],
  ],
  [
    '[role="status"][aria-label="Загрузка"]',
    ['ui/Skeleton.tsx', 'role="status"', 'aria-label="Загрузка"'],
  ],
  ['[role="status"]', ['features/page/blocks/DataBlock.tsx', 'role="status"', 'Загрузка…']],
  ['[data-testid="login-screen"]', ['auth/LoginScreen.tsx', 'data-testid="login-screen"']],
  [
    'input[aria-label="Строка поиска"]',
    ['features/search/SearchPanel.tsx', 'aria-label="Строка поиска"', '<Input'],
    ['ui/Input.tsx', '<input'],
  ],
  [
    '[data-testid="search-hit-${*}"]',
    ['features/search/SearchPanel.tsx', 'data-testid={`search-hit-${hit.id}`}'],
  ],
  ['[data-testid="host-back"]', ['app/frame/HostPresence.tsx', 'data-testid="host-back"']],
  ['[data-testid="host-new"]', ['app/frame/HostButtons.tsx', 'data-testid="host-new"']],
  [
    'form[data-testid="quick-capture-form"] input[aria-label="Быстрая запись"]',
    [
      'features/browser/QuickCapture.tsx',
      '<form data-testid="quick-capture-form"',
      'aria-label="Быстрая запись"',
      '<input',
    ],
  ],
  [
    'form[data-testid="quick-capture-form"] button[aria-label="Добавить"]',
    ['features/browser/QuickCapture.tsx', 'aria-label="Добавить"', '<button'],
  ],
  [
    '[data-testid="native-row"] [role="checkbox"][aria-label="Готово"]',
    [
      'features/entity-detail/NativeRow.tsx',
      'data-testid="native-row"',
      '<Checkbox',
      'aria-label="Готово"',
    ],
    ['ui/Checkbox.tsx', '<RC.Root'],
  ],
  [
    'role:tab;name:Детали',
    ['features/page/TabsContainer.tsx', 'label: tab.label'],
    ['ui/Tabs.tsx', '<RT.Trigger', '{t.label}'],
  ],
  [
    'select[data-testid="prop-orbis/task_status"]',
    ['lib/registry/PropertyControl.tsx', '<select', 'data-testid={`prop-${def.id}`}'],
  ],
  [
    '[data-testid="body-editor"] .ProseMirror',
    ['features/entity-editor/BodyEditor.tsx', '<EditorContent', 'data-testid="body-editor"'],
  ],
  [
    '[data-testid="editor-preview"]',
    ['features/entity-editor/EditorShell.tsx', 'data-testid="editor-preview"'],
  ],
  ['[data-testid="host-chat"]', ['app/frame/HostButtons.tsx', 'data-testid="host-chat"']],
  [
    '[data-testid="draft-banner"]',
    ['features/entity-detail/EntityBody.tsx', 'data-testid="draft-banner"'],
  ],
  [
    'main[data-testid="screen-content"] [data-testid="record-area"]',
    ['app/router.tsx', 'data-testid="screen-content"'],
    ['features/entity-detail/DetailScreen.tsx', 'data-testid="record-area"'],
  ],
  [
    'button[data-testid="screen-menu"]',
    ['app/frame/ScreenMenu.tsx', 'data-testid="screen-menu"', '<button'],
  ],
  [
    'role:menuitem;name:Архивировать',
    ['features/entity-detail/DetailMenu.tsx', "archived ? 'Разархивировать' : 'Архивировать'"],
    ['ui/DropdownMenu.tsx', '<RDM.Item', '{item.label}'],
  ],
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export interface TypingResult {
  /** Запросы tRPC по процедурам за весь набор. */
  requests: Record<string, number>;
  /** Запросы по временным окнам «очередь + пауза»; поздние ответы могут пересечь границу (N1/R99). */
  perSave: Array<Record<string, number>>;
  /** Маркер, набранный перед закрытием вкладки без паузы, виден на новом открытии в пределах потолка. */
  textSurvived: boolean;
  /** Когда маркер появился в области записи — мс от начала загрузки новой вкладки; не появился — `null`. */
  survivedAtMs: number | null;
  /** Показывалась ли плашка черновика (`draft-banner`) на новом открытии. */
  draftBanner: boolean;
}
export interface LabRun {
  label: string;
  url: string;
  /** Начало прогона (а не момент записи файла). */
  startedAt: string;
  repeat: number;
  records: Partial<Record<RecordKind, string>>;
  samples: LabSample[];
  notes: string[];
  trpcEncoding: Record<string, string | null>;
  typing: TypingResult | null;
  /** Созданные прогоном лаб-записи (В-5) — их id на случай ручной уборки. */
  labRecords: string[];
  /** Причина обрыва прогона; `null` — прогон прошёл целиком. При обрыве файл частичный. */
  failed: string | null;
}

/** Наблюдатели LCP и событий ввода — до первого скрипта страницы. INP лаборатории — максимум длительности
 *  взаимодействия (Event Timing) за шаг: один сценарий на одной машине, p98 по десяткам событий не нужен.
 *  Буфер Resource Timing (по умолчанию 250 записей) расширен: «подтверждено» читается из него (M-1). */
const OBSERVERS = `(() => { const lab = { lcp: null, maxEvent: 0 }; window.__lab = lab; try {
  performance.setResourceTimingBufferSize(5000);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) lab.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) lab.maxEvent = Math.max(lab.maxEvent, e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
} catch {} })();`;

/**
 * Строка поиска по заголовку (I-2): поиск хоста — полнотекст по ЦЕЛЫМ словам (`search-query.ts`: «Куп» не найдёт
 * «Купить»), поэтому заголовок режется только по границе слова — не посреди слова и не посреди суррогатной пары.
 * Длина — в кодовых точках; первое слово берётся целиком, даже если оно длиннее потолка.
 */
export function searchTextOf(title: string, max: number = SEARCH_TEXT_MAX): string {
  let out = '';
  for (const word of title.trim().split(/\s+/)) {
    if (word === '') continue;
    const next = out === '' ? word : `${out} ${word}`;
    if (out !== '' && [...next].length > max) break;
    out = next;
  }
  return out;
}

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

/**
 * Открыть приложение и убедиться, что профиль вошёл (M-10): экран входа вместо приложения — быстрый отказ с
 * подсказкой, а не 90 с ожидания экрана записи.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto(LAB_URL);
  const state = await (
    await page.waitForFunction(
      () =>
        document.querySelector('main[data-testid="screen-content"]')
          ? 'app'
          : document.querySelector('[data-testid="login-screen"]')
            ? 'login'
            : false,
      undefined,
      { timeout: 90_000 },
    )
  ).jsonValue();
  if (state === 'login') {
    throw new Error(
      'сессия лаб-профиля протухла или её нет — войдите заново: bun scripts/lab/login.ts',
    );
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

/**
 * Конец ответа процедуры, вызванной действием в момент `t0` (M-1): первая запись Resource Timing этой процедуры,
 * начатая не раньше `t0`. Запись попадает в буфер по концу ответа — позже заголовков, по которым резолвится
 * `waitForResponse`, — поэтому её ждём в странице. Не дождались — NaN: сводка отбросит замер и назовёт число.
 */
async function responseEnd(page: Page, procedure: string, t0: number): Promise<number> {
  try {
    const h = await page.waitForFunction(
      ({ p, t0 }) => {
        const e = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
          .filter((x) => x.name.includes('/trpc/') && x.name.includes(p) && x.startTime >= t0)
          .sort((a, b) => a.startTime - b.startTime)[0];
        return e !== undefined && e.responseEnd > 0 ? e.responseEnd : false;
      },
      { p: procedure, t0 },
      { timeout: 10_000 },
    );
    return (await h.jsonValue()) as number;
  } catch {
    return Number.NaN;
  }
}

/**
 * Вызов tRPC из контекста страницы токеном сессии профиля (без пачки): запрос — GET со входом в `?input=`,
 * мутация — POST со входом телом. Токен — из хранилища сессии auth-js (`auth/config.ts`, `sb-<ref>-auth-token`).
 */
async function trpcCall<T>(
  page: Page,
  path: string,
  input: unknown,
  kind: 'query' | 'mutation' = 'query',
): Promise<T> {
  return (await page.evaluate(
    async ({ path, input, kind }) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k));
      const token = key
        ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string }).access_token
        : undefined;
      if (!token) throw new Error('в профиле нет сессии — сначала bun scripts/lab/login.ts');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res =
        kind === 'query'
          ? await fetch(`/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
              headers,
            })
          : await fetch(`/trpc/${path}`, {
              method: 'POST',
              headers,
              body: JSON.stringify(input),
            });
      const body = (await res.json()) as {
        result?: { data: unknown };
        error?: { message?: string };
      };
      if (!res.ok || body.result === undefined)
        throw new Error(`${path}: ${body.error?.message ?? res.status}`);
      return body.result.data;
    },
    { path, input, kind },
  )) as T;
}

type Row = { id: string; title: string };
type EntityRead = { entity: { id: string; title: string; archived: boolean; body?: string } };

/**
 * Найдёт ли поиск хоста запись этим текстом в пределах потолка своей группы (I-2): тот же текст запросов, что у окна
 * поиска (`searchBlockTexts`), и та же пачка `entity.blocks`. Группа «Записи» — `limit=20` без ранжирования, и у
 * частого короткого заголовка цель может уйти под «и ещё N» — тогда переход через поиск ждал бы 30 с и падал.
 */
async function searchFinds(page: Page, id: string, text: string): Promise<boolean> {
  const texts = searchBlockTexts(text);
  if (texts === null) return false;
  const res = await trpcCall<{
    results: Record<string, { ok: boolean; rows?: Array<{ id: string }> }>;
  }>(
    page,
    'entity.blocks',
    { blocks: SEARCH_GROUPS.map((g) => ({ key: g, text: texts[g] })) },
    'mutation',
  );
  return SEARCH_GROUPS.some((g) => res.results[g]?.rows?.some((r) => r.id === id) ?? false);
}

/** Что делает запись пригодной для вида: страница с блоками данных, запись без блоков; прочим — аспект запроса. */
const KIND_SOURCES: Record<RecordKind, { query: string; fits?: (body: string) => boolean }> = {
  task: { query: 'aspect=orbis/task, limit=15' },
  note: { query: 'aspect=orbis/note, limit=15' },
  'page-with-blocks': {
    query: 'aspect=orbis/page, limit=30',
    fits: (body) => body.includes('{{query:'),
  },
  project: { query: 'aspect=orbis/project, limit=15' },
  'no-blocks': { query: 'aspect=orbis/note, limit=15', fits: (body) => !body.includes('{{') },
};

/**
 * Пять записей разных видов — один раз, дальше из `records.json` (сравнимость прогонов). Каждая — и выбранная, и
 * сохранённая — проверяется: жива, не в архиве, поиск её находит (I-2, M-10). Непригодная сохранённая
 * перевыбирается с заметкой: прогон по этому виду уже несравним с прежними.
 */
async function pickRecords(page: Page, notes: string[]): Promise<Partial<Record<RecordKind, Row>>> {
  const stored: Partial<Record<RecordKind, string>> = existsSync(RECORDS_FILE)
    ? JSON.parse(readFileSync(RECORDS_FILE, 'utf8'))
    : {};
  const read = (id: string) =>
    trpcCall<EntityRead>(page, 'entity.get', { id, include: ['body'] }).catch(() => null);
  const out: Partial<Record<RecordKind, Row>> = {};
  const taken = new Set<string>();
  let changed = false;
  // R99: сначала резервируем все пригодные сохранённые записи. Иначе замена раннего вида могла забрать
  // запись позднего вида; повтор сохранённого id принадлежит первому виду и позже перевыбирается.
  const validated = new Map<
    string,
    { entity: EntityRead['entity'] | undefined; why: string | null }
  >();
  for (const kind of RECORD_KINDS) {
    const kept = stored[kind];
    if (kept !== undefined) {
      let checked = validated.get(kept);
      if (checked === undefined) {
        const entity = (await read(kept))?.entity;
        const why =
          entity === undefined
            ? 'не читается'
            : entity.archived
              ? 'в архиве'
              : !(await searchFinds(page, entity.id, searchTextOf(entity.title)))
                ? 'не находится поиском'
                : null;
        checked = { entity, why };
        validated.set(kept, checked);
      }
      const { entity: e } = checked;
      const why =
        checked.why ??
        (e !== undefined && taken.has(e.id) ? 'уже сохранена для другого вида' : null);
      if (why === null && e !== undefined) {
        out[kind] = { id: e.id, title: e.title };
        taken.add(e.id);
        continue;
      }
      notes.push(
        `records.json: запись вида ${kind} (${kept}) ${why} — перевыбрана, вид несравним с прежними прогонами`,
      );
    }
  }
  for (const kind of RECORD_KINDS) {
    if (out[kind] !== undefined) continue;
    changed = true;
    const { query, fits } = KIND_SOURCES[kind];
    let skipped = 0;
    for (const r of await trpcCall<Row[]>(page, 'entity.query', { query })) {
      if (taken.has(r.id)) continue;
      if (fits !== undefined && !fits((await read(r.id))?.entity.body ?? '')) continue;
      if (!(await searchFinds(page, r.id, searchTextOf(r.title)))) {
        skipped += 1;
        continue;
      }
      out[kind] = { id: r.id, title: r.title };
      taken.add(r.id);
      break;
    }
    if (skipped > 0)
      notes.push(`вид ${kind}: поиском по заголовку не находятся ${skipped} — взята следующая`);
    if (out[kind] === undefined) notes.push(`нет записи вида ${kind}`);
  }
  if (changed) {
    const ids: Partial<Record<RecordKind, string>> = {};
    for (const kind of RECORD_KINDS) if (out[kind]) ids[kind] = out[kind]?.id;
    writeFileSync(RECORDS_FILE, JSON.stringify(ids, null, 2));
  }
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
  await page.fill('input[aria-label="Строка поиска"]', searchTextOf(title));
  await page.waitForSelector(`[data-testid="search-hit-${id}"]`, { timeout: 30_000 });
  return clickAt(page, `[data-testid="search-hit-${id}"]`);
}
/** Первая запись — опорная: с неё открывается каждая следующая, «‹» возвращает на неё (поиск снимается переходом,
 *  стопка — «опорная → следующая»). Повтор — вторая запись, уже открывавшаяся в этой вкладке (цель 1 §0.3). */
async function transitions(page: Page, recs: Row[], r: number, out: LabSample[], notes: string[]) {
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

/** Id записи из тела пачки `entity.create` (`{"0": {input: {id, …}, source}}`) — клиент задаёт его сам (QuickCapture). */
function createdIdOf(post: unknown): string | null {
  const first = (post as Record<string, { input?: { id?: unknown } }> | null)?.['0'];
  return typeof first?.input?.id === 'string' ? first.input.id : null;
}

/**
 * «＋» (§3.4 п. 3): запись (на домашней — без контекста) или подзадача (на записи — `entity.create`, затем
 * `relation.create`, `QuickCapture.tsx`); у подзадачи свой вид действия — два запроса подряд, не «создание» (M-7).
 * Подтверждение — конец ответа последней мутации, видимо — поле очистилось. Id регистрируется для уборки ДО
 * ожидания ответа — из тела запроса: запись есть на сервере, даже если ответ потеряется (I-3).
 */
async function capture(
  page: Page,
  title: string,
  r: number,
  out: LabSample[],
  kind: 'create' | 'subtask',
  register: (id: string) => void,
): Promise<string> {
  await page.click('[data-testid="host-new"]');
  await page.fill(
    'form[data-testid="quick-capture-form"] input[aria-label="Быстрая запись"]',
    title,
  );
  const sent = page.waitForRequest((req) => req.url().includes('/trpc/entity.create'));
  const t0 = await clickAt(
    page,
    'form[data-testid="quick-capture-form"] button[aria-label="Добавить"]',
  );
  const id = createdIdOf((await sent).postDataJSON());
  if (id === null) throw new Error('в запросе entity.create нет id записи');
  register(id);
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
  const last = await responseEnd(
    page,
    kind === 'subtask' ? 'relation.create' : 'entity.create',
    t0,
  );
  mark(out, { metric: 'action_confirmed', kind, durMs: last - t0, repeat: r });
  mark(out, { metric: 'action_visible', kind, durMs: cleared - t0, repeat: r });
  return id;
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
        durMs: (await responseEnd(page, 'entity.update', t0)) - t0,
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
        durMs: (await responseEnd(page, 'entity.update', t0)) - t0,
        repeat: r,
      });
    }
  } else notes.push('поля статуса на экране лаб-задачи нет');
}

/**
 * Редактор тела (M-8): встаёт по касанию превью ИЛИ сам по простою (`EditorShell.tsx`, requestIdleCallback), и
 * превью может исчезнуть между проверкой и кликом. Поэтому сперва — есть ли уже редактор; клик по превью — с
 * коротким потолком и без падения; затем ждём редактор.
 */
async function focusEditor(page: Page): Promise<void> {
  const editor = '[data-testid="body-editor"] .ProseMirror';
  if (!(await page.$(editor))) {
    await page
      .locator('[data-testid="editor-preview"]')
      .click({ timeout: 3_000 })
      .catch(() => {});
  }
  await page.waitForSelector(editor, { timeout: 30_000 });
  await page.click(editor);
}

/**
 * Набор ≈30 с при открытом чате (§3.4 п. 4, R-5): очереди `TYPING` с паузой длиннее паузы сохранения — запросы по
 * временным окнам и INP (N1/R99: это не причинная атрибуция сохранению). Затем маркер без паузы и закрытие вкладки: текст живёт только в досыле на `pagehide`
 * и в черновике. Новая вкладка — после события закрытия старой (I-4); маркер ждём в области записи (превью или
 * редактор) до потолка: до ответа сервера просмотр показывает прежний текст, черновик досылается при подъёме.
 */
async function typing(
  ctx: BrowserContext,
  noteId: string,
  out: LabSample[],
  notes: string[],
): Promise<TypingResult> {
  const page = await ctx.newPage();
  // Приложение пишет черновик на pagehide, а не beforeunload; но диалог ухода, появись он, Playwright по
  // умолчанию ОТКЛОНИЛ бы — вкладка осталась бы открытой, и замер «пережил закрытие» мерил бы не то.
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${LAB_URL}/r/${noteId}`);
  await waitReady(page, noteId, notes, 'лаб-запись');
  await page.click('[data-testid="host-chat"]');
  await focusEditor(page);
  const requests: Record<string, number> = {};
  const perSave: Array<Record<string, number>> = [];
  let slot: Record<string, number> = {};
  page.on('request', (req) => {
    for (const p of proceduresOf(req.url()) ?? []) {
      requests[p] = (requests[p] ?? 0) + 1;
      slot[p] = (slot[p] ?? 0) + 1;
    }
  });
  await page.evaluate(() => {
    (globalThis as unknown as { __lab: { maxEvent: number } }).__lab.maxEvent = 0;
  });
  for (let i = 0; i < TYPING.bursts; i++) {
    slot = {};
    perSave.push(slot);
    await page.keyboard.type(TYPING.burstText, { delay: TYPING.charDelayMs });
    await page.waitForTimeout(TYPING.pauseMs);
    if ((slot['entity.update'] ?? 0) === 0) notes.push(`набор: очередь ${i + 1} без сохранения`);
  }
  // Маркер — одним латинским словом: так он цел и в тексте превью, и в редакторе.
  const marker = `labmark${Date.now()}`;
  // Хвост с маркером — не окно сохранения: вкладка закрывается раньше паузы, его запросы в `perSave` не идут.
  slot = {};
  await page.keyboard.type(marker, { delay: TYPING.charDelayMs });
  mark(out, {
    metric: 'inp',
    kind: 'typing',
    durMs: await page.evaluate(
      () => (globalThis as unknown as { __lab: { maxEvent: number } }).__lab.maxEvent,
    ),
    repeat: 1,
  });
  const closed = page.waitForEvent('close', { timeout: 30_000 });
  await page.close({ runBeforeUnload: true });
  await closed;
  const again = await ctx.newPage();
  try {
    await again.goto(`${LAB_URL}/r/${noteId}`);
    await waitReady(again, noteId, notes, 'после закрытия');
    const at = await again
      .waitForFunction(
        (m) => {
          const w = globalThis as unknown as { __labBanner?: boolean };
          if (document.querySelector('[data-testid="draft-banner"]')) w.__labBanner = true;
          const area = document.querySelector('[data-testid="record-area"]');
          return area?.textContent?.includes(m) ? performance.now() : false;
        },
        marker,
        { timeout: SURVIVE_CEILING_MS, polling: 100 },
      )
      .then(async (h) => (await h.jsonValue()) as number)
      .catch(() => null);
    const draftBanner = await again.evaluate(
      () =>
        (globalThis as unknown as { __labBanner?: boolean }).__labBanner === true ||
        document.querySelector('[data-testid="draft-banner"]') !== null,
    );
    if (at === null) notes.push(`набор: маркер не появился за ${SURVIVE_CEILING_MS / 1000} с`);
    else mark(out, { metric: 'text_survived', kind: 'reopen', durMs: at, repeat: 1 });
    return {
      requests,
      perSave,
      textSurvived: at !== null,
      survivedAtMs: at === null ? null : Math.round(at),
      draftBanner,
    };
  } finally {
    await again.close();
  }
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

/**
 * Уборка при обрыве (I-3, В-5): лаб-записи, не ушедшие в архив путём интерфейса, архивируются запасным путём —
 * `entity.update {id, archived: true}` из контекста страницы тем же токеном. Не вышло — id в заметках и в логе:
 * уборка руками.
 */
async function archiveLeftovers(
  ctx: BrowserContext,
  page: Page,
  ids: string[],
  notes: string[],
  log: (l: string) => void,
): Promise<void> {
  log(`уборка: лаб-записи не в архиве — архивирую запасным путём: ${ids.join(', ')}`);
  try {
    await ctx.setOffline(false);
    const p = page.isClosed() ? await ctx.newPage() : page;
    if (!p.url().startsWith(LAB_URL)) await p.goto(LAB_URL, { timeout: 60_000 });
    for (const id of ids) {
      try {
        await trpcCall(p, 'entity.update', { id, archived: true }, 'mutation');
        notes.push(`уборка: ${id} в архиве запасным путём`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        notes.push(`уборка: ${id} НЕ в архиве (${why}) — архивировать руками`);
        log(`уборка: ${id} НЕ в архиве (${why}) — архивировать руками`);
      }
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    notes.push(`уборка не удалась (${why}) — архивировать руками: ${ids.join(', ')}`);
    log(`уборка не удалась (${why}) — архивировать руками: ${ids.join(', ')}`);
  }
}

export async function runScenario(
  ctx: BrowserContext,
  o: { label: string; repeat: number; log: (l: string) => void },
): Promise<LabRun> {
  const run: LabRun = {
    label: o.label,
    url: LAB_URL,
    startedAt: new Date().toISOString(),
    repeat: o.repeat,
    records: {},
    samples: [],
    notes: [],
    trpcEncoding: {},
    typing: null,
    labRecords: [],
    failed: null,
  };
  const { samples, notes } = run;
  const archived = new Set<string>();
  const register = (id: string) => {
    run.labRecords.push(id);
    o.log(`создана лаб-запись ${id}`);
  };
  await ctx.addInitScript(OBSERVERS);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Сжатие на краю сети (§9, §3.4): заголовок ответа по каждой пачке процедур.
  ctx.on('response', (res) => {
    const procs = proceduresOf(res.url());
    if (procs !== null)
      run.trpcEncoding[procs.join(',')] = res.headers()['content-encoding'] ?? null;
  });
  try {
    await openApp(page);
    await waitReady(page, null, notes, 'первый вход');
    const picked = await pickRecords(page, notes);
    const titled: Row[] = [];
    for (const kind of RECORD_KINDS) {
      const rec = picked[kind];
      if (rec === undefined) continue;
      run.records[kind] = rec.id;
      titled.push(rec);
    }
    const stamp = new Date().toISOString().slice(0, 16);
    // В-5: две лаб-записи за прогон
    const labNote = await capture(page, `Лаб-запись ${stamp}`, 1, samples, 'create', register);
    await page.goto(`${LAB_URL}/r/${labNote}`);
    await waitReady(page, labNote, notes, 'лаб-запись');
    const labTask = await capture(page, `Лаб-подзадача ${stamp}`, 1, samples, 'subtask', register);
    for (let r = 1; r <= o.repeat; r++) {
      o.log(`повтор ${r}/${o.repeat}`);
      await coldStarts(ctx, page, r, samples, notes);
      await transitions(page, titled, r, samples, notes);
      await toggles(page, labTask, r, samples, notes);
    }
    run.typing = await typing(ctx, labNote, samples, notes);
    await offlineStart(ctx, samples, notes);
    for (const id of [labTask, labNote]) {
      await archive(page, id, notes);
      archived.add(id);
    }
  } catch (e) {
    run.failed = e instanceof Error ? e.message : String(e);
    notes.push(`сбой: ${run.failed}`);
  } finally {
    const left = run.labRecords.filter((id) => !archived.has(id));
    if (left.length > 0) await archiveLeftovers(ctx, page, left, notes, o.log);
  }
  return run;
}
