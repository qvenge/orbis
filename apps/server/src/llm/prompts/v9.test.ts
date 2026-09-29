// apps/server/src/llm/prompts/v9.test.ts
// Снимок системного промпта v9 — та же механика, что у v1–v8: текст промпта версионированный
// артефакт, эталон — файл-фикстура v9.fixture.txt, фиксируемая ОСОЗНАННО.
//
// ЗАЧЕМ ВЕРСИЯ (срез 1в, спека §3.4, §3.8, §6.4; Д-16, Ф-1в-6): словарь токенов дат вырос с
// четырёх до восьми и получил адресата — контракт «когда» (`orbis/when`), а страница Upcoming
// снята с поставки: горизонт «неделя и две» теперь Повестка. Строка токенов v8 перечисляла
// четыре токена, строка горизонтов называла Upcoming — обе меняются, текст v8 не правится ни
// байтом (РП-18), отсюда линейка.
//
// Гарды здесь четырёх родов:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v8 — ДВУСТОРОННИЙ: снятые строки (REPLACED_V9) и добавленные
//      (ADDED_V9) перечислены поимённо, иной разницы нет;
//   2. НОВОЕ v9: строка токенов перечисляет ровно словарь кода (`QUERY_DATE_TOKENS`), пример с
//      `orbis/when` разбирается; горизонты называют Повестку, а Upcoming — нигде;
//   3. ИСПОЛНЯЕМЫЕ ГАРДЫ, перенесённые с v8 (грамматика по реестру, дерево ast, имена реестра,
//      протокол чипов, потолки из констант, маркер tool-результатов, ни одного id расширения);
//   4. СЛОВАРЬ спеки §1: «smart list» и «модуль» в тексте не встречаются.
// Гарды фрагмента Целей (строки о целях v7) остались в `v8.test.ts`: они проверяют манифест, а
// не текст версии, и второй их копией здесь манифест сторожился бы дважды.

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
import { EXTENSION_OWNED_IDS, extensionIdsIn } from '../../../test/extension-ids';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V8 } from './v8';
import { SYSTEM_PROMPT_V9, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v9';

/**
 * Строки v8, снятые в v9 ОСОЗНАННО: строка токенов (четыре токена, без адресата `orbis/when`) и
 * лестница горизонтов (Upcoming снята с поставки, спека §6.3–§6.4). Список сам под гардом.
 */
const REPLACED_V9 = new Set([
  '- Date-токены для любого свойства-даты: today | overdue | next_7d | after_7d (например, orbis/due_date=today|overdue). У свойств с порядком (даты, числа, суммы) работают сравнения и диапазон: «aspect=orbis/task, orbis/due_date<=today».',
  '- Горизонты планирования разложены по преднастроенным страницам хоста, а не по отдельной странице на каждый срок: день — «Daily Planning», неделя и месяц — «Upcoming», год — «Год», жизнь — «Жизнь» (вопросы ревизии). Страниц с названиями «День», «Неделя» и «Месяц» не существует — не предлагай их открыть и не создавай.',
]);

/**
 * Строки, которых в v8 не было. Двусторонний дифф: без этого списка v9 мог бы дописать в тело
 * новую строку, и гард «ничего не потерял» её не заметил бы.
 */
const ADDED_V9 = new Set([
  '- Date-токены для любого свойства-даты и для orbis/when: today | overdue | next_7d | next_14d | after_7d | this_week | this_month | last_month (например, orbis/due_date=today|overdue, orbis/when=this_week). У свойств с порядком (даты, числа, суммы) работают сравнения и диапазон: «aspect=orbis/task, orbis/due_date<=today».',
  '- Горизонты планирования разложены по преднастроенным страницам хоста, а не по отдельной странице на каждый срок: день — «Daily Planning», неделя и две — «Повестка» (встречи, сроки и сделанное по дням), год — «Год», жизнь — «Жизнь» (вопросы ревизии). Страниц «День», «Неделя» и «Месяц» не существует — не предлагай их открыть и не создавай.',
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

describe('SYSTEM_PROMPT_V9 (§7.1 слой 1, срез 1в §3.4, §3.8, §6.4)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v9.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V9).toBe(fixture);
  });

  test('версия промпта — v9', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v9');
  });

  // Сравнение по ЦЕЛОЙ строке (Set), а не подстрокой: иначе строку v8 можно было бы ослабить
  // дописыванием в её хвост. Порядок держит фикстура, смысл — гарды ниже.
  test('дифф против v8: снято ровно REPLACED_V9, добавлено ровно ADDED_V9', () => {
    const v8lines = SYSTEM_PROMPT_V8.split('\n').filter((l) => l.trim() !== '');
    const v9lines = SYSTEM_PROMPT_V9.split('\n').filter((l) => l.trim() !== '');
    const v8set = new Set(v8lines);
    const v9set = new Set(v9lines);
    expect(v8lines.filter((l) => !v9set.has(l)).sort()).toEqual([...REPLACED_V9].sort());
    expect(v9lines.filter((l) => !v8set.has(l)).sort()).toEqual([...ADDED_V9].sort());
  });

  // --- Новое в v9: восемь токенов и адресат orbis/when (спека §3.4, §3.8) ---------------------

  // Сверка с КОДОМ, а не с литералом: словарь токенов вырастет — строка промпта, перечисляющая
  // прежний набор, краснеет здесь, а не у модели, которая получит отказ разбора на новом токене
  // (или не узнает о нём вовсе, как v8 о четырёх токенах 1в).
  test('строка токенов перечисляет ровно словарь QUERY_DATE_TOKENS', () => {
    expect(tokensOfLine(lineWith('Date-токены'))).toEqual([...QUERY_DATE_TOKENS].sort());
    expect(QUERY_DATE_TOKENS).toHaveLength(8);
    // …а v8 перечислял четыре — гард различает версии, а не проверяет пустоту разбора строки
    expect(tokensOfLine(lineOf(SYSTEM_PROMPT_V8, 'Date-токены'))).toHaveLength(4);
  });

  test('строка токенов называет адресата orbis/when, и её примеры разбираются грамматикой', () => {
    const line = lineWith('Date-токены');
    expect(line).toContain('для любого свойства-даты и для orbis/when');
    const examples = line.match(/\(например, ([^)]+)\)/)?.[1]?.split(', ') ?? [];
    expect(examples).toEqual(['orbis/due_date=today|overdue', 'orbis/when=this_week']);
    for (const example of examples) {
      const r = parseQueryAst(example, PARSE_REG);
      expect(r.ok ? null : `${example}: ${r.error.code} ${r.error.message}`).toBeNull();
    }
    expect(BUILTIN_CONTRACT_DEFS.map((c) => c.id)).toContain('orbis/when');
  });

  // --- Горизонты: Повестка вместо Upcoming (спека §6.3–§6.4) ----------------------------------

  test('горизонты: каждая страница лестницы действительно сидируется, несуществующие — нет', () => {
    // Сверка — с поставкой ЭТОГО среза, без добавок: Upcoming снята с поставки (§6.3) и в
    // лестнице v9 стоять не может.
    const titles: string[] = SEED_SMART_LISTS.map((l) => l.title);
    const ladder = lineWith('Горизонты планирования разложены');
    const denied = ['День', 'Неделя', 'Месяц']; // названы как НЕсуществующие
    const named = [...ladder.matchAll(/«([^»]+)»/g)].map((m) => m[1] ?? '');
    for (const name of named) {
      if (denied.includes(name)) continue;
      expect(titles).toContain(name);
    }
    for (const carrier of ['Daily Planning', 'Повестка', 'Год', 'Жизнь']) {
      expect(named).toContain(carrier);
      expect(titles).toContain(carrier);
    }
    for (const absent of denied) expect(titles).not.toContain(absent);
    expect(ladder).toContain('неделя и две — «Повестка» (встречи, сроки и сделанное по дням)');
    expect(ladder).toContain('страницам хоста');
    expect(ladder).toContain('«День», «Неделя» и «Месяц» не существует');
    // «Год» не обещает цели: при выключенных Целях это было бы ложью о странице (с v8)
    expect(ladder).not.toMatch(/цел/i);
  });

  test('Upcoming в тексте v9 не названа нигде — а v8 её называл', () => {
    expect(SYSTEM_PROMPT_V9).not.toContain('Upcoming');
    expect(SEED_SMART_LISTS.map((l) => l.title)).not.toContain('Upcoming');
    expect(SYSTEM_PROMPT_V8).toContain('Upcoming');
  });

  test('горизонты: сначала entity_query, потом предложение — без дублей', () => {
    const block = horizonsBlock();
    expect(block).toContain('Горизонты планирования:');
    expect(block).toContain('entity_query');
    expect(block).toMatch(/Не заводи дубли/);
    expect(block).not.toMatch(/цел/i);
  });

  // --- Пришло с v8: тело не называет ни одного id расширения (С1б-4) --------------------------

  test('в тексте v9 ноль id аспектов и свойств любого расширения', () => {
    expect(EXTENSION_OWNED_IDS.length).toBeGreaterThan(0);
    expect(extensionIdsIn(SYSTEM_PROMPT_V9)).toEqual([]);
  });

  test('словарь спеки §1: нет «smart list» и «модуль»', () => {
    expect(SYSTEM_PROMPT_V9).not.toMatch(/smart list/i);
    expect(SYSTEM_PROMPT_V9).not.toMatch(/модул/i);
  });

  // --- Пришло с v8: грамматика по реестру -----------------------------------------------------

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
    expect(SYSTEM_PROMPT_V9).toContain('голого имени поля грамматика не знает');
    expect(SYSTEM_PROMPT_V9).not.toContain(', status=');
    expect(SYSTEM_PROMPT_V9).not.toContain('(status=planned|in_progress)');
    expect(SYSTEM_PROMPT_V9).not.toContain('sortBy=updated_at:');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
  });

  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = SYSTEM_PROMPT_V9.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
    expect(SYSTEM_PROMPT_V9).toContain('query и ast в одном вызове несовместимы');
  });

  // Контракты — в известных с v9: `orbis/when` не свойство и не аспект, а контракт языка
  // (спека §3.2), и без них гард краснел бы на честном имени.
  test('каждое имя orbis/… из промпта есть в реестре свойств, аспектов, ролей или контрактов', () => {
    const known = new Set<string>([
      ...PARSE_REG.properties.keys(),
      ...PARSE_REG.aspects.keys(),
      ...PARSE_REG.roles.keys(),
      ...PARSE_REG.contracts.keys(),
    ]);
    const named = [
      ...new Set([...SYSTEM_PROMPT_V9.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    // v8 называл 9 имён; v9 добавил orbis/when — порог поднят ровно на единицу.
    expect(named.length).toBeGreaterThanOrEqual(10);
    expect(named).toContain('orbis/when');
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    expect(SYSTEM_PROMPT_V9).toContain('via=subitem');
    expect([...PARSE_REG.roles.values()].map((r) => r.key)).toContain('subitem');
  });

  // --- Гарды блока продолжений (D19), перенесённые с v8 --------------------------------------

  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V9).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V9.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.');
    expect(parsed.suggestions).toHaveLength(3);
  });

  // Однократность заголовка — условие деления на PROMPT_BODY/CONTINUATIONS_BLOCK (llm/context.ts).
  test('блок продолжений — ровно один в промпте, блок горизонтов стоит перед ним', () => {
    expect(SYSTEM_PROMPT_V9.split('Продолжения разговора:')).toHaveLength(2);
    expect(SYSTEM_PROMPT_V9.indexOf('Горизонты планирования:')).toBeLessThan(
      SYSTEM_PROMPT_V9.indexOf('Продолжения разговора:'),
    );
  });

  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V9).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V9).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V9).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V9).toMatch(/нечем — строку не добавляй/);
  });

  // --- Прочие гарды, перенесённые с v8 --------------------------------------------------------

  test('слова meta в промпте нет: мешка структуры не существует', () => {
    expect(SYSTEM_PROMPT_V9).not.toMatch(/meta/i);
  });

  test('правила поведения: тулы, decimal-значения, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V9).toContain('decimal-строками');
    expect(SYSTEM_PROMPT_V9).toContain('entity_query');
    expect(SYSTEM_PROMPT_V9).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V9).toContain(TOOL_RESULT_MARKER);
  });

  test('в теле v9 нет финансовой прозы — она во фрагментах Финансов', () => {
    for (const n of ['budget_status', 'spend_class', 'Денежные суммы', 'что по бюджету?']) {
      expect(SYSTEM_PROMPT_V9).not.toContain(n);
    }
  });

  test('одна сущность на намерение: пример остался ДВУХАСПЕКТНЫМ и без денег', () => {
    expect(SYSTEM_PROMPT_V9).toContain('Одна сущность на намерение');
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
  const from = SYSTEM_PROMPT_V9.indexOf('Горизонты планирования:');
  const to = SYSTEM_PROMPT_V9.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока горизонтов перед продолжениями');
  return SYSTEM_PROMPT_V9.slice(from, to);
}

/** Примеры-ЗАПРОСЫ шпаргалки (отбор — как в v7.test.ts). */
function grammarExamples(): string[] {
  const from = SYSTEM_PROMPT_V9.indexOf('Шпаргалка грамматики запросов');
  const to = SYSTEM_PROMPT_V9.indexOf('Протокол tool-результатов');
  if (from < 0 || to < from) throw new Error('в промпте нет блока шпаргалки перед протоколом');
  return [...SYSTEM_PROMPT_V9.slice(from, to).matchAll(/«([^»]+)»/g)]
    .map((m) => m[1] as string)
    .filter((s) => /^[a-z_]+[=<>]/i.test(s));
}

/**
 * Токены строки «Date-токены…» — перечень между двоеточием и скобкой примеров, по «|».
 * Отсортированный список: порядок в строке — дело текста, состав — дело словаря кода.
 */
function tokensOfLine(line: string): string[] {
  const list = line.match(/: ([a-z0-9_ |]+) \(например/)?.[1];
  if (list === undefined) throw new Error(`в строке токенов нет перечня: «${line}»`);
  return list
    .split('|')
    .map((t) => t.trim())
    .sort();
}

/** Строка текста, содержащая подстроку, — ровно одна (довод — в v7.test.ts). */
function lineOf(prompt: string, needle: string): string {
  const found = prompt.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}

function lineWith(needle: string): string {
  return lineOf(SYSTEM_PROMPT_V9, needle);
}
