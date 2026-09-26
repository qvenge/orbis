// Признак «правка трогает деньги» (спека 1б §8.4, Н-5): по привязкам контрактов «движение денег» и
// «конверт» в снимке, а не по `module` свойства. После переноса суммы, валюты, направления и даты
// операции в язык (Р-7, `module: null`) признак по модулю перестал бы видеть правку суммы — и
// остаток конверта с бейджем вкладки остались бы вчерашними.
//
// Реестр НАСТОЯЩИЙ (`BUILTIN_REGISTRY`): вопрос теста — какие свойства СЕГОДНЯ связаны слотами
// денежных контрактов у встроенных аспектов, и выдуманный словарь ответил бы на другой вопрос.
import { expect, test } from 'vitest';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { rowRegistryOf, touchesMoneyContract } from './row';

const reg = rowRegistryOf(BUILTIN_REGISTRY);

test('свойства слотов «движения денег» и «конверта» трогают деньги — в том числе стандартные свойства ядра', () => {
  for (const id of [
    // Стандартные свойства ядра (Р-7): `module` у них NULL, а деньги они двигают.
    'orbis/amount',
    'orbis/currency',
    'orbis/direction',
    'orbis/occurred_on',
    // Свойства Финансов, связанные слотом «движения денег».
    'orbis/finance_category',
    'orbis/planned',
    // Слоты «конверта» (`orbis/budget`): лимит и период — свои агрегаты у бюджета.
    'orbis/limit',
    'orbis/period_start',
  ]) {
    expect(`${id}: ${touchesMoneyContract([id], reg)}`).toBe(`${id}: true`);
  }
});

test('свойство, не связанное ни одним слотом денежных контрактов, деньги не трогает', () => {
  for (const id of ['orbis/task_status', 'orbis/due_date', 'orbis/title', 'orbis/goal_nope']) {
    expect(`${id}: ${touchesMoneyContract([id], reg)}`).toBe(`${id}: false`);
  }
  // Пустая правка и пустой снимок (реестр ещё едет) — «нет», а не падение.
  expect(touchesMoneyContract([], reg)).toBe(false);
  expect(touchesMoneyContract(['orbis/amount'], rowRegistryOf(undefined))).toBe(false);
});

test('смешанная правка трогает деньги, если хоть одно свойство связано слотом', () => {
  expect(touchesMoneyContract(['orbis/task_status', 'orbis/amount'], reg)).toBe(true);
});
