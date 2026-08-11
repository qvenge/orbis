import { makeAiDeps } from './ai/send-message';
import { createApp, resolvePort } from './app';
import { type AspectDriftStatus, reportAspectDriftOnStartup } from './db/aspect-drift';
import { makeDb } from './db/client';
import { assertPublicOriginConfigured } from './oauth/metadata';

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

// Реестр аспектов в БД против кода (E1). НЕ fail-fast и НЕ блокирует приём запросов:
// пересев — шаг релиза с ноутбука владельца, и приложение обязано подняться, даже когда
// его забыли. Результат доезжает в /health: расхождение — списком, невыполненная
// проверка — «unknown» (молчать о ней нельзя, иначе ловушка тихо снята).
let aspectDrift: AspectDriftStatus = { status: 'unknown' };
void reportAspectDriftOnStartup(db).then((d) => {
  aspectDrift = d;
});

const app = createApp({ db, ai, aspectDrift: () => aspectDrift });

const server = Bun.serve({
  port: resolvePort(),
  fetch: app.fetch,
});

// Render шлёт SIGTERM на каждый деплой/рестарт и ждёт до 30 с. Без обработчика процесс
// умирает мгновенно: агентная петля обрывается посреди шага (действия тулов уже применены,
// assistant-сообщение не записано), пул соединений не дренится.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal}: останавливаюсь, дожидаюсь in-flight запросов`);
  try {
    await server.stop(); // без force: активные запросы доживают
    await client.end({ timeout: 5 });
  } catch (e) {
    console.error('[server] ошибка при остановке:', e);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
