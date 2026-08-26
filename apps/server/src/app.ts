// Сборка Hono-приложения (вынесено из index.ts ради тестируемости композиции роутов):
// index.ts инжектит боевые db/ai, тест — стабы + фикстурный webDistDir.
// Порядок роутов КРИТИЧЕН (слайс 1c-2, Task 7): API-роуты (/trpc/*, /mcp, /health,
// /.well-known/*) регистрируются ПЕРЕД статикой, поэтому их ответы не перехватываются
// SPA-fallback'ом (Hono исполняет matching-хендлеры в порядке регистрации; API-хендлер
// возвращает Response и не зовёт next → serveStatic до него не доходит).
import { trpcServer } from '@hono/trpc-server';
import { registryDriftIds } from '@orbis/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/bun';
import type { AiDeps } from './ai/send-message';
import { makeCreateContext } from './context';
import type { Db } from './db/client';
import type { RegistryDriftStatus } from './db/registry-drift';
import { makeMcpHandler } from './mcp/transport';
import { mountOAuthMetadata } from './oauth/metadata';
import { makeRegisterHandler } from './oauth/register';
import { makeTokenHandler } from './oauth/token-endpoint';
import { appRouter } from './router';

/**
 * Корень собранной web-статики (Vite output). Относителен cwd прод-процесса; дефолт —
 * apps/web/dist и в образе (Dockerfile выставляет WORKDIR=/app и на дефолт полагается);
 * тест передаёт абсолютный путь к фикстуре.
 */
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? 'apps/web/dist';

/** Порт по умолчанию: переменной нет (локальный `bun run dev`) или в ней мусор. */
export const DEFAULT_PORT = 3001;

/**
 * Порт HTTP-сервера из env (index.ts). Отдельная функция не ради красоты: прежнее
 * `Number(process.env.PORT) || 3001` съедало ровно ноль — `0 || 3001` даёт 3001, — а ноль
 * и есть единственное значение, которым просят «дай любой свободный порт» (соглашение
 * ядра, на котором держится `Bun.serve({ port: 0 })` во всех интеграционных тестах).
 * Из-за этого `PORT='0'` в пробе стартового гейта (oauth/metadata.test.ts) обещала защиту
 * от захода на боевой 3001 и не давала её: ребёнок садился ровно на 3001.
 *
 * Три случая различаются явно, потому что `Number('')` — это 0, и наивное `??` выдало бы
 * пустой строке случайный порт:
 *   • не задано, пусто, пробелы, мусор, вне диапазона → DEFAULT_PORT (прежнее терпимое
 *     поведение: кривой PORT не роняет старт);
 *   • явный `0` → свободный порт, выбранный ядром;
 *   • годное число → оно само.
 * Боевому деплою это ничего не меняет: Render всегда передаёт PORT.
 */
export function resolvePort(raw: string | undefined = process.env.PORT): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_PORT;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * Заголовки кэша статики: serveStatic из hono не ставит ни Cache-Control, ни ETag —
 * каждый визит до установки service worker перекачивал весь бандл (трафик free-плана,
 * медленный первый рендер). Файлы /assets/* имеют хеш в имени → immutable на год;
 * всё остальное (index.html, sw.js, manifest) обязано перепроверяться, иначе клиент
 * застрянет на старой версии.
 */
function cacheHeaders(path: string, c: Context): void {
  const immutable = path.includes('/assets/');
  c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
}

/**
 * Потолок тела /trpc/* — общий бэкстоп транспорта (не «лимит импорта»). До него у
 * tRPC не было лимита тела вовсе: любая мутация принимала гигабайтное тело, и его
 * разбирал JSON.parse ДО первой zod-проверки. Размер выбран по САМОЙ большой законной
 * мутации — import.confirm на MAX_IMPORT_ROWS строк: замер (фикс-раунд, A6) дал
 * 103 КБ на 300 строк и 344 КБ на 1000; поле `raw` строки схемой по длине не
 * ограничено, поэтому берём запас на выписку с длинными назначениями платежа.
 * 4 МиБ — с десятикратным запасом к замеру и всё ещё настоящий бэкстоп. Доменные
 * потолки (MAX_IMPORT_ROWS, .max() схем) он не заменяет: они дают внятный отказ,
 * этот — режет мусор до парсинга.
 */
