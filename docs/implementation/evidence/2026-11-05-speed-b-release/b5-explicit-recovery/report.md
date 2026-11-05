# Явное восстановление на подтверждённой основе · Исправление

В ordinary history 0 воспроизведён продуктовый отказ явного recovery после подтверждения другого тела. Пробная публичная кнопка действительно вызвана, но при старой показанной основе POST не начинался и предложение возвращалось. Это отдельное свидетельство через хук. Оно не устанавливает, был ли доставлен DOM click в первоначальном Safari WebDriver109.

Основа архива — 356a610f5ae92efe429bdb6891c5bde6f9c09e9f. Workspace aliases разрешаются внутрь candidate. tracked-source-check.json сверяет неизменённый исходный архив до правки. Итоговые два пути в review.json/review.diff/review.sha256. Shared workspace не менялся.

Постоянный recovery-basis.test.tsx создаёт managed B2 через captureDraftWriter().managed.stage/preserve, проверяет точный token в storage, завершает input session и открывает следующую на том же storage. Использован supported fallback persistent:false/sessionStorage, без native IndexedDB. QueryCache получает настоящий disk A2 через recordDiskRead и помечает его pending. Установлен public runtime acceptBody sink. После accepted network C3 кнопка вызывает публичный applyPendingDraft. Прямого доступа к приватным refs нет.

| Контроль | Исходник | Итоговая правка |
| --- | --- | --- |
| GET удержан, history0 | Нет POST, B/token целы | То же |
| GET C3 подтверждён, history0, показанная основа A2 | RED, callback1/POST0/баннер возвращается | Один B POST с expected3 |
| GET C3 подтверждён, показано C3 | Один B POST expected3 | То же |
| Подтверждённый C3 после строгого rewind | Один B POST expected3 | То же |

Все положительные ветки требуют в acceptBody исходный exact draftToken, expectedBodyRevision3 и returned revision4/bodyDoc B. Это проверка передачи ACK receipt. Запись нативного durable ответа и финальный retirement IndexedDB этой пробой не доказываются.

Исправление находится в capturePendingBasis явного жеста. При history0 он ищет каноническую detail publication текущего scoped runtime, требует runtime.isAcceptedRead, а затем сопоставляет её подтверждённую entity revision/bodyDoc с текущей базой. projectBody используется только после accepted network read и учитывает текущий серверный ACK. Disk или неподтверждённый GET не проходят. Если свидетельства нет, остаётся показанная основа. При history>0 сохраняется прежний strict confirmedBody. При explicit=false обычный набор сохраняет показанную основу.

Проверены два отклонённых варианта. Простое снятие условия truthy history ошибочно принимало props rev9 вместо displayed rev4 в существующем save-тесте. Проверка одной метки confirmed doc тоже не связывала уже использовавшийся объект с новой ревизией props. Эти варианты сохранены отдельно в useBodySave.rejected-naive.ts и useBodySave.rejected-doc-stamp.ts. Существующий тест и его ожидание не изменялись.

## Проверки и исходные ошибки

- Начальная setup-проба без durable sink отправляла B до кнопки, clicks0, и не достигала предпосылки. Она не является finding. Сохранены setup-without-durable-sink.log и отдельный тест.
- Неизменённый продукт со штатным sink — probe-with-durable-sink.log, 1 RED / 3 PASS, exit1. Публичный handler clicks1. Та же постоянная регрессия дополнена exact receipt проверками и запущена на исходном useBodySave — permanent-red.log, 1 RED / 3 PASS, exit1.
- Отклонённая наивная правка — affected-green.log, 215 PASS / 1 FAIL, exit1. Проверка невидимой props rev9 ожидает displayed4, получила9. Вариант object stamp — narrow-affected.log с тем же отказом. Продуктовые rejected версии не переносились в workspace.
- Итоговый focused прогон — scoped-focused.log, 6 PASS / 75 skipped, exit0. Четыре recovery-контроля и два existing displayed-basis контроля.
- Итоговый набор — bun run --cwd apps/web test src/features/entity-detail/recovery-basis.test.tsx src/features/entity-detail/freshness-reset.test.tsx src/lib/freshness/runtime.test.ts src/lib/freshness/wiring.test.tsx src/features/entity-editor/save.test.tsx src/features/entity-editor/draft.test.tsx --maxWorkers 1, 216 PASS / 6 файлов, exit0, final-affected.log.
- Biome двух owned путей — scoped-biome.log, без ошибок. git apply --check --whitespace=error review.diff и две SHA-проверки прошли.

Таймауты, бюджеты и проверки existing tests не менялись. Safari, истёкший fixture, DB, server, build и общий CI не запускались. После независимого ревью нужен отдельный Safari fresh fixture с passive DOM event/callback delivery trace для исходной полевой ветки. Унаследованная граница unseen rollback после hard reload этим исправлением не меняется.
- Web typecheck — bun run --cwd apps/web typecheck, exit0, final-typecheck.log. Проверки закончены, исходники заморожены для SAME reviewer.
