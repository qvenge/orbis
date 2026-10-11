// scripts/ops-build.test.ts
// СТОРОЖ РАЗРЕШЕНИЯ ИМПОРТОВ `scripts/ops.ts` (Fable I-2 / гейт m-3 задачи 9 среза 1в).
//
// `ops.ts` — единственный вход прод-операций, а его не видит ни корневой `typecheck` (`--filter '*'` —
// только воркспейсы, `scripts/` к ним не относится), ни один тест: снятый модуль, импорт которого забыт
// в `ops.ts`, оставил бы `test`/`lint`/`typecheck`/CI зелёными, а первая же прод-команда упала бы у
// владельца на `Could not resolve`. Сборка тем же рантаймом, что запускает `ops.ts`, разрешает весь граф
// импортов и ничего не исполняет.
//
// ОТДЕЛЬНЫМ ПРОЦЕССОМ `bun build`, а не `Bun.build` в процессе теста: внутри `bun test` разрешение
// модулей иное (проверено: `Bun.build` из теста не находит `../apps/server/src/identity`, тот же вызов из
// обычного скрипта и CLI — находят), и сторож мерил бы раннер тестов, а не то, чем запускается `ops.ts`.
// Выход сборки — во временный каталог, который тест за собой удаляет.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scripts/ops.ts собирается: все импорты разрешаются', () => {
  const out = mkdtempSync(join(tmpdir(), 'ops-build-'));
  try {
    const r = Bun.spawnSync(
      [process.execPath, 'build', join(import.meta.dir, 'ops.ts'), '--target=bun', '--outdir', out],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const log = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect([r.exitCode, log.includes('Could not resolve') ? log : '']).toEqual([0, '']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