export const TRPC_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Платформенный body-limit /trpc/* по образцу /mcp (mcp/transport.ts): считает по
 * ФАКТИЧЕСКИ прочитанным байтам, поэтому закрывает и chunked-тело без content-length.
 * Форма 413 — та же структурная, что у /mcp.
 */
const trpcBodyLimit = bodyLimit({
  maxSize: TRPC_MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `тело запроса превышает лимит ${TRPC_MAX_BODY_BYTES} байт`,
        },
      },
      413,
    ),
});

/**
 * Отказ «не тот метод» на POST-эндпоинтах OAuth (/oauth/token, /oauth/register). Нужен
 * потому, что на GET они доходили до SPA-fallback и отвечали index.html с кодом 200 —
 * страница вместо эндпоинта, объявленного в метаданных обнаружения.
 *
 * 405, а не 404: путь существует, не годится метод, и `Allow` называет это прямо.
 * Форма тела — спецификационная { error, error_description }, как у самих эндпоинтов
 * (register.ts, token-endpoint.ts), а не структурная { error: { code } } из /mcp и tRPC:
 * это OAuth-поверхность, и разработчик чужого агента разбирает её по RFC 6749 §5.2.
 * Код `invalid_request` — единственный общий в §5.2; своего кода под «не тот метод»
 * ни RFC 6749, ни RFC 7591 не дают, а выдумывать свой хуже, чем взять общий.
 */
function oauthMethodNotAllowed(path: string) {
  return (c: Context) =>
    c.json({ error: 'invalid_request', error_description: `${path} принимает только POST` }, 405, {
      Allow: 'POST',
    });
}

export interface AppDeps {
  db: Db;
  ai: AiDeps;
  /** Переопределение корня статики (тест/Docker); по умолчанию WEB_DIST_DIR. */
  webDistDir?: string;
  /**
   * Состояние стартовой проверки ПЯТИ реестров и таблицы действий (§А12-1 п.4) — геттер,
   * потому что проверка асинхронная и приложение поднимается, не дожидаясь её. Геттера нет
   * вовсе (тесты композиции, встроенные стенды) — /health про реестры молчит.
   */
  registryDrift?: () => RegistryDriftStatus;
  /**
   * Состояние планировщика рутин (V1.2) — тоже геттер: последний тик меняется каждую
   * минуту. Геттера нет — /health про планировщик молчит (та же форма, что у registryDrift).
   * `enabled: false` — фон выключен env'ом (стенд, тесты); `lastTickAt: null` при
   * включённом — первый тик ещё не прошёл.
   */
  routineScheduler?: () => { enabled: boolean; lastTickAt: string | null };
}

