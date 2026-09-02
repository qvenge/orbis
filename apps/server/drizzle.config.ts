import { defineConfig } from 'drizzle-kit';

// drizzle-kit сам не читает .env — запускать через package-скрипты db:generate/db:migrate
// (bun run подхватывает apps/server/.env и передаёт окружение дочернему процессу).
//
// DSN — АДМИНСКИЙ, и берётся он ЗДЕСЬ, а не подстановкой в строке скрипта. Прежняя форма
// (`DATABASE_URL=$DATABASE_URL_ADMIN bun run db:migrate` в корневом `db:prepare`) не
// работала локально: `$DATABASE_URL_ADMIN` раскрывает ШЕЛЛ — до того, как bun прочитает
// `.env`, — и если переменной нет в окружении, в `DATABASE_URL` уезжала ПУСТАЯ СТРОКА,
// перекрывая автозагрузку. В CI то же место работало только потому, что переменная задана
// на уровне job'а. `process.env` читается уже ПОСЛЕ автозагрузки `.env`, поэтому обе среды
// ведут себя одинаково (долг 2 ветки).
//
// Фолбэк на `DATABASE_URL` оставлен: у миграций и без того один вызывающий, а среда, где
// админский DSN и есть единственный (docker-образ CI без роли приложения), не обязана
// заводить второе имя для того же значения.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: (process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL) as string },
});
