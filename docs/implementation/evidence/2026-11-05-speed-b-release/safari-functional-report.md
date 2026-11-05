# Safari Mac — фактическая локальная функциональная проверка

Mac Safari26.2, принятый runtime356a610f, normal build manifest15144519…; отдельный синтетический owner/record на local54339, real Hono и ephemeral127.0.0.1:51083. Safari/WebDriver управлял root. Автор стенда создавал только согласованную фикстуру и loopback backend. Порт54321 был занят и не использовался. Синтетический JWT был введён только в отдельный origin, probe CSP connect-src self блокировал занятый Auth origin. Внешняя авторизация и реальные пользовательские аккаунты в проверке не участвовали.

Root наблюдал реальное приложение, запись, редактор, активный service worker, CacheStorage, IndexedDB и navigator.locks. Начальный persisted response содержал полный документ/rev1, inputs были пусты. Capabilities, DOM и screenshot сохранены в пакете. Эта проверка относится к Mac automation session. Приложение на iPhone здесь не запускалось.

## Строгая проверка ACK

Первый client2524966f завершился exit1 на начальном KeyError bodyDoc до арминга/ввода. Причина — state endpoint читает include body и не отдаёт bodyDoc. Runtime и данные этим запуском не изменились. Исходник и raw strict-ack-36ac1dd4 сохранены.

Исправленный client0bb57187 выполнился один раз и прошёл, exit0, raw strict-ack-1b238d03. Перед арминговой фазой он получил полный server bodyDoc одним реальным own-origin entity.get include body/bodyDoc с существующей синтетической авторизацией. Credential оставался внутри браузера и в пакет не включён. Реальный полный документ и ревизия совпали с диском.

Новые target entity.get удерживались, старые были дренированы. Фактический BODY request, его полный bodyDoc/expectedRevision и actual ACK были сопоставлены с observed input nonce01a1aa6d-114c-7686-8c48-ddb13447df4f, basis rev1. После освобождения только ACK полный документ стал durable и точный токен был снят ДО разрешения GET. HeldTargetReads0, receipt hash5fa7f719…, durable snapshot hash75435206…. Это причинное подтверждение записи ответа, независимое от возможного matching GET.

## Продолжение восстановления

Continuationd02e3feb выполнен один раз. Ранние этапы прошли:

- Сохранённый A пережил reload в той же Safari automation session.
- При ответах503 только своего tRPC backend был введён B настоящим WebDriver sendKeys. Пойман полный pending document и точный token, сервер оставался на A.
- Reload при503 сохранил cached A и exact B.
- Согласованный control выполнил настоящий foreign CAS C, сервер перешёл на rev3.
- После восстановления backend/reload показан C и плашка B. До явного выбора автоматического body POST и перезаписи C не наблюдалось.

Этап explicit-supported-recovery завершился RED по 18-секундной границе клиента. WebDriver ответил200 на штатный click кнопки «Оставить моё», но последующего entity.update и ACK в HTTP trace не было. Видимый C3 и плашка B остались. После таймаута root снял DOM/storage/visibility: visibility visible, focused false, кнопка доступна, native alert отсутствовал. Последний input snapshot содержит точный B nonce01a1aa8e-d07e-7002-838d-ed8edd4397bd. Root сохранил это до закрытия Safari session.

Причина не установлена. По этому запуску нельзя отличить непринятый жест от guard/runtime поведения. Здесь нет утверждения о подтверждённом дефекте продукта или успешном explicit recovery. Повтор и ослабление проверок не выполнялись. JWT истёк после failed window; root прекратил дальнейшие write attempts и закрыл свою Safari session с HTTP200. Это не испытание глобального offline, normal browser-profile restart или установленной PWA.

## Конечное состояние и завершение стенда

Перед завершением была предпринята одна попытка чтения финального HTTP state. Loopback51083 уже отказывал в соединении, exit7. PID93866 уже отсутствовал до любого сигнала. Exec session57299 также была недоступна; фактического launch.exit нет. Причина исчезновения процесса и его exit code не установлены. Сигнал другому PID не отправлялся, новый сервер не запускался. Повторная read-only проверка подтвердила отсутствие PID и listener51083.

Отдельное чтение единственной собственной записи через production withIdentity прошло, exit0, effective authenticated/session orbis_app. Фактическая БД содержит полный C bodyDoc и bodyRevision3. Граф и данные не удалялись. Свежего финального HTTP snapshot получить не удалось. Последний сохранённый HTTP log и root snapshots до закрытия Safari оставлены как свои наблюдения, не подменены данными после закрытия.

## Пакет

Путь public evidence записан в safari-functional-packet.path. В нём allowlisted Mac fixture data, исходники, исходные RED, strict PASS, partial continuation RED, root snapshots, HTTP trace и конечное DB proof. Исходные private raw остаются в /private/tmp/orbis-safari-functional.DBIeYK. В копии исключены bootstrap URL/nonce и credentials, метаданные устройства и реальные phone IDs не переносились. ID изолированного Mac WebDriver-сеанса оставлен в исходах клиента. Synthetic input tokens сохранены как требуемое доказательство. Маскирование выполнено только в новой копии; оригиналы не менялись.

Манифест safari-functional-evidence.sha256 SHA51069c70e96c437243ce7841d50c02f14ef515e7620786eb409db79bae84729e. Действующий запрет release/main, прежние performance RED/deferred и внешние/полевые ограничения остаются отдельными открытыми условиями. Установка или выключение Safari automation/driver принадлежит root и этим cleanup не выполнялось.
