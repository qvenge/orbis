# Safari · Повторная сверка причинной ACK-пробы

**Одобрено по исходникам для отдельного локального Mac-only окна.** Манифест `99311ff49a0e033a307aba0250354dab577f2943877e19dd8de58ff22f3ddd4d`, точная трёхфайловая дельта `157fe31a283bca5e530dfa079c3bbd9623e37194505f899a5df88590660bbbd0`. Все 12 entries совпали. Предыдущий source-only пакет сохранён.

Обязательные замечания к исходному стенду закрыты. DSN допускают только фиксированные local protocol/host/port/database/role без query/fragment overrides. Реальный запрос body update распознаётся по id, bodyDoc и положительной expectedRevision, отдельно от title/property ответов. Полные doc, body hash и receipt/tx/revision записываются до передачи ACK браузеру. Точный observed token проверяется по owner/graph/entity, writer/nonce/sequence/generation, revision basis и документу.

Фаза атомарно перекрывает новые authenticated target reads. Счётчик preexisting GET должен обнулиться до ввода. После наблюдения отправленного input контроль выпускает только ACK. Присланный из origin-check storage script снимок должен показать полный matching persisted bodyDoc/revision и отсутствие точного nonce среди native/emergency живых копий, пока GET остаётся закрыт. Лишь после фиксации snapshot hash открываются новые чтения. Browser storage сам control API не меняет. Это достаточный исходниковый барьер для требуемой причинной проверки.

Реальная поддержка storage и WebDriver, CSP и совпадение snapshot с наблюдаемым действием будут определены первым запуском. Потеря native store или fallback оставляет strict proof unavailable и требует отдельного описания actual retained ACK. Время ручного наблюдения не должно молча пройти 30-секундную выдержку текущего autosave; возможные повторы и timeout записывать фактически, без смены таймеров.

Синтетический session seed, one-hour JWT, probe-only connect-src self, ephemeral origin и backend outage сохраняют прежние ограничения. Mac/iPhone automation readiness не является результатом проверки приложения. Эта source-сверка не открывает iPhone app navigation, tunnel, ignore-TLS, deployed endpoints, installed PWA, ordinary Safari restart или внешний Auth. Root закрывает только свои sessions и восстанавливает временные настройки автоматизации обоих устройств после checks. [Шаги](safari-functional-stand/webdriver-steps.md).

Ни сервер, ни браузер, ни БД в этой сверке не запускались.
