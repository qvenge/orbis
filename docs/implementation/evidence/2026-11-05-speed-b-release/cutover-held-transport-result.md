# Один benign held-navigation transport control

Исполнен ровно один разрешённый контроль, без App, Auth, SW и DB. Raw: `/private/tmp/orbis-cutover-held-control.gcbjechz`. Новый disposable profile, два loopback HTML origins и отдельный deny-egress proxy. Исходный пакет `5f5c503cfb458d59f0afc05c5c12033959132674b5b018b0489cd8fad7bcde78` сохранён неизменным в `held-transport-control/source.sha256`. Базовый reviewed N runner b07 и прежние raw не изменены. До запуска записаны SHA preimage observer/rehearsal.

## Локализованная граница

Chrome/156.0.8078.80, reviewed public persistent pipe, sandbox включён. Удалён только ранее reviewed BFCache-disabling default; остальные defaults сохранены. Браузер PID 1564/start `Thu Nov 5 15:05:28 2026`, exact disposable `chrome.Go9E2F`. Начальные и последующие descendants собраны, включая helpers без profile flag.

1. На нейтральном документе созданы target CDP и отдельная browser CDP session. `Network.enable` и bypass=true завершились.
2. Настоящий HTTP `/held` удержан до отправки response headers. `arrived.promise` завершился; маркеры before/after присутствуют.
3. Отправленный после latch target `Network.setBypassServiceWorker(false)` не завершился за **6000 ms**. Зафиксирован `failed-await` именно этой операции, до любого cleanup/discard.
4. Event-loop tick продолжался каждую секунду. После FAIL browser-level `Browser.getVersion` ответил примерно за 2 ms, process census — за 98 ms. Значит общий JS event loop, browser pipe и ps/census на этой границе оставались работоспособны. Это не доказывает внутреннюю причину в Chrome/Playwright и не устанавливает универсальную невозможность CDP reset: конкретная pending-target команда не получила ответ в этом контроле.
5. Только после записанного FAIL сервер отбросил held response с 410. Navigation завершилась HTTP error. Освобождение не использовано как PASS held-контрпримера. Позднее завершение исходной target CDP команды отдельно не наблюдалось.
6. Штатный context.close завершился, closing event и исчезновение всех **11** накопленных runner Chrome identities подтверждены. Независимый внешний watchdog успел засэмплировать 10 identities; remaining=[] и watchdogTimedOut=false. Wrapper записал exit **1**. Принудительные сигналы не понадобились.

Внешний watchdog имеет собственный 90s предел и право signal только сверенным PID+start собственных Chrome/runner; он не сработал. Окно Chrome/CPU освобождено. Никакого нового полного N/P, миграции, seed или app-запроса нет. Нейтральный контроль не является доказательством cutover или BFCache приложения.

## Предложение для source review, не применено

`cutover-n-first-navigation.PROPOSED.diff` предлагает узкую N-only альтернативу. Сразу после запуска чистого профиля, до любого origin-документа и регистрации SW, начать held navigation естественным HTTP путём **без CDP bypass**. Проверить все текущие targets about:blank, дождаться настоящего old HTML proxy latch и оставить ответ удержанным. Затем обычная old visible страница выполняет Auth/body input/SW; отдельный BFCache candidate открывает существующую запись `b`, а не held path. Три notes и остальные исходные условия сохраняются. Никаких новых legacy writers или storage injection.

Late document после release по-прежнему обязан предъявить собственный controller/protocol. Если он не имеет protocol1, результат обозначается только same-origin held-old-code race; initiator controller не переносится на него утверждением. Предложение не обещает new controller и не переписывает классификацию. P path этим N-only предложением не исправлен: его прежний pending-reset остаётся явным blocker до отдельного решения о natural-first-held или discard+close sequencing. P не запускать как будто runnable.

Альтернатива оставить bypass и не await reset до N release/P discard+close возможна лишь с честно ограниченной controller claim, но текущий контроль не доказывает надёжность такой отложенной команды. Поэтому предпочтителен source review естественного первого запроса без reset, прежде чем давать новую app-пробу. Изменение не применено к reviewed runner и не исполнялось. Большой transport rewrite и Bun-cause не предлагаются.

Evidence manifest: `cutover-held-control-evidence/SHA256SUMS`, SHA `3fec545349aa67b15e9772df7081e0035471d0eaa985c3533722d8f4321da321`. Proposal SHA `1f7754b76478af42b4ac0f856f005cb322bfe6bffad2cfac339bdbaa3b6a0c55`. Реальный reviewed `rehearsal.ts` остаётся SHA `a76549c588ed5c2c8fc9333ead10f0de0712a7b6aa40e8516d09629f96f31f0d`.
