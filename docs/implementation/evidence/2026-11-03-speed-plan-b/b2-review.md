# Независимое ревью Б2

**PASS.** Замечаний, требующих исправления, нет. Проверен фактический рабочий diff ветки `codex/speed-plan-b` от `ad7dd5bb` по Б2 плана rev3, speed rev6 §§4.3–4.4 и 5.3, условиям Р4/Р8. Миграция и SQL-тесты Б1 без изменений.

- [Сверка](../../../apps/server/src/freshness/feed.ts) берёт снимок, `xmin`, цель `xmax − 1`, floor и не более 1001 строки одним SQL-оператором. Используется полуинтервал `[from, W2)`, сортировка по xid и номеру строки. Десятичные xid8 не проходят через JS Number. При переполнении возвращается reset без частичных транзакций. Парсер отклоняет malformed/overflow uint64. При будущем курсоре возвращается безопасная W2.
- При `from < floor` provisional/complete имеют разные токены. Повтор F1 стабилен, новый F2 при той же W2 виден отдельно. Поздняя reset TX с меньшим xid не повышает max floor, а complete после пересечения F2 покрывает A, закоммиченную после provisional-чтения. Повторы HTTP от прежней from воспроизводят reset и затем обычные дельты. Выборки от `max(from, floor)` нет.
- [Роут](../../../apps/server/src/routers/changes.ts) использует `ownerOnlyProcedure` и RLS под `withIdentity`; HTTP видит только `page`. PAT и JWT без читаемого гранта получают 403. В дополнительной пробе читаемый граф без singleton получил 500, а отсутствие гранта по-прежнему 403. Проба удаляет singleton внутри откатываемой транзакции и проверяет, что запись осталась.
- [withIdentity](../../../apps/server/src/db/with-identity.ts) снимает `xmin` в первом SELECT с `set_config`, сохраняет READ COMMITTED и не выдаёт xid читающей транзакции. [HTTP-сборщик](../../../apps/server/src/freshness/watermark.ts) отдаёт минимум обычной tRPC пачки через responseMeta. Тест на двух реальных процедурах подтверждает разные границы, заголовок с меньшей и сохранение Server-Timing.
- [Executor](../../../apps/server/src/executor/executor.ts) берёт xid из UPDATE RETURNING и переносит его до ответа успешного [entity.update](../../../apps/server/src/routers/entity.ts). Квитанция тела включает bodyDoc сохранённой строки, revision и bodyAction. Текстовый сеанс сохраняет actionId, меняя txId. Post-commit эскалация не влияет на квитанцию. No-op сохраняет ревизию. Для suppression последующим этапам нужен подходящий body-save с изменением ревизии, подходящим scope события и текущим epoch. CAS и публичные контракты MCP, batch replay и Undo сохраняются.

## Независимые проверки

- `bun test apps/server/src/freshness/ apps/server/src/db/with-identity.test.ts apps/server/src/routers/entity.test.ts` — 51 pass, 0 fail, 245 assertions. [Лог](b2-review-core.log)
- Executor, entity-update-batch, journal-ref, code boundaries и Server-Timing — 99 pass, 0 fail, 747 assertions. [Лог](b2-review-regression.log)
- Дополнительная проба — 2 pass, 0 fail, 10 assertions. Откат в текущем графе невидим после продвижения W2. 1001 строка одной транзакции даёт reset с пустыми transactions. Ошибки отсутствия floor и отсутствия гранта различены. [Проба](b2-review-repro.test.ts) · [лог](b2-review-repro.log)
- `bun run typecheck` — shared/server/web exit 0. Biome на 16 затронутых файлах и `git diff --check` exit 0. [Лог типов](b2-review-typecheck.log)

PASS охватывает серверный контракт. Живые SSE reconnect/fallback и повтор при потере reset на транспортном уровне остаются Б3. Применение токенов и ACK во вкладке остаётся Б5. Подтверждение тела на диске и снятие черновика остаются Б6. Локальная БД 54339 освобождена.
