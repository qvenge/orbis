import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_CONTRACT_DEFS, BUILTIN_PROPERTY_META } from '@orbis/shared';
import { classOfEntity, classPrecondition, statusPatch } from './class-write';
import type { RegistrySnapshot } from './load';

/** Снимок из встроенных строк: функции чистые, база им не нужна. */
const REG = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  roles: new Map(),
  subscriptions: new Map(),
  ownerVersion: 1,
  systemVersion: 1,
} as unknown as RegistrySnapshot;
const TICKET = (status: string) => ({
  aspects: ['orbis/task'],
  props: { 'orbis/task_status': status },
});

describe('запись классом: помощники сервера (Р-И-39)', () => {
  test('класс тикета читается по привязке', () => {
    expect(classOfEntity(REG, TICKET('planned'), 'orbis/delegable')).toBe('queued');
    expect(classOfEntity(REG, TICKET('in_progress'), 'orbis/delegable')).toBe('in_progress');
    // Вариант вне состояний контракта — НЕ член (§Б2-3), а не «неизвестный класс».
    expect(classOfEntity(REG, TICKET('cancelled'), 'orbis/delegable')).toBeNull();
    // Аспекта нет — признак носителя Р9 встроен в чтение класса (РЧ-14а-7).
    expect(
      classOfEntity(
        REG,
        { aspects: [], props: { 'orbis/task_status': 'done' } },
        'orbis/delegable',
      ),
    ).toBeNull();
  });

  test('statusPatch и classPrecondition — имя свойства и значения целиком из реестра', () => {
    expect(statusPatch(REG, 'orbis/task', 'orbis/delegable', 'waiting')).toEqual({
      'orbis/task_status': 'waiting',
    });
    expect(statusPatch(REG, 'orbis/task', 'orbis/delegable', 'queued')).toEqual({
      'orbis/task_status': 'planned',
    });
    expect(classPrecondition(REG, 'orbis/task', 'orbis/delegable', ['new', 'queued'])).toEqual({
      property: 'orbis/task_status',
      in: ['inbox', 'planned'],
    });
  });

  test('ДАННЫЕ РЕШАЮТ ВАРИАНТ: переименуй вариант в привязке — код поедет за ним', () => {
    // Главное утверждение задачи. Реестр-двойник: у класса `queued` вариант `todo`, а не `planned`.
    // Ни строки кода не меняется — меняется строка реестра, и потребители пишут `todo`.
    const task = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/task');
    const renamed = {
      ...task,
      implements: task?.implements.map((b) =>
        b.contract !== 'orbis/delegable'
          ? b
          : {
              ...b,
              value_map: b.value_map.map((m) =>
                m.variant === 'planned' ? { ...m, variant: 'todo' } : m,
              ),
            },
      ),
    };
    const reg2 = {
      ...REG,
      aspects: new Map([...REG.aspects, ['orbis/task', renamed]]),
    } as RegistrySnapshot;
    expect(statusPatch(reg2, 'orbis/task', 'orbis/delegable', 'queued')).toEqual({
      'orbis/task_status': 'todo',
    });
    expect(classPrecondition(reg2, 'orbis/task', 'orbis/delegable', ['queued']).in).toEqual([
      'todo',
    ]);
    expect(classOfEntity(reg2, TICKET('todo'), 'orbis/delegable')).toBe('queued');
  });
});
