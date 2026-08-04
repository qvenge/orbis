# Диета бандла — работа на конец слайса 3

| Поле | Значение |
|---|---|
| Дата замера | 2026-08-04 |
| Состояние | решение владельца: делать **после того, как закрыты все фазы слайса 3** (включая E) |
| Повод | вопрос владельца из бэклога фазы C: markdown-стек дал +49.3 кБ gzip — оставить или искать разрез легче |
| Замер сделан на | ветка `slice3d-query-builder`, HEAD `53231fc` (фаза D закрыта) |

---

## Что измерено

Прод-сборка web: единый чанк **292.1 кБ gzip** (1 018.8 кБ сырых), PWA precache — 1031 KiB
на 8 записей, то есть весь объём перекачивается при каждом обновлении бандла.

Разбивка по вендорам (gzip каждого чанка, временная сборка с `manualChunks` — рецепт ниже):

| Чанк | gzip | доля | используется |
|---|---|---|---|
| наш код (`index`) | 60.1 кБ | 21% | да |
| `react` + `react-dom` | 55.7 кБ | 19% | да |
| **`@supabase/supabase-js`** | **51.6 кБ** | **18%** | **только `.auth`, 4 вызова** |
| markdown-стек (`react-markdown`, `remark-gfm`, `rehype-sanitize` + экосистема unified/micromark) | 47.1 кБ | 16% | да, лента чата и body сущности |
| `radix-ui` (+ floating-ui, react-remove-scroll, aria-hidden) | 32.7 кБ | 11% | да |
| прочие вендоры | 14.6 кБ | 5% | да |
| `@tanstack/react-query` | 11.7 кБ | 4% | да |
| `@trpc/client` + `superjson` | 11.2 кБ | 4% | да |
| `lucide-react` | 6.3 кБ | 2% | да |
| `zustand` | 1.3 кБ | 0.4% | да |

**Вывод замера:** цена markdown из фазы C подтверждена третьим независимым способом (47 кБ против
заявленных +49.3), но это не самая дорогая статья. Самая дорогая ошибка — supabase.

---

## Работа 1 (первая, самая дешёвая): `supabase-js` → `auth-js`

**Что не так.** `apps/web/src/auth/supabase.ts:1` импортирует `createClient` из
`@supabase/supabase-js`, который тянет в бандл `postgrest-js`, `realtime-js` (+ `phoenix`,
websocket-клиент), `storage-js` и `functions-js`. Web не вызывает из них **ничего**: все данные
идут через tRPC. Сплошной поиск по `apps/web/src` даёт ровно четыре обращения к клиенту, все
к `.auth`:

- `auth/supabase.ts:30` — `supabase.auth.getSession()`
- `auth/supabase.ts:33` — `supabase.auth.onAuthStateChange(...)`
- `auth/LoginScreen.tsx:20` — `supabase.auth.signInWithPassword({ email, password })`
- `auth/AuthProvider.tsx:34` — `supabase.auth.signOut()`

**Что сделать.** Заменить на `@supabase/auth-js` (тот же auth-клиент отдельным пакетом; уже лежит
в `node_modules` транзитивно). Правка — один файл `apps/web/src/auth/supabase.ts`, публичный
интерфейс модуля (`supabase`, `useSession`, `SessionState`) сохраняется, остальные три файла
не трогаются.

**Ожидаемая экономия:** большая часть из 51.6 кБ, ориентировочно **30–40 кБ gzip** — больше,
чем весь markdown-стек. Точная цифра снимается замером до/после.

**Риски и на что смотреть.**
- `persistSession` / `autoRefreshToken` обязаны продолжать работать: сессия переживает F5,
  токен обновляется сам. Проверять живым смоуком, а не только сьютом.
- Локальный Supabase подписывает JWT **ES256** — сервер проверяет подпись по JWKS
  (`SUPABASE_URL`), и это не должно измениться.
- В тестах web supabase мокается — проверить, что мок не завязан на форму пакета.
- Приёмка: вход, выход, перезагрузка страницы с живой сессией, протухший токен.

---

## Работа 2 (вторая): ленивая загрузка редко нужных экранов

В `apps/web/src` сегодня **ноль** `React.lazy`, `Suspense` и динамических `import()`
(проверено grep'ом при разведке фазы D), а сборщик уже предупреждает про чанк больше 500 кБ.

Кандидаты — то, что открывается по явному действию и не нужно на первом экране:

- **query-builder** (`features/query-builder/*` — форма, `FieldRows`, `model`): открывается
  кнопкой «настроить» на виджете, лежит в бандле всегда;
- **CSV-импорт** (`features/import/*`): открывается из чата, разовый сценарий;
- вкладка **Budget** целиком — самый крупный кандидат, но и самый спорный (её открывают часто).

**Осторожно:** это первое разбиение в проекте, то есть архитектурное решение, а не микроправка.
Оно меняет поведение PWA (несколько файлов в precache вместо одного) и требует продумать
состояние загрузки, чтобы экран не мигал.

---

## Чего делать НЕ надо (решено при разборе)

- **Свой мини-рендерер markdown** вместо `react-markdown`. Сэкономит ~40 кБ, но вместе с ними
  уедет `rehype-sanitize`, а тело сущности и ответы модели могут нести что угодно — вплоть
  до текста из импортированной банковской выписки. Менять проверенную санитизацию на свою ради
  40 кБ — плохой размен. (Отдельно: `hast-util-sanitize` сравнивает протокол регистрозависимо —
  известный минор бэклога фазы C; это долг, а не повод переписывать рендерер.)
- **Ленивая загрузка markdown.** Он нужен и в ленте чата, и в body сущности, то есть почти
  на каждом экране; ленивость даст мерцание при первой отрисовке, а сэкономит только на экране
  логина.

---

## Рецепт замера (чтобы не выяснять заново)

Разбивка получается временным патчем `apps/web/vite.config.ts` — добавить в `defineConfig`
перед ключом `server`:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (!id.includes('node_modules')) return;
        if (/react-markdown|remark|rehype|micromark|mdast|hast|unified|unist|vfile|property-information|space-separated|comma-separated|character-entities|decode-named|bail|trough|is-plain-obj|zwitch|longest-streak|ccount|markdown-table|escape-string-regexp|devlop|estree|html-url-attributes|trim-lines|parse-entities/.test(id)) return 'x-markdown';
        if (/radix-ui|@radix-ui|aria-hidden|react-remove-scroll|use-sidecar|get-nonce|floating-ui|tabbable/.test(id)) return 'x-radix';
        if (/@tanstack/.test(id)) return 'x-tanstack';
        if (/@trpc|superjson|copy-anything|is-what/.test(id)) return 'x-trpc';
        if (/@supabase/.test(id)) return 'x-supabase';
        if (/lucide-react/.test(id)) return 'x-lucide';
        if (/zustand|use-sync-external/.test(id)) return 'x-zustand';
        if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'x-react';
        return 'x-vendor-rest';
      },
    },
  },
},
```

Затем:

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x bun run --filter @orbis/web build
for f in apps/web/dist/assets/*.js; do printf "%-34s %7s\n" "$(basename $f)" "$(gzip -c $f | wc -c)"; done | sort -k2 -nr
```

**Патч обязательно откатить** (`git checkout apps/web/vite.config.ts`) и пересобрать штатный
бандл — иначе на стенд уедет сборка с чужой разбивкой.

Историческая база для сравнения: **237.9 кБ** (до фазы C) → **287.2 кБ** (markdown, фаза C) →
**292.1 кБ** (query-builder, фаза D).
