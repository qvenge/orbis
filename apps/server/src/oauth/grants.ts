// apps/server/src/oauth/grants.ts
// Жизненный цикл доступа внешнего агента (§9.3, D34): выдача кода, обмен на пару
// токенов, ротация refresh, лукап по хешу, отзыв. Всё под ролью orbis_app (политика
// server_manages_grants): аутентификация происходит ДО того, как владелец известен,
// поэтому withIdentity здесь неприменим — RLS скоупит эти запросы не по auth.uid(),
// а самим условием на хеш.
import { createHash } from 'node:crypto';
import { newId } from '@orbis/shared';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { agentGrants } from '../db/schema';
import { OAuthError } from './errors';
import {
  ACCESS_PREFIX,
  ACCESS_TTL_SECONDS,
  BEARER_PREFIXES,
  CODE_PREFIX,
  CODE_TTL_SECONDS,
  hashToken,
  mintToken,
  PAT_PREFIX,
  REFRESH_PREFIX,
  REFRESH_TTL_SECONDS,
} from './tokens';

export interface GrantIdentity {
  grantId: string;
  ownerId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GrantSummary {
  id: string;
  kind: string;
  label: string;
  /**
   * Агент забрал токены. false — согласие владельца есть, а обмена кода не было:
   * строка появляется в момент «Разрешить», и агент, который до обмена не дошёл
   * (упал, окно закрыли), оставляет её навсегда. Без этого признака такая строка
   * в списке «Агенты» неотличима от подключённого агента.
   */
  connected: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);

/**
 * Bearer → владелец. Живым считается неотозванный грант, у которого срок либо не
 * наступил, либо не задан вовсе (PAT бессрочен — отзывается строкой, не временем).
 * Отметка last_used_at питает экран настроек; она же делает видимым доступ, о котором
 * владелец забыл.
 */
export async function verifyBearer(db: Db, token: string): Promise<GrantIdentity | null> {
  // Набор принимаемых префиксов — один на всех (tokens.ts): его же спрашивает context.ts,
  // решая, агентский это Bearer или владельческий JWT. Перечисление вручную давало бы
  // две правды, расходящиеся при добавлении третьего вида токена.
  if (!BEARER_PREFIXES.some((prefix) => token.startsWith(prefix))) return null;
  const rows = await db
    .update(agentGrants)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(agentGrants.accessHash, hashToken(token)),
        isNull(agentGrants.revokedAt),
        or(isNull(agentGrants.accessExpiresAt), gt(agentGrants.accessExpiresAt, new Date())),
      ),
    )
    .returning({ id: agentGrants.id, ownerId: agentGrants.ownerId });
  const row = rows[0];
  return row ? { grantId: row.id, ownerId: row.ownerId } : null;
}

/** Согласие владельца: строка гранта с одноразовым кодом, токенов ещё нет. */
export async function createAuthorizationCode(
  db: Db,
  input: {
    ownerId: string;
    clientId: string;
    label: string;
    redirectUri: string;
    codeChallenge: string;
  },
): Promise<string> {
  const code = mintToken(CODE_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    clientId: input.clientId,
    kind: 'oauth',
    label: input.label,
    codeHash: hashToken(code),
    codeChallenge: input.codeChallenge,
    codeExpiresAt: secondsFromNow(CODE_TTL_SECONDS),
    redirectUri: input.redirectUri,
  });
  return code;
}

/**
 * Обмен кода на пару токенов. Одноразовость — не проверкой в коде, а самим UPDATE
 * с условием `code_used_at IS NULL`: двум одновременным обменам строку отдаст ровно
 * один. Предъявленный повторно код — признак перехвата (OAuth 2.1 §7.5), поэтому
 * второй обмен не просто отказывает, а отзывает уже выданный по этому коду доступ.
 */
