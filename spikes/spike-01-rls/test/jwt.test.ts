// JWT-верификация в Bun без сетевого auth.getUser: jose (JWKS → fallback HS256).
// Сквозной путь: реальный access_token → verify → sub → withIdentity → RLS.
// Service-role используется ТОЛЬКО здесь, в сетапе (создание тестового пользователя).
import { describe, test, expect, afterAll } from 'bun:test';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { makeDb } from '../src/db';
import { withIdentity } from '../src/with-identity';
import { spikeItems } from '../src/schema';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = process.env.SUPABASE_ANON_KEY!;

const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
let createdUserId: string | null = null;

afterAll(async () => {
  if (createdUserId) await adminClient.auth.admin.deleteUser(createdUserId);
});

async function verifyToken(token: string): Promise<{ payload: JWTPayload; path: 'jwks' | 'hs256' }> {
  try {
    const jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, { audience: 'authenticated' });
    return { payload, path: 'jwks' };
  } catch {
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!);
    const { payload } = await jwtVerify(token, secret, { audience: 'authenticated' });
    return { payload, path: 'hs256' };
  }
}

describe('JWT в Bun (jose)', () => {
  test('access_token верифицируется локально; sub → withIdentity → RLS', async () => {
    const email = `spike-${crypto.randomUUID()}@example.com`;
    const password = crypto.randomUUID();

    const created = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error).toBeNull();
    createdUserId = created.data.user!.id;

    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const signIn = await anon.auth.signInWithPassword({ email, password });
    expect(signIn.error).toBeNull();
    const token = signIn.data.session!.access_token;

    const { payload, path } = await verifyToken(token);
    console.log(`[jwt] верификация прошла путём: ${path}`);
    expect(payload.sub).toBe(createdUserId);

    const { db, client } = makeDb({ max: 1 });
    try {
      const sub = payload.sub!;
      await withIdentity(db, sub, async (tx) => {
        await tx.insert(spikeItems).values({ ownerId: sub, title: 'from-jwt' });
      });
      const rows = await withIdentity(db, sub, (tx) => tx.select().from(spikeItems));
      expect(rows.some((r) => r.title === 'from-jwt' && r.ownerId === sub)).toBe(true);
    } finally {
      await client.end();
    }
  });
});
