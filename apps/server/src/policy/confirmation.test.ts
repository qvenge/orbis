// apps/server/src/policy/confirmation.test.ts
// Юнит-тесты классификатора §7.10 (Task 5, слайс 1b): детерминированная таблица MVP —
// каждый ряд и границы закреплены отдельным тестом, порядок «первое совпадение сверху»
// значим. БД не нужна: классификация — чистая функция типизированных фактов вызова.
// Интеграционное подключение к dispatch — tools/dispatch.test.ts (describe §7.10).
// Вместе они закрывают контракт-заглушку shared/contracts/confirmation-policy.test.ts
// (describe.skip удалён этой задачей).
import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_DEFS, BUILTIN_PROPERTY_META, newId } from '@orbis/shared';
import { ROUTINE_UNTOUCHABLE_OBJECTS } from '../executor/invariants';
import type { ActorKind } from '../executor/types';
import type { RegistrySnapshot } from '../registry/load';
import { AGENT_VERB_NAMES, buildToolDefs } from '../tools/registry';
import { REGISTRY_TOOL_NAMES } from '../tools/registry-tools';
import {
  AUTONOMY_PROPERTIES,
  autonomyArmed,
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
  type Reconfigures,
  ROUTINE_MODE_PROPERTY,
  ROUTINE_STAGE_PROPERTY,
  ROUTINE_TOOLS_PROPERTY,
  reconfiguresOf,
  type ToolCallFacts,
} from './confirmation';

/** База: одиночная мутация AI без архивации; тесты переопределяют значимые факты. */
function facts(over: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    tool: 'entity_update',
    kind: 'mutate',
    known: true,
    actorKind: 'ai',
    explicitCommand: false,
    archives: false,
    isBatch: false,
    grantsAutonomy: false,
    reconfigures: 'none',
    ...over,
  };
}

describe('classifyToolCall: таблица MVP §7.10 — ряд за рядом, первое совпадение сверху', () => {
  test('ряд 1 «!known → forbidden»: незнакомый вызов не исполняется (fail-closed)', () => {
    expect(classifyToolCall(facts({ tool: 'entity_delete', known: false }))).toBe('forbidden');
  });

  test('ряд 1 первее ряда 2: !known + kind=read → всё равно forbidden', () => {
    expect(classifyToolCall(facts({ known: false, kind: 'read' }))).toBe('forbidden');
  });

  test('ряд 2 «read → execute»: чтение без внешних эффектов', () => {
    expect(classifyToolCall(facts({ tool: 'entity_query', kind: 'read' }))).toBe('execute');
  });

  test('ряд 2 первее рядов 3–5: read с archives/isBatch (нереальные для чтения факты) → execute', () => {
    expect(
      classifyToolCall(facts({ kind: 'read', archives: true, isBatch: true, batchSize: 100 })),
    ).toBe('execute');
  });

  test('ряд 3 «archives && !explicitCommand → explicit-confirmation»: инициатива AI', () => {
    expect(classifyToolCall(facts({ archives: true }))).toBe('explicit-confirmation');
  });

  test('ряд 3: инициатива MCP-агента — тот же уровень (правила едины, §7.10)', () => {
    expect(classifyToolCall(facts({ archives: true, actorKind: 'agent' }))).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 3 по actorKind не ветвится: owner-актор (в dispatch не бывает — UI мимо политики) классифицируется так же', () => {
    expect(classifyToolCall(facts({ archives: true, actorKind: 'owner' }))).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 3 первее рядов 4–5: архивирующий batch (size 3) → explicit-confirmation, не preview', () => {
    expect(
      classifyToolCall(
        facts({ tool: 'batch_execute', archives: true, isBatch: true, batchSize: 3 }),
      ),
    ).toBe('explicit-confirmation');
  });

  test('граница брифа «archives + explicitCommand=true → execute»: прямая команда пользователя классифицируется мягче', () => {
    expect(classifyToolCall(facts({ archives: true, explicitCommand: true }))).toBe('execute');
  });

  test('archives + explicitCommand=true в batch: ряд 3 пропущен, работают ряды масштаба (5 → preview, 11 → explicit)', () => {
    const batch = {
      tool: 'batch_execute',
      archives: true,
      explicitCommand: true,
      isBatch: true,
    };
    expect(classifyToolCall(facts({ ...batch, batchSize: 5 }))).toBe('preview');
    expect(classifyToolCall(facts({ ...batch, batchSize: 11 }))).toBe('explicit-confirmation');
  });

  test('ряд 4 «isBatch && batchSize > 10 → explicit-confirmation»: масштаб приближается к bulk', () => {
    expect(classifyToolCall(facts({ tool: 'batch_execute', isBatch: true, batchSize: 11 }))).toBe(
      'explicit-confirmation',
    );
  });

  test('граница 10/11: ровно 10 → preview, 11 → explicit-confirmation', () => {
    expect(classifyToolCall(facts({ tool: 'batch_execute', isBatch: true, batchSize: 10 }))).toBe(
      'preview',
    );
    expect(classifyToolCall(facts({ tool: 'batch_execute', isBatch: true, batchSize: 11 }))).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 5 «isBatch → preview»: bounded-масштаб исполняется с информационным предпросмотром', () => {
    expect(classifyToolCall(facts({ tool: 'batch_execute', isBatch: true, batchSize: 2 }))).toBe(
      'preview',
    );
  });

  test('ряд 6 «иначе → execute»: одиночная мутация, обратимо (inverse в журнале §7.8)', () => {
    expect(classifyToolCall(facts())).toBe('execute');
    expect(classifyToolCall(facts({ tool: 'entity_create' }))).toBe('execute');
    expect(classifyToolCall(facts({ tool: 'relation_create' }))).toBe('execute');
    expect(classifyToolCall(facts({ tool: 'thread_post' }))).toBe('execute');
  });
});

