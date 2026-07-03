import { defineConfig } from 'drizzle-kit';

// drizzle-kit сам не читает .env — запускать через package-скрипты db:generate/db:migrate
// (bun run подхватывает apps/server/.env и передаёт окружение дочернему процессу).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL as string },
});
