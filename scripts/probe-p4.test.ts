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
import { MAX_TOKENS_NOTE, STEP_LIMIT_NOTE } from '../apps/server/src/ai/send-message.ts';
import type { RunEnd } from '../apps/server/src/routines/runner.ts';
import { BUILTIN_PROPERTY_META } from '../packages/shared/src/registry/builtin-properties.ts';
import {
  chooseProvider,
  duplicatePairs,
  HEURISTIC_ACCURACY_NOTE,
  measurementUsable,
  type PropertyRow,
  SIMILARITY_THRESHOLD,
  similarity,
} from './probe-p4.ts';

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

// ---------------------------------------------------------------------------
// Годность замера: исход прогона садовника (Important-A ре-ревью)
// ---------------------------------------------------------------------------

const finished: RunEnd = { outcome: 'finished' };

test('годен РОВНО один исход: finished без причины и без пометки об обрыве', () => {
  expect(measurementUsable(finished, 'Свёл два свойства, сирот нет.').ok).toBe(true);
  expect(measurementUsable(finished, undefined).ok).toBe(true);
});

test('failed по ЛЮБОЙ причине — замер не состоялся, а не «ноль сведённых»', () => {
  // Цикл рутины ловит сбой провайдера сам и наружу не бросает: «кредиты кончились на
  // садовнике» приходит сюда обычным возвратом. Без этой ветки мёртвый садовник давал
  // «0 сведённых» и вердикт из воздуха — причём в одну сторону, «сужать Р14».
  for (const reason of [
    'provider',
    'deadline',
    'limit',
    'refusal',
    'aborted',
    'internal',
    'steps',
    'no_proposal',
  ] as const) {
    const u = measurementUsable({ outcome: 'failed', reason }, undefined);
    expect([reason, u.ok]).toEqual([reason, false]);
  }
});

test('checkpoint — тоже НЕ замер, хотя для act-рутины это штатный исход', () => {
  const u = measurementUsable({ outcome: 'checkpoint' }, undefined);
  expect(u.ok).toBe(false);
  if (u.ok) return;
  // Причина названа по существу: словарь обойдён не весь, знаменатель неполон.
  expect(u.reason).toContain('checkpoint');
});

test('finished, но отчёт с пометкой об обрыве — прогон не довёл работу до конца', () => {
  // RunEnd этого не показывает вовсе: в режиме act обе ветки возвращают голый
  // {outcome:'finished'}, и единственный след обрыва — пометка в отчёте.
  for (const note of [STEP_LIMIT_NOTE, MAX_TOKENS_NOTE]) {
    expect(measurementUsable(finished, `Начал разбирать словарь…\n\n${note}`).ok).toBe(false);
  }
  // Позитивный контроль: обычный отчёт пометок не содержит и годен.
  expect(measurementUsable(finished, 'Начал разбирать словарь и закончил.').ok).toBe(true);
});

test('finished с причиной — тоже не годен (RunEnd вправе принести её и с успехом)', () => {
  expect(measurementUsable({ outcome: 'finished', reason: 'steps' }, undefined).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// Точность мерки измерена, а не предположена (Important-B / Р-17-5)
// ---------------------------------------------------------------------------

test('цифры точности в тексте владельцу — не украшение: они воспроизводятся прогоном по реестру', () => {
  // Текст обещает «77 свойств, 2926 пар, 17 пересекли порог». Обещание проверяется здесь же:
  // разъехавшись с реестром, оно превратилось бы в докблок-неправду — четвёртый рецидив ветки.
  const rows = BUILTIN_PROPERTY_META;
  const ru = (t: Record<string, string>): string => t.ru ?? t.en ?? Object.values(t)[0] ?? '';
  let pairs = 0;
  let crossed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const x = rows[i];
      const y = rows[j];
      if (x === undefined || y === undefined) continue;
      pairs += 1;
      const s = similarity(
        `${ru(x.label)} ${ru(x.description)}`,
        `${ru(y.label)} ${ru(y.description)}`,
      );
      if (s >= SIMILARITY_THRESHOLD) crossed += 1;
    }
  }
  expect([rows.length, pairs, crossed]).toEqual([77, 2926, 17]);
  expect(HEURISTIC_ACCURACY_NOTE).toContain('77');
  expect(HEURISTIC_ACCURACY_NOTE).toContain('2926');
  expect(HEURISTIC_ACCURACY_NOTE).toContain('17');
});

test('текст владельцу говорит, что верных среди них НОЛЬ и что решает он, а не скрипт', () => {
  // Без этих двух утверждений список кандидатов читался бы как измеренная доля дублей —
  // ровно то, чего Р-17-5 запрещает.
  expect(HEURISTIC_ACCURACY_NOTE).toContain('ВЕРНЫХ среди них 0');
  expect(HEURISTIC_ACCURACY_NOTE).toContain('принимает он');
  expect(HEURISTIC_ACCURACY_NOTE).toContain('вердикта по этой цифре не выносит');
});

test('списки пар отсортированы по убыванию счёта — их читает человек', () => {
  const rows: PropertyRow[] = [
    row({
      id: 'p-a',
      key: 'user/a',
      label: { ru: 'Начало периода' },
      description: { ru: 'Первый день периода бюджета' },
    }),
    row({
      id: 'p-b',
      key: 'user/b',
      label: { ru: 'Конец периода' },
      description: { ru: 'Последний день периода бюджета' },
    }),
    row({
      id: 'p-c',
      key: 'user/c',
      label: { ru: 'Усилие' },
      description: { ru: 'Сколько сил отнимет дело' },
    }),
    row({
      id: 'p-d',
      key: 'user/d',
      label: { ru: 'Уровень усилия' },
      description: { ru: 'Сколько сил отнимет дело' },
    }),
  ];
  const own = duplicatePairs(rows).own;
  expect(own.length).toBeGreaterThan(1);
  for (let i = 1; i < own.length; i += 1) {
    expect(own[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(own[i]?.score ?? 0);
  }
});
