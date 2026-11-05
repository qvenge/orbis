# Cutover N, один согласованный повтор

Сценарий запущен с reviewed packet `bc53016432fe897aeb6d9edeb9e067563bfc130ed8f10e8c8ba8e793dca7e5e3`. Точный raw run `/private/tmp/orbis-cutover-n.wk7qhl`. Перед запуском подтверждены все шесть хешей runner, pinned N handoff и оба artifact JSON. Actual admin TCP доказал `postgres | supabase_admin | supabase_admin | internal 5432 | system 7704513346943397928 | exact 0026`. Docker name/ID/Image/label/published port совпали с прежней выдачей. Предыдущий частичный аккаунт по исходному синтетическому email ещё присутствовал ровно один раз. Новый запуск использовал независимый UUID аккаунта, email и temporary profile. P не запускался.

## Результат

Wrapper сохранил **exit 1**. Настоящий сервер b5 открылся с проверенной ограниченной ролью. Все четыре seed операции нового графа прошли HTTP 200 через реальный tRPC с 0.6.0: `user.seedOnboarding` и три note create. Категория и D2 в N не запускались. Входных ошибок первого окна больше нет на этом участке.

Следующий этап остановился на подключении Playwright к DevTools одноразового Chrome. Chrome сообщил точный адрес `ws://127.0.0.1:64766/devtools/browser/…`, HTTP discovery вернул этот адрес. На WebSocket handshake пришёл **HTTP 200 OK**, а не upgrade. В Chrome log на том же `/devtools/browser/…` виден `GetMimeType doesn't know mime type … text/plain`, что подтверждает попадание в обычный HTTP handler. Журнал запроса содержит только четыре driver seed операции. Продуктовый браузерный документ ещё не запускался. Old/current switch, BFCache, held request, 412, purge и legacy writer в этом повторе не наблюдались. Неподтверждённый cutover остаётся блокером.

Runner инициировал cleanup для собственного Chrome child в ветке failed startup и собственного upstream. Отдельное доказательство полного browser PID+start census отсутствует, потому что подключение закончилось раньше этого этапа. На точном DevTools порту после выхода слушатель не наблюдался. Личный Chrome не затрагивался. Утверждения о рабочей CDP Auth interception и браузерном proxy из этого RED не следуют.

## Узкий диагноз

Сбой находится на harness transport между discovery endpoint и CDP WebSocket, до доступа к приложению. Из сырых данных не следует, почему Chrome обработал запрос как обычный HTTP. Возможны несовместимость Bun/Playwright WS на этом участке или потеря upgrade в транспортном клиенте. Проверка исходника `playwright-core` показывает отдельный обработчик unexpected-response, именно эта ветка отдала зафиксированный 200. Произвольные флаги Chrome, сетевые bypass или изменение приложения для прохождения не проверялись.

Для следующего согласования практичен тестовый pipe transport через уже использованный на этой же машине `chromium.launchPersistentContext`. Он должен сохранить root/descendant PID+start проверки по точному одноразовому профилю, включая доказанный выход после `context.close()`, и оставить Auth/CDP/proxy/held guards. Это предложение к проверке исходников, не выполненная правка. Другой вариант требует отдельного минимального разрешённого WS диагностикума с той же парой версий без БД и product fixture.

Повтора и запуска P не было. Доказательства в `cutover-n-repeat-evidence/`, секреты подключения не перенесены.
