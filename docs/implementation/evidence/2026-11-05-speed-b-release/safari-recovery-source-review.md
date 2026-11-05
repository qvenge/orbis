# Safari · Продолжение проверки восстановления ввода

**Точный клиент одобрен по исходникам для одной переданной попытки существующего root Mac-сеанса.** Client `d02e3febc814d57a4582ff75d3aabe5bddf2848967788453433f9a1688fe7213`, README `df914ab3006680b194db2026b3f98dc29f1769d2f2148ac943331960e3db712a`, манифест `869a49600d587aa0164d3fa4425fdf7f25810936e6e1a0ec8d82e1efec35553b`. Все шесть hashes совпали.

Проверки ограничены собственными descriptor origin/record и выданным session ID, source356 и принятым manifest. Предыдущий strict ACK должен быть завершён с открытым GET, исходная серверная ревизия/полная bodyDoc совпадают, живой input отсутствует. Перед каждой ограниченной фазой проверяется исходный срок JWT. Ни новый session, ни settings, ни искусственные storage данные не создаются.

Дальнейший сценарий сохраняет actor-generated ввод. Same-session reload A проверяется с нулём body POST. Backend503 допускает фактическую отправку, но сервер остаётся A; полный документ B и точный scope/writer/sequence/generation/nonce/basis снимаются из браузера. Повтор reload проверяет persisted A и тот же B. Само равенство видимого тела A в этой ветке не asserted, поэтому в отчёте следует опираться на фактический `visibleBody` сохранённого снимка.

Контроль CAS создаёт настоящий C через production caller при закрытом браузерном API. После возобновления до явного жеста проверены C, исходный B/предложение и отсутствие POST/перезаписи, включая штатную паузу debounce. Затем WebDriver нажимает поддерживаемую кнопку баннера. Новое полное B, одна успешная ACK, matching durable response и исчезновение именно B nonce проверяются без direct fullDoc GET после жеста. Это проверка штатного recovery. Прежняя strict-проба отдельно доказала причинную запись ACK до GET.

Фактический результат ещё не получен. Lifetime automation session, own backend outage, исключённый внешний Auth и полевая/installed PWA граница сохраняются. Root обязан закрыть только свои sessions/stand и восстановить временные automation settings. Своих запусков браузера, driver, SQL или сервера в этом review не было. [Клиент](safari-functional-stand/recovery-client.py).
