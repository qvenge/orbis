# Исходниковая сверка pipe и Safari-стенда

**Pipe-пакет одобрен для единственной переданной попытки N.** Манифест `00f5ee22842b4524bf4d7c97d6a54f990de823f7b3bd2e92860c3f067b017101`, дельта `781cd20cfa994b651208ede37eeb186d1be195296ed589fd8df01a317451421e`, notes `2cc6efd3872fb2514a7ca8ac10618583a25f335cd3b332c20db4a8d6b8d77891`. Все source hashes совпали.

Переход использует public `launchPersistentContext` и точный профиль. Playwright 1.63/coreBundle закреплён SHA `549070af3acabb3efcc4f55bfe6210f9f7c2fcf633cf7eaa59bfe60719969171`. Исключён только явный BFCache disable, остальные defaults сохранены, Chrome sandbox включена. Проверка фактических аргументов, identity root/потомков и полного выхода оставлена обязательной. Failed startup cleanup адресует только тот же owned root с повторно проверенным временем старта и профилем. Старые N RED и их неизвестные причины сохраняются. Подключение pipe, возможности BFCache, lifecycle, proxy и CSP требуют фактической первой попытки. Подготовка P этим review не открывается. [Дельта](cutover-runner.pipe.diff).

**Safari-стенд имеет точный локальный scope, но причинный ACK-контроль требует малого барьера GET.** Манифест `941062d59fbc2f8e9f62a5496404e5b96243cf6aa9612743299718cc9963e8e8` проверен по всем 12 entries. Чистый source 356, принятый dist, loopback/roles и новый synthetic граф проверяются до HTTP. Каждый bootstrap и HTML получает probe-only `connect-src self`; descriptor и журнал не содержат JWT. Только exact own origin допускается к чтению probe JS. [Стенд](safari-functional-stand/README.md).

До заявления о прямом ACK→durable retirement:

- Запретить неожиданные query/fragment в обоих DSN, чтобы URL override не обходил фиксированные hostname/port/role.
- Удержать новые целевые GET и дождаться завершения прежних до отдельной body-правки. Реальный HTTP ACK отпустить при всё ещё закрытом GET. Снять полного документа/ревизии и точного nonce до/после, затем открыть GET. Иначе итоговый matched response мог прийти отдельным чтением.
- Для `body-ack` привязать запрос к actual body update fixture record и expected revision. Наличие bodyDoc только в ответе не отличает его от иной entity.update, которая также возвращает тело.
- До iPhone проверки наблюдать доступность собственного origin с физического устройства. Успех создания WebDriver session не доказывает доступ к Mac loopback. Расширение bind или networking не выводится из этой source-сверки.

Пробы Safari остаются ограничены текущей automation session. Backend503 не равен общему offline. Реальный Hono используется, а Auth refresh/login/logout и installed PWA здесь не проверяются. Перед завершением окна root обязан закрыть только созданные browser sessions/stand и восстановить временные настройки remote automation Mac/iPhone. Эти настройки и браузер не менялись ревьюером.

Запусков runtime, синтаксических команд, Docker, Chrome/Safari, сборок или БД в этом review не было.
