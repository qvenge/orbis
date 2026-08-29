// Правила чтения подписей из реестра (§А9-2): три формы адреса, порядок их резолва и
// деградация, когда реестра нет.
//
// Реестр НАСТОЯЩИЙ (`BUILTIN_REGISTRY`): слова, которыми проверяются подписи, обязаны быть
// теми же, что увидит владелец. Выдуманный словарь здесь означал бы тест, зелёный при любом
// содержимом реестра.
import { expect, test } from 'vitest';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { aspectLabel, fieldLabel, lookupOf, propertyIdOf } from './labels';

const reg = lookupOf(BUILTIN_REGISTRY);

test('адрес свойства: id и key ведут к одной записи', () => {
  // У встроенных key = id (§А2-1), поэтому проба формы идёт по СВОЕЙ строке владельца, где
  // они разные: web адресует значения id, а тулы и модель — key, и обе формы обязаны
  // резолвиться, иначе половина читателей осталась бы без подписи.
  const first = BUILTIN_REGISTRY.properties[0];
  if (first === undefined) throw new Error('встроенный реестр свойств пуст');
  const custom = lookupOf({
    version: '2.0',
    properties: [{ ...first, id: 'uuid-1', key: 'user/часы' }],
    aspects: [],
    roles: [],
  });
  expect(custom.property('uuid-1')?.id).toBe('uuid-1');
  expect(custom.property('user/часы')?.id).toBe('uuid-1');
});

test('подпись — в локали читателя, а карта локалей едет целиком', () => {
  expect(fieldLabel(reg, 'orbis/task_status')).toBe('Состояние задачи');
  // Локаль выбирает КЛИЕНТ: сервер не сворачивает карту, и смена языка не требует запроса.
  expect(reg.label('orbis/task_status', 'en')).toBe('Task status');
  // Локали нет вовсе — правило §А2-1: локаль → en → любая.
  expect(reg.label('orbis/task_status', 'pt-BR')).toBe('Task status');
});

test('старая пара «аспект + поле» переводится таблицей, а не догадкой', () => {
  expect(propertyIdOf(reg, 'status', 'orbis/task')).toBe('orbis/task_status');
  expect(fieldLabel(reg, 'status', 'orbis/task')).toBe('Состояние задачи');
  // Догадка «orbis/<имя поля>» дала бы здесь `orbis/status`, которого в реестре нет вовсе:
  // проба именно на поле, чьё имя РАСХОДИТСЯ с id свойства.
  expect(reg.property('orbis/status')).toBeUndefined();
  // Аспект чужой — перевода нет, и подпись честно сырая: у `orbis/note` поля `status` нет.
  expect(fieldLabel(reg, 'status', 'orbis/note')).toBe('status');
});

test('поле САМОЙ записи резолвится по закрытому списку core-проекций (§А1-3)', () => {
  // `archived` и `title` — имена колонок, которыми их адресуют строки предложения и
  // отложенного действия; у них ЕСТЬ свойство реестра.
  expect(propertyIdOf(reg, 'archived')).toBe('orbis/archived');
  expect(fieldLabel(reg, 'archived')).toBe('В архиве');
  expect(fieldLabel(reg, 'title')).toBe('Заголовок');
  // А у `body`, `tags` и `emoji` свойства в срезе А нет вовсе — и выдумывать его нечем:
  // правило работает по списку core-проекций, а не по префиксу «orbis/».
  expect(propertyIdOf(reg, 'body')).toBeUndefined();
  expect(propertyIdOf(reg, 'tags')).toBeUndefined();
  expect(fieldLabel(reg, 'body')).toBe('body');
});

test('промах по АСПЕКТУ не обрывает резолв: поле записи находит свою core-проекцию', () => {
  // Вызывающий, выразивший «носителя нет» пустой строкой или подставивший чужой аспект,
  // всё равно обязан получить подпись: у поля записи носителя нет вовсе, и промах по
  // аспекту значит «носителя не нашли», а не «искать больше негде». До фикс-раунда 13a
  // резолв обрывался здесь, и плашка предложения печатала владельцу сырое `archived`.
  expect(propertyIdOf(reg, 'archived', '')).toBe('orbis/archived');
  expect(fieldLabel(reg, 'archived', 'orbis/note')).toBe('В архиве');
  expect(fieldLabel(reg, 'title', '')).toBe('Заголовок');
  // Обратная сторона: поля, которого нет ни у аспекта, ни среди core-проекций, правило не
  // выдумывает — иначе «поле записи» стало бы свалкой для любого промаха.
  expect(propertyIdOf(reg, 'status', '')).toBeUndefined();
  expect(propertyIdOf(reg, 'body', 'orbis/note')).toBeUndefined();
});

test('носитель свойства — из реестра; у core-проекции его нет', () => {
  expect(reg.carrierOf('orbis/task_status')?.id).toBe('orbis/task');
  expect(reg.carrierOf('orbis/archived')).toBeUndefined();
});

test('подпись аспекта — из реестра; неизвестный аспект показывается своим id', () => {
  expect(aspectLabel(reg, 'orbis/task')).toBe('Задача');
  expect(aspectLabel(reg, 'user/sleep-log')).toBe('user/sleep-log');
});

test('реестра ещё нет — каждый адрес показывается сырым, но показывается', () => {
  // Пустой снимок и «подписи не полагается» — разные вещи: до первого ответа сервера
  // владелец видит машинный адрес, а не пустое место (прятать строку значило бы убрать
  // с экрана данные, которые уже есть).
  const empty = lookupOf(undefined);
  expect(fieldLabel(empty, 'orbis/task_status')).toBe('orbis/task_status');
  expect(fieldLabel(empty, 'status', 'orbis/task')).toBe('orbis/task_status');
  expect(aspectLabel(empty, 'orbis/task')).toBe('orbis/task');
  expect(empty.carrierOf('orbis/task_status')).toBeUndefined();
});
