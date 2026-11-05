# Одна actual N, natural first origin request

Применена только SAME-approved дельта `1f7754b76478af42b4ac0f856f005cb322bfe6bffad2cfac339bdbaa3b6a0c55`. Предыдущий b07 пакет сохранён в `cutover-runner-before-natural-first`; исполненный source сохранён отдельно в `cutover-runner-executed-natural-first`. Пакет `962c8654a1181f4559f3e7257453cfbd3d921f2cf5323531d0f5205a8f65793a`, rehearsal `2497519c5224ca2f7201cee0d8d12c1ea3751cdfa9696498965210f39d038932`. Product и постоянные документы не менялись.

**Ровно один запуск** начат 2026-11-05 08:32:07 UTC, output `/private/tmp/orbis-cutover-n.4azv5nkk`. Внешний watchdog ограничивал выполнение 180 секундами, с отдельным scoped cleanup. Watchdog SHA `3d444f16d5aa4c8f4ed4e8ef28b6e56731106c5aab0e33cb8c24602f1ab2046e`. Реальный wrapper exit **1**, watchdogTimedOut=false. Автоматических повторов нет; P не запускался.

## Фактический progress и новая граница

До запуска проверены прежние exact N container ID/image/label/loopback54344, реальный TCP supabase_admin/system ID `7704513346943397928`, exact0026, handoff f547cabba и оба pinned artifact JSON. Runner повторно проверил source/dist inventory и restricted runtime identity до Hono. Созданы новый synthetic owner/три notes/profile; прежние fixture не изменялись.

- Chrome/156.0.8078.80, reviewed pipe/sandbox/BFCache args, root PID8811/start `Thu Nov 5 15:32:13 2026`, новый `chrome.zJXZCP`.
- Первый origin request удержал настоящий старый HTML до любой origin page/SW registration, без CDP bypass. Есть оба natural-first markers и exact old HTML SHA `42e9d421c20b64083494dc38ae9e0558e305291a4540ee7e633c6f8c3579a0ef`. Held path `/r/4a05dc02-7a3d-45ce-820c-f677f83ce9eb`.
- Реальный старый Auth/0.6 entry/controller и old body edit прошли. Browser `entity.update` для `e73575e1-3f70-478b-bbb1-c9f876c85b82` остановлен перед upstream (journal seq21, forwarded=false). Legacy draft ожидался в actual UI. Это не injected writer.
- Отдельная запись b дала реальный BFCache roundtrip: token `0b9aa0bf-feef-46aa-ad00-c1a5b3cbce11`, pagehide seq2 persisted=true и pageshow seq3 persisted=true, same document/memory. Последующий away не объявлен вторым hide proof.
- Старый upstream остановлен/drained, stock current migration успешно применена. **Dedicated N54344 теперь0027**, уже не0026. Текущий real a0 Hono запущен, driver 0.6 request получил412 PRECONDITION_FAILED. Это driver412, не late browser412.
- Current main document допущен свежим HTTP и exact current entry/HTML. Следующее наблюдение — `AssertionError [ERR_ASSERTION]: null == true`. Сценарий не дошёл до маркера `visible-legacy-blocked-wipe`. В catch сохранена только строка ошибки; исходный стек был утрачен самим runner при rethrow. Raw message, runner.stderr и request journal сохранены без изменений.
- По исполнимому source после admission null-valued assertion соответствует `assert(blocked.drafts[0] && before.drafts[0])` (текущая строка713). Между ними currentWorker/toggle/pending-mode checks. Это source localization, а не дополнительно полученный original stack. Данных для заключения «текст потерян» нет: helper `store()` смотрит только один legacy LS key, тогда как current draft reader может после успешного native persist убрать scoped legacy source (`draft-storage.ts:393`).

Current wipe, late old HTML delivery, late controller verdict/old writer и browser412 **не проверены**. Held ответ отброшен в finally после FAIL. Закрытие context подтвердило исчезновение всех12 runner Chrome identities; внешний monitor записал28 собственных descendants включая upstreams/мигратор и имеет remaining=[]. Сигналы watchdog не потребовались. Собственные Chrome/HTTP/Hono процессы завершены, CPU/browser окно освобождено. N container оставлен running с0027, P не затронут (последняя проверенная база0026); никакого reset/truncate.

