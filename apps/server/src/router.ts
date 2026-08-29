// apps/server/src/router.ts
// Сборка appRouter (§9.1): entity/relation/chat/ai — Task 12; user — Task 13.
//
// Ручки `aspect.list` здесь БОЛЬШЕ НЕТ (гейт-ревью Задачи 14): её последний читатель,
// экран настроек, переехал на `registry.effective` ещё Задачей 13a, и с тех пор она была
// мёртвой — а на её мнимой живости держалось объяснение, почему колонка `schema` не видит
// дельт. Реестр аспектов отдаёт `registry.effective`: там три словаря, версия снимка и
// эффективные определения (система ⊕ строки владельца ⊕ дельты).
import { agentRunRouter } from './routers/agent-run';
import { aiRouter } from './routers/ai';
import { budgetRouter } from './routers/budget';
import { chatRouter } from './routers/chat';
import { entityRouter } from './routers/entity';
// `import` — зарезервированное слово JS: ключ роутера так назвать можно, переменную нет
import { importRouter } from './routers/import';
import { oauthRouter } from './routers/oauth';
import { registryRouter } from './routers/registry';
import { relationRouter } from './routers/relation';
import { routineRouter } from './routers/routine';
import { userRouter } from './routers/user';
import { versionRouter } from './routers/version';
import { protectedProcedure, publicProcedure, router } from './trpc';

export const appRouter = router({
  ping: publicProcedure.query(() => ({ ok: true })),
  whoami: protectedProcedure.query(({ ctx }) => ({ actorUserId: ctx.actorUserId })),
  entity: entityRouter,
  relation: relationRouter,
  chat: chatRouter,
  ai: aiRouter,
  user: userRouter,
  // Эффективный реестр владельца одним ответом и с версией снимка (§А9-2): по нему web
  // строит подписи, формы и каталог полей — вместо рукописных словарей в коде.
  registry: registryRouter,
  budget: budgetRouter,
  import: importRouter,
  // Закреплённые версии тела (С11): страховка владельца перед работой агента
  version: versionRouter,
  // Владельческая половина OAuth (§9.3): экран согласия и управление доступами
  oauth: oauthRouter,
  // Владельческая половина круга исполнителя (С3, С6, С12): ответ на чекпойнт,
  // подметание с экранов, откат прогона
  agentRun: agentRunRouter,
  // Владельческая половина внутреннего исполнителя (V1.3, V1.6, V1.9, V1.14): «прогнать
  // сейчас», ответ на вопрос прогона, предложение и решение по нему, обзор рутины
  routine: routineRouter,
});

export type AppRouter = typeof appRouter;
