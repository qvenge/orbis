// apps/server/src/llm/prompts/v8.test.ts
// Снимок системного промпта v8 — та же механика, что у v1–v7: текст промпта версионированный
// артефакт, эталон — файл-фикстура v8.fixture.txt, фиксируемая ОСОЗНАННО.
//
// ЗАЧЕМ ВЕРСИЯ (срез 1б, спека §8.2 «Обязательная работа с промптом», С1б-4): агент не видит
// выключенное расширение, а блок «Цели и горизонты» v7 называл id расширения «Цели» рукописным
// текстом. Блок делится: строки о целях — во фрагмент `goals/goals` манифеста (он едет в канал
// только при включённых Целях), горизонты по страницам хоста остаются в теле (Н-7).
//
// Гарды здесь четырёх родов:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v7 — ДВУСТОРОННИЙ: снятые строки (REPLACED_V8) и добавленные
//      (ADDED_V8) перечислены поимённо, иной разницы нет;
//   2. ИСПОЛНЯЕМЫЕ ГАРДЫ, перенесённые с v7 (грамматика по реестру, дерево ast, имена реестра,
//      протокол чипов, потолки из констант, маркер tool-результатов, лестница горизонтов по сиду);
//   3. ГАРДЫ ВЫНОСА: в теле нет ни одного id расширения (сторож `extensionIdsIn`), а утверждения
//      о целях стоят на ФРАГМЕНТЕ манифеста Целей и проверяются живым валидатором записи;
//   4. СЛОВАРЬ спеки §1: «smart list» и «модуль» в тексте не встречаются.

