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

## Матрица провайдеров (факты проверены по официальным страницам 02–03.07.2026)

| Критерий | Render | Koyeb | Cloud Run | Oracle Free VPS | Fly.io | Railway |
|---|---|---|---|---|---|---|
| Free tier сегодня | 512MB, 750 ч/мес (24/7 для 1 сервиса), **без карты** | **Закрыт для новых** (куплен Mistral AI, 02.2026) | Always Free кредит, но карта обязательна | 2× E2.1.Micro (1GB) бессрочно, карта обязательна | **Нет** (trial 7 дней) | Trial $5 разово; Free $1/мес — на 24/7 не хватает |
| Сон / cold start | Спит через 15 мин без HTTP; cold ~1 мин | — | CPU-троттлинг между запросами: idle TCP-пул — анти-паттерн | Не спит (VM); idle-reclaim при <20% CPU 7 дней | Autostop; отключение — платно | Не спит, но кредит кончается |
| Регион | **Frankfurt** | Frankfurt | europe-west3 (Frankfurt) | eu-frankfurt-1 | fra | Франкфурта нет (Амстердам) |
| Dockerfile/OCI | Git push или образ из registry | — | gcloud + registry | SSH + docker (root) | fly deploy | git / registry |
| Секреты | UI + env groups | — | Secret Manager | самообслуживание | fly secrets | UI Variables |
| Логи | 7 дней | — | 30 дней, 50GiB/мес | самообслуживание | 7 дней | 7 дней |
| Egress TCP 5432/6543 | **Да** (закрыт только SMTP); IPv4 → пулер | Да | Порты открыты, но троттлинг рвёт keepalive | Да («allow all» из коробки) | Да | Да (после GitHub-верификации) |
| Платный шаг «без сна» | **Starter $7/мес** | — | ~$85/мес (always-allocated) | не нужен | **~$2.24/мес** (дешевейший always-on) | Hobby $5/мес, но не Франкфурт |

**Выбор (C4): Render free, Frankfurt** — единственный живой вариант «бесплатно + без карты + Франкфурт + egress открыт». Компромисс: сон через 15 мин, cold start ~1 мин (polling агентной петли днём держит сервис тёплым; Supavisor штатно переживает переустановку пула). Путь апгрейда: Render Starter $7/мес или миграция на Fly.io ~$2.24/мес (карта). Топ-2: Oracle Always Free VPS (всегда живой, но карта + ops-налог + риск idle-reclaim).

## Бэкап

`scripts/backup.sh` — pg_dump через session-пулер (прямое подключение к Supabase IPv6-only). Runbook: гонять вручную до автоматизации; restore — `psql "$ADMIN_DSN" -f <dump>`.
