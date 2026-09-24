import { describe, expect, test } from 'bun:test';
import { PAGE_ASPECT, TEMPLATE_FOR_PROPERTY, TEMPLATE_WINS_OVER_PROPERTY } from '../constants';
import {
  type BrokenTemplate,
  chooseTemplate,
  contendersOf,
  recordDisputeChoice,
  type TemplateCandidate,
  type TemplateChoice,
  templatesFromRows,
} from './choose-template';

const P = 'orbis/project';
const T = 'orbis/task';
const PT = { aspects: [P, T] };

const t = (
  id: string,
  forAspects: readonly string[],
  winsOver: readonly string[] = [],
  createdAt = '2026-09-01T00:00:00Z',
): TemplateCandidate => ({ id, forAspects, winsOver, createdAt });

const allOk = () => null;

/**
 * Разбор «сломан» для перечисленных id. Повторный вопрос о том же id — ошибка теста, а не
 * ответ: шаг 7 исключает сломанный шаблон навсегда, и второй вопрос значит, что выбор ходит
 * по кругу. Таймаут `bun test` (1.2.7) синхронный бесконечный цикл НЕ обрывает — проверено:
 * тест висит, пока процесс не убит снаружи. Поэтому петлю ловит этот сторож, а не таймаут.
 */
function brokenBy(reasons: Record<string, string>): (id: string) => string | null {
  const asked = new Set<string>();
  return (id) => {
    if (asked.has(id)) throw new Error(`разбор шаблона ${id} спрошен повторно — выбор зациклился`);
    asked.add(id);
    return reasons[id] ?? null;
  };
}

