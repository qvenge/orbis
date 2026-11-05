# Первый P: до D2 prerequisite, без verdict безопасного перехода

Ровно одна root-approved actual HEADLESS P попытка выполнена на frozen source `e23e19ab261435bb18597a46275374b0ea19de1c499d99595cd1070bfdf4c942` / watchdog `d22a7c3ce29b9d2c2b42b31e688b2c7471a14459b4de795e10dbe7c292e4dfda` после SafariCPUfree. Source/SAME53f893ca и root-approved P handoff `1ce082ae…`, current JSON `2ec1888a…` не менялись. Никаких N, reset или повторов.

Raw `/private/tmp/orbis-cutover-p.pvxxid4n`. Начало 2026-11-05 09:17:53 UTC, конец 09:19:03 UTC. Actual runner/wrapper/watchdog exit **1**; watchdog240s не сработал. Ошибка зафиксирована на первом новом prerequisite. Product/постоянные документы не менялись.

## Preflight и пройденные фактические условия

Fresh preflight до seed/Hono подтвердил exact P container `df2b9c20578cfbc3ba64cd2b494b0de214ef4758ddb1c89081a23488bd7af770`, image650184…, labelp/sole loopback54345, system ID `7704513601507176482`, DBpostgres/login supabase_admin, exact0026. Реальный TCP admin superuser=true, postgres superuser=false. Реальный runtime orbis_app имеет все шесть restricted flags=false, authenticated MEMBER=true и privileged MEMBER=false, включая capture role при его наличии. Admin DSN не передавался серверу.

Проверены immutable старый b5/source/dist и current c7:2132 Git blobs/130 dist, нормальная localhost54321 Auth config и actual c7 build ID. Current runtime в этой попытке не запускался. Browser Auth перехватывался точным CDP fixture, остальные browser внешние запросы ограничены deny proxy; существующий localhost54321 не использовался.

Реальный driver b5 включил Finance OFF→ON через user.setModuleEnabled с проверкой mask. Registry/flat query вернули настоящий Transport с aliasтакси. Уникальный graph `043f53d7-4d00-40b6-a1bb-6fc8e7471e90` имел0 финансовых движений и0 fast_path actions до browser ввода. Никакой вручную созданной категории/очереди или fake tRPC.

Chrome/156.0.8078.80 запущен reviewed pipe, sandbox включён, удалён только reviewed BFCache-disabling default. Root PID17976/start `Thu Nov 5 16:18:12 2026`, новый disposable `chrome.1sy5qh`. Первый origin request удержал actual old HTML `/r/323b42a1-e429-402f-bc61-dbceaa10b3fe`, exact SHA42e9d421…, до origin page/SW и без bypass/reset. Actual old Auth/0.6 entry/controller, два UI body edits и ожидание их legacy drafts прошли. Настоящие browser body POST остановлены перед upstream: seq28/A=`e46c8b66-01a0-41f4-b1d2-104f41ef5fd2`, seq37/B=`fc6ccf04-8459-42dd-83ed-d42acb4f1d28`.

## Точная первая ошибка и предел причинного вывода

После actual перехода на `/chat`, ввода `такси 500` и обычного submit runner ждал `orbis:retry-buffer:v1:<owner>` в LS. Через18000ms `waitForFunction` завершился TimeoutError, точный original stack указывает `rehearsal.ts:1007`. Он сохранён в `original-failure.json`, trace и stderr. Новых исходников после failure не применялось.

Request journal содержит actual browser `ai.sendMessage` seq46 с HTTP200; **ни одного browser entity.create/fast_path** нет. Три entity.create относятся только к driver seed notes. Поэтому исходный create transport gate/D2 retry/replay вообще не упражнялся. Нельзя объявить отсутствие ожидаемой очереди потерей ранее поставленного D2: постановка в D2 не доказана.

Bounded source analysis exact b5 даёт различимые пути, но текущий raw не выбирает один из них:

- ChatPanel75–76 при ненулевом composer context вызывает submitWithContext, а useFastPath367–373 прямо отправляет такую строку сразу агенту, обходя parser. Старый экран читает контекст из сохранённой navigation model. Composer имеет `data-testid="composer-context"` и обычную кнопку `aria-label="Убрать ссылку"`.
- Без контекста submit также отправляет AI, когда parseFastPath неуверен. Context chip и AI request body текущий harness отдельно не записывал.

Фактический AI вместо create подтверждён. Context precondition gap — source-supported кандидат, не доказанная единственная причина. Не назначаем Finance-off/enum/Chrome/transport причиной вопреки actual Finance/Transport guards. Малый будущий source seam мог бы явно записать/снять composer chip обычной UI перед D2 submit, подтвердить отсутствие chip и сохранять readonly input checkpoint ещё до D2 prerequisite. Сейчас это только предложение, ни patch, ни повтор не выполнялись.

## Что не проверено

BFCache candidate P, normal old-exit order, pre-switch native/legacy checkpoints, migration/current startup, два CAS mismatch, explicit draft A recovery, B retained/discard, original D2 replay exactly once и shared purge/reopen **не достигнуты**. Нет local-positive verdict, ordinary/assisted startup verdict или field Safari/iOS/PWA proof. Исторический held old-code counterexample сохраняется; он не отменён и не требует бесконечного повторения N.

Checkpoint files `*.input.json` ещё не были созданы: первое место их записи расположено после D2 prerequisite. Exact JS snapshots до/после не выдуманы задним числом. Сохранён закрытый final disposable profile на месте и SHA/size manifest441 файлов. Он не переоткрывался и не выдаётся за point-in-time before-state; UI edit helper/body gate — отдельные фактические свидетельства ввода.

## Cleanup и оставшиеся ресурсы

FAIL finally отбросил удержанный ответ **перед** graceful context.close. Это failure cleanup; его порядок отличается от положительной P-процедуры close+all-PID-exit→discard и не считается её PASS. Context closing event и исчезновение всех12 накопленных Chrome identities подтверждены; внешний monitor записал25 своих descendants, remaining=[]. Принудительные сигналы/20s cleanup fallback не понадобились. Own Chrome/Hono/proxy/runner завершены, CPU/browser окно освобождено.

P dedicated54345 оставлен с0026, поскольку migration branch не вызывалась; новые synthetic seed/body/chat данные не удалялись. N dedicated54344 остаётся ранее0027, в этой попытке не затрагивался. Оба containers оставлены для evidence, не удалены. Другие DB54339–43/профили/Safari не затронуты. Для реального verdict ещё нужна отдельная разрешённая positive процедура с исправленным наблюдаемым prerequisite, актуальным reviewed source и fresh guards; этим отчётом запуск не запрашивается и не подразумевается.

Evidence `cutover-p-first-evidence/SHA256SUMS`: **92857e6675af6350200cb16a7097f9405fc246b98dd6e4166dcef007b74a128b**. Включены original failure, actual exits/launch timestamps, preflight, full journal/trace, source/watchdog hashes, закрытый profile manifest и явный пустой input-checkpoint inventory. Перенесённые evidence проверены на отсутствие admin/runtime DSN и паролей.