// ---------------------------------------------------------------------------
// Инвариант 4 (§9.3): глагол исполнителя НИКОГДА не попадает в pending
// ---------------------------------------------------------------------------

/**
 * Пять глаголов круга и `thread_post` — весь набор, доступный фоновому исполнителю
 * (WORKER_SCOPE_TOOLS минус чтения). Инвариант 4 требует, чтобы каждый из них таблицей
 * §7.10 попадал ровно в `execute`: у фонового прогона нет человека, который нажал бы
 * «подтвердить», и карточка `explicit-confirmation` висела бы вечно, а прогон встал.
 *
 * Дефы берутся из НАСТОЯЩЕГО реестра (`buildToolDefs` на ПУСТОМ снимке — core + глаголы;
 * attach_* требуют аспектов, а их здесь и не проверяем), а факты — из `factsFromToolCall`.
 * Выдуманный `{kind:'mutate'}` в тесте закрепил бы намерение автора теста, а не то, что
 * реестр реально объявляет: смена `kind` глагола на что-то иное обязана падать здесь.
 */
/** Снимок без единой строки реестра: core-тулы и глаголы от него не зависят. */
const EMPTY_REGISTRY: RegistrySnapshot = {
  properties: new Map(),
  aspects: new Map(),
  roles: new Map(),
  ownerVersion: 0,
  systemVersion: 0,
};

describe('глаголы исполнителя и thread_post → execute (инвариант 4, ряд 6 таблицы §7.10)', () => {
  const defs = buildToolDefs(EMPTY_REGISTRY);
  /** Валидные envelope-входы: форма вызова — вход фактов, а не декорация. */
  const inputs: Record<string, Record<string, unknown>> = {
    orbis_my_queue: {},
    orbis_claim_task: { ticket_id: newId() },
    orbis_run_step: { run_id: newId(), summary: 'Прочитал тикет' },
    orbis_checkpoint: { run_id: newId(), question: 'Какой подход выбрать?' },
    orbis_finish: { run_id: newId(), report: 'Готово, проверь' },
    thread_post: { entity_id: newId(), content: 'Взял тикет в работу.' },
  };

  for (const name of [...AGENT_VERB_NAMES, 'thread_post']) {
    test(`«${name}»: mutate, archives:false, isBatch:false → execute при любой явности намерения`, () => {
      const def = defs.find((d) => d.name === name);
      if (def === undefined) throw new Error(`тула «${name}» нет в реестре`);
      const input = inputs[name];
      if (input === undefined) throw new Error(`для «${name}» не задан валидный вход`);

      // Факты формы вызова — ровно те, что требует инвариант: не архивация, не batch
      const f = factsFromToolCall(def, input);
      expect(f).toEqual({
        tool: name,
        kind: 'mutate',
        known: true,
        archives: false,
        isBatch: false,
        grantsAutonomy: false,
        reconfigures: 'none',
      });

      // explicitCommand — единственный акторный вход, способный сдвинуть уровень
      // (ряд 3). У фонового прогона он всегда false: прямой команды человека за
      // вызовом нет. Проверяем оба значения — уровень от них не зависит.
      for (const explicitCommand of [false, true]) {
        expect(classifyToolCall({ ...f, actorKind: 'agent', explicitCommand })).toBe('execute');
      }
    });
  }
});

describe('factsFromToolCall: извлечение фактов формы вызова (до стадии 1 executor)', () => {
  const UPDATE_DEF = { name: 'entity_update', kind: 'mutate' as const };
  const BATCH_DEF = { name: 'batch_execute', kind: 'mutate' as const };

  test('entity_update: archived: true → archives: true; known: true, не batch', () => {
    const f = factsFromToolCall(UPDATE_DEF, { id: newId(), archived: true });
    expect(f).toEqual({
      tool: 'entity_update',
      kind: 'mutate',
      known: true,
      archives: true,
      isBatch: false,
      grantsAutonomy: false,
      reconfigures: 'none',
    });
  });

  test('граница брифа «archived: false → execute»: явное false — не архивация', () => {
    const f = factsFromToolCall(UPDATE_DEF, { id: newId(), archived: false });
    expect(f.archives).toBe(false);
    expect(classifyToolCall({ ...f, actorKind: 'ai', explicitCommand: false })).toBe('execute');
  });

  test('entity_update без archived и с не-объектным input → archives: false (невалидный упадёт стадией 1)', () => {
    expect(factsFromToolCall(UPDATE_DEF, { id: newId(), title: 'x' }).archives).toBe(false);
    expect(factsFromToolCall(UPDATE_DEF, null).archives).toBe(false);
    expect(factsFromToolCall(UPDATE_DEF, 'мусор').archives).toBe(false);
  });

  test('archives — только entity_update: archived: true в чужом envelope не считается архивацией (strict-схема отклонит стадией 1)', () => {
    const f = factsFromToolCall(
      { name: 'entity_create', kind: 'mutate' },
      { title: 'x', tags: [], archived: true },
    );
    expect(f.archives).toBe(false);
  });

  test('read-тул: kind=read, не batch, archives false', () => {
    expect(factsFromToolCall({ name: 'entity_query', kind: 'read' }, { query: 'tags=x' })).toEqual({
      tool: 'entity_query',
      kind: 'read',
      known: true,
      archives: false,
      isBatch: false,
      grantsAutonomy: false,
      reconfigures: 'none',
    });
  });

  test('batch: isBatch: true, batchSize = operations.length; без архиваций archives: false', () => {
    const f = factsFromToolCall(BATCH_DEF, {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'a', tags: [] } },
        { tool: 'entity_create', input: { title: 'b', tags: [] } },
      ],
    });
    expect(f).toEqual({
      tool: 'batch_execute',
      kind: 'mutate',
      known: true,
      archives: false,
      isBatch: true,
      batchSize: 2,
      grantsAutonomy: false,
      reconfigures: 'none',
    });
  });

  test('batch: ЛЮБАЯ операция с archived: true → archives: true (archived: false не считается)', () => {
    const withArchive = factsFromToolCall(BATCH_DEF, {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: newId(), title: 'x' } },
        { tool: 'entity_update', input: { id: newId(), archived: true } },
      ],
    });
    expect(withArchive.archives).toBe(true);

    const withFalse = factsFromToolCall(BATCH_DEF, {
      batch_id: newId(),
      operations: [{ tool: 'entity_update', input: { id: newId(), archived: false } }],
    });
    expect(withFalse.archives).toBe(false);
  });

  test('batch с невалидным envelope → fallback «не batch»: классификация не исполнит, стадия 1 executor честно откажет', () => {
    const f = factsFromToolCall(BATCH_DEF, { operations: 'мусор' });
    expect(f.isBatch).toBe(false);
    expect(f.batchSize).toBeUndefined();
    expect(f.archives).toBe(false);
  });
});

