// apps/server/src/policy/confirmation.test.ts
// Юнит-тесты классификатора §7.10 (Task 5, слайс 1b): детерминированная таблица MVP —
// каждый ряд и границы закреплены отдельным тестом, порядок «первое совпадение сверху»
// значим. БД не нужна: классификация — чистая функция типизированных фактов вызова.
// Интеграционное подключение к dispatch — tools/dispatch.test.ts (describe §7.10).
// Вместе они закрывают контракт-заглушку shared/contracts/confirmation-policy.test.ts
// (describe.skip удалён этой задачей).
import { describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { AGENT_VERB_NAMES, buildToolDefs } from '../tools/registry';
import {
  classifyToolCall,
  entityUpdatePreviewDiff,
  factsFromToolCall,
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
 * Дефы берутся из НАСТОЯЩЕГО реестра (`buildToolDefs([])` — core + глаголы; attach_*
 * требуют строк аспектов, а их здесь и не проверяем), а факты — из `factsFromToolCall`.
 * Выдуманный `{kind:'mutate'}` в тесте закрепил бы намерение автора теста, а не то, что
 * реестр реально объявляет: смена `kind` глагола на что-то иное обязана падать здесь.
 */
describe('глаголы исполнителя и thread_post → execute (инвариант 4, ряд 6 таблицы §7.10)', () => {
  const defs = buildToolDefs([]);
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

  test('поле, которого прежде не было (нет в inverse) → before: undefined', () => {
    const id = newId();
    const diff = entityUpdatePreviewDiff({
      operations: [
        { op: 'entity_update', payload: { id, aspects: { 'orbis/task': { status: 'done' } } } },
      ],
      inverse: [{ op: 'entity_update', payload: { id } }],
    });
    expect(diff.aspects).toEqual({
      before: undefined,
      after: { 'orbis/task': { status: 'done' } },
    });
  });
});