describe('§4.2–4.3: таблица случаев С1а-3', () => {
  test('страница: запись с orbis/page показывается своим телом, шаблоны не смотрятся', () => {
    const subject = { aspects: [PAGE_ASPECT, P] };
    const templates = [t('A', [P]), t('B', [P])];
    expect(chooseTemplate(subject, templates, allOk)).toEqual({ kind: 'own-body' });
    // Спора у страницы нет: шаг 1 раньше шагов 4–5.
    expect(contendersOf(subject, templates)).toBeNull();
  });

  test('нет подходящих: шаблон хоста, сломанных нет', () => {
    expect(chooseTemplate({ aspects: [T] }, [t('A', [P])], allOk)).toEqual({
      kind: 'host',
      broken: [],
    });
  });

  test('один подходящий: он, без спора', () => {
    expect(chooseTemplate(PT, [t('A', [P])], allOk)).toEqual({
      kind: 'template',
      id: 'A',
      dispute: null,
      broken: [],
    });
  });

  test('больший набор побеждает меньший', () => {
    expect(chooseTemplate(PT, [t('A', [P]), t('B', [P, T])], allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: null,
      broken: [],
    });
  });

  test('ничья без выбора: раньше созданный, плюс спор', () => {
    const a = t('A', [P], [], '2026-09-01T00:00:00Z');
    const b = t('B', [T], [], '2026-09-02T00:00:00Z');
    expect(chooseTemplate(PT, [a, b], allOk)).toEqual({
      kind: 'template',
      id: 'A',
      dispute: ['A', 'B'],
      broken: [],
    });
    // Дата главнее id: раньше создан B — показывается B, спорящие те же.
    const earlyB = t('B', [T], [], '2026-08-31T00:00:00Z');
    expect(chooseTemplate(PT, [a, earlyB], allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: ['A', 'B'],
      broken: [],
    });
  });

  test('ничья с равной датой: меньший id, плюс спор; порядок списка не влияет', () => {
    const a = t('A', [P]);
    const b = t('B', [T]);
    const want: TemplateChoice = { kind: 'template', id: 'A', dispute: ['A', 'B'], broken: [] };
    expect(chooseTemplate(PT, [a, b], allOk)).toEqual(want);
    expect(chooseTemplate(PT, [b, a], allOk)).toEqual(want);
  });

  test('ничья с выбором: запомненный победитель, спора нет', () => {
    const a = t('A', [P], [], '2026-09-01T00:00:00Z');
    const b = t('B', [T], ['A'], '2026-09-02T00:00:00Z');
    expect(chooseTemplate(PT, [a, b], allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: null,
      broken: [],
    });
  });

  test('новый участник: прежний выбор его не покрывает — снова спор', () => {
    const a = t('A', [P], [], '2026-09-01T00:00:00Z');
    const b = t('B', [T], ['A'], '2026-09-02T00:00:00Z');
    const c = t('C', [T], [], '2026-09-03T00:00:00Z');
    expect(chooseTemplate(PT, [c, b, a], allOk)).toEqual({
      kind: 'template',
      id: 'A',
      dispute: ['A', 'B', 'C'],
      broken: [],
    });
  });

  test('противоречие: A главнее B и B главнее A — выбор не сделан, показ детерминирован', () => {
    const a = t('A', [P], ['B'], '2026-09-01T00:00:00Z');
    const b = t('B', [T], ['A'], '2026-09-02T00:00:00Z');
    const want: TemplateChoice = { kind: 'template', id: 'A', dispute: ['A', 'B'], broken: [] };
    expect(chooseTemplate(PT, [a, b], allOk)).toEqual(want);
    expect(chooseTemplate(PT, [b, a], allOk)).toEqual(want);
  });

  test('цикл из трёх: A главнее B, B главнее C, C главнее A — выбор не сделан, показ детерминирован', () => {
    // Каждый покрывает лишь одного из двух прочих, и каждого кто-то бьёт: победителя нет ни при
    // каком порядке обхода M.
    const a = t('A', [P], ['B'], '2026-09-01T00:00:00Z');
    const b = t('B', [P], ['C'], '2026-09-02T00:00:00Z');
    const c = t('C', [P], ['A'], '2026-09-03T00:00:00Z');
    const want: TemplateChoice = {
      kind: 'template',
      id: 'A',
      dispute: ['A', 'B', 'C'],
      broken: [],
    };
    expect(chooseTemplate(PT, [a, b, c], allOk)).toEqual(want);
    expect(chooseTemplate(PT, [c, b, a], allOk)).toEqual(want);
  });

  test('побеждённый вне M не в счёт: «Главнее, чем» шаблона с меньшим набором победителя не снимает', () => {
    // X{project} в M не входит (набор меньше), и его «X главнее B» к спору B и C отношения не имеет.
    // C создан раньше: учти шаг 5 слово X, победителя не было бы, и показался бы C со спором.
    const x = t('X', [P], ['B'], '2026-08-01T00:00:00Z');
    const b = t('B', [P, T], ['C'], '2026-09-02T00:00:00Z');
    const c = t('C', [P, T], [], '2026-09-01T00:00:00Z');
    const want: TemplateChoice = { kind: 'template', id: 'B', dispute: null, broken: [] };
    expect(chooseTemplate(PT, [x, b, c], allOk)).toEqual(want);
    expect(chooseTemplate(PT, [c, b, x], allOk)).toEqual(want);
    // Один на вершине — тоже B: чужое «главнее» из-под вершины его не сдвигает.
    expect(chooseTemplate(PT, [x, b], allOk)).toEqual(want);
  });

  test('самоссылка игнорируется: из строк графа', () => {
    const rows = [
      { id: 'A', props: { [TEMPLATE_FOR_PROPERTY]: [P] }, createdAt: '2026-09-01T00:00:00Z' },
      {
        id: 'B',
        props: { [TEMPLATE_FOR_PROPERTY]: [T], [TEMPLATE_WINS_OVER_PROPERTY]: ['B', 'A'] },
        createdAt: '2026-09-02T00:00:00Z',
      },
    ];
    const templates = templatesFromRows(rows);
    expect(templates.find((x) => x.id === 'B')?.winsOver).toEqual(['A']);
    expect(chooseTemplate(PT, templates, allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: null,
      broken: [],
    });
  });

  test('самоссылка игнорируется: прямой вызов в обход templatesFromRows', () => {
    const a = t('A', [P], [], '2026-09-01T00:00:00Z');
    const b = t('B', [T], ['B', 'A'], '2026-09-02T00:00:00Z');
    expect(chooseTemplate(PT, [a, b], allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: null,
      broken: [],
    });
    expect(contendersOf(PT, [a, b])).toEqual(['A', 'B']);
    // Ссылка только на себя выбором не считается: спор остаётся спором.
    const selfOnly = t('B', [T], ['B'], '2026-09-02T00:00:00Z');
    expect(chooseTemplate(PT, [a, selfOnly], allOk)).toEqual({
      kind: 'template',
      id: 'A',
      dispute: ['A', 'B'],
      broken: [],
    });
  });

  test('сломанный: исключается, выбор повторяется с шага 2', () => {
    const got = chooseTemplate(
      PT,
      [t('A', [P]), t('B', [P, T])],
      brokenBy({ B: 'нет закрытия {{/tabs}}' }),
    );
    expect(got).toEqual({
      kind: 'template',
      id: 'A',
      dispute: null,
      broken: [{ id: 'B', reason: 'нет закрытия {{/tabs}}' }],
    });
  });

  test('сломанный на вершине: спор считается по оставшимся', () => {
    const templates = [
      t('A', [P], [], '2026-09-01T00:00:00Z'),
      t('C', [T], [], '2026-09-02T00:00:00Z'),
      t('B', [P, T]),
    ];
    expect(chooseTemplate(PT, templates, brokenBy({ B: 'сломан' }))).toEqual({
      kind: 'template',
      id: 'A',
      dispute: ['A', 'C'],
      broken: [{ id: 'B', reason: 'сломан' }],
    });
    // Сломанный из спора выпадает — остался один, спора нет.
    const tie = [t('A', [P], [], '2026-09-01T00:00:00Z'), t('C', [T], [], '2026-09-02T00:00:00Z')];
    expect(chooseTemplate(PT, tie, brokenBy({ A: 'сломан' }))).toEqual({
      kind: 'template',
      id: 'C',
      dispute: null,
      broken: [{ id: 'A', reason: 'сломан' }],
    });
    expect(contendersOf(PT, tie, new Set(['A']))).toBeNull();
  });

  test('все сломаны: шаблон хоста, сломанные перечислены', () => {
    expect(chooseTemplate(PT, [t('A', [P])], brokenBy({ A: 'сломан' }))).toEqual({
      kind: 'host',
      broken: [{ id: 'A', reason: 'сломан' }],
    });
    // Несколько уровней, все сломаны: каждый спрошен ровно раз, порядок — порядок попыток.
    const templates = [
      t('A', [P], [], '2026-09-01T00:00:00Z'),
      t('C', [T], [], '2026-09-02T00:00:00Z'),
      t('B', [P, T]),
    ];
    const broken: BrokenTemplate[] = [
      { id: 'B', reason: 'b' },
      { id: 'A', reason: 'a' },
      { id: 'C', reason: 'c' },
    ];
    expect(chooseTemplate(PT, templates, brokenBy({ A: 'a', B: 'b', C: 'c' }))).toEqual({
      kind: 'host',
      broken,
    });
  });

  test('пустой набор: кандидат без «Шаблон для» не участвует', () => {
    expect(chooseTemplate({ aspects: [P] }, [t('E', [])], allOk)).toEqual({
      kind: 'host',
      broken: [],
    });
    expect(contendersOf({ aspects: [P] }, [t('E', []), t('A', [P])])).toBeNull();
  });
});

