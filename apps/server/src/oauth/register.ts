// apps/server/src/oauth/register.ts
// Динамическая регистрация клиентов (RFC 7591). Эндпоинт публичный по построению —
// именно он избавляет владельца от ручного client_id. Регистрация сама по себе не даёт
// ничего: без согласия владельца на /oauth/authorize клиент не получит ни кода, ни
// токена. Единственный реальный риск — засорение таблицы, поэтому стоит суточный потолок.
import { randomBytes } from 'node:crypto';
import { count, gte } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from '../db/client';
import { oauthClients } from '../db/schema';

/** Потолок регистраций в сутки на весь сервис: у одного владельца агентов единицы. */
export const MAX_REGISTRATIONS_PER_DAY = 50;

/** Подпись клиента, когда он не назвался: пустая строка на экране согласия хуже. */
const DEFAULT_CLIENT_NAME = 'внешний агент';

/**
 * Куда разрешено возвращать код. Локальная петля — это Claude Code и родня
 * (они слушают http://localhost:PORT/callback), https — размещённые клиенты.
 * Всё остальное — способ увести код на чужой хост.
 *
 * Сверка идёт по РАЗОБРАННОМУ hostname, а не по подстроке: `http://localhost.evil.com/cb`
 * и `http://evil.com/localhost` содержат «localhost», но петлёй не являются.
 */
function isAllowedRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  );
}

export function makeRegisterHandler(deps: { db: Db }) {
  return async (c: Context): Promise<Response> => {
    // Тело формирует неаутентифицированный клиент, то есть кто угодно: битый JSON обязан
    // давать отказ по спеке, а не 500 с трейсом. Не-объект (`null`, `[]`) проваливается
    // в ту же ветку — у него нет ни одного нужного поля.
    const body = (await c.req.json().catch(() => null)) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    } | null;
    const uris = Array.isArray(body?.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    const name =
      typeof body?.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim()
        : DEFAULT_CLIENT_NAME;

    if (uris.length === 0) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'redirect_uris обязателен' },
        400,
      );
    }
    // Один негодный адрес в списке — отказ целиком: иначе клиент считал бы себя
    // зарегистрированным с адресом, которого мы у него не приняли.
    if (!uris.every(isAllowedRedirect)) {
      return c.json(
        {
          error: 'invalid_redirect_uri',
          error_description: 'разрешены только https и локальная петля',
        },
        400,
      );
    }

    // Потолок считается по ВРЕМЕНИ СОЗДАНИЯ строк, а не по их общему числу: израсходованная
    // сутки назад квота обязана возвращаться сама, без ручной чистки таблицы. Считается он
    // на весь сервис: у одного владельца агентов единицы, а различать клиентов за прокси
    // Render нечем — заголовку с адресом снаружи веры нет.
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const rows = await deps.db
      .select({ value: count() })
      .from(oauthClients)
      .where(gte(oauthClients.createdAt, since));
    // Явная развилка вместо деструктуризации: при noUncheckedIndexedAccess `rows[0]` — это
    // `T | undefined`, а пустой ответ у агрегата и так означает ноль строк.
    const recent = rows[0]?.value ?? 0;
    if (recent >= MAX_REGISTRATIONS_PER_DAY) {
      return c.json(
        { error: 'invalid_client_metadata', error_description: 'слишком много регистраций' },
        429,
      );
    }

    const clientId = randomBytes(16).toString('hex');
    await deps.db.insert(oauthClients).values({ clientId, clientName: name, redirectUris: uris });
    return c.json(
      {
        client_id: clientId,
        client_name: name,
        redirect_uris: uris,
        // Публичный клиент: секрета нет, защита обмена — на PKCE
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    );
  };
}
