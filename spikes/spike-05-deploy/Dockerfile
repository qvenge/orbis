FROM oven/bun:1.2 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/index.ts"]
