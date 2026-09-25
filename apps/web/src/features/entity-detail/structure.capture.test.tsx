/**
 * Съёмка эталона экрана записи (С1а-5, РП-10) — ТОЛЬКО по `CAPTURE=1`, в обычном прогоне пропуск.
 *
 * Эталон снят задачей 2 с экрана ДО среза 1а и не перезаписывается никогда: пересъёмка с нового
 * экрана сделала бы сравнение задачи 14 тавтологией. Старого экрана в коде больше нет (задача 14
 * заменила его шаблоном хоста), поэтому запуск ниже снимет уже НОВЫЙ экран — такой снимок годится
 * только для разбора расхождений, класть его в `golden/*.json` нельзя. Файл остаётся в репозитории
 * как запись о том, КАК эталон получен (те же фикстуры, тот же обработчик, та же стабилизация), а
 * не как инструмент обновления.
 *
 * Запуск (пишет `{[fixture]: {structure, requests}}` в `CAPTURE_OUT`; раскладка по
 * `golden/detail-structure.json` и `golden/detail-requests.json` — руками):
 *   cd apps/web && CAPTURE=1 CAPTURE_OUT=/private/tmp/…/detail-capture.json \
 *     bun run test src/features/entity-detail/structure.capture.test.tsx
 */
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installCrashTrap } from '../../test/harness';
import { captureDetail, type DetailCapture, STRUCTURE_FIXTURES } from './structure-fixtures';

installCrashTrap();

beforeEach(() => {
  localStorage.clear();
  // То же окружение, что у сверки (structure.test.tsx): простой не наступает.
  vi.stubGlobal('requestIdleCallback', () => 1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test.runIf(process.env.CAPTURE === '1')('съёмка эталона экрана записи', async () => {
  const out = process.env.CAPTURE_OUT;
  expect(out, 'CAPTURE_OUT — куда писать снимок').toBeTruthy();
  const result: Record<string, DetailCapture> = {};
  for (const f of STRUCTURE_FIXTURES) {
    // Окружение — на каждую фикстуру, как в сверке: там каждая идёт своим тестом.
    localStorage.clear();
    result[f.name] = await captureDetail(f);
  }
  writeFileSync(out as string, `${JSON.stringify(result, null, 2)}\n`);
});
