// Тест чистой части пробы П4 (`scripts/probe-p4.ts`, §С9, приёмка §С8-12).
//
// Сам прогон пробы тестом не покрывается и покрыт быть не может: он ходит в живого
// провайдера и меряет поведение модели. Но ДВЕ его вещи — код выхода «мерить нечем» и
// разделение цифр по роду дубля — это правила, а не измерения, и разъехаться молча они не
// имеют права: первую читает тот, кто запускает пробу после пополнения кредитов, вторую —
// владелец, решающий судьбу Р14.
//
// Прогоняется корневым `bun run test` (хвост `bun test scripts/`), как и тест греп-гейта.
import { expect, test } from 'bun:test';
import { chooseProvider, duplicatePairs, type PropertyRow, similarity } from './probe-p4.ts';

// ---------------------------------------------------------------------------
// Выбор провайдера: два исхода вместо трёх (Important-1 гейт-ревью)
// ---------------------------------------------------------------------------

test('явный ORBIS_LLM_PROVIDER без ключа — «мерить нечем», а не исключение наружу', () => {
  // Боевой `.env` репозитория прописывает ORBIS_LLM_PROVIDER, поэтому живьём срабатывает
  // именно эта ветка: `makeLLMProvider` БРОСАЕТ, и непойманное исключение дало бы код 1
  // («замер сломался») там, где правда — код 2 («замер не состоялся»).
  for (const name of ['openai', 'anthropic'] as const) {
    const choice = chooseProvider({ ORBIS_LLM_PROVIDER: name });
    expect(choice.kind).toBe('unavailable');
    if (choice.kind !== 'unavailable') continue;
    // Причина названа текстом самой фабрики — оператор видит, какого ключа не хватает.
    expect(choice.reason).toContain('API_KEY');
  }
});

test('echo — тоже «мерить нечем»: он не зовёт инструменты, обе цифры вышли бы нулями', () => {
  const choice = chooseProvider({ ORBIS_LLM_PROVIDER: 'echo' });
  expect(choice.kind).toBe('unavailable');
  if (choice.kind !== 'unavailable') return;
  expect(choice.reason).toContain('EchoProvider');
});

test('кривой ORBIS_LLM_PROVIDER и «оба ключа без выбора» — тот же исход, а не падение', () => {
  expect(chooseProvider({ ORBIS_LLM_PROVIDER: 'gemini' }).kind).toBe('unavailable');
  expect(chooseProvider({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x' }).kind).toBe(
    'unavailable',
  );
});

test('ключ на месте — провайдер живой (позитивный контроль: «unavailable» не константа)', () => {
  const choice = chooseProvider({ ORBIS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-тест' });
  expect(choice.kind).toBe('live');
  if (choice.kind !== 'live') return;
  expect(choice.provider.modelId).not.toBe('echo');
});

// ---------------------------------------------------------------------------
// Разделение цифр по роду дубля (рулинг Р-17-4, Important-2 гейт-ревью)
// ---------------------------------------------------------------------------

const OWNER = '11111111-1111-4111-8111-111111111111';

function row(over: Partial<PropertyRow> & Pick<PropertyRow, 'id' | 'key'>): PropertyRow {
  return {
    label: { ru: over.key },
    description: { ru: over.key },
    status: 'active',
    merged_into: null,
    owner_id: OWNER,
    ...over,
  };
}

/** Свой ↔ свой, свой ↔ встроенный и встроенный ↔ встроенный — три различимых рода в одной фикстуре. */
const FIXTURE: PropertyRow[] = [
  row({
    id: 'p-own-1',
    key: 'user/effort',
    label: { ru: 'Усилие' },
    description: { ru: 'Сколько сил отнимет дело' },
  }),
  row({
    id: 'p-own-2',
    key: 'user/effort-level',
    label: { ru: 'Уровень усилия' },
    description: { ru: 'Сколько сил отнимет дело' },
  }),
  row({
    id: 'p-own-3',
    key: 'user/task-state',
    label: { ru: 'Состояние задачи' },
    description: { ru: 'Стадия работы над задачей' },
  }),
  row({
    id: 'orbis/task_status',
    key: 'orbis/task_status',
    owner_id: null,
    label: { ru: 'Состояние задачи' },
    description: { ru: 'Стадия работы над задачей' },
  }),
  // Встроенная пара, лексически похожая друг на друга: в знаменатель попасть не должна.
  row({
    id: 'orbis/period_start',
    key: 'orbis/period_start',
    owner_id: null,
    label: { ru: 'Начало периода' },
    description: { ru: 'Первый день периода бюджета' },
  }),
  row({
    id: 'orbis/period_end',
    key: 'orbis/period_end',
    owner_id: null,
    label: { ru: 'Конец периода' },
    description: { ru: 'Последний день периода бюджета' },
  }),
];

test('мерка вообще различает похожее и непохожее (иначе разделение ниже ничего не значит)', () => {
  expect(
    similarity('Усилие Сколько сил отнимет дело', 'Уровень усилия Сколько сил отнимет дело'),
  ).toBeGreaterThanOrEqual(0.5);
  expect(similarity('Валюта Код валюты', 'Срок Когда это надо сделать')).toBeLessThan(0.5);
});

test('Р-17-4: свои дубли и «своё против встроенного» — РАЗНЫЕ списки, встроенная пара не в счёт', () => {
  const split = duplicatePairs(FIXTURE);

  // Своё против своего — то, что сводит садовник; по нему считается порог §С9.
  expect(split.own).toHaveLength(1);
  expect(split.own[0]?.a).toContain('user/effort');
  expect(split.own[0]?.b).toContain('user/effort-level');

  // Своё против встроенного — садовник бессилен по устройству; отдельная цифра.
  expect(split.vsBuiltin).toHaveLength(1);
  expect(`${split.vsBuiltin[0]?.a}${split.vsBuiltin[0]?.b}`).toContain('orbis/task_status');
  expect(`${split.vsBuiltin[0]?.a}${split.vsBuiltin[0]?.b}`).toContain('user/task-state');

  // Встроенное против встроенного не попадает НИКУДА: эта пара не про Р14 ни одним концом,
  // а попав в знаменатель, утопила бы обе цифры.
  const everything = [...split.own, ...split.vsBuiltin].map((p) => `${p.a} ${p.b}`).join(' | ');
  expect(everything).not.toContain('orbis/period_start');
});

test('поглощённые и deprecated строки выбывают из обоих списков — их в словаре больше нет', () => {
  const merged = FIXTURE.map((r) => (r.id === 'p-own-2' ? { ...r, merged_into: 'p-own-1' } : r));
  expect(duplicatePairs(merged).own).toHaveLength(0);
  // …а вторая цифра при этом не меняется: рода независимы.
  expect(duplicatePairs(merged).vsBuiltin).toHaveLength(1);

  const deprecated = FIXTURE.map((r) =>
    r.id === 'orbis/task_status' ? { ...r, status: 'deprecated' } : r,
  );
  expect(duplicatePairs(deprecated).vsBuiltin).toHaveLength(0);
  expect(duplicatePairs(deprecated).own).toHaveLength(1);
});
