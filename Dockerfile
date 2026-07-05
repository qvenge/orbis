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

# 3) Сборка web-статики → apps/web/dist (дефолт WEB_DIST_DIR разрешается от WORKDIR /app).
#    VITE_*-переменные клиента имеют localhost-дефолты; реальные значения — build-args на Render.
RUN cd apps/web && bun run build

ENV NODE_ENV=production
EXPOSE 3001

# cwd=/app → WEB_DIST_DIR по умолчанию 'apps/web/dist' резолвится в /app/apps/web/dist.
CMD ["bun", "apps/server/src/index.ts"]
