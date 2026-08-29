// Эталон реестра тулов (РП-13, приёмка §С8-2): побайтовый снимок ВСЕЙ поверхности, которую
// видит модель, — имён, описаний и JSON Schema.
//
// Зачем эталон, когда состав уже проверяют поимённые тесты `registry.test.ts`. Те отвечают
// на вопрос «есть ли то, что мы помним»; эталон — на вопрос «не изменилось ли то, чего мы
// не помним». Схема тула теперь ПРОИЗВОДНАЯ от реестра свойств: правка одной строки
// `property_definitions` — типа, подписи, обязательности, ранга — молча меняет описание
// параметра у attach-тула и, значит, поведение модели. Ни один поимённый тест такого не
// увидит, а прод-регрессия LLM видна только по её ответам, то есть постфактум.
//
// ЭТАЛОН СНИМАЕТСЯ ОДИН РАЗ, при чистом сиде, и дальше ЗАЩИЩАЕТ. «Записать что вышло» при
// расхождении — запрещено: расхождение разбирается, и если правка намеренная, эталон
// пересдаётся ОТДЕЛЬНЫМ движением с объяснением в коммите (`bun test … --update-golden`
// здесь нет намеренно — автоматическое обновление и есть тот способ, которым эталоны
// перестают что-либо значить).
//
// Пересдача: `buildToolRegistry` на чистом сиде → `JSON.stringify(snap, null, 2)` в этот
// файл → `bunx biome check --write` по нему (форматтер репозитория раскладывает JSON
// по-своему, и без этого шага падает `lint`). Сверка идёт по `canonicalJson` РАЗОБРАННОГО
// JSON, поэтому форматирование на смысл эталона не влияет.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { canonicalJson } from '@orbis/shared';
import GOLDEN from '../../test/golden/tool-registry.json';
import { appDb, freshUserId, requireEnv, seedCustomAspect, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { buildToolRegistry, type OrbisToolDef } from './registry';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const withCustom = freshUserId();

/** Кастомный аспект с «/» и «-» в ключе — второй ряд эталона: +1 тул, схема из своих свойств. */
const CUSTOM_ASPECT_KEY = 'user/sleep-log';

beforeAll(async () => {
  await truncateAll();
  await seedCustomAspect(withCustom, {
    key: CUSTOM_ASPECT_KEY,
    label: { ru: 'Сон', en: 'Sleep Log' },
    description: { ru: 'Трекинг сна.', en: 'Sleep tracking.' },
    aiInstructions: 'Пиши часы сна числом.',
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
});

afterAll(async () => {
  await client.end();
});

/**
 * Снимок дефа в объёме, который ВИДИТ МОДЕЛЬ. Служебные признаки (`kind`, `internalOnly`,
 * `agentOnly`, `routineOnly`, `fullScopeOnly`, `aspectId`) в эталон НЕ входят: их сторожат
 * поимённые тесты `registry.test.ts` и `mcp.test.ts` — там отказ называет правило, которое
 * сломалось, а здесь он назвал бы только «строка отличается».
 */
function snapshot(def: OrbisToolDef): Record<string, unknown> {
  return { name: def.name, description: def.description, inputJsonSchema: def.inputJsonSchema };
}

async function registryFor(userId: string): Promise<Record<string, unknown>[]> {
  const defs = await withIdentity(db, userId, (tx) => buildToolRegistry(tx, userId));
  return defs.map(snapshot);
}

test('реестр тулов при чистом сиде равен эталону по canonicalJson (§С8-2)', async () => {
  const actual = await registryFor(owner);
  // Сверка по КАНОНИЧЕСКОЙ форме: порядок ключей объекта в JSON не значим (jsonb его не
  // хранит), а порядок ЭЛЕМЕНТОВ списка значим — тулы сравниваются как последовательность.
  // Сначала имена: их расхождение читается человеком, а diff двух больших JSON — нет.
  expect(actual.map((d) => d.name)).toEqual(GOLDEN.map((d) => d.name as string));
  for (const [index, def] of actual.entries()) {
    expect(`${def.name}: ${canonicalJson(def)}`).toBe(
      `${def.name}: ${canonicalJson(GOLDEN[index])}`,
    );
  }
  expect(canonicalJson(actual)).toBe(canonicalJson(GOLDEN));
});

test('счётчик тулов — ПРОИЗВОДНЫЙ от эталона, а не написанный рядом', async () => {
  // Число 37 в `registry.test.ts` читается отсюда: два независимо написанных счётчика
  // разошлись бы молча, и «сколько тулов у модели» перестало бы иметь один ответ.
  expect((await registryFor(owner)).length).toBe(GOLDEN.length);
});

test('кастомный аспект добавляет РОВНО один тул сверх эталона, остальные — байт-в-байт', async () => {
  const actual = await registryFor(withCustom);
  expect(actual.length).toBe(GOLDEN.length + 1);
  const extra = actual.filter((d) => !GOLDEN.some((g) => g.name === d.name));
  expect(extra.map((d) => d.name)).toEqual(['attach_user_sleep_log']);
  // Всё, что было, осталось прежним: свой аспект владельца не трогает встроенную поверхность.
  const untouched = actual.filter((d) => GOLDEN.some((g) => g.name === d.name));
  expect(canonicalJson(untouched)).toBe(canonicalJson(GOLDEN));
});
