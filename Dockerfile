# check=skip=SecretsUsedInArgOrEnv
# ^ Осознанный пропуск: единственные ARG/ENV ниже — VITE_SUPABASE_URL/ANON_KEY, публичные
#   по дизайну (Supabase publishable-ключ и так уезжает в браузерный бандл; граница доступа —
#   RLS, не секретность ключа). Настоящие секреты (DATABASE_URL, ANTHROPIC_API_KEY, ORBIS_PAT_*)
#   в образ НЕ попадают — это рантайм-env на Render.
#
# Прод-образ монорепо Orbis (Bun workspaces): собирает web-статику и запускает API,
# который раздаёт её same-origin (Task 7). Один stage — сервер исполняет TS напрямую
# через Bun, поэтому финальному образу нужны и node_modules, и исходники, и apps/web/dist.
# Пин Bun 1.2.7 — как CI (.github/workflows/ci.yml); bun 1.3.x бракует integrity-lock 1.2.x.
FROM oven/bun:1.2.7 AS base
WORKDIR /app

# 1) Манифесты воркспейса отдельным слоем — кэш bun install переживает правки исходников.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile

# 2) Исходники всего воркспейса (локальные dist/node_modules/.env отсечены .dockerignore).
COPY . .

# 3) Build-args web-клиента. Vite бакает import.meta.env В МОМЕНТ СБОРКИ, поэтому реальные
#    прод-значения должны прийти сюда как build-args (Render автоматически отдаёт env-переменные
#    сервиса как --build-arg). Дефолты = localhost-фолбэку из apps/web/src/auth/supabase.ts:
#    без build-arg (локальная сборка / run-smoke) образ собирается с localhost и работает как
#    прежде; на Render VITE_SUPABASE_URL/ANON_KEY перебиваются реальными. VITE_API_URL пуст →
#    относительный /trpc (same-origin, Вариант A; см. trpc.ts).
ARG VITE_SUPABASE_URL=http://localhost:54321
ARG VITE_SUPABASE_ANON_KEY=anon
ARG VITE_API_URL=""
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_URL=$VITE_API_URL

# 4) Сборка web-статики → apps/web/dist (дефолт WEB_DIST_DIR разрешается от WORKDIR /app).
RUN cd apps/web && bun run build

ENV NODE_ENV=production
EXPOSE 3001

# cwd=/app → WEB_DIST_DIR по умолчанию 'apps/web/dist' резолвится в /app/apps/web/dist.
CMD ["bun", "apps/server/src/index.ts"]
