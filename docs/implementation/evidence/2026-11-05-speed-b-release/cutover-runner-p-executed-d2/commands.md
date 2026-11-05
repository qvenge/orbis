# Запуск после отдельного допуска корня

Этот scratch-пакет написан по плану SHA-256 `45ccb03ee57730b3812cf2466a70e72780d1e6d8d695f4da1ea46e580a8c2083` и уточнён по source review `76f26daf31cb76c6cc91ff5575a594d3697a7f77028531abe4c218182ab07797`. При подготовке Chrome, DB, HTTP, install, сборка и тесты не запускались. Продуктовый код и постоянные документы сохранены.

## 1. Выделение стенда и pinned handoff

Root готовит по одному новому **контейнеру на сценарий**, а не отдельные БД внутри чужого кластера.

| Сценарий | Контейнер | Публикация | База | Label |
| --- | --- | --- | --- | --- |
| N | `orbis-speed-b-cutover-n` | `127.0.0.1:54344 → 5432/tcp` | `postgres` | `orbis.cutover.lane=n` |
| P | `orbis-speed-b-cutover-p` | `127.0.0.1:54345 → 5432/tcp` | `postgres` | `orbis.cutover.lane=p` |

В каждом контейнере root подготавливает оригинальными b5 средствами exact `0026_body_revision` и restricted login `orbis_app`. Admin login `supabase_admin`. В стандартном образе роль `postgres` не является SUPERUSER. Сохранить эти флаги образа. При выделении каждого нового контейнера до запуска runner подтвердить TCP-вход под `supabase_admin` по указанному loopback-порту и чтение `pg_control_system()`. Пароль при необходимости настроить только в собственном новом контейнере и передать через отдельный env без печати. Служебные auth/cron схемы остаются там, где создаёт их Supabase image. Runner не создаёт контейнеры, роли или БД. Он проверяет ID контейнера, `.Image`, label и единственную опубликованную привязку, реальные DB/login/current_user/internal port, роли и `pg_control_system().system_identifier` по admin соединению до seed и перед миграцией. Launcher проверяет restricted runtime login на собственном соединении до Hono и не получает admin DSN. У runtime сохраняются обычные ограничения флагов и членство в `authenticated`. Членство в `postgres`, `supabase_admin`, `service_role` и `orbis_change_feed_owner` запрещено. Последняя роль проверяется по OID только если уже создана миграцией. DSN принимаются только с `postgres:` / `postgresql:`, точными localhost/port, DB, ролью и без query/fragment.

Root после проверки артефактов выдаёт JSON для каждой lane и закрепляет SHA-256 самого JSON. В `manifests.old/current` — **хеши байтов** файлов `$ARTIFACTS/old.json` и `$ARTIFACTS/current.json`, не хеши HTML. В handoff нет секретов. Пример структуры, значения угловых скобок требуют реального подтверждения.

```json
{
  "lane": "N",
  "container": { "id": "<actual docker .Id>", "image": "<actual docker .Image>" },
  "db": {
    "port": 54344,
    "name": "postgres",
    "admin": "supabase_admin",
    "runtime": "orbis_app",
    "systemId": "<actual pg_control_system system_identifier>"
  },
  "manifests": { "old": "<sha256 old.json>", "current": "<sha256 current.json>" }
}
```

Отдельный root env содержит только согласованные DSN. Не печатать их. Не занимать 54321, 54339, 54340 или 54341. Браузерный Auth fixture обслуживается narrow CDP только по `http://localhost:54321/auth/v1/*`, физический localhost:54321 остаётся свободным или принадлежит прежнему сервису. Остальная браузерная сеть направляется в deny proxy, исключения только у двух проверяемых loopback origins.

## 2. Подготовка точных артефактов

Команды выполняются только в разрешённом окне. b5 строится один раз с allowlisted environment и совпадающим Auth host. Для a0 создаётся новый чистый source clone с собственными `@orbis` aliases и **побайтной копией** принятого normal dist. Исходный a0 archive содержит игнорируемое окружение и не запускается как server tree. Его файлы не изменяются. Старый архив поставляет только пакеты на чтение. Ссылки на его workspace source/dist и скрытые кеши не создаются. В verify повторно сверяются все git blobs и сохранённые до build байты архивного b5 dist.

