// apps/server/src/llm/prompts/routine-v3.test.ts
// Снимок системного слоя раннера рутины (реформа свойств, РП-18) — та же механика, что у
// routine-v1/routine-v2 и линейки v1–v5: текст промпта версионированный артефакт, эталон —
// routine-v3.fixture.txt, фиксируется ОСОЗНАННО. Гарды routine-v2.test.ts перенесены все до
// одного: новая версия не имеет права молча потерять нормативный кусок слоя.
//
// Сверх переноса здесь:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v2 со списком осознанно заменённых строк (REPLACED);
//   2. ИСПОЛНЯЕМЫЕ гарды новой грамматики: каждый пример-запрос шпаргалки прогоняется через
//      НАСТОЯЩИЙ `parseQueryAst` по встроенному реестру, дерево примера `ast` — через схему
//      канона, а имена запретных объектов сверяются с тем самым списком, по которому
//      отказывает исполнитель (`ROUTINE_UNTOUCHABLE_OBJECTS`);
//   3. НЕГАТИВНЫЕ гарды снятого: голых имён полей в примерах нет, `category_ref` нет.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import { parseQueryAst, queryAstSchema, toParseRegistry } from '@orbis/shared/query';
import { ROUTINE_UNTOUCHABLE_OBJECTS } from '../../executor/invariants';
import { MAX_RUN_UNITS } from '../../routines/constants';
import {
  ROUTINE_SYSTEM_PROMPT as ROUTINE_SYSTEM_PROMPT_V2,
  routineModeSection as routineModeSectionV2,
} from './routine-v2';
import {
  ROUTINE_PROMPT_VERSION,
  ROUTINE_SYSTEM_PROMPT_V3,
  routineModeSection,
  TOOL_RESULT_MARKER,
} from './routine-v3';
import { SYSTEM_PROMPT_V5 } from './v5';

/**
 * Строки routine-v2, снятые в v3 ОСОЗНАННО. Каждая — не переформулировка, а утверждение,
 * которое реформа свойств сделала ложным или неполным:
 *
 * 1. `category_ref` — поля с таким именем нет: категорию несёт `orbis/finance_category`
 *    (слияние `financial.category_ref` и `budget.category_ref`, §А8/В1);
 * 2. запрет по объекту в «Правилах» перечислял ДВА аспекта из трёх — аспект прогона
 *    (`orbis/agent-run`) не был назван вовсе, хотя исполнитель отказывает и по нему
 *    (`ROUTINE_UNTOUCHABLE_OBJECTS`, `executor/invariants.ts`);
 * 3. тот же запрет в разделе act был назван доменными словами («сущности-рутины, прогоны и
 *    назначения»), по которым нельзя понять, что именно смотрит сервер, — и молчал про
 *    отказ по встроенным строкам реестра (Задача 16);
 * 4-8. пять строк шпаргалки грамматики: голые имена полей (`status=`, `due_date=`,
 *    `updated_at:`) новый разбор отвергает кодом `UNKNOWN_FIELD` (`parse-ast.ts`), то есть
 *    пример учил бы модель умирающему языку.
 */
const REPLACED = new Set([
  '- category_ref — только uuid реально существующей категории: найди её через entity_query.',
  '- Сущности-рутины (аспект orbis/routine) и назначения исполнителям (аспект orbis/assignment) не трогай ни правкой, ни предложением: кому и что поручать, решает владелец сам. Считаешь, что рутину надо изменить, — скажи об этом словами в отчёте или вопросом.',
  '- Запрещённое ПО ОБЪЕКТУ, наоборот, отклоняется сразу и не откладывается никогда: сущности-рутины, прогоны и назначения (см. «Правила»), выдача рутине автономии и правка инструкции act-рутины. Такой отказ повтором не чинится — напиши о нужной правке словами в отчёте.',
  '- Фильтры перечисляются через запятую и объединяются по И. Примеры: «aspect=orbis/category, search=Еда»; «aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20».',
  '- В значении «|» — ИЛИ (status=planned|in_progress), «!v1&!v2» — НЕ эти значения (status=!done&!cancelled); смешивать | и & в одном значении нельзя.',
  '- Date-токены для любого date-поля: today | overdue | next_7d | after_7d (например, due_date=today|overdue).',
  '- tags=<тег>|<тег> — отбор по тегам сущности (ключ во МНОЖЕСТВЕННОМ числе, `tag=` грамматика не знает); excludeTags=<тег> — исключение.',
  '- children_of=<uuid> — дети сущности (по parent-связи); sortBy=<поле>:asc|desc, search=<текст по title+body>, limit=<число>.',
]);

/** Реестр разбора — ВСТРОЕННЫЙ, тот же, что кладёт сид (довод — в v5.test.ts). */
const PARSE_REG = toParseRegistry(
  {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  },
  'ru',
);

