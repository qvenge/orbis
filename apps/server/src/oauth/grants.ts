// apps/server/src/oauth/grants.ts
// Жизненный цикл доступа внешнего агента (§9.3, D34): выдача кода, обмен на пару
// токенов, ротация refresh, лукап по хешу, отзыв. Всё под ролью orbis_app (политика
// server_manages_grants): аутентификация происходит ДО того, как владелец известен,
// поэтому withIdentity здесь неприменим — RLS скоупит эти запросы не по auth.uid(),
// а самим условием на хеш.
import { createHash } from 'node:crypto';
import { type GrantScope, newId } from '@orbis/shared';
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
  /** Область гранта (С2): 'full' — весь граф владельца, 'worker' — сужение до тикета. */
  scope: GrantScope;
  /** Подпись доступа, которую владелец видит на экране «Агенты». */
  label: string;
}

/**
 * Грант в контексте вызова — то же самое, что GrantIdentity, минус владелец: на всех
 * путях ниже транспорта владелец уже лежит отдельным полем (actorUserId контекста тула,
 * actorUserId контекста tRPC), и второй его экземпляр рядом стал бы вторым источником
 * правды — расходящимся ровно в тот момент, когда кто-нибудь соберёт GrantRef руками.
 */
export interface GrantRef {
  id: string;
  scope: GrantScope;
  label: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /**
   * Область гранта, из которого выдана пара. Едет в ответе /oauth/token (`scope`, RFC 6749
   * §5.1): клиент узнаёт о сужении единственным способом — из ответа обмена. Читается из
   * той же строки, что и токены, и тем же запросом — иначе между записью области и её
   * чтением помещался бы отзыв или повторная выдача.
   */
  scope: GrantScope;
}

export interface GrantSummary {
  id: string;
  kind: string;
  label: string;
  /** Область (С2): экран «Агенты» подписывает ею строку — полный доступ или исполнитель. */
  scope: GrantScope;
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
 * Штамп отзыва — ОДИН на все три пути (ручной отзыв, повторный код, реплей refresh).
 *
 * COALESCE, а не голое присваивание: отзыв обязан быть идемпотентным по ДАТЕ. Уже
 * проставленный `revoked_at` — единственная улика владельца о том, когда доступ на самом
 * деле погас, и она показывается ему на экране «Агенты». Голое `new Date()` двигало бы её
 * на «сейчас» при каждом повторе, а повторы здесь бывают не только от владельца: пути
 * гашения по признаку перехвата (OAuth 2.1 §7.5) запускает ПРЕДЪЯВИТЕЛЬ спетого кода или
 * ротированного refresh — то есть ровно тот, от кого улику и прячут. Повторяя запрос, он
 * стирал бы время настоящего отзыва.
 *
 * Условие `IS NULL` в WHERE дало бы тот же неподвижный штамп, но false в ответе
 * revokeGrant — и «уже отозван» стало бы неотличимо от «грант не ваш», то есть экран не
 * смог бы честно сказать об отказе.
 *
 * `now()` — часы базы, потому что COALESCE считается ею же, прямо в UPDATE. Раз выражение
 * одно на все пути, шкала у revoked_at теперь тоже одна: разъехаться часам сервера и базы
 * больше негде. Решений по этому полю всё равно не принимается — живость гранта везде
 * проверяется `IS NULL`, а не сравнением времён.
 */
const revokedAtStamp = sql`COALESCE(${agentGrants.revokedAt}, now())`;

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
    .returning({
      id: agentGrants.id,
      ownerId: agentGrants.ownerId,
      scope: agentGrants.scope,
      label: agentGrants.label,
    });
  const row = rows[0];
  if (!row) return null;
  // Каст, а не разбор: колонка `scope` — text с DEFAULT 'full', перечисление живёт одним
  // списком в @orbis/shared (GRANT_SCOPES), а пишут в неё выдача кода и issuePatGrant —
  // значениями этого же списка. Откат на 'full' при незнакомом значении был бы здесь
  // РАСШИРЕНИЕМ доступа (самый широкий скоуп по умолчанию), поэтому лукап отдаёт значение
  // как есть, а решение о нём принимает гейт скоупа — и обязан быть fail-closed
  // «не 'full' → не полный доступ», а не сравнением с одним лишь 'worker'.
  return {
    grantId: row.id,
    ownerId: row.ownerId,
    scope: row.scope as GrantScope,
    label: row.label,
  };
}

/**
 * Согласие владельца: строка гранта с одноразовым кодом, токенов ещё нет.
 *
 * `scope` — ОБЯЗАТЕЛЬНОЕ поле, а не необязательное с умолчанием, хотя экран согласия и
 * подставляет 'full' сам (zod-схема процедуры). Умолчание здесь молча выдавало бы САМЫЙ
 * ШИРОКИЙ доступ всякому будущему вызову, забывшему про область, — то есть ошибка стоила
 * бы владельцу полного графа. Обязательное поле превращает эту ошибку в отказ компилятора.
 */
