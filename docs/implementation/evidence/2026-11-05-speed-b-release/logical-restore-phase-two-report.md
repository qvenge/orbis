# Б13 · Восстановление после 0027, каталог и новый XID под старым порогом

Выполнено после согласования координатора и независимой сверки `c553c82b…` на прежнем выделенном TARGET `127.0.0.1:54343`, Docker ID `ac87003ee607a16065ca91192394987cf2bbd04d41826e68cde40d85d053928f`, system identifier `7704502933634711586`. SOURCE и остальные БД в этом окне не менялись.

## Каталог

Применены ровно согласованные `catalog-repair-proposal.sql` `ada90f29f127d52d74fd39faa1d1548c78e944f30bdd738c151269b6cc8ecf78` и `acl-proposed.sql` `9e63ef542939dd175f252bf6f97ddbee13eeb5fa0c33f51caf82d66befc7b512`. Для второго имя входа runner `acl-reviewed.sql`, байты совпали с proposal. Обе операции exit 0, каждая в своей транзакции после проверки database/current and session role/system identifier и Unix socket в том же psql. Новый режим `catalog-repair` не переименовывает DDL в ACL, допускает только один закреплённый digest. Runner SHA `d0767fa7da64d242e5a6c7e88f054d3b0ff6c32b08ea2a004fd5fcedc87a4e36`, true mode-only diff `83c1c90b448b68141917339680b69c1336d05f39551694eb2ca92c5a7fdccbc9`. Перед запуском `.Image` обеих целей ещё раз совпал с известным локальным образом. Bash outer/embedded syntax checks прошли.

Сырой diff до записи witness `4ae63d8c73a197a0cd7322415c88aa77216f865cc275284c74a00bcf2da39580` отличается только ожидаемыми различиями. System identifier и xmin различны, TARGET не получил оставшуюся от передачи owner неэффективную membership `supabase_admin → orbis_change_feed_owner` с INHERIT/SET/ADMIN=false. После удаления ровно этой строки и двух динамических границ из сравнения совпали все 304 строки каталога. Это включает владельцев схем/таблиц/последовательностей/функций, флаги роли, object/column/default ACL, policy/RLS/FORCE RLS, function definitions/search_path, триггеры, pg_cron 1.6.4, обе jobs с теми же command hashes, активностью и владельцем. Сами задания в этом окне не запускались.

Бизнес-манифест 27 объектов/251 строки до и после каталожного ремонта побайтно равен источнику `42e9c9a6401b7e00ff688a58266c7f7a4d44d8173b55a9d8444c8c1882b2d10c`. Старая лента оставалась `84|1131|5252`, floor 5250.

## Закоммиченный low-XID witness

Изолированный probe в архивной копии точного 356 использовал настоящий runtime `orbis_app` и `withIdentity`. A увидел только свой graphId, B только свой, authenticated без claims получил пустые feed и floor. Проверка effective privileges отвергла прямые INSERT/UPDATE/DELETE/TRUNCATE ленты, UPDATE порога и EXECUTE helper/capture для runtime authenticated. SQL не подменял штатный писатель.

Одна штатная `entity.update` с CAS ожидаемого заголовка закоммитила TARGET TX 1001, оставив body revision 3. После commit независимое административное чтение увидело событие update этой записи (feed id 86) и journal insert (id 87) с тем же TX/graph. Владелец через настоящий `changes.reconcile` получил:

- От свежего target from 1001 — `floor/provisional`, W2 1002, floor 5250 и пустой список событий. TX 1001 уже ниже W2.
- От старого source from 5253 — `future-cursor/complete`, тот же W2 и пустой список. Продолжение от принятого 1002 — снова `floor/provisional` без TX 1001.

Это воспроизведение второго независимого RED — захват событий и эксплуатационный каталог исправны, но импортированный порог скрывает реальный новый commit. Bun probe exit 0, 1 PASS / 0 FAIL / 27 утверждений. Новый TARGET business manifest после witness `17409c137c3936dd51155023e01c8f635d781784e8e9013e8ad43e7f2dd07266` нужен как preimage rebase. Только `entities` (51→51), `action_journal` (7→8) и `action_journal_entities` (10→11) изменились.

24 файла `/private/tmp/orbis-b-restore.oE4t8P/phase-two-evidence.sha256`, SHA `365f2cc8c37fbe2227dab986005b59908e69fd5b99dc324780d704151e41b862`, все хеши первого и второго пакетов сверены, сырые локальные секреты отсутствуют. Проба закрыла соединения. Остановка перед rollback control, rebase и минутным тестом scheduler. Подготовленные SQL, данные пользователя, production, Chrome и постоянный runbook этим окном не менялись.