describe('ROUTINE_SYSTEM_PROMPT_V3 (реформа свойств, системный слой раннера)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./routine-v3.fixture.txt', import.meta.url)).text();
    expect(ROUTINE_SYSTEM_PROMPT_V3).toBe(fixture);
  });

  test('версия промпта — routine-v3', () => {
    expect(ROUTINE_PROMPT_VERSION).toBe('routine-v3');
  });

  // Механический гард «новая версия ничего не потеряла» (образец — routine-v2.test.ts:75-91):
  // построчно весь v2 за вычетом ЯВНОГО списка снятого. Сравнение по ЦЕЛОЙ строке (Set), а не
  // подстрокой: при `.includes(line)` строку v2 можно было бы ослабить дописыванием в её же
  // хвост, и гард промолчал бы.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v3 ⊇ v2 − REPLACED) и
  // судит только о наличии строк — перестановка блоков и новый текст, противоречащий старому,
  // для него невидимы. Порядок и точный вид держит фикстура, смысл — гарды ниже.
  test('v3 не потерял ни одной строки v2, кроме осознанно заменённых', () => {
    const v3lines = new Set(ROUTINE_SYSTEM_PROMPT_V3.split('\n'));
    const lost = ROUTINE_SYSTEM_PROMPT_V2.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !REPLACED.has(line))
      .filter((line) => !v3lines.has(line));
    expect(lost).toEqual([]);
  });

  test('каждое исключение — настоящая строка v2, и в v3 её действительно нет', () => {
    const v2lines = new Set(ROUTINE_SYSTEM_PROMPT_V2.split('\n'));
    const v3lines = new Set(ROUTINE_SYSTEM_PROMPT_V3.split('\n'));
    for (const line of REPLACED) {
      expect(v2lines.has(line)).toBe(true);
      expect(v3lines.has(line)).toBe(false);
    }
  });

  // --- Перенос гардов routine-v2 -------------------------------------------

  test('нет блока продолжений разговора: маркера [[suggest: в тексте нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('[[suggest:');
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('Продолжения разговора');
    // и в чат-промпте он ЕСТЬ — гард сравнивает две живые версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V5).toContain('[[suggest:');
  });

  test('нет собеседника: сказано прямо, что текст по ходу работы никто не читает', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/Собеседника нет/);
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/Вопрос, написанный текстом, никто не прочитает/);
  });

  test('orbis_propose: терминален, обязателен в propose, форма операций сужена', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V3).toContain('orbis_propose');
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/orbis_propose ТЕРМИНАЛЕН/);
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/без предложения[^.\n]*провалившимся/);
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/[Пп]редусловия[^.\n]*не передавай/);
  });

  test('вопрос — с run_id прогона; отчёт — финальным текстом', () => {
    expect(ROUTINE_SYSTEM_PROMPT_V3).toContain('orbis_checkpoint');
    expect(ROUTINE_SYSTEM_PROMPT_V3).toContain('run_id');
    expect(ROUTINE_SYSTEM_PROMPT_V3).toMatch(/отчёт ФИНАЛЬНЫМ текстом/);
  });

  test('протокол tool-результатов — тот же маркер, что сериализует toolResultMessage', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(ROUTINE_SYSTEM_PROMPT_V3).toContain(TOOL_RESULT_MARKER);
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
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('Единственный способ спросить');
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('Он тоже терминален');
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

  // --- Новое в v3: запрет по объекту через реестровые аспекты ---------------

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
    // …и v2 аспект прогона не называл: гард различает версии, а не проверяет опечатку
    expect(lineOf(ROUTINE_SYSTEM_PROMPT_V2, 'не трогай ни правкой')).not.toContain(
      'orbis/agent-run',
    );
  });

  test('запрет по объекту: встроенные строки реестра названы и отказ повтором не чинится', () => {
    const line = lineWith('Запрещённое ПО ОБЪЕКТУ');
    expect(line).toMatch(/встроенных строк реестра/);
    expect(line).toMatch(/автономи/);
    expect(line).toMatch(/инструкц/);
    expect(line).toMatch(/повтор/);
  });

  // --- Новое в v3: грамматика по реестру и своё свойство --------------------

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
    expect(ROUTINE_SYSTEM_PROMPT_V3).toContain('голого имени поля грамматика не знает');
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('(status=planned|in_progress)');
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('sortBy=updated_at:');
    expect(ROUTINE_SYSTEM_PROMPT_V3).not.toContain('category_ref');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
    // …а v2 эти формы содержал
    expect(ROUTINE_SYSTEM_PROMPT_V2).toContain('(status=planned|in_progress)');
    expect(ROUTINE_SYSTEM_PROMPT_V2).toContain('category_ref');
  });

  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = ROUTINE_SYSTEM_PROMPT_V3.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
  });

  test('каждое имя orbis/… из промпта есть в реестре свойств, аспектов или ролей', () => {
    const known = new Set<string>([
      ...PARSE_REG.properties.keys(),
      ...PARSE_REG.aspects.keys(),
      ...PARSE_REG.roles.keys(),
    ]);
    const named = [
      ...new Set([...ROUTINE_SYSTEM_PROMPT_V3.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    expect(named.length).toBeGreaterThanOrEqual(8);
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

describe('routineModeSection (V1.10, копия v2 без правок)', () => {
  const RUN_ID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

  // Секция скопирована из routine-v2 БАЙТ В БАЙТ (правок в ней реформа не требует), а
  // реэкспортировать её из v2 запрещено правилом версионирования. Копия без гарда
  // разъезжается молча, поэтому в каждом из трёх случаев результат сверяется с v2.
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
    expect(s).toBe(routineModeSectionV2(args));
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
    expect(s).toBe(routineModeSectionV2(args));
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
    expect(s).toBe(routineModeSectionV2(args));
  });
});

/**
 * Примеры-ЗАПРОСЫ шпаргалки: «…»-фрагменты блока грамматики, начинающиеся с имени конструкции
 * и оператора. Отбор именно такой, потому что «…» в этом блоке носят и не-запросы — «|»,
 * «!v1&!v2», «часть внутри целого»: скормив их разбору, гард краснел бы на честном тексте.
 */
function grammarExamples(): string[] {
  const from = ROUTINE_SYSTEM_PROMPT_V3.indexOf('Шпаргалка грамматики запросов');
  if (from < 0) throw new Error('в промпте нет блока шпаргалки');
  return [...ROUTINE_SYSTEM_PROMPT_V3.slice(from).matchAll(/«([^»]+)»/g)]
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
  return lineOf(ROUTINE_SYSTEM_PROMPT_V3, needle);
}