describe('contendersOf — спорящие для меню «Сменить выбор»', () => {
  test('ничья: отсортированные id наибольшего набора', () => {
    expect(contendersOf(PT, [t('B', [T]), t('A', [P]), t('X', [])])).toEqual(['A', 'B']);
  });

  test('спорящие есть и при запомненном выборе (плашка по требованию)', () => {
    expect(contendersOf(PT, [t('A', [P]), t('B', [T], ['A'])])).toEqual(['A', 'B']);
  });

  test('один на вершине — спора нет', () => {
    expect(contendersOf(PT, [t('A', [P]), t('B', [P, T])])).toBeNull();
    expect(contendersOf(PT, [])).toBeNull();
  });
});

describe('recordDisputeChoice — запись выбора одной пачкой (§4.3, РП-21)', () => {
  const apply = (templates: readonly TemplateCandidate[], changes: ReadonlyMap<string, string[]>) =>
    templates.map((x) => (changes.has(x.id) ? { ...x, winsOver: changes.get(x.id) ?? [] } : x));

  test('победитель покрывает спорящих, у спорящих победитель вычеркнут', () => {
    const templates = [t('A', [P], ['B']), t('B', [T]), t('C', [T], ['B'])];
    const got = recordDisputeChoice('B', ['A', 'B', 'C'], templates);
    expect(new Set(got.get('B'))).toEqual(new Set(['A', 'C']));
    expect(got.get('A')).toEqual([]);
    expect(got.get('C')).toEqual([]);
    // После записи шаг 5 находит победителя: плашки больше нет.
    expect(chooseTemplate(PT, apply(templates, got), allOk)).toEqual({
      kind: 'template',
      id: 'B',
      dispute: null,
      broken: [],
    });
  });

  test('архивный шаблон (нет в списке) из «Главнее, чем» вычищен', () => {
    const templates = [t('A', [P], ['Z']), t('B', [T], ['Z', 'A']), t('C', [T])];
    const got = recordDisputeChoice('B', ['A', 'B', 'C'], templates);
    expect(got.get('B')).toEqual(['A', 'C']);
    expect(got.get('A')).toEqual([]);
    // Архивный id среди спорящих не записывается никому.
    const withGhost = recordDisputeChoice('B', ['A', 'B', 'Z'], [t('A', [P]), t('B', [T])]);
    expect(withGhost.get('B')).toEqual(['A']);
    expect(withGhost.has('Z')).toBe(false);
  });

  test('в карту попадают только изменившиеся', () => {
    const templates = [t('A', [P]), t('B', [T], ['A']), t('C', [T]), t('D', [P], ['C'])];
    const got = recordDisputeChoice('B', ['A', 'B', 'C'], templates);
    expect([...got.keys()]).toEqual(['B']);
    expect(got.get('B')).toEqual(['A', 'C']);
  });

  test('повторный выбор того же победителя идемпотентен', () => {
    const templates = [t('A', [P], ['B', 'Z']), t('B', [T], ['Z']), t('C', [T], ['B'])];
    const once = apply(templates, recordDisputeChoice('B', ['A', 'B', 'C'], templates));
    expect(recordDisputeChoice('B', ['A', 'B', 'C'], once).size).toBe(0);
  });

  test('смена выбора переворачивает прежний', () => {
    const templates = [t('A', [P]), t('B', [T], ['A', 'C']), t('C', [T])];
    const got = recordDisputeChoice('A', ['A', 'B', 'C'], templates);
    expect(got.get('A')).toEqual(['B', 'C']);
    expect(got.get('B')).toEqual(['C']);
    expect(got.has('C')).toBe(false);
    expect(chooseTemplate(PT, apply(templates, got), allOk)).toMatchObject({
      id: 'A',
      dispute: null,
    });
  });

  test('самоссылка в данных не переносится в запись (правило §3.2 отвергло бы пачку)', () => {
    const got = recordDisputeChoice('B', ['A', 'B'], [t('A', [P], ['A']), t('B', [T], ['B'])]);
    expect(got.get('B')).toEqual(['A']);
    expect(got.get('A')).toEqual([]);
  });

  test('победитель вне списка шаблонов — ошибка вызывающего', () => {
    expect(() => recordDisputeChoice('Z', ['A', 'Z'], [t('A', [P])])).toThrow();
  });
});

