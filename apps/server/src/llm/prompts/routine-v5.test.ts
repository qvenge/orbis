// apps/server/src/llm/prompts/routine-v5.test.ts
// Снимок системного слоя раннера рутины, версия 5 (срез 1в, спека §3.4, §3.8; Д-16, Ф-1в-6) — та
// же механика, что у routine-v1…v4: текст промпта версионированный артефакт, эталон —
// routine-v5.fixture.txt, фиксируется ОСОЗНАННО. Гарды routine-v4.test.ts перенесены все, кроме
// проверок фрагмента `finance/amounts`: они сторожат манифест, а не текст версии, и остались в
// `routine-v4.test.ts` (второй их копией манифест сторожился бы дважды).
//
// ЗАЧЕМ ВЕРСИЯ: запросы рутины идут тем же тулом `entity_query` (`dispatchTool`, Э-11), что и в
// чате, и понимают восемь токенов дат и контракт «когда» — а строка токенов routine-v4 называла
// четыре токена и не знала адресата `orbis/when`. Строка меняется ровно так же, как в чате (v9):
// одна правда о словаре у обоих каналов. Горизонтов (Повестка) у рутины нет — строка горизонтов
// живёт только в чате.
//
// Сверх переноса здесь:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v4 — ДВУСТОРОННИЙ: снятая строка (REPLACED) и добавленная (ADDED);
//   2. строка токенов перечисляет ровно словарь кода (`QUERY_DATE_TOKENS`) и совпадает со строкой
//      чата v9 байт в байт.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import {
  parseQueryAst,
  QUERY_DATE_TOKENS,
  queryAstSchema,
  toParseRegistry,
} from '@orbis/shared/query';
import { extensionIdsIn } from '../../../test/extension-ids';
import { ROUTINE_UNTOUCHABLE_OBJECTS } from '../../executor/invariants';
import { MAX_RUN_UNITS } from '../../routines/constants';
import { ROUTINE_SYSTEM_PROMPT_V4, routineModeSection as routineModeSectionV4 } from './routine-v4';
import {
  ROUTINE_PROMPT_VERSION,
  ROUTINE_SYSTEM_PROMPT_V5,
  routineModeSection,
  TOOL_RESULT_MARKER,
} from './routine-v5';
import { SYSTEM_PROMPT_V9 } from './v9';

/**
 * Строка routine-v4, снятая в v5 ОСОЗНАННО: строка токенов (четыре токена, без адресата
 * `orbis/when`).
 */
const REPLACED = new Set([
  '- Date-токены для любого свойства-даты: today | overdue | next_7d | after_7d (например, orbis/due_date=today|overdue). У свойств с порядком (даты, числа, суммы) работают сравнения и диапазон: «aspect=orbis/task, orbis/due_date<=today».',
]);

/** Строки, которых в v4 не было, — ровно новая строка токенов (та же, что в чате v9). */
const ADDED = new Set([
  '- Date-токены для любого свойства-даты и для orbis/when: today | overdue | next_7d | next_14d | after_7d | this_week | this_month | last_month (например, orbis/due_date=today|overdue, orbis/when=this_week). У свойств с порядком (даты, числа, суммы) работают сравнения и диапазон: «aspect=orbis/task, orbis/due_date<=today».',
]);

/** Реестр разбора — ВСТРОЕННЫЙ, тот же, что кладёт сид (довод — в v5.test.ts). */
const PARSE_REG = toParseRegistry(
  {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  },
  'ru',
);