describe('entityUpdatePreviewDiff: diff карточки preview из журнала §7.8', () => {
  test('прежние значения — из inverse, новые — из operations; id исключён', () => {
    const id = newId();
    const diff = entityUpdatePreviewDiff({
      operations: [{ op: 'entity_update', payload: { id, title: 'Новое', archived: true } }],
      inverse: [{ op: 'entity_update', payload: { id, title: 'Старое', archived: false } }],
    });
    expect(diff).toEqual({
      title: { before: 'Старое', after: 'Новое' },
      archived: { before: false, after: true },
    });
  });

  test('свойства раскрыты поштучно: добавленное → before undefined, снятое → after undefined (§А7-4)', () => {
    const id = newId();
    const diff = entityUpdatePreviewDiff({
      operations: [
        {
          op: 'entity_update',
          payload: {
            id,
            props: {
              'orbis/task_status': 'done',
              'orbis/completed_at': '2026-08-26T10:00:00.000Z',
            },
            unset: ['orbis/due_date'],
            aspects: { attach: ['orbis/task'] },
          },
        },
      ],
      inverse: [
        {
          op: 'entity_update',
          payload: {
            id,
            props: { 'orbis/task_status': 'planned', 'orbis/due_date': '2026-07-10' },
            unset: ['orbis/completed_at'],
            aspects: { detach: ['orbis/task'] },
          },
        },
      ],
    });
    expect(diff).toEqual({
      'orbis/task_status': { before: 'planned', after: 'done' },
      // проставлено нормализацией §3.2 — прежде его не было
      'orbis/completed_at': { before: undefined, after: '2026-08-26T10:00:00.000Z' },
      // снято операцией — прежнее значение видно из inverse
      'orbis/due_date': { before: '2026-07-10', after: undefined },
      // смена интерпретации — отдельной строкой, полями её не разбирают
      aspects: { before: { detach: ['orbis/task'] }, after: { attach: ['orbis/task'] } },
    });
    // мешков `props`/`unset` в карточке не остаётся: они раскрыты
    expect(Object.hasOwn(diff, 'props')).toBe(false);
    expect(Object.hasOwn(diff, 'unset')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Инвариант 7 (V1.10): выдача автономии рутине — explicit-confirmation
// ---------------------------------------------------------------------------

/**
 * Право рутины писать в граф выдаёт ТОЛЬКО владелец: `mode: act` и белый список
 * `allowed_tools` — это доверенность, а не поле расписания. Проверяется на уровне политики,
 * а не транспорта: правило одно для внутреннего чата и MCP (§9.3), иначе внешний агент
 * получил бы автономию, обойдя карточку подтверждения другим каналом.
 */
describe('автономия рутине → explicit-confirmation (V1.10, инвариант 7)', () => {
  const CREATE_DEF = { name: 'entity_create', kind: 'mutate' as const };
  const UPDATE_DEF = { name: 'entity_update', kind: 'mutate' as const };
  const ATTACH_DEF = { name: 'attach_orbis_routine', kind: 'mutate' as const };
  const BATCH_DEF = { name: 'batch_execute', kind: 'mutate' as const };

  /**
   * Доверенность рутины СВОЙСТВАМИ (§А9-1): `props` у create/update, `data` у `attach_*`.
   * Старой карты гейт больше не читает — контракты тулов её не принимают (Задача 12).
   */
  const routine = (over: Record<string, unknown> = {}) => ({
    'orbis/routine_stage': 'active',
    'orbis/routine_at': '07:00',
    'orbis/routine_mode': 'propose',
    ...over,
  });

  /** Уровень «как в dispatch»: факты формы вызова + акторные факты. */
  function levelOf(
    def: { name: string; kind: 'read' | 'mutate' },
    input: unknown,
    actorKind: ToolCallFacts['actorKind'] = 'ai',
  ): ReturnType<typeof classifyToolCall> {
    return classifyToolCall({
      ...factsFromToolCall(def, input),
      actorKind,
      explicitCommand: false,
    });
  }

  test('create/attach рутины с mode act и правка mode|allowed_tools → explicit-confirmation актором ai и agent', () => {
    const cases: Array<[string, { name: string; kind: 'mutate' }, unknown]> = [
      [
        'entity_create act-рутины',
        CREATE_DEF,
        {
          title: 'Утренний обзор',
          tags: [],
          props: routine({ 'orbis/routine_mode': 'act' }),
          aspects: ['orbis/routine'],
        },
      ],
      [
        'attach_orbis_routine act',
        ATTACH_DEF,
        { entity_id: newId(), data: routine({ 'orbis/routine_mode': 'act' }) },
      ],
      ['entity_update mode', UPDATE_DEF, { id: newId(), props: { 'orbis/routine_mode': 'act' } }],
      [
        'entity_update allowed_tools',
        UPDATE_DEF,
        { id: newId(), props: { 'orbis/allowed_tools': ['entity_create'] } },
      ],
      // Возврат в propose — тоже правка доверенности: разоружение рутины владелец
      // обязан видеть так же, как её вооружение.
      [
        'entity_update mode обратно в propose',
        UPDATE_DEF,
        { id: newId(), props: { 'orbis/routine_mode': 'propose' } },
      ],
      // РАЗОРУЖЕНИЕ ЧЕРЕЗ `unset` — вторая половина патча (§А9-1). В старой карте оно
      // выражалось значением (`{allowed_tools: null}`) и попадало под то же условие; в
      // новой форме снятие — ОТДЕЛЬНЫЙ список, и читатель одних `props` пропускал бы его
      // мимо замка (регресс, найденный гейт-ревью: `execute` вместо подтверждения).
      [
        'entity_update unset allowed_tools (снятие белого списка)',
        UPDATE_DEF,
        { id: newId(), unset: ['orbis/allowed_tools'] },
      ],
      [
        'entity_update unset routine_mode (снятие режима)',
        UPDATE_DEF,
        { id: newId(), unset: ['orbis/routine_mode'] },
      ],
      // Обе половины разом — тот же ответ, а не «одна перебила другую»
      [
        'entity_update props + unset вместе',
        UPDATE_DEF,
        { id: newId(), props: { 'orbis/routine_mode': 'act' }, unset: ['orbis/allowed_tools'] },
      ],
      // НАБОР ЦЕЛИКОМ (attach/create): назвать белый список — уже выдача, при ЛЮБОМ режиме.
      // Иначе проходила двухшаговая эскалация: шаг 1 молча раздаёт инструменты propose-рутине,
      // шаг 2 просит только `act`, и карточка вооружения про инструменты молчит по правилу
      // «у update молчание значит прежний» — владелец подтверждает, не увидев, чем вооружает.
      [
        'attach_orbis_routine с allowed_tools при mode propose',
        ATTACH_DEF,
        { entity_id: newId(), data: routine({ 'orbis/allowed_tools': ['entity_create'] }) },
      ],
      [
        'entity_create propose-рутины СРАЗУ с белым списком',
        CREATE_DEF,
        {
          title: 'Рождена вооружённой',
          tags: [],
          props: routine({ 'orbis/allowed_tools': ['entity_create'] }),
          aspects: ['orbis/routine'],
        },
      ],
    ];
    for (const [name, def, input] of cases) {
      expect(factsFromToolCall(def, input).grantsAutonomy).toBe(true);
      for (const actorKind of ['ai', 'agent'] as const) {
        expect([name, levelOf(def, input, actorKind)]).toEqual([name, 'explicit-confirmation']);
      }
    }
  });

  test('актором owner ряд не срабатывает: владелец выдаёт автономию сам, подтверждать некому', () => {
    const input = {
      title: 'Утренний обзор',
      tags: [],
      props: routine({ 'orbis/routine_mode': 'act' }),
      aspects: ['orbis/routine'],
    };
    expect(levelOf(CREATE_DEF, input, 'owner')).toBe('execute');
  });

  test('mode propose и правка расписания автономии не выдают → execute', () => {
    const created = {
      title: 'Утренний обзор',
      tags: [],
      props: routine(),
      aspects: ['orbis/routine'],
    };
    expect(factsFromToolCall(CREATE_DEF, created).grantsAutonomy).toBe(false);
    expect(levelOf(CREATE_DEF, created)).toBe('execute');

    // attach с mode propose И БЕЗ белого списка ПРАВ НЕ ВЫДАЁТ — это про КЛАССИФИКАТОР, и
    // только про него. ОЖИДАНИЕ ПЕРЕПИСАНО ФИКС-РАУНДОМ 2 (рулинг Р-12-2): прежде эта строка
    // означала «такой вызов исполняется без подтверждения», и это было неправдой про
    // систему — тот же вызов на ВООРУЖЁННОЙ рутине стирает её белый список заменой носителя
    // (§А7-4) или гасит её режим эхом. Разоружение по-прежнему требует карточки, но видит
    // его не классификатор (он чист и состояния не знает), а диспатч —
    // `autonomyChangedByCarrier`, который держит и четвёртый путь (снятие аспекта рутины у
    // вооружённой, Р-12-3); пин обеих сторон живёт на живой БД в `dispatch.test.ts`.
    const attach = { entity_id: newId(), data: routine() };
    expect(factsFromToolCall(ATTACH_DEF, attach).grantsAutonomy).toBe(false);
    expect(levelOf(ATTACH_DEF, attach)).toBe('execute');

    // Патч расписания и жизненного цикла доверенности не касается
    const reschedule = {
      id: newId(),
      props: { 'orbis/routine_at': '09:00', 'orbis/routine_stage': 'paused' },
    };
    expect(factsFromToolCall(UPDATE_DEF, reschedule).grantsAutonomy).toBe(false);
    expect(levelOf(UPDATE_DEF, reschedule)).toBe('execute');

    // ПУСТОЙ белый список в НАБОРЕ выдачей не является: он ничего не разрешает, и рутина с
    // `allowed_tools: []` безоружна так же, как без свойства вовсе. Ответ у набора и у пробы
    // состояния (`autonomyArmed`, она же считает вооружённость по БД) обязан быть ОДИН —
    // иначе владельца просят подтвердить выдачу ничего (Н-1 ре-ревью фикс-раунда 3).
    const attachEmpty = {
      entity_id: newId(),
      data: routine({ 'orbis/allowed_tools': [] }),
    };
    expect(factsFromToolCall(ATTACH_DEF, attachEmpty).grantsAutonomy).toBe(false);
    expect(levelOf(ATTACH_DEF, attachEmpty)).toBe('execute');
    const createEmpty = {
      title: 'Пустой список',
      tags: [],
      props: routine({ 'orbis/allowed_tools': [] }),
      aspects: ['orbis/routine'],
    };
    expect(factsFromToolCall(CREATE_DEF, createEmpty).grantsAutonomy).toBe(false);
    // …а ОДИН элемент — уже выдача (тот же вход, длина списка другая).
    const attachOne = { entity_id: newId(), data: routine({ 'orbis/allowed_tools': ['x'] }) };
    expect(factsFromToolCall(ATTACH_DEF, attachOne).grantsAutonomy).toBe(true);
    // В ПАТЧЕ пустой список — наоборот, выдача: там это не «инструментов нет», а «ОТНЯТЬ
    // инструменты у живой рутины». Набор описывает состояние, патч — переход.
    const patchEmpty = { id: newId(), props: { 'orbis/allowed_tools': [] } };
    expect(factsFromToolCall(UPDATE_DEF, patchEmpty).grantsAutonomy).toBe(true);

    // Чужое свойство — не доверенность рутины
    const foreign = { id: newId(), props: { 'orbis/task_status': 'done' } };
    expect(factsFromToolCall(UPDATE_DEF, foreign).grantsAutonomy).toBe(false);

    // Обе стороны границы `unset` в одной фикстуре: снятие ЧУЖОГО свойства замка не
    // трогает — иначе ветка `unset` ловила бы всё подряд и «сработала» бы вакуумно.
    const unsetForeign = { id: newId(), unset: ['orbis/waiting_for'] };
    expect(factsFromToolCall(UPDATE_DEF, unsetForeign).grantsAutonomy).toBe(false);
    expect(levelOf(UPDATE_DEF, unsetForeign)).toBe('execute');
    // …а снятие свойства доверенности — трогает (тот же вход, другое имя свойства).
    const unsetAutonomy = { id: newId(), unset: ['orbis/allowed_tools'] };
    expect(factsFromToolCall(UPDATE_DEF, unsetAutonomy).grantsAutonomy).toBe(true);
    expect(levelOf(UPDATE_DEF, unsetAutonomy)).toBe('explicit-confirmation');
  });

  test('batch: любая операция выдачи автономии поднимает весь batch (ряд ПЕРЕД isBatch → preview)', () => {
    const withAutonomy = {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'Итог', tags: [] } },
        {
          tool: 'attach_orbis_routine',
          input: { entity_id: newId(), data: routine({ 'orbis/routine_mode': 'act' }) },
        },
      ],
    };
    const f = factsFromToolCall(BATCH_DEF, withAutonomy);
    expect(f.grantsAutonomy).toBe(true);
    // Ряд масштаба здесь дал бы preview (2 операции) — автономия обязана быть первее
    expect(f.isBatch).toBe(true);
    expect(f.batchSize).toBe(2);
    expect(levelOf(BATCH_DEF, withAutonomy)).toBe('explicit-confirmation');

    const plain = {
      batch_id: newId(),
      operations: [{ tool: 'entity_create', input: { title: 'Итог', tags: [] } }],
    };
    expect(factsFromToolCall(BATCH_DEF, plain).grantsAutonomy).toBe(false);
  });

  test('ряды 1–6 не сдвинулись: grantsAutonomy=false по умолчанию, уровни прежние', () => {
    expect(factsFromToolCall(UPDATE_DEF, { id: newId(), title: 'x' }).grantsAutonomy).toBe(false);
    expect(classifyToolCall(facts({ known: false }))).toBe('forbidden'); // ряд 1
    expect(classifyToolCall(facts({ kind: 'read' }))).toBe('execute'); // ряд 2
    expect(classifyToolCall(facts({ archives: true }))).toBe('explicit-confirmation'); // ряд 3
    expect(classifyToolCall(facts({ isBatch: true, batchSize: 11 }))).toBe('explicit-confirmation'); // ряд 4
    expect(classifyToolCall(facts({ isBatch: true, batchSize: 2 }))).toBe('preview'); // ряд 5
    expect(classifyToolCall(facts())).toBe('execute'); // ряд 6

    // Ряд 1 первее автономии: незнакомый тул не исполняется ни на каком уровне
    expect(classifyToolCall(facts({ known: false, grantsAutonomy: true }))).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// §С2-1: класс подтверждения мутаций реестра — ряды 4a/4b (Задача 16)
// ---------------------------------------------------------------------------

/**
 * «Молчаливых мутаций реестра не существует ни для какого актора» (§С2-1, норматив Б1).
 * Здесь пиннится ОТВЕТ КЛАССИФИКАТОРА на каждый ряд таблицы; живые пути — `dispatch.test.ts`
 * (чат, рутина, UI-роутер) и `mcp.test.ts` (скоуп worker).
 */
describe('§С2-1: перенастраивает поверхность или права — reconfiguresOf и ряды 4a/4b', () => {
  const OWN = '019e4466-1111-7e07-b5d4-64be9721da01'; // id своей строки реестра — uuid (Р3)
  const OTHER = '019e4466-2222-7e07-b5d4-64be9721da02';
  const CREATE_INPUT = {
    label: { ru: 'Усилие' },
    description: { ru: 'Сколько сил отнимет' },
    type: { kind: 'number' },
    status: 'proposed' as const,
  };
  const defOf = (name: string) => ({ name, kind: 'mutate' as const });
  const levelFor = (name: string, input: unknown, actorKind: ActorKind = 'ai') =>
    classifyToolCall({
      ...factsFromToolCall(defOf(name), input),
      actorKind,
      explicitCommand: false,
    });

  test('пять тулов реестра разложены по трём ответам; всё прочее — none', () => {
    // ПЕРЕХОДЫ, а не формы вызова (вывод десяти фикс-раундов Задачи 12): каждая строка —
    // один переход защищаемого состояния «что владелец видит и что система делает».
    const cases: Array<[string, string, unknown, Reconfigures]> = [
      ['1. родилась своя строка ПРЕДЛОЖЕНИЕМ', 'property_create', CREATE_INPUT, 'own-property'],
      [
        // Р-24-8: тот же итог, что у перехода 3, — значит и тот же замок. Без этой строки
        // ЛЮБОЕ из двух решений владельца легло бы без красного (мутационная проба M1).
        '1б. родилась своя строка СРАЗУ АКТИВНОЙ',
        'property_create',
        { ...CREATE_INPUT, status: 'active' as const },
        'behavior-delta',
      ],
      [
        '2. сменилась подпись своей строки',
        'property_update',
        { id: OWN, label: { ru: 'Усилие' } },
        'own-property',
      ],
      [
        '2. сменились область показа и место в порядке',
        'property_update',
        { id: OWN, scope: { filter: { aspect: 'orbis/task' } }, rank: 7 },
        'own-property',
      ],
      [
        '3. сменился СТАТУС своей строки',
        'property_update',
        { id: OWN, status: 'active' },
        'behavior-delta',
      ],
      [
        '4. слились два своих свойства',
        'property_merge',
        { source: OWN, into: OTHER },
        'behavior-delta',
      ],
      [
        '5. дельта поверх СВОЕГО аспекта',
        'aspect_delta_set',
        { aspect: 'user/sleep-log', delta: { icon: '😴' } },
        'behavior-delta',
      ],
      [
        '6. снятие дельты СВОЕГО аспекта',
        'aspect_delta_remove',
        { aspect: 'user/sleep-log' },
        'behavior-delta',
      ],
      [
        '7. правка ВСТРОЕННОГО свойства',
        'property_update',
        { id: 'orbis/priority', label: { ru: 'Важность' } },
        'system-object',
      ],
      [
        '7. встроенное свойство ЦЕЛЬЮ слияния',
        'property_merge',
        { source: OWN, into: 'orbis/title' },
        'system-object',
      ],
      [
        '7. встроенное свойство ИСТОЧНИКОМ слияния',
        'property_merge',
        { source: 'orbis/priority', into: OWN },
        'system-object',
      ],
      [
        '7. дельта поверх ВСТРОЕННОГО аспекта',
        'aspect_delta_set',
        { aspect: 'orbis/task', delta: { label: { ru: 'Дела' } } },
        'system-object',
      ],
      [
        '7. снятие дельты встроенного аспекта',
        'aspect_delta_remove',
        { aspect: 'orbis/note' },
        'system-object',
      ],
    ];
    for (const [what, tool, input, expected] of cases) {
      expect([what, reconfiguresOf(tool, input)]).toEqual([what, expected]);
      expect([what, factsFromToolCall(defOf(tool), input).reconfigures]).toEqual([what, expected]);
    }
    // Обратная сторона границы: тулы графа реестра не трогают, и ряды 4a/4b на них молчат.
    for (const [tool, input] of [
      ['entity_update', { id: newId(), title: 'x' }],
      ['entity_create', { title: 'x', tags: [] }],
      ['attach_orbis_task', { entity_id: newId(), data: {} }],
      ['relation_create', { source_id: newId(), target_id: newId(), role: 'subitem' }],
    ] as const) {
      expect([tool, reconfiguresOf(tool, input)]).toEqual([tool, 'none']);
    }
  });

  test('машинерия делегирования: дельта поверх orbis/routine, agent-run и assignment — тоже system-object', () => {
    // Реконфигурация ОПРЕДЕЛЕНИЯ этих аспектов — тот же переход, что запрещён рутине над их
    // ЗАПИСЯМИ (`ROUTINE_UNTOUCHABLE_OBJECTS` ∪ `orbis/assignment`), только другой дверью:
    // скрыв `orbis/routine_mode` из аспекта, фон убрал бы доверенность с глаз владельца.
    // Отдельного списка для этого не заведено — правило по адресу накрывает их само, и этот
    // тест сторожит, что накрывает.
    for (const aspect of [...ROUTINE_UNTOUCHABLE_OBJECTS, 'orbis/assignment']) {
      expect([aspect, reconfiguresOf('aspect_delta_set', { aspect, delta: {} })]).toEqual([
        aspect,
        'system-object',
      ]);
    }
    // Ни один из тринадцати встроенных аспектов не считается своим — перечень закрыт.
    for (const aspect of BUILTIN_ASPECT_DEFS) {
      expect([aspect.id, reconfiguresOf('aspect_delta_remove', { aspect: aspect.id })]).toEqual([
        aspect.id,
        'system-object',
      ]);
    }
  });

  test('`implements` встроенных аспектов сегодня ПУСТ (§Б2) — правило накрывает их адресом', () => {
    // Tripwire к §С2-1: спека называет «`implements` встроенных аспектов» отдельным
    // объектом запрета. В срезе А поле объявлено и пустует (часть Б), поэтому ветки по нему
    // здесь НЕТ — её нечем было бы достичь, а пин на недостижимом пути ничего не сторожит.
    // Наполнится `implements` — упадёт эта строка, и правило придётся перечитать: сегодня
    // все тринадцать носителей будущих привязок и так `system-object` (тест выше), а
    // аспекты владельца (`user/…`) привязки получат вместе с частью Б.
    expect(BUILTIN_ASPECT_DEFS.every((a) => a.implements.length === 0)).toBe(true);
  });

  test('ряд 4a: behavior-delta и system-object → explicit-confirmation ДЛЯ ЛЮБОГО актора', () => {
    const heavy: Array<[string, unknown]> = [
      ['property_update', { id: OWN, status: 'deprecated' }],
      ['property_merge', { source: OWN, into: OTHER }],
      ['aspect_delta_set', { aspect: 'orbis/task', delta: { icon: '📌' } }],
      ['aspect_delta_remove', { aspect: 'orbis/task' }],
    ];
    for (const [tool, input] of heavy) {
      for (const actorKind of ['ai', 'agent', 'owner'] as const) {
        expect([tool, actorKind, levelFor(tool, input, actorKind)]).toEqual([
          tool,
          actorKind,
          'explicit-confirmation',
        ]);
      }
    }
  });

  test('ряд 4b: своя строка от AI/агента → preview, от владельца → execute', () => {
    for (const [tool, input] of [
      ['property_create', CREATE_INPUT],
      ['property_update', { id: OWN, label: { ru: 'Усилие' } }],
    ] as const) {
      for (const actorKind of ['ai', 'agent'] as const) {
        expect([tool, actorKind, levelFor(tool, input, actorKind)]).toEqual([
          tool,
          actorKind,
          'preview',
        ]);
      }
      // Владелец делает это сам — подтверждать некому (тот же довод, что у ряда автономии).
      // Живьём владелец сюда и не доходит: `routers/registry.ts` зовёт `execute` напрямую.
      expect([tool, levelFor(tool, input, 'owner')]).toEqual([tool, 'execute']);
    }
  });

  test('property_create со status=active → explicit-confirmation: итог тот же, что у перехода 3 (Р-24-8)', () => {
    // Два пути в ОДНО состояние («активная своя строка существует») обязаны иметь один
    // замок: `property_update {status:'active'}` его уже имеет, а `property_create` сразу
    // активной обходил и его, и кап §А2-7 разом.
    for (const actorKind of ['ai', 'agent'] as const) {
      expect(levelFor('property_create', { ...CREATE_INPUT, status: 'active' }, actorKind)).toBe(
        'explicit-confirmation',
      );
    }
    // Ветка предложения не тронута — иначе разбор пачки §А2-7 стал бы разговором на каждую
    // догадку модели.
    expect(levelFor('property_create', CREATE_INPUT)).toBe('preview');
  });

  test('ряд 4a стоит ВЫШЕ 4b: пачка «своё свойство + слияние» подтверждается целиком', () => {
    const batch = {
      batch_id: newId(),
      operations: [
        { tool: 'property_create', input: CREATE_INPUT },
        { tool: 'property_merge', input: { source: OWN, into: OTHER } },
      ],
    };
    const f = factsFromToolCall({ name: 'batch_execute', kind: 'mutate' }, batch);
    expect(f.reconfigures).toBe('behavior-delta');
    expect(classifyToolCall({ ...f, actorKind: 'ai', explicitCommand: false })).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 4b НЕ гасит ряд масштаба: 11 операций с property_create внутри → explicit-confirmation', () => {
    // Стой 4b рядом с 4a, первое совпадение сверху отдало бы пачке `preview`, то есть
    // исполнило бы одиннадцать операций и лишь показало diff.
    const batch = {
      batch_id: newId(),
      operations: [
        { tool: 'property_create', input: CREATE_INPUT },
        ...Array.from({ length: 10 }, () => ({
          tool: 'entity_create',
          input: { title: 'x', tags: [] },
        })),
      ],
    };
    const f = factsFromToolCall({ name: 'batch_execute', kind: 'mutate' }, batch);
    expect([f.reconfigures, f.batchSize]).toEqual(['own-property', 11]);
    expect(classifyToolCall({ ...f, actorKind: 'ai', explicitCommand: false })).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 4b НЕ гасит замок автономии: пачка «своё свойство + act-рутина» → explicit-confirmation', () => {
    const batch = {
      batch_id: newId(),
      operations: [
        { tool: 'property_create', input: CREATE_INPUT },
        {
          tool: 'attach_orbis_routine',
          input: { entity_id: newId(), data: { [ROUTINE_MODE_PROPERTY]: 'act' } },
        },
      ],
    };
    const f = factsFromToolCall({ name: 'batch_execute', kind: 'mutate' }, batch);
    expect([f.reconfigures, f.grantsAutonomy]).toEqual(['own-property', true]);
    expect(classifyToolCall({ ...f, actorKind: 'ai', explicitCommand: false })).toBe(
      'explicit-confirmation',
    );
  });

  test('ряд 3 остаётся первее: архивирующий вызов с реестром в пачке — тот же explicit-confirmation', () => {
    // Ряд 4a даёт тот же уровень, поэтому наблюдаемо ровно одно: новые ряды не ПОНИЖАЮТ
    // ничего, что таблица уже подняла (граница проверяется и сверху, и снизу).
    const batch = {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: newId(), archived: true } },
        { tool: 'property_create', input: CREATE_INPUT },
      ],
    };
    const f = factsFromToolCall({ name: 'batch_execute', kind: 'mutate' }, batch);
    expect([f.archives, f.reconfigures]).toEqual([true, 'own-property']);
    expect(classifyToolCall({ ...f, actorKind: 'ai', explicitCommand: false })).toBe(
      'explicit-confirmation',
    );
  });

  test('мусор вместо конверта — самый тяжёлый ответ, а не самый лёгкий (fail-closed)', () => {
    for (const input of [null, 'строка', 42, ['список']]) {
      expect([input, reconfiguresOf('property_update', input)]).toEqual([input, 'system-object']);
    }
    // Адрес не той формы — тоже чужой: свой это либо uuid, либо `user/…` (§А2-1).
    for (const id of ['effort', 'orbis/effort', 'app-x/effort', '', 42, null, undefined]) {
      expect([id, reconfiguresOf('property_update', { id, label: { ru: 'x' } })]).toEqual([
        id,
        'system-object',
      ]);
    }
    // …а обе своих формы адреса — свои (обратная сторона той же границы).
    for (const id of [OWN, 'user/effort']) {
      expect([id, reconfiguresOf('property_update', { id, label: { ru: 'x' } })]).toEqual([
        id,
        'own-property',
      ]);
    }
  });

  test('перечень тулов реестра берётся у реестра, а не переписан здесь литералами', () => {
    // Шестой тул реестра, заведённый без правки `reconfiguresOf`, получит `system-object`
    // (fail-closed ветка switch'а), а не молчаливое `none`, — и упадёт вот на этой строке.
    expect([...REGISTRY_TOOL_NAMES].sort()).toEqual([
      'aspect_delta_remove',
      'aspect_delta_set',
      'property_create',
      'property_merge',
      'property_update',
    ]);
    for (const tool of REGISTRY_TOOL_NAMES) {
      expect([tool, reconfiguresOf(tool, {})]).not.toEqual([tool, 'none']);
    }
  });
});

// ---------------------------------------------------------------------------
// Адреса доверенности ≡ реестр (Minor-4 фикс-раунда 3)
// ---------------------------------------------------------------------------

/**
 * `ROUTINE_MODE_PROPERTY`/`ROUTINE_TOOLS_PROPERTY` объявлены ОДИН раз, но объявление само по
 * себе не гарантирует, что оно называет ЖИВЫЕ свойства реестра: разъедься константа с ним —
 * и гейт §7.10 смотрел бы на адрес, которого нет, молча отвечая `execute` на любую правку
 * доверенности. Читатели-литералы, до которых константа дойти НЕ МОЖЕТ (реестр свойств
 * живёт в `@orbis/shared` и на `apps/server` ссылаться не вправе), связаны с ней здесь пином
 * — он и заменяет им импорт.
 */
describe('адреса доверенности ≡ реестр (Minor-4)', () => {
  const routineAspect = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/routine');

  test('обе константы — свойства аспекта orbis/routine; режим обязателен, белый список нет', () => {
    const required = new Map(
      (routineAspect?.properties ?? []).map((r) => [r.propertyId, r.required]),
    );
    expect(required.get(ROUTINE_MODE_PROPERTY)).toBe(true);
    expect(required.get(ROUTINE_TOOLS_PROPERTY)).toBe(false);
    // Стадия живёт в том же доме, но ВНЕ множества доверенности: она выключатель, а не право.
    // Пин ловит и её расхождение с реестром, и попадание в `AUTONOMY_PROPERTIES` — от второго
    // гейт формы начал бы требовать карточку на постановку рутины на паузу, то есть на
    // СУЖЕНИЕ прав (разбор направлений — в докблоке `grantsRoutineAutonomy`).
    expect(required.get(ROUTINE_STAGE_PROPERTY)).toBe(true);
    expect(AUTONOMY_PROPERTIES).not.toContain(ROUTINE_STAGE_PROPERTY);
    // Обязательность — не мелочь: на ней стоит довод, почему «назвать белый список = выдача»
    // не шумит (`autonomyArmed`), и почему консервативный вариант пробы был отклонён.
    expect([...AUTONOMY_PROPERTIES]).toEqual([ROUTINE_MODE_PROPERTY, ROUTINE_TOOLS_PROPERTY]);
  });

  test('вооружённость считает ОДНА функция: набор и состояние отвечают одинаково', () => {
    // `autonomyArmed` зовут двое: гейт (набор из payload'а) и проба состояния по БД
    // (`autonomyChangedByCarrier`). Пока формулы стояли врозь, `allowed_tools: []` был
    // «выдачей» у одного и «безоружностью» у другого.
    for (const values of [
      { [ROUTINE_MODE_PROPERTY]: 'act' },
      { [ROUTINE_TOOLS_PROPERTY]: ['entity_create'] },
      { [ROUTINE_MODE_PROPERTY]: 'act', [ROUTINE_TOOLS_PROPERTY]: [] },
    ]) {
      expect([values, autonomyArmed(values)]).toEqual([values, true]);
    }
    for (const values of [
      {},
      { [ROUTINE_MODE_PROPERTY]: 'propose' },
      { [ROUTINE_TOOLS_PROPERTY]: [] },
      { [ROUTINE_MODE_PROPERTY]: 'propose', [ROUTINE_TOOLS_PROPERTY]: [] },
    ]) {
      expect([values, autonomyArmed(values)]).toEqual([values, false]);
    }
  });

  test('оба свойства — скаляр и список строк: сравнение значений по JSON точное', () => {
    // Довод докблока `sameAutonomyValue` (tools/dispatch.ts): порядок ключей объекта
    // сравнение не подводит, потому что объектов среди значений доверенности нет. Стань
    // одно из них `json` — довод перестанет быть правдой, и упадёт здесь.
    const kinds = AUTONOMY_PROPERTIES.map(
      (id) => BUILTIN_PROPERTY_META.find((p) => p.id === id)?.type.kind,
    );
    expect(kinds).toEqual(['select', 'text']);
  });
});
