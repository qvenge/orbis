// apps/server/src/routers/oauth.ts
// Владельческая половина OAuth-флоу (§9.3): экран согласия в SPA ходит сюда под JWT.
// Всё — ownerOnlyProcedure: выдача доступа агенту и управление им — операции владельца
// аккаунта, и агент, уже имеющий грант, не должен выписывать себе новые.
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { oauthClients } from '../db/schema';
import { createAuthorizationCode, listGrants, revokeGrant } from '../oauth/grants';
import { configuredCanonicalResource, isOurResource } from '../oauth/metadata';
import { ownerOnlyProcedure, router } from '../trpc';
import { toWireAgentGrant, type WireAgentGrant } from '../wire';

const REQUEST_SHAPE = {
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  resource: z.string().optional(),
};

/**
 * Потолок подписи клиента на экране согласия. `client_name` полностью подконтролен тому,
 * кто регистрируется, и ограничен только потолком тела /oauth/register в 16 КиБ: без
 * обрезки на экран уехала бы строка на тысячи символов. Резать надо здесь, на сервере:
 * вёрстка — не защита, и то же имя идёт меткой гранта в список «Агенты».
 *
 * 64 символа выбраны от законной подписи: «Claude Code» — 11 символов, самые длинные
 * реальные имена клиентов — десятки. Запас есть, а строка остаётся строкой.
 */
const CLIENT_NAME_MAX_CHARS = 64;

/**
 * Подпись клиента для показа владельцу. Пробельные последовательности схлопываются ДО
 * обрезки, и это не косметика: `Claude<500 пробелов>Code` иначе обрезался бы в «Claude…»,
 * а `A<500 пробелов>B` — в почти пустую подпись, то есть набивка пробелами делала бы
 * обрезку бесполезной. Пустым результат стать не может: /oauth/register не принимает
 * пустое и пробельное имя, подставляя «внешний агент».
 */
function displayName(raw: string): string {
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  return collapsed.length <= CLIENT_NAME_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, CLIENT_NAME_MAX_CHARS - 1)}…`;
}

/**
 * Общая проверка запроса агента: клиент известен, redirect_uri в точности тот, что
 * он зарегистрировал, ресурс — наш. Она нужна ДО показа кнопки: владелец не должен
 * жать «Разрешить», чтобы узнать, что запрос негодный. И она же обязана стоять на самой
 * выдаче кода: процедуру зовут по HTTP, экран согласия её не охраняет.
 *
 * Канонический ресурс спрашивается у metadata.ts (`configuredCanonicalResource`) — там же,
 * где его берут метаданные и /oauth/token: своё чтение ORBIS_PUBLIC_URL завело бы вторую
 * правду об одном и том же ресурсе. null оттуда означает «публичная база не настроена» —
 * сверять не с чем, и на локальном стенде проверка пропускается (в production такой ветки
 * нет: без переменной процесс не поднимается).
 */
async function requireValidRequest(
  db: Db,
  input: { clientId: string; redirectUri: string; resource?: string },
): Promise<{ clientName: string }> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, input.clientId))
    .limit(1);
  const client = rows[0];
  if (!client) throw new TRPCError({ code: 'BAD_REQUEST', message: 'клиент не зарегистрирован' });
  // Сверка ТОЧНОЙ строкой, как и при обмене кода (grants.ts): нормализация развела бы
  // зарегистрированный адрес с предъявленным.
  if (!client.redirectUris.includes(input.redirectUri)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'redirect_uri не зарегистрирован этим клиентом',
    });
  }
  const canonical = configuredCanonicalResource();
  if (input.resource && canonical !== null && !isOurResource(input.resource, canonical)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'запрошен доступ к другому ресурсу' });
  }
  return { clientName: displayName(client.clientName) };
}

export const oauthRouter = router({
  describeRequest: ownerOnlyProcedure
    .input(z.object(REQUEST_SHAPE))
    .query(({ ctx, input }) => requireValidRequest(ctx.db, input)),

  consent: ownerOnlyProcedure
    .input(
      z.object({
        ...REQUEST_SHAPE,
        // Верхняя граница — от длины code_verifier (RFC 7636 §4.1): S256-challenge всегда
        // ровно 43 символа base64url, но узкой проверкой мы отказали бы клиенту раньше,
        // чем PKCE не сойдётся на обмене, и без внятной причины.
        codeChallenge: z.string().min(43).max(128),
        // plain отвергаем схемой: значение вне литерала не пройдёт валидацию.
        // Метаданные объявляют `code_challenge_methods_supported: ['S256']` — здесь та же
        // правда, и расходиться им нельзя.
        codeChallengeMethod: z.literal('S256'),
        state: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { clientName } = await requireValidRequest(ctx.db, input);
      const code = await createAuthorizationCode(ctx.db, {
        ownerId: ctx.actorUserId,
        clientId: input.clientId,
        // Метка в списке «Агенты» — та же подпись, что владелец видел на экране согласия
        label: clientName,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
      });
      // Адрес возврата строится ТОЛЬКО разбором и `.href`, никакой склейки `${uri}?code=…`.
      // Две причины, обе проверены пробой: (а) redirect_uri с УЖЕ имеющимся query законен
      // (RFC 6749 §3.1.2, реальный пример — `…/auth_callback?tenant=acme`), и склейка
      // приклеила бы код значением к чужому параметру — клиент кода не увидит, вход молча
      // не состоится; (б) не-ASCII в адресе (`…/cb?next=привет`) даёт непостроимый
      // заголовок Location и 500, а `.href` процентно кодирует и снимает это.
      const url = new URL(input.redirectUri);
      url.searchParams.set('code', code);
      // state необязателен (RFC 6749 §4.1.1): не пришёл — класть нечего. Пустой `state=`
      // клиент, сверяющий его строкой, счёл бы ответом на чужой запрос.
      if (input.state !== undefined) url.searchParams.set('state', input.state);
      return { redirectTo: url.href };
    }),

  // Наружу — wire-форма (таймстампы строками ISO), а не доменный GrantSummary: у клиента
  // нет transformer'а, Date всё равно доедет строкой, и отдача Date обещала бы экрану
  // «Агенты» тип, которого в рантайме нет.
  listGrants: ownerOnlyProcedure.query(
    async ({ ctx }): Promise<WireAgentGrant[]> =>
      (await listGrants(ctx.db, ctx.actorUserId)).map(toWireAgentGrant),
  ),

  revokeGrant: ownerOnlyProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => ({
      // Скоуп по владельцу — внутри revokeGrant: идентификатор приезжает снаружи, и без
      // него один аккаунт гасил бы доступы другого.
      revoked: await revokeGrant(ctx.db, { ownerId: ctx.actorUserId, grantId: input.grantId }),
    })),
});
