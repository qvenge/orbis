import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export const forbiddenWriter = (db: Db) => db.execute(sql`update entities set archived = true`);