## Ограничение before/blocked snapshots

`before` и `blocked` были только JS local variables; этот runner не записывал их в raw. После graceful browser exit их точные значения в те два момента недоступны. Нельзя ретроспективно выдать closed profile за эти snapshots. Сохранён весь исходный disposable profile на месте и файловый manifest562 файлов с SHA/размером, но профиль не открывался для восстановления. Исходный RED сохраняется как есть.

## Smallest future assertion/provenance fix — source-only proposal

Новый N не предлагается. Известный исторический old-code counterexample остаётся основанием, current N не получает verdict. Для будущего P и его focused input checkpoints достаточно следующих узких изменений harness:

1. Перед переключением записывать полные synthetic `before` snapshots LS, native slots и server revisions в отдельный JSON checkpoint, а не только хеш. После blocked/retained состояния писать второй checkpoint **до assertions**; сохранять scope, LS key/raw, полный slot key/latest/snapshot/token/acknowledged и doc. Чтение IndexedDB только уже существующей DB, readonly transaction; отсутствие DB не должно создать её.
2. Использовать существующий semantic `requireDraftSnapshot`, расширив его provenance: native token.accountId=owner, graphId=owner, entityId=expected; revision basis равен исходному legacy baseRevision; непросроченный unacknowledged doc равен исходному. Записать generation/writerId/nonce/sequence, slot key и latest; при дальнейшей повторной проверке сравнить полный ранее наблюдавшийся token. При миграции из b5 нельзя выдумать исходный native token: до native adoption известны doc/basis/savedAt/legacy key, а новый token становится отдельной доказанной точкой provenance. Legacy branch проверяет owner/entity из точного scoped key. Нельзя принять чужой account/graph slot или acknowledged fallback за неотправленный ввод.
3. Заменить требование обязательного наличия старого LS row на наличие того же retained doc/basis в допустимом LS **или** native input slot. Проверки normal/pending mode, неизменённого server body/revision, zero unintended body POST и явного recovery/discard остаются. Само исчезновение LS row не является потерей ввода.
4. Future catch пишет readable redacted `error.stack`, name/message/operator/actual/expected и checkpoint ID **до** cleanup, затем rethrow с тем же redacted stack. Не терять первичную строку за новым `Error(message)` и не печатать DSN/credentials. Это только предложение будущего harness, current executed source/RED не переписан.

## P-only source design для следующего review

По указанию root использовать будущий correctness-fixed current candidate, новый accepted pin/byte-exact dist и общий с Safari build после scoped commit; a0 сейчас не подменять. P remains NOT GRANTED.

Предпочтение — natural-first-held сразу после `launch()` и до страницы a, без каких-либо bypass/reset на pending target. Fixture Finance/category/D2 остаётся реальным и подготовленным до браузера. Отдельный BFCache candidate b сохраняет точные before-nav latches/same-doc proof; он не посещает held path. После всех actual old input snapshots требуются bounded whole-context close, cancelled held navigation и исчезновение exact PID/start descendants, drain upstream. Лишь после зафиксированного закрытия всех old contexts можно discard удержанного сервером ответа, мигрировать и выполнить два законных CAS mismatch до current open. Если close/exit не доказан, фиксируется FAIL; cleanup discard разрешён после FAIL, но не превращает его в PASS.

Вариант «discard до выхода, затем закрыть» технически упрощает ожидание, но доказывает более узкую процедуру с принудительным proxy discard, а не neutralization pending work полным browser exit. Он не должен молча подменить исходный P. Предлагаемый natural-first вариант сохраняет реальный held pending на момент закрытия и не требует зависшего target reset. Никакой pending CDP reset, новых registry, injected writers или продукта. Source review и отдельный runtime grant обязательны; P/повторN не исполнялись.

Evidence `cutover-n-natural-evidence/SHA256SUMS`: `6292cad4aed944e412e1f869bfc983e2c66a79fd8c7a0c60929b585c7f316ed0`. Исходный thrown payload, exit, migration/server logs, request journal, process identities и closed-profile manifest входят в этот пакет. Проверено отсутствие admin/runtime DSN и паролей в перенесённых evidence files.
