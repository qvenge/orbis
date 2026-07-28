import type { AspectDrift } from '@orbis/shared';
import { makeAiDeps } from './ai/send-message';
import { createApp } from './app';
import { reportAspectDriftOnStartup } from './db/aspect-drift';
import { makeDb } from './db/client';

// Один пул соединений на процесс; в request-контекст db попадает ссылкой (Task 12)
const { db, client } = makeDb();

// AI-deps — один инстанс на процесс (§7.7: провайдер один, имя модели — конфиг);
// fail-fast: невалидный ORBIS_LLM_PROVIDER, а также отсутствие ANTHROPIC_API_KEY при
// ORBIS_LLM_PROVIDER='anthropic' или в production — роняют старт, а не запрос
const ai = makeAiDeps();

// Реестр аспектов в БД против кода (E1). НЕ fail-fast и НЕ блокирует приём запросов:
// пересев — шаг релиза с ноутбука владельца, и приложение обязано подняться, даже когда
// его забыли. Результат доезжает в /health отдельным полем — но только при расхождении.
let aspectDrift: AspectDrift | null = null;
void reportAspectDriftOnStartup(db).then((d) => {
  aspectDrift = d;
});

const app = createApp({ db, ai, aspectDrift: () => aspectDrift });

const server = Bun.serve({
  port: Number(process.env.PORT) || 3001,
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
