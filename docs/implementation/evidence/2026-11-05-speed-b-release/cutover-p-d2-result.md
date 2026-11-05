# P2: old quiescence/CAS proved; current browser restart blocked

Одна approved P71021834/88a46db0 попытка выполнена09:45:20–09:46:19 UTC, raw `/private/tmp/orbis-cutover-p.pwk1qtlm`. Actual runner/wrapper/watchdog exit1, watchdog240s не сработал. Первый P raw/RED сохранён; повторов/reset/N после результата нет. Frozen executed source отдельно: `cutover-runner-p-executed-d2/`.

Fresh exact P preflight подтвердил containerdf2/image650/labelp/loopback54345, system7704513601507176482, DBpostgres/admin TCP и0026. Admin/postgres flags t/f, restricted orbis_app flags/authenticated/negative privileged membership прошли. Exact oldb5 и currentc7 source/dist/JSON/handoff hashes проверены; build не повторялся.

## Что фактически доказано

- Actual old0.6/Auth/body A/B UI edits выполнены, body POST gated до upstream. Новый owner `0d34368a-d2f7-49ca-8a11-eaebc869a670`.
- Здесь реально наблюдался chip «Про: Cutover b». Он снят поддержанной кнопкой, перед submit дважды подтверждён no-chip. Это доказывает исправленный prerequisite этой попытки, но не назначает chip причиной прежнего P, где его не записали.
- Actual browser fast_path create seq47 gated; AI-route в D2 отсутствует. Legacy queue содержит original UUID `01a1ab19-a935-73cd-8632-1d1562433c63`; все gated D2 payload hashes совпадают с полным canonical payload `6e854ff8712809fb8f22cf0e8c9894577bb81d74cdaa4a7bf9cc349b76a11c16`. Financial aspect/category и empty financial/action baseline прошли. Public UI показала «Ждут отправки:1» и финансовые поля; формат только наблюдался.
- Сохранены четыре полных readonly LS/native checkpoints: до precondition, перед submit, после queue, перед old exit. A/B doc hashes и bases1 находятся в raw; original server bodies/revisions оставались Original a/b,rev1.
- Actual BFCache roundtrip b: token28c9c4a2…, seq2 pagehide/seq3 pageshow, persisted=true, same document/memory. Второй away не назван ещё одним hide proof.
- Whole old Chrome22121/start16:45:30 со всеми14 записанными identities штатно завершён **до** discard held old HTML, drain/migration/CAS. Held navigation cancelled, proxy discard после exit. Именно planned positive quiescence order, не failure cleanup вместо него.
- Stock migration0027 применена, currentc7 real Hono поднят. Driver0.6 получил412. Два законных CAS до current browser open дали Server CAS0/1,rev2/2, несовпадающие с draft bases1. P54345 теперь0027.

## Первая новая граница

Первый restartOrdinary `launchPersistentContext` того же disposable profile завершился Timeout18000ms. Current-документ не открылся: current browser requests=0. Original stack/full Chrome calllog сохранены в original-failure.json и trace. Current entry/own SW/controller/startup ordinary-vs-assisted, native input adoption, explicit recovery A, retained/discard B, D2 replay exactly once и purge/reopen не проверены. **Local positive cutover verdict отсутствует.**

Failed restart PID22283/start16:46:00 дал pipe-read EOF stderr16:46:01, allocator warning и CVDisplayLink -6670 в16:46:02. Успешный первый launch сохранял version/args/process census, но не полный stderr; нельзя утверждать отсутствие тех же warnings при успехе. Exit0 line не имеет timestamp; explicit Playwright kill/graceful-close markers в failed calllog отсутствуют. Pinned Playwright source создаёт новый child/pipe на каждый launch и отдельно выполняет timeout cleanup. Эти данные локализуют повторный browser launch, но **не доказывают** Bun, allocator, display/lock или profile-lock причиной. Pipe EOF предшествует18s deadline по embedded Chrome timestamp; момент exit и его causality не установлены.

После cleanup Singleton* отсутствуют, profile.exit_type=Normal. Это только final profile state: до/после original old-exit Singleton snapshots не снимались. Все8 failed-startup identities устранены scoped startup cleanup, внешний monitor remaining=[]. Собственные Chrome/Hono/proxy/runner завершены, CPU/browser free. Forced watchdog signals не понадобились. Closed profile469-file hash manifest сохранён, профиль не переоткрывался.

## Следующий узкий шаг и предел resume

Root запросил source для одного benign sequential-relaunch control: новый blank profile, exact public pipe/PW/Chrome/options, deny-egress; launch→close+all-PID-gone→second launch same profile→close, обе stderr и timestamps/census/Singleton snapshots, прежние18s deadlines, общий60–90s+scoped cleanup. Без App/Auth/DB. Контроль отделит повторный launcher от Orbis; это не третья P. Его runtime пока не разрешён.

Faithful P2 resume закрыт: graph/IDs/input checkpoints, exact profile/origin `http://127.0.0.1:64408`, currentc7 manifest2ec1888a, container/system/0027/CAS bound. Но synthetic Hono JWT signer — два randomUUID только в памяти завершившегося runner; ни private DB env, ни ready files его не сохраняли. Нельзя восстановить тот же signer или незаметно менять Auth/scope и объявлять continuation исходной P. Root эту ветку остановил. Новой auth/resume архитектуры не предлагается.

N54344 ранее0027 и P54345 теперь0027 оставлены с evidence/fixtures, не reset/truncate/delete. Другие DB/профили/Safari не тронуты. Исторический old-client counterexample и обязательная operator quiescence boundary не отменены. Нет Safari/iOS/PWA field PASS или разрешения release/main.

Evidence `cutover-p-d2-evidence/SHA256SUMS`: **c07da971bf1e2c870e445379d833241e6b56ddc42f4fb620f381640f0fed249c**. Original failure, actual exits/timestamps, migration/journal/D2 route, четыре input checkpoints, process/profile manifests сохранены; перенесённые файлы проверены на отсутствие DB DSN/password. Никаких product changes/commits/повторных runtime после failure.
