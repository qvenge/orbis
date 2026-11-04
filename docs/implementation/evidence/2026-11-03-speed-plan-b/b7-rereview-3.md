# Узкое повторное ревью Б7, fix 3

**PASS узкого повторного ревью.** P2 из rereview 2 закрыт. Новых замечаний по однопутевому delta нет.

База `28c1f5952f320ccbb1b25928fc43c31cd5a957f1` + 40 файлов Б7 + три adopted leaf Б12. Все 43 SHA-256 совпали в рабочем дереве и exact archive `new` из `b7-fix3-exact-build-path.txt`. Единственный путь с новым хешем относительно fix 2 — `apps/web/src/lib/local-data/browser-lifecycle.ts`. SHA-256 `b7-fix-3-hashes.json` — `df1301f583ab96b6cb255c3f648be7c311c260531c36ae52419d30200d0b9913`; true delta — `a155d2e43b10e321951961e2ab5c47be6a9e16006a3816ec6cf450eeabda2c64`. Незавершённые Б9 и Б12 не использовались. Product files не менял.

## Проверка изменения

`browser-lifecycle.ts:364,380,749,770,774,795,865,875,959`. После await устаревшего compatibility proof `enter` оставляет retry, который перечитывает durable control. Если очистка уже завершилась, `enter` проверяет текущее поколение и не переиспользует прежний Promise. Если остаётся действующий intent, только явный Retry передаёт `true` и один раз вызывает `resumeIntent`. События BroadcastChannel, storage, pageshow, cancel и post-transition используют вызов без аргументов. DOM Event не попадает в булев параметр. Автоматического цикла повторов в изменении нет. Имеющийся exact-build veto и сериализация положительного proof под lock сохранены.

## Независимые прогоны

- `b7-rereview-3-complete.log`, exit 0. После настоящего конкурирующего 412 и завершённой очистки один клик «Повторить» открыл приложение в том же JS документе. Суммарно две пробы, одна устаревшая и одна для нового поколения. В durable control сохранилось veto прежней сборки, а положительное доказательство записалось для проверенной точной сборки.
- `b7-rereview-3-pending.log`, exit 0. При удержанном native IDB соединении первый явный Retry вызвал `deleteDatabase`, оставил тот же pending intent и не послал compatibility HTTP. После освобождения соединения второй Retry завершил удаление и проверил совместимость в том же JS документе. Суммарно две пробы, считая устаревшую. Обе ветки также подтвердили отсутствие новых product/probe reads у отвергнутой сборки, отказ на proxy 401 и повторный допуск ранее доказанного exact build без сетевой пробы.
- `b7-rereview-3-same-owner-off.log`, exit 0. Queued Retry в другой shared вкладке того же аккаунта оставил её собственные сеанс и ввод, в том числе после reload. В IDB до отдельного согласия лежал только слот инициатора, после подтверждения — оба. Локальные синтетические HTTP серверы, временные профили Chromium, production bundles из exact archive.
- Независимый Vitest 28/28 плюс 15/15 в AuthProvider, всего 43/43 по пяти файлам, оба exit 0. `b7-rereview-3-tests.log`, `b7-rereview-3-auth-provider.log`. Scoped `git diff --check` чист. Прочитан авторский exact typecheck.

## Граница приёмки

Ранее независимо проверены 251/251, аварийный recovery ACK с native strict abort/complete и точный handoff. Здесь повторён узкий delta и смежный queued Retry. Известная pre-protocol навигация, обязательный операционный cutover, физические Safari/mobile/PWA, full release privacy matrix и red eager budget остаются отдельными воротами. Локальный merge в main и выпуск закрыты по решению владельца. Scope Б12 ограничен тремя неизменными adopted leaf.
