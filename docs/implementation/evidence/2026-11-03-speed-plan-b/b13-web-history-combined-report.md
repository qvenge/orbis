# Б13 — общий пакет фикстур истории на принятом R6

Exact d4bc1c5cba6478f02530c83a50b69c90da8c0eb7, отдельный detached checkout `/private/tmp/orbis-b13-web-history-combined.FMPjv5`. Пять исходных test paths: `foreign-refusal.test.tsx`, `history-delivery.test.tsx`, `history-lifecycle.test.tsx`, `arrows.test.tsx`, `useGraphUndo.test.tsx`. Продукт, cold BODY и новые R6 регрессии побайтно сохранены. По `history-lifecycle` tail от original cold BODY parameter family до EOF сравнен побайтно с d4bc. Хунки 11 доказанных случаев перенесены адресно, поверх rebase прежних 9, без wholesale replacement.

Фактическое покрытие:
- Title: distinct ACK и реальные CAS inputs, current/old scopes, offscreen history, foreign title commit отдельно от checkbox, raw/visible pending separation. Accepted foreign basis сбрасывает обе истории под pending title; own matching raw «План Б» остаётся контрольной веткой. Обе coalesced ветки получают отдельные результаты B и C, no-write не создаёт event.
- Body: no-write 409 сохраняет текст и draft, сбрасывает native/common history; явное «Обновить» реально делает один GET без resend. Journal Undo приносит согласованные body/BodyDoc/revision и separate entity/body feed, editor и обе истории проверяются; два соседних journal/foreign controls не потеряны.
- Generic Undo: отказ без записи отделён от независимо доставленного foreign commit, а 500 после настоящего commit — от подтверждения клиента. В detailed known 409 существующий targeted recheck сохраняет structured outcome. Настоящие server cases закреплены в `b13-feed-shapes-report.md` и `b13-undo-loss-witness-report.md`.

После scoped форматирования Biome нашёл только порядок одного нового import, первая красная проверка сохранена SHA f2fe698bd1fbdb31b5c786a629a8a11ee713e4ed06553f8dc16bf4f3a10a68cc. Исправлен порядок, затем source freeze. На тех же финальных байтах scoped Biome exit 0 (4 прежних warnings), typecheck web exit 0, diff-check exit 0. Один named Vitest run с одним worker на 6 файлах, включая неизменённый `title-history.test.ts`: **54 PASS / 114 skip**, exit 0, 20 исходных отказов и 34 R6/соседних controls. 04.11.2026 15:37:50–15:38:52 UTC. Это scoped validation, полный CI ещё впереди.

- Review diff `b13-web-history-combined-review.diff` SHA 2ac29f02c40aea9653bab6c5de0b6ea37dfc464f27ca5bee802b5b1e0d5bfe61.
- Source manifest `b13-web-history-combined-review.sha256` SHA f1c971cbeab833d64574dac939ce1b4164fac53c9d6e8c65bc0eeed488f9bd55.
- Raw targeted log SHA 7f5778a89cdb7452af12267359e5052b6dc9d0c27ad08d2cd06b2292ad8202b3, names JSON SHA ff6da90e6d0deabf84069760dde5ce00b5af73dc993248f12c99effcf42614eb.
- Type log SHA 0bd1d3dd44fbb89b7e03ad525fd1455e141c303775257e1983ee245850961e16, Biome log SHA 9f28c4fad2d7125e844082c88a2c919813c71629db7cb20f22c813e1ad9fe2c9.

Ничего не применялось к общей ветке. Пакет передан root для принятия. Отдельно открыты 12 прежних app/nav/settings/menu/budget cases, первый full-run timeout/flakes и остальные Б13 gates.
