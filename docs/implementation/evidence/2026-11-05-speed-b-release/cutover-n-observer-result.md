# Cutover N с исправленным наблюдателем

Единственный разрешённый запуск reviewed packet `b07dd775d905938aab48b5dd96b15130086bfc3f55b1a8aa95d788cb88e6e22d`. Raw `/private/tmp/orbis-cutover-n.5Xm4yX`. Перед началом перепроверены прежние exact N container/system/54344/0026, runner, handoff и оба artifact SHA. Новый owner/email/profile, старые RED и данные сохранены. P не запускался.

## Наблюдавшиеся факты

- Chrome/156.0.8078.80 успешно запущен через pipe. Фактические аргументы сохранили sandbox и исключили reviewed BFCache default. Root PID/start и начальные/последующие потомки записаны.
- Настоящая 0.6 прошла Auth fixture и открыла запись с фактическим old entry/controller. Старый edit helper прошёл ожидание legacy draft и настоящая browser body POST остановлена перед upstream.
- На самой b5 странице подтверждён BFCache roundtrip. Marker `4704d845-c7c7-4b46-a0a0-6bc04a58b691`, seq 2 pagehide persisted=true и seq 3 pageshow persisted=true, одинаковый документ, подтверждённые latched события и readonly память. Следующая навигация away записана отдельно, её скрытое состояние не засчитано вторым BFCache доказательством.
- Прокси получил и удержал настоящий old HTML по `/r/9af091d3-af3b-42b5-b5ee-c28cfff9776b`, точный SHA-256 `42e9d421c20b64083494dc38ae9e0558e305291a4540ee7e633c6f8c3579a0ef`. На этом progress остановился. Начиная с 13:54:39 не появилось `held-target-bypass-reset`. Между этими двумя маркерами исходник ожидает latch, ответ target `Network.setBypassServiceWorker(false)` и снимок процессов. Точная неосевшая операция без дополнительных внутренних маркеров не установлена.
- Upstream switch/миграция, текущий App, census/wipe, 412 и late writer не достигнуты. Старый held HTML не освобождался. Итога безопасности cutover нет.

## Остановка зависшей пробы

Scoped liveness подтвердил продолжение того же Chrome, runner и старого upstream. После сохранения live trace и census отправлен SIGTERM только повторно сверенной Chrome identity `96152/Thu Nov 5 13:54:27 2026` с точным disposable profile `chrome.992782`. Chrome завершился, но runner и upstream продолжали ожидание, внутренних final/error маркеров не появилось.

Затем отдельно подтверждено исчезновение всех 10 записанных Chrome process identities. Собственный old upstream PID 96147/start13:54:23 и runner PID 96138/start13:54:19 повторно сверены по точным command/profile/output и завершены SIGTERM. Wrapper наблюдал и записал **143**. Это внешний stop зависшего harness, а не обычное завершение сценария. `finally` request journal не получен. Собственные процессы завершились, личный Chrome и другие приложения не затронуты.

В `cutover-n-observer-evidence/` сохранены trace, stderr, exit, исходные preflight/command, stalled process census, оба решения scoped cleanup и summary. DSN/пароли не перенесены. Исходники runner и продукта после старта не менялись. Следующая правка или повтор требуют разбора source/transport и отдельного допуска; освобождение held ответа ради продвижения изменило бы проверяемую границу.