```sh
CUTOVER_RUNNER="$PWD/.superpowers/sdd/2026-11-05-speed-b-release/cutover-runner"
CURRENT_FROZEN=/private/tmp/orbis-b13-final-ci.07CROy/candidate
CURRENT_DIST_MANIFEST="$PWD/docs/implementation/evidence/2026-11-03-speed-plan-b/final-ci-a0/b13-ci-dist-manifest.json"
BUN_BIN=$(command -v bun) || exit 1
OLD_TREE=$(python3 "$CUTOVER_RUNNER/artifacts.py" "$PWD" prepare-old) || exit 1
CURRENT_TREE=$(python3 "$CUTOVER_RUNNER/artifacts.py" "$PWD" prepare-current \
  --current "$CURRENT_FROZEN" --current-manifest "$CURRENT_DIST_MANIFEST") || exit 1
(
  cd "$OLD_TREE" || exit 1
  env -i PATH="$PATH" VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=anon \
    "$BUN_BIN" run --cwd apps/web build
) || exit 1
ARTIFACTS="$(mktemp -d /private/tmp/orbis-cutover-input.XXXXXX)/manifests"
python3 "$CUTOVER_RUNNER/artifacts.py" "$PWD" verify --old "$OLD_TREE" --current "$CURRENT_TREE" \
  --current-manifest "$CURRENT_DIST_MANIFEST" --out "$ARTIFACTS" || exit 1
shasum -a 256 "$ARTIFACTS/old.json" "$ARTIFACTS/current.json"
```

Root переносит только подтверждённые manifest SHA в оба handoff. Runner требует закреплённый SHA handoff аргументом, повторяет SHA обоих манифестов и всех перечисленных исходников/файлов dist, сверяет inventory dist без дополнительных файлов. Пакет не устанавливает зависимости и не использует response-off. При несовпадении байтов остановиться.

## 3. Запуск по одной lane

Для каждого запуска root подтверждает собственный контейнер и выдаёт DSN текущей lane из отдельного env. Переключить обе DSN между N и P. Не переиспользовать мигрированный контейнер или профиль.

```sh
N_PARENT=$(mktemp -d /private/tmp/orbis-cutover-n.XXXXXX)
bash "$CUTOVER_RUNNER/run-lane.sh" N "$ARTIFACTS" "$N_PARENT" "$N_HANDOFF" "$N_HANDOFF_SHA"

# После завершения N и проверки его ресурсов, с DSN только контейнера P.
P_PARENT=$(mktemp -d /private/tmp/orbis-cutover-p.XXXXXX)
bash "$CUTOVER_RUNNER/run-lane.sh" P "$ARTIFACTS" "$P_PARENT" "$P_HANDOFF" "$P_HANDOFF_SHA"
```

Браузер запускается public API `chromium.launchPersistentContext` с pipe, точным уникальным профилем и включённой Chrome sandbox. Установленная Playwright 1.63.0 зафиксирована по source hash `549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171`. В её фактических defaults найден только один явно отключающий BFCache аргумент `--disable-back-forward-cache`; он исключён. Список `--disable-features` сохранён, `BackForwardCache` в нём отсутствует. При следующем запуске фактические аргументы, root PID/start и потомки попадут в trace. Закрытие persistent context должно завершить все отмеченные identity, иначе завершение не доказано. При startup failure cleanup может адресовать только повторно сверенный browser PID с точным одноразовым профилем. События раннего failed startup и закрытие контекста не подменяют положительное доказательство cutover.

macOS Chrome, Docker inspect и loopback bind могут потребовать утверждённый локальный запуск вне sandbox. Не пересекать окно с тяжёлыми гейтами. В каждом run остаются request journal, логи настоящих upstream и миграции, временный синтетический профиль. Новая обёртка пишет фактический код Bun в отдельный `exit` через `run_exit`. В первом историческом N такого файла нет из-за прежней zsh-обёртки. Его исходный PTY exit и stderr сохраняются отдельно. Профиль содержит тестовый auth; его удаление — отдельный шаг владельца прогона после проверки завершения Chrome.

