# SPIKE-05: деплой-связность

Hello-world Bun API (Hono) с проверками связности к hosted Supabase. Цель — выбрать хостинг по матрице DEPLOY-04 (регион, session-pool/IPv4, персистентный контейнер, логи, секреты, бэкапы, стоимость) и доказать: приложение с хостинга дотягивается до БД и RLS-механика SPIKE-01 работает в проде.

Регион: **Франкфурт (eu-central-1)** — решение владельца (2026-07-03), без замера.

## Endpoints

- `GET /health` — живость процесса (без БД)
- `GET /db-check` — `SELECT 1` + латентность API↔DB (co-location → единицы мс)
- `GET /spike-check` (заголовок `x-spike-token`) — мини-сабсет RLS-матрицы против hosted: uid заполняется, cross-user скрыт, deny-by-default, чистый checkout; JSON pass/fail

## Локальная проверка

```bash
bun install
cp .env.example .env   # hosted-DSN роли orbis_app через Supavisor
bun run start          # :3000
curl localhost:3000/health
docker build -t spike05 . && docker run --env-file .env -p 3000:3000 spike05
```

## Матрица провайдеров (заполняется при исполнении C4)

| Критерий | Render | Koyeb | Cloud Run | Oracle Free VPS | Fly.io | Railway |
|---|---|---|---|---|---|---|
| Free tier сегодня | | | | | | |
| Сон / cold start | | | | | | |
| Регион (Франкфурт±) | | | | | | |
| OCI/Dockerfile | | | | | | |
| Секреты | | | | | | |
| Логи | | | | | | |
| Связность к Supavisor (IPv4 egress) | | | | | | |
| Путь апгрейда / цена | | | | | | |

## Бэкап

`scripts/backup.sh` — pg_dump через session-пулер (прямое подключение к Supabase IPv6-only). Runbook: гонять вручную до автоматизации; restore — `psql "$ADMIN_DSN" -f <dump>`.