describe('ROUTINE_SYSTEM_PROMPT_V5 (срез 1в, системный слой раннера)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./routine-v5.fixture.txt', import.meta.url)).text();
    expect(ROUTINE_SYSTEM_PROMPT_V5).toBe(fixture);
  });

  test('версия промпта — routine-v5', () => {
    expect(ROUTINE_PROMPT_VERSION).toBe('routine-v5');
  });

  // Сравнение по ЦЕЛОЙ строке (Set), а не подстрокой: при `.includes(line)` строку v4 можно было
  // бы ослабить дописыванием в её хвост. Порядок держит фикстура, смысл — гарды ниже.
  test('дифф против v4: снято ровно REPLACED, добавлено ровно ADDED', () => {
    const v4lines = ROUTINE_SYSTEM_PROMPT_V4.split('\n').filter((l) => l.trim() !== '');
    const v5lines = ROUTINE_SYSTEM_PROMPT_V5.split('\n').filter((l) => l.trim() !== '');
    const v4set = new Set(v4lines);
    const v5set = new Set(v5lines);
    expect(v4lines.filter((l) => !v5set.has(l)).sort()).toEqual([...REPLACED].sort());
    expect(v5lines.filter((l) => !v4set.has(l)).sort()).toEqual([...ADDED].sort());
  });

  // --- Новое в v5: восемь токенов и адресат orbis/when (спека §3.4, §3.8) --------------------

  // Сверка с КОДОМ, а не с литералом: словарь токенов вырастет — строка, перечисляющая прежний
  // набор, краснеет здесь, а не у фонового прогона, который получит отказ разбора.
  test('строка токенов перечисляет ровно словарь QUERY_DATE_TOKENS', () => {
    const line = lineWith('Date-токены');
    const list = line.match(/: ([a-z0-9_ |]+) \(например/)?.[1];
    if (list === undefined) throw new Error(`в строке токенов нет перечня: «${line}»`);
    expect(
      list
        .split('|')
        .map((t) => t.trim())
        .sort(),
    ).toEqual([...QUERY_DATE_TOKENS].sort());
    expect(line).toContain('для любого свойства-даты и для orbis/when');
    for (const example of ['orbis/due_date=today|overdue', 'orbis/when=this_week']) {
      expect(line).toContain(example);
      const r = parseQueryAst(example, PARSE_REG);
      expect(r.ok ? null : `${example}: ${r.error.code} ${r.error.message}`).toBeNull();
    }
  });

  // Запрос рутины идёт тем же тулом, что у чата (Э-11): две разные строки о словаре токенов учили
  // бы одну модель двум языкам одного тула.
  test('строка токенов — та же, что в чате v9, байт в байт', () => {
    expect(lineWith('Date-токены')).toBe(lineOf(SYSTEM_PROMPT_V9, 'Date-токены'));
  });

  test('в тексте v5 ноль id аспектов и свойств любого расширения', () => {
    expect(extensionIdsIn(ROUTINE_SYSTEM_PROMPT_V5)).toEqual([]);
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toMatch(/модул/i);
  });

  test('горизонтов (Повестки, Upcoming) в канале рутины нет — они только в чате', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('Горизонты планирования');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('Upcoming');
  });

  // --- Перенос гардов routine-v4 -------------------------------------------

  test('нет блока продолжений разговора: маркера [[suggest: в тексте нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('[[suggest:');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('Продолжения разговора');
    // и в чат-промпте он ЕСТЬ — гард сравнивает две живые версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V9).toContain('[[suggest:');
  });

  test('нет собеседника: сказано прямо, что текст по ходу работы никто не читает', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/Собеседника нет/);
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/Вопрос, написанный текстом, никто не прочитает/);
  });

  test('orbis_propose: терминален, обязателен в propose, форма операций сужена', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).toContain('orbis_propose');
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/orbis_propose ТЕРМИНАЛЕН/);
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/без предложения[^.\n]*провалившимся/);
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/[Пп]редусловия[^.\n]*не передавай/);
  });

  test('вопрос — с run_id прогона; отчёт — финальным текстом', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).toContain('orbis_checkpoint');
    expect(ROUTINE_SYSTEM_PROMPT_V5).toContain('run_id');
    expect(ROUTINE_SYSTEM_PROMPT_V5).toMatch(/отчёт ФИНАЛЬНЫМ текстом/);
  });

  test('протокол tool-результатов — тот же маркер, что сериализует toolResultMessage', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(ROUTINE_SYSTEM_PROMPT_V5).toContain(TOOL_RESULT_MARKER);
  });

  test('orbis_ask объявлен НЕтерминальным: прогон продолжается, в результате pending_id', () => {
    const line = lineWith('orbis_ask — ');
    expect(line).toMatch(/НЕтерминальн/);
    expect(line).toMatch(/прогон ПРОДОЛЖАЕТСЯ/);
    expect(line).toContain('pending_id');
    expect(line).toMatch(/истори[юя] следующего прогона/);
  });

  test('orbis_checkpoint объявлен терминальным и оставлен для тупика', () => {
    const line = lineWith('orbis_checkpoint — ');
    expect(line).toMatch(/ТЕРМИНАЛЕН/);
    expect(line).toMatch(/бессмысленн/i);
  });

  test('ложь v1 остаётся снятой: «единственного способа спросить» в тексте нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('Единственный способ спросить');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('Он тоже терминален');
  });

  test('отложка в act: pending_confirmation с pendingId, это не ошибка, работа продолжается', () => {
    const line = lineWith('pending_confirmation');
    expect(line).toContain('pendingId');
    expect(line).toMatch(/НЕ ошибка/);
    expect(line).toMatch(/продолжай/);
  });

  // Число в промпте — то же, что в константе сервера: разойдясь, они дадут модели «пачка
  // полна» на счёте, которого она не ждала, и она будет чинить не то.
  test('кап пачки: число из MAX_RUN_UNITS, отказ «пачка полна», требование группировать', () => {
    const line = lineWith('пачка полна');
    expect(line).toContain(`не больше ${MAX_RUN_UNITS}`);
    expect(line).toMatch(/Группируй/);
    expect(line).toMatch(/шаг/i);
  });

  test('история: новые части строки прогона названы промптом дословно', () => {
    const line = lineWith('и ещё N решений');
    expect(line).toContain('спрашивал:');
    expect(line).toContain('откладывал:');
    expect(line).toMatch(/не поместились/);
  });

  test('история: перечисление обратной связи включает отложенное и решения владельца', () => {
    const line = lineWith('[история прогонов]');
    expect(line).toMatch(/что откладывал/);
    expect(line).toMatch(/не переспрашивай/);
  });

  // --- Пришло с v3 (через v4): запрет по объекту через реестровые аспекты ---

  // Исполняемый гард, а не toContain по одному имени: список запретных объектов промпта
  // сверяется с ТЕМ САМЫМ списком, по которому отказывает стадия 4 исполнителя. Разойдясь,
  // они дадут рутине отказ по объекту, о котором промпт молчал, — ровно то, что было в v2 с
  // аспектом прогона.
  test('запрет по объекту: промпт называет все аспекты, по которым отказывает исполнитель', () => {
    const expected = [...ROUTINE_UNTOUCHABLE_OBJECTS, 'orbis/assignment'];
    for (const where of ['Записи машинерии делегирования', 'Запрещённое ПО ОБЪЕКТУ']) {
      const line = lineWith(where);
      for (const aspect of expected) expect(line).toContain(aspect);
    }
    // Сравнение с v2 («аспект прогона не был назван») осталось в routine-v3.test.ts: ложь снята
    // версиями раньше, и v3…v5 по ней не различаются.
  });

  test('запрет по объекту: встроенные строки реестра названы и отказ повтором не чинится', () => {
    const line = lineWith('Запрещённое ПО ОБЪЕКТУ');
    expect(line).toMatch(/встроенных строк реестра/);
    expect(line).toMatch(/автономи/);
    expect(line).toMatch(/инструкц/);
    expect(line).toMatch(/повтор/);
  });

  // --- Пришло с v3 (через v4): грамматика по реестру и своё свойство -------

  test('шпаргалка: каждый пример-запрос разбирается настоящей грамматикой по реестру', () => {
    const examples = grammarExamples();
    // Страховка от «регулярка перестала находить»: пустой список прошёл бы цикл молча
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const example of examples) {
      const r = parseQueryAst(example, PARSE_REG);
      expect(r.ok ? null : `${example}: ${r.error.code} ${r.error.message}`).toBeNull();
    }
    const joined = examples.join('\n');
    expect(joined).toContain('orbis/task_status=!done&!cancelled');
    expect(joined).toContain('orbis/due_date<=today');
    expect(joined).toContain('has=orbis/recurrence');
  });

  test('голого имени поля в промпте нет, и грамматика его действительно не знает', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V5).toContain('голого имени поля грамматика не знает');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('(status=planned|in_progress)');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('sortBy=updated_at:');
    expect(ROUTINE_SYSTEM_PROMPT_V5).not.toContain('category_ref');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
    // Обратная половина («…а v2 эти формы содержал») — в routine-v3.test.ts: форма снята там.
  });

  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = ROUTINE_SYSTEM_PROMPT_V5.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
  });

  // Контракты — в известных с v5: `orbis/when` не свойство и не аспект, а контракт языка (спека
  // 1в §3.2), и без них гард краснел бы на честном имени.
  test('каждое имя orbis/… из промпта есть в реестре свойств, аспектов, ролей или контрактов', () => {
    const known = new Set<string>([
      ...PARSE_REG.properties.keys(),
      ...PARSE_REG.aspects.keys(),
      ...PARSE_REG.roles.keys(),
      ...PARSE_REG.contracts.keys(),
    ]);
    const named = [
      ...new Set([...ROUTINE_SYSTEM_PROMPT_V5.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    // Порог v4 был 8; v5 добавил orbis/when — поднят ровно на единицу.
    expect(named.length).toBeGreaterThanOrEqual(9);
    expect(named).toContain('orbis/when');
    // `orbis/…` в строке про встроенные строки реестра — плейсхолдер многоточием, а не имя;
    // регулярка его не ловит (в ней нет `…`), и это проверено самим счётом ниже.
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    expect([...PARSE_REG.roles.values()].map((r) => r.key)).toContain('subitem');
  });

  // РУЛИНГ Р-19-1 (замер Задачи 17). Проверяется В ОДНОЙ строке: «property_create» в одном
  // абзаце и «proposed» в другом складываются в смысл только в голове читателя гарда.
  test('своё свойство: белый список, «по чему фильтруют» и status=proposed — одной строкой', () => {
    const line = lineWith('property_create');
    expect(line).toContain('status=proposed');
    expect(line).toContain('property_catalog');
    expect(line).toMatch(/белый список/);
    expect(line).toMatch(/фильтровать или считать/);
  });
});

describe('routineModeSection (V1.10, копия v4 без правок)', () => {
  const RUN_ID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

  // Секция скопирована из routine-v4 БАЙТ В БАЙТ (ни токенов, ни имён она не называет), а
  // реэкспортировать её из v4 запрещено правилом версионирования. Копия без гарда
  // разъезжается молча, поэтому в каждом из трёх случаев результат сверяется с v4.
  test('propose: назван режим, run_id и бакет; сказано, что белый список не действует', () => {
    const args = {
      mode: 'propose' as const,
      allowedTools: [],
      runId: RUN_ID,
      bucket: '2026-08-17T07:00',
    };
    const s = routineModeSection(args);
    expect(s).toContain('режим: propose');
    expect(s).toContain(RUN_ID);
    expect(s).toContain('2026-08-17T07:00');
    expect(s).toContain('orbis_propose');
    expect(s).not.toContain('белый список правок:');
    expect(s).toBe(routineModeSectionV4(args));
  });

  test('act: перечислен ровно белый список владельца', () => {
    const args = {
      mode: 'act' as const,
      allowedTools: ['entity_update', 'relation_create'],
      runId: RUN_ID,
      bucket: 'manual:2026-08-17T12:00:00.000Z',
    };
    const s = routineModeSection(args);
    expect(s).toContain('режим: act');
    expect(s).toContain('entity_update, relation_create');
    expect(s).toContain('manual:2026-08-17T12:00:00.000Z');
    expect(s).toBe(routineModeSectionV4(args));
  });

  test('act с пустым списком: сказано, что менять граф нечем (а не молчание)', () => {
    const args = {
      mode: 'act' as const,
      allowedTools: [],
      runId: RUN_ID,
      bucket: '2026-08-17T07:00',
    };
    const s = routineModeSection(args);
    expect(s).toMatch(/белый список правок пуст/);
    expect(s).toBe(routineModeSectionV4(args));
  });
});

/**
 * Примеры-ЗАПРОСЫ шпаргалки: «…»-фрагменты блока грамматики, начинающиеся с имени конструкции
 * и оператора. Отбор именно такой, потому что «…» в этом блоке носят и не-запросы — «|»,
 * «!v1&!v2», «часть внутри целого»: скормив их разбору, гард краснел бы на честном тексте.
 */
function grammarExamples(): string[] {
  const from = ROUTINE_SYSTEM_PROMPT_V5.indexOf('Шпаргалка грамматики запросов');
  if (from < 0) throw new Error('в промпте нет блока шпаргалки');
  return [...ROUTINE_SYSTEM_PROMPT_V5.slice(from).matchAll(/«([^»]+)»/g)]
    .map((m) => m[1] as string)
    .filter((s) => /^[a-z_]+[=<>]/i.test(s));
}

/**
 * Строка промпта, содержащая подстроку. Гарды нового поведения смотрят В ОДНУ строку, а не в
 * весь текст: утверждение «заводя от себя, ставь proposed» рассыпается, если его половины
 * стоят в разных абзацах, — модель читает строку целиком, а гард по всему тексту этого не
 * заметит.
 */
function lineOf(prompt: string, needle: string): string {
  const found = prompt.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}

function lineWith(needle: string): string {
  return lineOf(ROUTINE_SYSTEM_PROMPT_V5, needle);
}
