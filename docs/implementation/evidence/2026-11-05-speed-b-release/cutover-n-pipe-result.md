# Cutover N, первый запуск через pipe

Единственный запуск разрешённого пакета `00f5ee22842b4524bf4d7c97d6a54f990de823f7b3bd2e92860c3f067b017101`. Raw `/private/tmp/orbis-cutover-n.XoWeWY`. Перед стартом повторно подтверждены pinned Docker ID/Image/label/54344, system ID `7704513346943397928`, exact 0026, исходный partial seed и прежние handoff/artifact SHA. Новый fixture использовал независимые аккаунт/email и профиль. Wrapper сохранил exit 1.

Public `chromium.launchPersistentContext` подключился через pipe. Chrome/156.0.8078.80 получил правильный disposable profile. Фактические аргументы включают pipe, не содержат `--no-sandbox` и `--disable-back-forward-cache`, а retained disable-features list не содержит `BackForwardCache`. Root identity и начальные/последующие потомки записаны. В cleanup `context.close()` завершился, закрытие контекста и исчезновение всех отмеченных PID/start и процессов профиля подтверждены. Это доказательство scoped cleanup этого запуска, не состоявшегося cutover.

Реальный сервер b5 выполнил seedOnboarding и три note create, затем браузер открыл старый App и успешно прошёл собственный Auth fixture. Зафиксированы old entry `index-BJCcYD8v.js`, controller `/sw.js` старого поколения и реальные browser API 0.6.0. Edit helper прошёл ожидание маркера в legacy draft и зарегистрировал настоящую попытку `entity.update`, остановленную перед upstream.

Остановка произошла при подготовке BFCache-кандидата. После перехода с нетронутой старой записи на нейтральную страницу runner не нашёл event `pagehide` в своей console-based коллекции и выдал `No pagehide observation for old BFCache candidate`. В trace нейтральный `pageshow` приходит после записи сценарного отказа. Исходник читает массив событий сразу после `page.goto`, без отдельного ожидания доставки lifecycle observation. Это подтверждённая слабость наблюдателя, но сырые данные не устанавливают, был ли документ сохранён в BFCache или его console event вообще мог быть доставлен этим путём.

Held latch, переключение upstream/миграция, 412, shared-on и допись после purge не достигнуты. Положительного или отрицательного cutover verdict нет. Сценарий P не запускался; оба контейнера остаются на подготовленной схеме 0026. Новых изменений runner или продукта, повторов и дополнительных Chrome проб после отказа не выполнялось.

Возможный следующий source-only разбор должен отделить событие браузера от задержки доставки консоли: ограниченное ожидание маркера и, если оно не даёт доказательства, прямое подтверждение BFCache на реальном возврате с чтением lifecycle массива из памяти восстановленного документа. Проверка не должна писать тестовые legacy keys или считать timeout доказательством отсутствия BFCache. Точная форма требует отдельного решения root и прежнего reviewer.

Сырые журналы и манифест в `cutover-n-pipe-evidence/`. Временные DSN и пароли туда не перенесены. Прежние N RED сохранены.