import { describe, expect, test } from 'bun:test';
import {
  attachToolName,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  EXTENSION_IDS,
  EXTENSION_MANIFESTS,
} from '@orbis/shared';
import { parseQueryAst, queryAstSchema, toParseRegistry } from '@orbis/shared/query';
import { EXTENSION_OWNED_IDS, extensionIdsIn } from '../../../test/extension-ids';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { type PropsRegistry, validateEntityProps } from '../../registry/validate-props';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V7 } from './v7';
import { SYSTEM_PROMPT_V8, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v8';

/**
 * Строки v7, снятые в v8 ОСОЗНАННО, — весь блок «Цели и горизонты». Две строки о целях уехали
 * во фрагмент Целей дословно, заголовок, лестница горизонтов и строка «Спланируй неделю…»
 * переписаны без целевой части и без «smart lists». Список сам под гардом (проверка ниже).
 */
const REPLACED_V8 = new Set([
  'Цели и горизонты:',
  '- Измеримая цель пользователя («накопить 300 000», «прочитать 24 книги», «вес 80 кг») — ОДНА сущность с аспектом orbis/goal: orbis/target_value — целевое число decimal-строкой, orbis/progress_source — откуда берётся факт (query — ДЕРЕВО запроса по графу, такое же, как во входе ast тула entity_query, плюс aggregate: sum, count или latest). Какие ключи требует каждый вариант aggregate — в описании тула attach_orbis_goal; не угадывай их состав.',
  '- orbis/current_value НЕ заполняй никогда: прогресс цели считает сервер, обходя граф запросом из orbis/progress_source при каждом чтении.',
  '- Горизонты планирования разложены по преднастроенным smart lists, а не по отдельному списку на каждый срок: день — «Daily Planning», неделя и месяц — «Upcoming», год — «Год» (в нём цели), жизнь — «Жизнь» (вопросы ревизии). Списков с названиями «День», «Неделя» и «Месяц» не существует — не предлагай их открыть и не создавай.',
  '- «Спланируй неделю», «как идут цели», «что у меня на год» — сначала посмотри entity_query, что уже заведено (задачи на нужный срок; цели — aspect=orbis/goal), и только потом предлагай. Не заводи дубли уже существующих целей и задач: найденное правь, а не создавай заново.',
]);

/**
 * Строки, которых в v7 не было. Двусторонний дифф: без этого списка v8 мог бы дописать в тело
 * новую строку с id расширения, и гард «ничего не потерял» её не заметил бы.
 */
const ADDED_V8 = new Set([
  'Горизонты планирования:',
  '- Горизонты планирования разложены по преднастроенным страницам хоста, а не по отдельной странице на каждый срок: день — «Daily Planning», неделя и месяц — «Upcoming», год — «Год», жизнь — «Жизнь» (вопросы ревизии). Страниц с названиями «День», «Неделя» и «Месяц» не существует — не предлагай их открыть и не создавай.',
  '- «Спланируй неделю», «что у меня на год» — сначала посмотри entity_query, что уже заведено (задачи на нужный срок), и только потом предлагай. Не заводи дубли уже существующих задач: найденное правь, а не создавай заново.',
]);

/** Реестр разбора — ВСТРОЕННЫЙ, тот же, что кладёт сид (довод — в v7.test.ts). */
const PARSE_REG = toParseRegistry(
  {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  },
  'ru',
);

/** Тот же снимок для валидатора записи (§А7-1) — у него своя форма аргумента. */
const PROPS_REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

/** Текст фрагмента Целей — то, что канал получает при включённых Целях. */
function goalsFragment(): string {
  const f = EXTENSION_MANIFESTS.goals.promptFragments.find((x) => x.id === 'goals/goals');
  if (!f) throw new Error('в манифесте Целей нет фрагмента goals/goals');
  return f.text;
}

describe('SYSTEM_PROMPT_V8 (§7.1 слой 1, срез 1б §8.2)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v8.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V8).toBe(fixture);
  });

  test('версия промпта — v8', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v8');
  });

  // Сравнение по ЦЕЛОЙ строке (Set), а не подстрокой: иначе строку v7 можно было бы ослабить
  // дописыванием в её хвост. Порядок держит фикстура, смысл — гарды ниже.
  test('дифф против v7: снято ровно REPLACED_V8, добавлено ровно ADDED_V8', () => {
    const v7lines = SYSTEM_PROMPT_V7.split('\n').filter((l) => l.trim() !== '');
    const v8lines = SYSTEM_PROMPT_V8.split('\n').filter((l) => l.trim() !== '');
    const v7set = new Set(v7lines);
    const v8set = new Set(v8lines);
    expect(v7lines.filter((l) => !v8set.has(l)).sort()).toEqual([...REPLACED_V8].sort());
    expect(v8lines.filter((l) => !v7set.has(l)).sort()).toEqual([...ADDED_V8].sort());
  });

  test('две строки о целях уехали во фрагмент Целей ДОСЛОВНО, а не переписаны', () => {
    const fragmentLines = new Set(goalsFragment().split('\n'));
    for (const line of REPLACED_V8) {
      if (line.includes('orbis/target_value') || line.startsWith('- orbis/current_value')) {
        expect(fragmentLines.has(line)).toBe(true);
      }
    }
  });

  // --- Новое в v8: тело не называет ни одного id расширения (С1б-4) -------------------------

  // Проверяется ВЕСЬ текст промпта, а не только PROMPT_BODY: блок продолжений тоже едет в канал.
  // Что `PROMPT_BODY` вырезан именно из v8, пиннит `llm/context.test.ts`.
  test('в тексте v8 ноль id аспектов и свойств любого расширения', () => {
    expect(EXTENSION_OWNED_IDS.length).toBeGreaterThan(0);
    expect(extensionIdsIn(SYSTEM_PROMPT_V8)).toEqual([]);
    // …а v7 их называл — сторож различает версии, а не проверяет пустоту регулярки
    expect(extensionIdsIn(SYSTEM_PROMPT_V7).length).toBeGreaterThan(0);
  });

  test('словарь спеки §1: нет «smart list» и «модуль»', () => {
    expect(SYSTEM_PROMPT_V8).not.toMatch(/smart list/i);
    expect(SYSTEM_PROMPT_V8).not.toMatch(/модул/i);
    expect(SYSTEM_PROMPT_V7).toMatch(/smart list/i);
  });

  // --- Пришло с v7: грамматика по реестру ---------------------------------------------------

  test('шпаргалка: каждый пример-запрос разбирается настоящей грамматикой по реестру', () => {
    const examples = grammarExamples();
    expect(examples.length).toBeGreaterThanOrEqual(6);
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
    expect(SYSTEM_PROMPT_V8).toContain('голого имени поля грамматика не знает');
    expect(SYSTEM_PROMPT_V8).not.toContain(', status=');
    expect(SYSTEM_PROMPT_V8).not.toContain('(status=planned|in_progress)');
    expect(SYSTEM_PROMPT_V8).not.toContain('sortBy=updated_at:');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
  });

  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = SYSTEM_PROMPT_V8.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
    expect(SYSTEM_PROMPT_V8).toContain('query и ast в одном вызове несовместимы');
  });

  test('каждое имя orbis/… из промпта есть в реестре свойств, аспектов или ролей', () => {
    const known = new Set<string>([
      ...PARSE_REG.properties.keys(),
      ...PARSE_REG.aspects.keys(),
      ...PARSE_REG.roles.keys(),
    ]);
    const named = [
      ...new Set([...SYSTEM_PROMPT_V8.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    // Порог v7 был 13; v8 снял четыре имени Целей (orbis/goal, orbis/target_value,
    // orbis/progress_source, orbis/current_value) — ровно 9, порог опущен ровно на разность.
    expect(named.length).toBeGreaterThanOrEqual(9);
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    expect(SYSTEM_PROMPT_V8).toContain('via=subitem');
    expect([...PARSE_REG.roles.values()].map((r) => r.key)).toContain('subitem');
  });

  // --- Горизонты по страницам хоста (Н-7) ----------------------------------------------------

  test('горизонты: каждая страница лестницы действительно сидируется, несуществующие — нет', () => {
    const titles: string[] = SEED_SMART_LISTS.map((l) => l.title);
    const ladder = lineWith('Горизонты планирования разложены');
    const denied = ['День', 'Неделя', 'Месяц']; // названы как НЕсуществующие
    const named = [...ladder.matchAll(/«([^»]+)»/g)].map((m) => m[1] ?? '');
    for (const name of named) {
      if (denied.includes(name)) continue;
      expect(titles).toContain(name);
    }
    for (const carrier of ['Daily Planning', 'Upcoming', 'Год', 'Жизнь']) {
      expect(named).toContain(carrier);
      expect(titles).toContain(carrier);
    }
    for (const absent of denied) expect(titles).not.toContain(absent);
    expect(ladder).toContain('страницам хоста');
    expect(ladder).toContain('«День», «Неделя» и «Месяц» не существует');
    // «Год» больше не обещает цели: при выключенных Целях это было бы ложью о странице
    expect(ladder).not.toMatch(/цел/i);
  });

  test('горизонты: сначала entity_query, потом предложение — без дублей', () => {
    const block = horizonsBlock();
    expect(block).toContain('Горизонты планирования:');
    expect(block).toContain('entity_query');
    expect(block).toMatch(/Не заводи дубли/);
    expect(block).not.toMatch(/цел/i);
  });

  // --- Фрагмент Целей: гарды блока целей v7 переехали вместе с текстом ------------------------

  test('фрагмент Целей: заголовок называет расширение, аспект существует', () => {
    const text = goalsFragment();
    expect(text.startsWith('Цели (расширение «Цели»):')).toBe(true);
    expect(text).toContain('aspect=orbis/goal');
    expect(BUILTIN_ASPECT_IDS).toContain('orbis/goal');
  });

  test('фрагмент Целей: каждый aggregate принимает валидатор записи orbis/goal', () => {
    const named = [...goalsFragment().matchAll(/\b(sum|count|latest)\b/g)].map(
      (m) => m[1] as string,
    );
    expect(new Set(named)).toEqual(new Set(['sum', 'count', 'latest']));
    const query = { filter: { aspect: 'orbis/task' } };
    for (const aggregate of new Set(named)) {
      const progressSource =
        aggregate === 'count'
          ? { query, aggregate }
          : { query, aggregate, field: 'orbis/effort_min' };
      const violations = validateEntityProps(PROPS_REG, {
        props: { 'orbis/progress_source': progressSource, 'orbis/target_value': '24' },
        aspects: ['orbis/goal'],
      });
      expect(violations).toEqual([]);
    }
  });

  test('фрагмент Целей: названные свойства объявлены аспектом orbis/goal', () => {
    const goal = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal');
    if (!goal) throw new Error('в реестре нет аспекта orbis/goal');
    const declared = goal.properties.map((ref) => ref.propertyId);
    for (const key of ['orbis/target_value', 'orbis/progress_source', 'orbis/current_value']) {
      expect(goalsFragment()).toContain(key);
      expect(declared).toContain(key);
    }
    expect(goalsFragment()).toMatch(/orbis\/current_value НЕ заполняй/);
    expect(goalsFragment()).toMatch(/прогресс цели считает сервер/i);
  });

  test('фрагмент Целей: ключи aggregate — в описании настоящего тула attach_*', () => {
    expect(goalsFragment()).toContain(`в описании тула ${attachToolName('orbis/goal')}`);
    const goal = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal');
    for (const n of ['aggregate', 'count', 'sum', 'latest', 'field']) {
      expect(goal?.aiInstructions).toContain(n);
    }
  });

  test('фрагмент Целей: сначала entity_query по целям, без дублей', () => {
    expect(goalsFragment()).toContain('entity_query');
    expect(goalsFragment()).toMatch(/Не заводи дубли уже существующих целей/);
  });

  // Маска гасит фрагмент целиком: назови фрагмент Целей id Финансов (или наоборот), и
  // выключение одного расширения оставило бы в канале имена другого.
  test('каждый фрагмент манифеста называет только id своего расширения', () => {
    const ownerOf = new Map(
      [...BUILTIN_ASPECT_DEFS, ...BUILTIN_PROPERTY_META].map((x) => [x.id, x.module ?? null]),
    );
    for (const ext of EXTENSION_IDS) {
      for (const f of EXTENSION_MANIFESTS[ext].promptFragments) {
        const foreign = extensionIdsIn(f.text).filter((id) => ownerOf.get(id) !== ext);
        expect([f.id, foreign]).toEqual([f.id, []]);
      }
    }
  });

  // --- Гарды блока продолжений (D19), перенесённые с v7 --------------------------------------

  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V8).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V8.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.');
    expect(parsed.suggestions).toHaveLength(3);
  });

  // Однократность заголовка — условие деления на PROMPT_BODY/CONTINUATIONS_BLOCK (llm/context.ts).
  test('блок продолжений — ровно один в промпте, блок горизонтов стоит перед ним', () => {
    expect(SYSTEM_PROMPT_V8.split('Продолжения разговора:')).toHaveLength(2);
    expect(SYSTEM_PROMPT_V8.indexOf('Горизонты планирования:')).toBeLessThan(
      SYSTEM_PROMPT_V8.indexOf('Продолжения разговора:'),
    );
  });

  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V8).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V8).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V8).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V8).toMatch(/нечем — строку не добавляй/);
  });

  // --- Прочие гарды, перенесённые с v7 --------------------------------------------------------

  test('слова meta в промпте нет: мешка структуры не существует', () => {
    expect(SYSTEM_PROMPT_V8).not.toMatch(/meta/i);
  });

  test('правила поведения: тулы, decimal-значения, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V8).toContain('decimal-строками');
    expect(SYSTEM_PROMPT_V8).toContain('entity_query');
    expect(SYSTEM_PROMPT_V8).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V8).toContain(TOOL_RESULT_MARKER);
  });

  test('в теле v8 нет финансовой прозы — она во фрагментах Финансов', () => {
    for (const n of ['budget_status', 'spend_class', 'Денежные суммы', 'что по бюджету?']) {
      expect(SYSTEM_PROMPT_V8).not.toContain(n);
    }
  });

  test('одна сущность на намерение: пример остался ДВУХАСПЕКТНЫМ и без денег', () => {
    expect(SYSTEM_PROMPT_V8).toContain('Одна сущность на намерение');
    const line = lineWith('Одно дело пользователя');
    expect(line).toContain('orbis/task');
    expect(line).toContain('orbis/schedule');
    expect(line).toContain('orbis/start_at');
    expect(line).not.toContain('orbis/amount');
  });

  test('где брать имя свойства: параметры attach_* и property_catalog названы оба', () => {
    const line = lineWith('Имя свойства');
    expect(line).toContain('attach_<аспект>');
    expect(line).toContain('property_catalog');
    expect(line).toMatch(/свободные свойства/);
  });

  test('своё свойство заводится со status=proposed, и только по тому, по чему фильтруют', () => {
    const line = lineWith('property_create');
    expect(line).toContain('status=proposed');
    expect(line).toMatch(/фильтровать или считать/);
    expect(line).toMatch(/status=active/);
  });
});

/** Блок «Горизонты планирования» без соседей: гарды блока не должны ловить слова остального текста. */
function horizonsBlock(): string {
  const from = SYSTEM_PROMPT_V8.indexOf('Горизонты планирования:');
  const to = SYSTEM_PROMPT_V8.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока горизонтов перед продолжениями');
  return SYSTEM_PROMPT_V8.slice(from, to);
}

/** Примеры-ЗАПРОСЫ шпаргалки (отбор — как в v7.test.ts). */
function grammarExamples(): string[] {
  const from = SYSTEM_PROMPT_V8.indexOf('Шпаргалка грамматики запросов');
  const to = SYSTEM_PROMPT_V8.indexOf('Протокол tool-результатов');
  if (from < 0 || to < from) throw new Error('в промпте нет блока шпаргалки перед протоколом');
  return [...SYSTEM_PROMPT_V8.slice(from, to).matchAll(/«([^»]+)»/g)]
    .map((m) => m[1] as string)
    .filter((s) => /^[a-z_]+[=<>]/i.test(s));
}

/** Строка промпта, содержащая подстроку, — ровно одна (довод — в v7.test.ts). */
function lineWith(needle: string): string {
  const found = SYSTEM_PROMPT_V8.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}
