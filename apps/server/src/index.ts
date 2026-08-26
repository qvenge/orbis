import { makeAiDeps } from './ai/send-message';
import { createApp, resolvePort } from './app';
import { makeDb } from './db/client';
import { type RegistryDriftStatus, reportRegistryDriftOnStartup } from './db/registry-drift';
import { assertPublicOriginConfigured } from './oauth/metadata';
import { type RoutineScheduler, startRoutineScheduler } from './routines/scheduler';
import { manualRuns } from './routines/shutdown';

// Публичная база метаданных OAuth (§9.3) — ПЕРВОЙ: это чистая проверка конфигурации,
// ей не нужны ни соединения, ни ключи, а цена ошибки высока. Кривое значение роняет
// старт (манера D28), потому что иначе оно роняло бы 401 на /mcp в 500: указатель на
// метаданные собирается на пути отказа, и вход агента ломался бы молча при зелёном
// /health. Вне production незаданная переменная законна — база берётся из запроса.
assertPublicOriginConfigured();

// Один пул соединений на процесс; в request-контекст db попадает ссылкой (Task 12)
const { db, client } = makeDb();

// AI-deps — один инстанс на процесс (§7.7: провайдеров два, выбор — env, имя модели
// для метеринга отдаёт сам провайдер);
// fail-fast роняет старт, а не запрос: невалидный ORBIS_LLM_PROVIDER; отсутствие
// ключа выбранного провайдера (ANTHROPIC_API_KEY / OPENAI_API_KEY) при явном
// ORBIS_LLM_PROVIDER или в production; ОБА ключа сразу без явного
// ORBIS_LLM_PROVIDER — выбор неоднозначен, и молчаливый метерился бы чужой моделью
const ai = makeAiDeps();

// Реестры в БД против кода — пять реестров и таблица действий (§А12-1 п.4). НЕ fail-fast и
// НЕ блокирует приём запросов: пересев — шаг релиза с ноутбука владельца, и приложение
// обязано подняться, даже когда его забыли. Результат доезжает в /health: расхождение —
// списком, невыполненная проверка — «unknown» (молчать о ней нельзя, иначе ловушка тихо
// снята).
let registryDrift: RegistryDriftStatus = { status: 'unknown' };
void reportRegistryDriftOnStartup(db).then((d) => {
  registryDrift = d;
});

// Планировщик рутин (V1.2): тик раз в минуту в ЭТОМ процессе, включается явно переменной
// окружения (Р-14) — на стенде и в тестах фон молчит, в render.yaml включён. Стартует
// ПОСЛЕ подъёма сервера: /health должен отвечать до первого тика, а не после него.
// Объявлен до createApp ради геттера в /health: 'off' | ISO последнего тика | 'pending'.
let scheduler: RoutineScheduler | undefined;
const app = createApp({
  db,
  ai,
  registryDrift: () => registryDrift,
  routineScheduler: () => ({
    enabled: scheduler !== undefined,
    lastTickAt: scheduler?.lastTickAt()?.toISOString() ?? null,
  }),
});

const server = Bun.serve({
  port: resolvePort(),
  fetch: app.fetch,
});

if (process.env.ORBIS_ROUTINE_SCHEDULER === '1') {
  scheduler = startRoutineScheduler({
    db,
    provider: ai.provider,
    model: ai.model,
    // Резолвер §8 из AiDeps: у боевых deps его нет (undefined → resolveEntitlement), но
    // общий шов с чатом сохраняется — второй способ задать лимиты сюда не заводим
    ...(ai.entitlements !== undefined && { entitlements: ai.entitlements }),
    clock: () => new Date(),
  });
  console.log('[routines] планировщик рутин включён (ORBIS_ROUTINE_SCHEDULER=1)');
}

// Render шлёт SIGTERM на каждый деплой/рестарт и ждёт до 30 с. Без обработчика процесс
// умирает мгновенно: агентная петля обрывается посреди шага (действия тулов уже применены,
// assistant-сообщение не записано), пул соединений не дренится.
//
// Планировщик и ручные прогоны останавливаются ДО client.end() (Р-12, хвост C2-1):
// stop()/shutdown() дают раннеру рубильник — идущий прогон закрывается `failed` «остановлен
// при выключении процесса» между шагами — и дожидаются закрытия; иначе пул рвался бы под
// транзакцией закрытия, а прогон висел бы `running` до подметания. Рубильники дёргаются
// сразу (до дренажа запросов), чтобы прогон не тратил окно SIGTERM на лишний шаг модели.
// Ручные прогоны («прогнать сейчас») — отдельный реестр (routines/shutdown.ts): они живут
// вне тика, и stop() планировщика их не видит. Его shutdown() зовётся ДВАЖДЫ нарочно: первый
// вызов — рубильник до дренажа (при пустом реестре он резолвится сразу и ждать ему нечего),
// второй — ПОСЛЕ `server.stop()`: запрос runNow, доживший в дренаже, регистрирует прогон уже
// после первого вызова, и дождаться его может только повторный (идемпотентный) shutdown.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal}: останавливаюсь, дожидаюсь in-flight запросов`);
  try {
    const schedulerStopped = scheduler?.stop();
    void manualRuns.shutdown(); // рубильник сразу; ожидание — повторным вызовом ниже
    await server.stop(); // без force: активные запросы доживают
    await schedulerStopped;
    await manualRuns.shutdown(); // дождаться и прогонов, зарегистрированных в дренаже
    await client.end({ timeout: 5 });
  } catch (e) {
    console.error('[server] ошибка при остановке:', e);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