export function createApp({
  db,
  ai,
  webDistDir = WEB_DIST_DIR,
  registryDrift,
  routineScheduler,
}: AppDeps): Hono {
  const app = new Hono();

  // --- Защита от кликджекинга: ПЕРВЫМ middleware, на весь сервис ---
  // Экран согласия OAuth — обычная страница SPA, и без этих заголовков её можно поместить
  // в iframe: регистрация клиентов публична, а `client_name` никак не проверяется, поэтому
  // чужой регистрируется «Claude Code» со своим адресом возврата, фреймит наш /oauth/authorize
  // под прозрачным оверлеем — и один клик владельца по «Разрешить» отправляет ему живой код
  // авторизации. RFC 9700 §4.14 требует защищать authorization endpoint от кликджекинга явно.
  //
  // Заголовок на ВЕСЬ сервис, а не только на /oauth/authorize: Orbis нигде не встраивается
  // (ни виджета, ни встроенного просмотра нет), а защита, повешенная на один путь, теряется
  // на следующем добавленном роуте. Оба заголовка вместе — не дубль: `frame-ancestors` из
  // CSP это современная норма, `X-Frame-Options` остаётся для старых движков.
  //
  // Почему заголовком, а не <meta> в apps/web/index.html: `frame-ancestors` в meta-теге
  // браузеры игнорируют по спеке CSP (наравне с `sandbox` и `report-uri`), то есть защита
  // из HTML тут невозможна в принципе.
  //
  // Оговорка о полноте: современные браузеры партиционируют сторадж третьих сторон, поэтому
  // во фрейме владелец, скорее всего, увидел бы экран входа, а не согласия, — готового
  // эксплойта на свежем браузере нет. Но защита не должна быть заимствованной у чужой
  // браузерной фичи, которую мы не контролируем и не проверяем.
  //
  // Заголовки ставятся ПОСЛЕ next(), прямо на готовом ответе: на пути статики ответ рождает
  // serveStatic собственным Response, и подготовленные до next() заголовки на него не
  // переносятся.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  });

  // --- API-роуты: регистрируются ПЕРЕД статикой (порядок = приоритет) ---
  // Size-гейт ДО tRPC-хендлера: сверхлимитное тело отсекается прежде JSON-парсинга и
  // любой zod-валидации (порядок регистрации = порядок исполнения middleware).
  app.use('/trpc/*', trpcBodyLimit);
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: makeCreateContext(db, ai) }));
  // MCP-эндпоинт внешних агентов (§9.3): Streamable HTTP, только по гранту из
  // agent_grants — access-токен OAuth или headless-PAT (transport.ts)
  app.all('/mcp', makeMcpHandler({ db }));
  // Метаданные OAuth (§9.3): публичные, до статики — иначе их съест SPA-fallback
  mountOAuthMetadata(app);
  // Динамическая регистрация клиентов (RFC 7591) — адрес, объявленный в
  // registration_endpoint метаданных выше. Публичный по построению: агент регистрируется
  // ДО всякой аутентификации, иначе ему нечем начать вход.
  // Про порядок здесь — честно: статика и SPA-fallback зарегистрированы ТОЛЬКО на GET,
  // поэтому POST они не перехватили бы и снизу (проверено переносом строки под статику —
  // сьют остаётся зелёным). Место выбрано ради одной точки со всеми API-роутами.
  app.post('/oauth/register', makeRegisterHandler({ db }));
  // Обмен кода и refresh на пару токенов (§9.3) — адрес из `token_endpoint` метаданных.
  // Публичный по построению: клиенты у нас без секрета, обмен защищён PKCE.
  app.post('/oauth/token', makeTokenHandler({ db }));
  // Хвост к обоим POST-эндпоинтам выше: не-POST до правки доходил до SPA-fallback и получал
  // index.html с кодом 200. Регистрируются СРАЗУ ЗА своими POST-роутами — те на POST
  // возвращают Response и next() не зовут, поэтому сюда доходят только прочие методы.
  // Отсечка поимённая, а не по /oauth/*: /oauth/authorize — клиентский роут SPA, ему
  // страницей быть положено.
  app.all('/oauth/register', oauthMethodNotAllowed('/oauth/register'));
  app.all('/oauth/token', oauthMethodNotAllowed('/oauth/token'));
  // Форма ответа на здоровом реестре НЕ меняется ({status:'ok'}) — на неё смотрит и
  // healthCheckPath Render, и тесты. Расхождение добавляет поле, но не меняет код ответа:
  // не-200 здесь превратил бы наблюдаемость ловушки в отказ деплоя (E1). Третье значение
  // — 'unknown': проверка не выполнилась (БД была недоступна на старте), и выдавать это
  // за «расхождений нет» нельзя — именно так ловушка снималась молча. Поле называется
  // registryDrift (было aspectDrift): реестров теперь шесть, и каждая строка списка несёт
  // имя реестра — иначе `orbis/task` в ответе не отличить от свойства с тем же id.
  //
  // Планировщик рутин (V1.2) — тем же правилом: поле появляется только с геттером и никогда
  // не меняет код ответа. 'off' — выключен env'ом; 'pending' — включён, первого тика ещё не
  // было; иначе ISO последнего тика — по нему внешний пингер (runbook §5) видит, что фон
  // жив, а не только что процесс отвечает.
  app.get('/health', (c) => {
    const body: Record<string, unknown> = { status: 'ok' };
    const state = registryDrift?.();
    if (state !== undefined && state.status === 'unknown') body.registryDrift = 'unknown';
    else if (state !== undefined && state.status === 'drift') {
      body.registryDrift = registryDriftIds(state.drift);
    }
    const scheduler = routineScheduler?.();
    if (scheduler !== undefined) {
      body.routineScheduler = !scheduler.enabled ? 'off' : (scheduler.lastTickAt ?? 'pending');
    }
    return c.json(body);
  });

  // --- Same-origin раздача web-статики (Task 7, Вариант A) ---
  // GET-only: не-GET к неизвестному пути падает в 404 Hono (не в index.html), а API-роуты
  // выше уже забрали свои методы. serveStatic при отсутствии файла зовёт next() →
  // цепочка доходит до SPA-fallback (index.html) — только для GET.
  app.get('*', serveStatic({ root: webDistDir, onFound: cacheHeaders }));
  // Отсечка ДО SPA-fallback: хешированный ассет либо существует (его отдал serveStatic
  // выше и сюда не дошёл), либо исчез вместе со старым деплоем — клиентским роутом
  // /assets/* не бывает никогда. Без этой строки fallback отдаёт на промах index.html
  // с 200 и text/html, и провал динамического import() приходит в консоль ошибкой MIME
  // («Failed to fetch dynamically imported module») вместо «файла нет»; на честный 404
  // опирается клиентский обработчик vite:preloadError. c.notFound(), а не свой c.text:
  // тот же путь при не-GET уже отвечает штатным 404 Hono, и расходиться телом ответа
  // по методу незачем.
  // Отсечка НАМЕРЕННО узкая — только /assets/*. Хешированные файлы есть и в корне dist
  // (workbox-<хеш>.js, на него ссылается sw.js): промах по ним по-прежнему отдаёт HTML,
  // и в узкое окно скользящего деплоя service worker упадёт SyntaxError вместо «файла
  // нет». Улик, что это случалось, нет, а «всё с хешем в имени» — правило, которое
  // некому проверять; расширять отсечку без улики не стали.
  app.get('/assets/*', (c) => c.notFound());
  // Та же отсечка для /.well-known/*: известные документы обнаружения смонтированы выше
  // (mountOAuthMetadata) и сюда не доходят, а всё прочее под этим префиксом клиентским
  // роутом не бывает — SPA о нём не знает. Без строки SPA-fallback отдавал index.html с
  // кодом 200 на `/.well-known/oauth-protected-resource/mcp/` (тот же адрес со слэшем) и
  // `/.well-known/oauth-authorization-server/mcp`. Цена ровно та: MCP-клиент обходит
  // документы обнаружения СПИСКОМ кандидатов и на 404 спокойно берёт следующий, а 200 с
  // HTML даёт ему не мягкий откат, а исключение при разборе JSON — вход агента ломается
  // на первом же кандидате, которого мы не смонтировали.
  app.get('/.well-known/*', (c) => c.notFound());
  // SPA-fallback: любой не пойманный выше GET (клиентский роут вроде /browser/123) →
  // index.html. path игнорирует путь запроса, поэтому всегда отдаёт единый bootstrap.
  app.get('*', serveStatic({ path: 'index.html', root: webDistDir, onFound: cacheHeaders }));

  return app;
}
