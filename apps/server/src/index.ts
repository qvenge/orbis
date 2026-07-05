import { makeAiDeps } from './ai/send-message';
import { createApp } from './app';
import { makeDb } from './db/client';

// Один пул соединений на процесс; в request-контекст db попадает ссылкой (Task 12)
const { db } = makeDb();

// AI-deps — один инстанс на процесс (§7.7: провайдер один, имя модели — конфиг);
// fail-fast: невалидный ORBIS_LLM_PROVIDER/отсутствующий ключ роняют старт, не запрос
const ai = makeAiDeps();

const app = createApp({ db, ai });

export default {
  port: Number(process.env.PORT) || 3001,
  fetch: app.fetch,
};