## 4. Наблюдения и границы

- N ожидает `expected-unsafe-reproduced`. N не готовит категорию и не упражняет D2. Каждый повтор использует новый синтетический account/graph и email, даже если допускается тот же pinned N container на exact 0026. Частичный ввод первого N не стирается. Записаны отдельно видимый blocker, поздний old entry, собственный controller позднего документа и фактическая запись старого auth. `old-code-under-current-worker` только при ответе протокола в поздней вкладке. `driver-412` относится к запросу runner. `late-browser-412` — к отдельному коррелированному 0.6 ответу поздней вкладки, с явным `observed:false` при отсутствии наблюдения.
- P различает `ordinary-worker-controlled` и `fresh-http-later-controller` по ответу именно новой штатной навигации. 0.7 доказательство — настоящий tRPC результат её main frame после границы журнала, связанный через порядковый номер ответа, и актуальные HTML/entry/worker. `assisted` отмечает второй обычный запуск после диагностического восстановления. При старой первой оболочке в логе остаётся `restart-only-insufficient`. Статус BFCache отдельно ограничен, если не наблюдался.
- D2 forwarded current попытки и ACK привязаны к исходному UUID и canonical payload hash. P через реальный b5 API включает Finance и проверяет маску, затем сверяет registry и штатную категорию «Транспорт» с алиасом «такси» в плоском массиве b5 `entity.query`. До ввода и до допуска досыла проверяется ноль финансовых записей/fast-path действий в новом графе. После ACK ищется запись по полному содержимому очереди без условия на PK, отдельно проверяется единственная финансовая операция с аспектом `orbis/financial` (бюджетные конверты вне счётчика) и единственное fast-path действие этого графа. Browser body POST до явного принятия обоих черновиков должен быть нулевым, для второго — до wipe.
- Playwright route с глобальным выключением HTTP cache не используется. Нативную работу proxy/CDP, BFCache, UI selectors и fast-path «такси 500» ещё предстоит проверить. Любой нераспознанный профиль, upstream, Auth interception, process exit или fixture assertion — отдельный RED. Не вводить искусственный legacy writer, поддельный tRPC ACK или фальшивый feed.
- Независимое ревью делает прежний reviewer. Результат ограничен локальным Chrome с одноразовым профилем и этой парой сборок. Полевая матрица, физические устройства и установленная PWA остаются отдельными гейтами. Выпуск и main merge остаются за пределами этого прогона.

## Отдельный контроль наблюдателя жизненного цикла

`lifecycle-observer.ts` регистрирует ожидаемые token/sequence до навигации. Console является одним каналом доставки. После возврата дополнительно читается массив реальных pagehide/pageshow событий из памяти того же документа. Только пара persisted=true и неизменный marker доказывает BFCache. Timeout или новый marker дают отдельный uncovered статус, не заключение об отсутствии поддержки. Целевой старый документ затем снова уходит на нейтральную страницу, однако эта вторая навигация сама по себе не засчитывается как ещё одно доказательство BFCache.

`observer-control.ts` содержит дословные срезы utility/process/pipe/close из runner, хеши срезов в `observer-control-slices.json`. Он открывает только две нейтральные loopback HTML страницы. Физический профиль, App, tRPC и БД не используются. Его контроль подтверждает только работу наблюдателя и не переносит eligibility результата на старое приложение.

Один запуск требует отдельного выделенного окна. Исходы, полный trace и context-close/PID proofs сохраняются. Пример команды после допуска:

```sh
OBSERVER_OUT=$(mktemp -d /private/tmp/orbis-cutover-observer.XXXXXX)
"$BUN_BIN" run "$CUTOVER_RUNNER/observer-control.ts" "$OBSERVER_OUT"   > "$OBSERVER_OUT/trace.jsonl" 2> "$OBSERVER_OUT/stderr"
```