export async function exchangeAuthorizationCode(
  db: Db,
  input: { code: string; codeVerifier: string; redirectUri: string; clientId: string },
): Promise<TokenPair> {
  const codeHash = hashToken(input.code);
  const existing = await db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.codeHash, codeHash))
    .limit(1);
  const grant = existing[0];
  if (!grant) throw new OAuthError('invalid_grant', 'код неизвестен');

  if (grant.codeUsedAt !== null) {
    await db.update(agentGrants).set({ revokedAt: new Date() }).where(eq(agentGrants.id, grant.id));
    throw new OAuthError('invalid_grant', 'код уже использован — выданный по нему доступ отозван');
  }
  if (grant.clientId !== input.clientId)
    throw new OAuthError('invalid_grant', 'код выдан другому клиенту');
  if (grant.redirectUri !== input.redirectUri)
    throw new OAuthError('invalid_grant', 'redirect_uri не совпадает');
  if (grant.codeExpiresAt !== null && grant.codeExpiresAt.getTime() <= Date.now()) {
    throw new OAuthError('invalid_grant', 'код просрочен');
  }
  const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
  if (challenge !== grant.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE не сошёлся');

  const pair = mintPair();
  const claimed = await db
    .update(agentGrants)
    .set({ codeUsedAt: new Date(), ...pairColumns(pair) })
    .where(
      and(
        eq(agentGrants.id, grant.id),
        isNull(agentGrants.codeUsedAt),
        // Строка гранта видна владельцу с момента выдачи кода, поэтому «Отозвать»
        // можно нажать в те же 60 секунд, пока код не обменян. Без этого условия
        // клиент получал бы пару токенов, не работающую ни на /mcp, ни на ротации,
        // и считал бы себя подключённым. Условие здесь, а не отдельной проверкой
        // выше, — тогда гонка «обмен против отзыва» разрешается атомарно.
        isNull(agentGrants.revokedAt),
      ),
    )
    .returning({ id: agentGrants.id });
  if (claimed.length === 0) {
    throw new OAuthError('invalid_grant', 'код уже использован либо доступ отозван');
  }
  return pair;
}

/**
 * Ротация refresh (OAuth 2.1 требует её для публичных клиентов). Предъявленный
 * повторно старый refresh — тот же признак перехвата, что и повторный код: грант
 * отзывается целиком. Чтобы такой реплей вообще был различим, ротация оставляет
 * след — прежний хеш уезжает в prev_refresh_hash; иначе затёртый токен не с чем
 * связать и погасить цепочку нечем.
 */
export async function rotateRefresh(
  db: Db,
  input: { refreshToken: string; clientId: string },
): Promise<TokenPair> {
  const presented = hashToken(input.refreshToken);
  const pair = mintPair();
  const rows = await db
    .update(agentGrants)
    .set({
      ...pairColumns(pair),
      // Правая часть SET читает значение ДО присваивания (семантика UPDATE в Postgres),
      // поэтому след переносится тем же запросом — без отдельного SELECT и без гонки.
      prevRefreshHash: sql`${agentGrants.refreshHash}`,
    })
    .where(
      and(
        eq(agentGrants.refreshHash, presented),
        eq(agentGrants.clientId, input.clientId),
        isNull(agentGrants.revokedAt),
        gt(agentGrants.refreshExpiresAt, new Date()),
      ),
    )
    .returning({ id: agentGrants.id });
  if (rows.length === 0) {
    // Среди живых не нашли. Гасим цепочку только если предъявленный токен этому гранту
    // всё-таки принадлежит: совпал либо с текущим хешем (грант отозван или refresh
    // просрочен), либо с предыдущим — это и есть реплей уже ротированного токена,
    // ради которого заведён prev_refresh_hash (OAuth 2.1 §7.5). Условие на client_id
    // обязательно: без него клиент со сбитым конфигом отзывал бы владельцу доступ —
    // чужая ошибка ценой чужого доступа. Не совпало ни с чем — просто отказ, без гашения.
    await db
      .update(agentGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          or(eq(agentGrants.refreshHash, presented), eq(agentGrants.prevRefreshHash, presented)),
          eq(agentGrants.clientId, input.clientId),
        ),
      );
    throw new OAuthError('invalid_grant', 'refresh-токен недействителен');
  }
  return pair;
}

