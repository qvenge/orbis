# Разбор: codebase-memory-mcp (DeusData)

| Поле | Значение |
|---|---|
| Дата | 2026-08-22 |
| Источник | ссылка владельца: `github.com/DeusData/codebase-memory-mcp` |
| Проверено | README, сайт, препринт arXiv:2603.27277, исходники (`src/mcp/mcp.c`, `pipeline_incremental.c`, `watcher.c`, `agent_profiles.c`, `hook_augment.c`), релизы и issues через GitHub API на 2026-08-22; цитаты дословные |
| Статус | разбор + швы; швы внесены в спеку ADE тем же коммитом |
| Индекс | `market-scan-index.md`, раунд 6 |

---

## Что это

MCP-сервер, индексирующий локальный репозиторий в постоянный граф знаний о коде (функции,
классы, вызовы, HTTP-маршруты, кросс-сервисные связи) и отдающий агенту структурные запросы
вместо чтения файлов. **Принципиально без LLM в контуре**: «it relies on your MCP client…
to be the intelligence layer» — граф детерминирован, обновление стоит миллисекунды и $0.
Чистый C + SQLite + вендоренные tree-sitter (158 языков), один статический бинарь. 15 MCP-тулов
(`search_graph`, `trace_path`, `detect_changes`, `check_index_coverage`, `query_graph`,
`manage_adr` и др.), MIT.

Несмотря на слово memory в названии, это **не память агента и не генератор доков** — это
структурный субстрат под то и другое. «Память» = граф кода + векторы + один markdown-блоб ADR
на проект.

## Статус

★39.8k за 6 месяцев (создан 2026-02-24), пуш сегодня, 121–261 коммит/нед, 350k+ загрузок
релиза. **Bus factor = 1**: DeusData — это один человек (Martin Vogel, Берлин), 1346 коммитов
против 53 у второго контрибьютора, все PR через его аппрув, «solo, volunteer-maintained
project». Монетизации нет вовсе. Препринт с TU Berlin/Charité.