export async function createAuthorizationCode(
  db: Db,
  input: {
    ownerId: string;
    clientId: string;
    label: string;
    redirectUri: string;
    codeChallenge: string;
    scope: GrantScope;
  },
): Promise<string> {
  const code = mintToken(CODE_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    clientId: input.clientId,
    kind: 'oauth',
    label: input.label,
    scope: input.scope,
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
    await db
      .update(agentGrants)
      .set({ revokedAt: revokedAtStamp })
      .where(eq(agentGrants.id, grant.id));
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
    // Область читается ТЕМ ЖЕ запросом, что забирает код: отдельный SELECT после UPDATE
    // отдал бы её из строки, которую в этот момент уже могли отозвать или переписать.
    .returning({ id: agentGrants.id, scope: agentGrants.scope });
  const row = claimed[0];
  if (row === undefined) {
    throw new OAuthError('invalid_grant', 'код уже использован либо доступ отозван');
  }
  return { ...pair, scope: row.scope as GrantScope };
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
    .returning({ id: agentGrants.id, scope: agentGrants.scope });
  const rotated = rows[0];
  if (rotated === undefined) {
    // Среди живых не нашли. Гасим цепочку только если предъявленный токен этому гранту
    // всё-таки принадлежит: совпал либо с текущим хешем (грант отозван или refresh
    // просрочен), либо с предыдущим — это и есть реплей уже ротированного токена,
    // ради которого заведён prev_refresh_hash (OAuth 2.1 §7.5). Условие на client_id
    // обязательно: без него клиент со сбитым конфигом отзывал бы владельцу доступ —
    // чужая ошибка ценой чужого доступа. Не совпало ни с чем — просто отказ, без гашения.
    await db
      .update(agentGrants)
      .set({ revokedAt: revokedAtStamp })
      .where(
        and(
          or(eq(agentGrants.refreshHash, presented), eq(agentGrants.prevRefreshHash, presented)),
          eq(agentGrants.clientId, input.clientId),
        ),
      );
    throw new OAuthError('invalid_grant', 'refresh-токен недействителен');
  }
  // Ротация область не трогает: обновление токена — не новое согласие, и расширить доступ
  // им было бы обходом экрана согласия.
  return { ...pair, scope: rotated.scope as GrantScope };
}

/**
 * Headless-доступ (Р4): та же таблица, без клиента и без срока.
 *
 * Область необязательна — в отличие от кода согласия: PAT выдаётся скриптом из командной
 * строки, где `--scope` не указан у всех уже описанных в документации способов подключения,
 * и обязательное поле сломало бы их. Умолчание 'full' здесь — сохранение прежнего
 * поведения, а не решение о доступе: выбор делает тот, кто запускает скрипт.
 */
export async function issuePatGrant(
  db: Db,
  input: { ownerId: string; label: string; scope?: GrantScope },
): Promise<string> {
  const token = mintToken(PAT_PREFIX);
  await db.insert(agentGrants).values({
    id: newId(),
    ownerId: input.ownerId,
    kind: 'pat',
    label: input.label,
    scope: input.scope ?? 'full',
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
      // Каст типа, а не разбор — по той же причине, что в verifyBearer: перечисление
      // живёт одним списком в @orbis/shared, а колонка — text. Приём тот же, что у
      // `connected` строкой ниже (sql<T> в этом же select).
      scope: sql<GrantScope>`${agentGrants.scope}`,
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
 * Отзыв: условие на owner_id — ЕДИНСТВЕННОЕ, что не даёт владельцу отозвать чужой грант.
 *
 * Формулировка «вторая линия к RLS» стояла здесь и была неверной. Процедура зовётся на
 * `ctx.db`, то есть под ролью `orbis_app`, а её политика — `USING (true) WITH CHECK (true)`
 * (0005_oauth_rls.sql): под этой ролью RLS не скоупит ничего и подстраховать предикат
 * не может. Политика владельца (`owner_id = auth.uid()`) действует для роли
 * `authenticated`, под которой этот путь не исполняется вовсе — по построению, а не по
 * недосмотру: те же процедуры ищут грант по хешу ДО того, как владелец известен, и
 * withIdentity к ним неприменим. Убрать предикат «как дубль RLS» — значит открыть отзыв
 * любого гранта по одному чужому id; docblock не должен приглашать к этому.
 *
 * Штамп даты — общий revokedAtStamp (см. его докблок): отзыв идемпотентен по дате, и
 * повторное нажатие «Отозвать» или гонка двух вкладок её не двигают.
 */
export async function revokeGrant(
  db: Db,
  input: { ownerId: string; grantId: string },
): Promise<boolean> {
  const rows = await db
    .update(agentGrants)
    .set({ revokedAt: revokedAtStamp })
    .where(and(eq(agentGrants.id, input.grantId), eq(agentGrants.ownerId, input.ownerId)))
    .returning({ id: agentGrants.id });
  return rows.length > 0;
}

/**
 * Токены пары БЕЗ области: минт ничего не знает о гранте, а область принадлежит строке,
 * из которой пара выдаётся, — и приезжает из её же UPDATE ... RETURNING.
 */
type MintedTokens = Omit<TokenPair, 'scope'>;

function mintPair(): MintedTokens {
  return {
    accessToken: mintToken(ACCESS_PREFIX),
    refreshToken: mintToken(REFRESH_PREFIX),
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

function pairColumns(pair: MintedTokens) {
  return {
    accessHash: hashToken(pair.accessToken),
    accessExpiresAt: secondsFromNow(ACCESS_TTL_SECONDS),
    refreshHash: hashToken(pair.refreshToken),
    refreshExpiresAt: secondsFromNow(REFRESH_TTL_SECONDS),
  };
}