describe('templatesFromRows — строки entity.query → кандидаты', () => {
  test('строка без «Шаблон для» или с пустым набором пропускается', () => {
    const rows = [
      { id: 'A', props: {}, createdAt: '2026-09-01T00:00:00Z' },
      { id: 'B', props: { [TEMPLATE_FOR_PROPERTY]: [] }, createdAt: '2026-09-01T00:00:00Z' },
      {
        id: 'C',
        props: { [TEMPLATE_FOR_PROPERTY]: [P, T], [TEMPLATE_WINS_OVER_PROPERTY]: ['A'] },
        createdAt: '2026-09-03T00:00:00Z',
      },
    ];
    expect(templatesFromRows(rows)).toEqual([
      { id: 'C', forAspects: [P, T], winsOver: ['A'], createdAt: '2026-09-03T00:00:00Z' },
    ]);
  });

  test('без «Главнее, чем» — пустой список; значения не-строки отбрасываются', () => {
    const rows = [
      { id: 'A', props: { [TEMPLATE_FOR_PROPERTY]: [P, 7] }, createdAt: '2026-09-01T00:00:00Z' },
      {
        id: 'B',
        props: { [TEMPLATE_FOR_PROPERTY]: 'orbis/task' },
        createdAt: '2026-09-01T00:00:00Z',
      },
    ];
    expect(templatesFromRows(rows)).toEqual([
      { id: 'A', forAspects: [P], winsOver: [], createdAt: '2026-09-01T00:00:00Z' },
    ]);
  });
});
