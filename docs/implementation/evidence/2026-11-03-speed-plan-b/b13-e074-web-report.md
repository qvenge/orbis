# Б13 — полный web повтор на e074

`e0741de683680323cf4fbfe99c608c860b22d4d9`, exact detached clone `/private/tmp/orbis-b13-final-ci.07CROy/web-final`. 1519 tracked files совпали с Git archive, все workspace aliases внутри, Git clean после прогона. Разница от a0 только два принятых test files навигации. Остальные paths byte-identical, поэтому server/shared/guard/lint/types/runtime/build evidence остаётся на фактически проверенном a0 и переносится по явно подтверждённой эквивалентности. Браузерные артефакты остаются с настоящим a0 SHA.

Одна команда `bun run --filter @orbis/web test` с обычной конфигурацией (без CI env и без concurrent Chrome/DB/perf). Exit 1, 3058 PASS / 3 FAIL / 2 skip, 216 passing files / 2 failed / 2 skipped. Навигационные проверки из исправленных двух файлов проходят, прежние 40 устойчивых fixture RED не повторились. Три новых имени сохраняют полный web status RED.

- `properties-relations/responsive.test.tsx:57` same-mounted session reset discards prior values panel and ignores its late write. Не найден начальный текст «Заметка», до первого действия и до reset. `beforeEach` готовит DesktopFrame, но DetailScreen приходит отдельным импортом. Точный timeout phase ещё проверяется.
- `properties-relations/host-pending.test.tsx:41` addressed host lock starts synchronously before import and spans real page batch failure/retry. Не найден пункт «Свойства и связи». Этот тест нажимает меню до явной готовности заголовка записи и не дошёл до разрешения своего контролируемого panel-host import.
- `properties-relations/host-pending.test.tsx:114` public owner close/open cannot replace the addressed panel synchronously during a host intent. Диалог на месте, spy makePage остаётся нулём. Первый отказ произошёл до `loader.release()` общего hoisted gate, поэтому возможен каскад в этом файле. Нужна проверка целого файла, isolated second test пропустит release изначально.

Неизменённый адресный контроль и causal plan при необходимости отдельны. Первые полный a0 и повторный e074 RED остаются в журнале. Никаких изменений в исходниках/таймаутах этой стадии.

Raw `/private/tmp/orbis-b13-final-ci.07CROy/reports/web-final.log`, exit, commands, times, source and aliases verification in same directory, hash index `b13-e074-web-evidence.sha256`.