**Маркетинг расходится с бумагой**: README цитирует «83% answer quality, 10× fewer tokens» и
умалчивает, что в статье это «83% **versus 92%** for a file-exploration agent» — качество
ответов *ниже* файлового агента, выигрыш только в цене. Есть открытое опровержение от
пользователя (#1129: с MCP токенов ушло *больше*, 74k против 43k — без ответа мейнтейнера).

## Главный улов — четыре механизма под Р2 и швы 4–6

1. **Хеш «поверхности» отдельно от хеша содержимого.** Ключ инвалидации — `surface_sha`
   (sha256 канонического JSON определений файла), не хеш байтов: «a body edit leaves a file's
   persisted LSP surface byte-identical, so only the file itself is recomputed; a **surface
   change** pulls in exactly the files with edges into it». Ровно тот критерий, которого не
   хватает контент/AST-хешам Р2 — они инвалидируют слишком широко: правка тела функции не
   должна протухать производный док, если контракт не менялся.
2. **Depth-1 замыкание + «Declining is never wrong».** Обратно-зависимая инвалидация не ищет
   фикспойнт («an unchanged dependent can never be surface-changed in turn»), а **каждый
   сомнительный случай эскалирует в полный пересбор**: «Every uncertain case declines to a
   FULL rebuild… Declining is never wrong — it is exactly today's behaviour». Готовая политика
   fail-safe для дрейф-гейта: непокрытый случай даёт «дороже, но верно», никогда «тихо неверно».
3. **`check_index_coverage` + «граф промахов» — честность про незнание как первоклассный
   механизм.** Отдельный тул «а ты вообще это читал?»: «use scopes before negative/exhaustive
   claims because fully skipped files cannot appear in normal graph results»; «coverage is
   best-effort, **never proof of completeness**». Плюс `query_graph(graph="missed")` —
   материализованное негативное пространство с диапазонами строк, и **три категории
   непокрытого**: `parse_partial` / `skipped` / `not_indexed` («excluded **BY DESIGN**…
   deliberate and deterministic, not failures»). Для Р2: гейт не имеет права сказать «дрейфа
   нет», не доказав, что просмотрел периметр; «исключено намеренно» ≠ «не смогли».
4. **`detect_changes` — готовая форма радиуса поражения.** git diff → символы → одна
   многоисточниковая обходка → transitive impact, с правилом честности метрики: «Seeds (the
   changed symbols) are excluded from impacted; a changed file reached from another changed
   file is not counted as extra impact» — иначе радиус раздувается сам собой.

Провенанс на рёбрах — тоже образцовый: `trace_path(include_evidence)` отдаёт **класс**
резолвера (`lsp | language_rule | heuristic | unresolved`) + confidence, а не внутренние имена
(«publishing those verbatim would make each internal resolver name public API by accident» —
новый *вид* резолюции ломает пиннинг-тест и требует решения); недоказанный вызов получает
отдельный тип ребра `USAGE`, а не притворяется `CALLS`; отсутствие confidence кодируется −1,
чтобы не путать с честным 0.0.

## Второй улов — MCP-дисциплины для нашего сервера (слайс 4b)

1. **Профили тулов на уровне процесса**: `scout` = 7 тулов, `analysis` = 11, полный = 15 —
   «positive allowlists… future or mutating tools remain unavailable until explicitly
   reviewed». Для Orbis: внешний агент по OAuth-скоупу получает физически урезанный список,
   а не «все тулы + просьбу не трогать».
2. **Эпистемический контракт в `initialize` instructions**: не описание фич, а правила
   («Coverage is best-effort, never proof of completeness»). Плюс три навязанных сервером
   тира агента (Scout: «do not make all/none claims… label findings provisional» / Verify:
   «require path coverage for every cited file» / Auditor: «disclose every unresolved
   limitation»). Orbis может так же вшивать «предложение, а не запись; всё через приёмку».
3. **Курсор привязан к поколению данных**: «Cursors outlive nothing: after a reindex you get
   a stale_cursor error». Пагинация с `total` + `has_more` как часть контракта честности.
4. **Периметр применяется на всех входах**: `CBM_ALLOWED_ROOT` проверяется после разрешения
   симлинков и `..` — и на MCP-туле, и на HTTP-роуте UI.
5. **Урок #858 (fail-open хуки)**: бюджет 300ms молча самоубивался на холодном старте —
   «augmentation never appeared in real sessions (**0/24 observed**) while manual warm
   invocations worked». Fail-open без наблюдаемости = невидимый no-op; любому нашему хуку —
   лог сработавших дедлайнов.

## Классы багов, которые Orbis обязан не повторить

- **#1339: «Graph not updated when the working tree returns to clean»** — откат изменений не
  переиндексирует, граф остаётся с фантомами. Для Р2: undo/revert — такое же событие домена,
  как правка.
- **#1458 (open, без ответа): «Memory poisoning — can an agent inject false data into the
  knowledge graph?»** — прямой вопрос к любому MCP-серверу с памятью. У Orbis ответ
  конструктивный (приёмка + журнал + Undo) — усиление нашей позиции, но вопрос «может ли
  внешний агент писать мимо приёмки» уже стоит в наших отдельных задачах (ревалидация IV.3
  п.10) — этот прецедент поднимает его приоритет.
- **Дрейф собственных доков** — иронично для проекта про память о коде: SECURITY.md утверждает
  фоновый update-check после `initialize`, а в коде единственный сетевой вызов — из явной
  команды `update` (README прав, SECURITY.md устарел). Живой экспонат тезиса Р2.

## Что сознательно не берём

- **ADR-модель**: один markdown-блоб, `update` заменяет документ целиком, без авторства, дат,
  провенанса и undo — строго хуже нашего журнала. Берём только «пустой каркас» (фиксированная
  сетка секций в подсказке тула — дешёвая типизация вместо свободного текста).
- **Git-поллинг как реактивность** (5–60 с, только git-репо) — у нас доменные события точнее.
- **Собственный LSP на C, 43 клиентские интеграции, `ingest_traces`, единый бинарь-демон** —
  героика дистрибуции OSS-инструмента, не наша модель.
- Как зависимость/инструмент — **не сейчас**: bus factor = 1, системные проблемы памяти
  (#1654 OOM-регрессия, #832 «20GB+ RSS for 5MB indexed», #581 «50+ GB virtual»), 474 открытых
  issue против 451 закрытых за 6 месяцев, спорная экономия токенов (#1129). Прецедент механизмов
  — да; runtime-зависимость — нет.

## Сравнение с разобранными соседями (одной строкой каждый)

Code Wiki — LLM-перегенерация вики, дорого, без честности про незнание; Repowise — решения с
провенансом exact/fuzzy/unverified, но LLM в контуре; Semantica/Zep — bi-temporal факты, не код;
здесь — **детерминированный слой без LLM с лучшей на рынке дисциплиной незнания и инвалидации**,
но памятью в смысле Orbis не являющийся. Чего нет ни у кого из разобранных: coverage-тул,
граф промахов, закрытый словарь классов провенанса с пиннинг-тестом, surface-hash инвалидация,
эпистемические тиры, навязанные из сервера.

## Куда легли швы

Спека ADE, «Швы под будущее», дополнение от 2026-08-22 (пп. Р2/4–6: surface-hash, decline-to-FULL,
coverage перед негативным утверждением, три категории непокрытого, seeds-excluded радиус,
revert-как-событие). Дисциплины MCP — в отдельную задачу «разбор MCP 2026-07-28» (ревалидация
IV.3 п.10) как второй вход: пересматривать наш сервер разом против новой спеки протокола и
этого прецедента.