/** Headless-доступ (Р4): та же таблица, без клиента и без срока. */
export async function issuePatGrant(
  db: Db,
  input: { ownerId: string; label: string },
): Promise<string> {
  const token = mintToken(PAT_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    kind: 'pat',
    label: input.label,
    accessHash: hashToken(token),
  });
  return token;
}

/**
 * Для экрана настроек: ни одного хеша наружу. `connected` считается ИЗ хешей прямо в
 * запросе — сами значения не покидают базу, наружу едет один булев признак. Условие
 * «нет ни access, ни refresh»: у PAT refresh_hash пуст всегда, и проверка на один
 * refresh выдала бы каждый headless-токен за брошенную попытку авторизации.
 */
export async function listGrants(db: Db, ownerId: string): Promise<GrantSummary[]> {
  return db
    .select({
      id: agentGrants.id,
      kind: agentGrants.kind,
      label: agentGrants.label,
      connected: sql<boolean>`(${agentGrants.accessHash} IS NOT NULL OR ${agentGrants.refreshHash} IS NOT NULL)`,
      createdAt: agentGrants.createdAt,
      lastUsedAt: agentGrants.lastUsedAt,
      revokedAt: agentGrants.revokedAt,
    })
    .from(agentGrants)
    .where(eq(agentGrants.ownerId, ownerId))
    .orderBy(sql`${agentGrants.createdAt} DESC`);
}

/**
 * Отзыв: условие на owner_id — вторая линия к RLS, а не замена ей.
 *
 * COALESCE, а не голое присваивание: отзыв идемпотентен. Повторное нажатие «Отозвать»
 * (или гонка двух вкладок) иначе двигало бы revoked_at на «сейчас» — на экране настроек
 * дата отзыва прыгала бы, и владелец терял бы единственную улику о том, когда доступ
 * на самом деле погас. Условие `IS NULL` в WHERE вместо этого дало бы тот же неподвижный
 * штамп, но false в ответе — и «уже отозван» стало бы неотличимо от «грант не ваш»,
 * то есть экран не смог бы честно сказать об отказе.
 *
 * `now()` — часы базы, потому что COALESCE считается ею же, прямо в UPDATE. Единой шкалы
 * у revoked_at это не даёт: ту же колонку в других путях пишет `new Date()` сервера
 * (exchangeAuthorizationCode при повторном коде, rotateRefresh при реплее). Расхождение
 * часов там безвредно — по revoked_at не принимается ни одного решения, живость гранта
 * везде проверяется `IS NULL`, а не сравнением времён; значение только показывается
 * владельцу.
 */
export async function revokeGrant(
  db: Db,
  input: { ownerId: string; grantId: string },
): Promise<boolean> {
  const rows = await db
    .update(agentGrants)
    .set({ revokedAt: sql`COALESCE(${agentGrants.revokedAt}, now())` })
    .where(and(eq(agentGrants.id, input.grantId), eq(agentGrants.ownerId, input.ownerId)))
    .returning({ id: agentGrants.id });
  return rows.length > 0;
}

function mintPair(): TokenPair {
  return {
    accessToken: mintToken(ACCESS_PREFIX),
    refreshToken: mintToken(REFRESH_PREFIX),
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

function pairColumns(pair: TokenPair) {
  return {
    accessHash: hashToken(pair.accessToken),
    accessExpiresAt: secondsFromNow(ACCESS_TTL_SECONDS),
    refreshHash: hashToken(pair.refreshToken),
    refreshExpiresAt: secondsFromNow(REFRESH_TTL_SECONDS),
  };
}
