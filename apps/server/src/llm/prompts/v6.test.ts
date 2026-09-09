// apps/server/src/llm/prompts/v6.test.ts
// Снимок системного промпта v6 — та же механика, что у v1–v5: текст промпта версионированный
// артефакт, эталон — файл-фикстура v6.fixture.txt, фиксируемая ОСОЗНАННО.
//
// ЗАЧЕМ ВЕРСИЯ (§Б8-3, Р-К-6): проза модуля обязана уходить вместе с модулем, а текст
// версионированного снимка не правится ни байтом (РП-18; v5 заморожен в FROZEN_PROMPTS).
// Пять строк финансовой прозы уехали во фрагменты манифеста Финансов (§Б8-1), три переписаны
// без денег — итого восемь правок, и ровно они перечислены в REPLACED_V6.
//
// Сверх снимка здесь три рода гардов:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v5 со списком осознанно заменённых строк (REPLACED_V6);
//   2. ДВЕНАДЦАТЬ ИСПОЛНЯЕМЫХ ГАРДОВ, перенесённых с v5 (РП-18). «Исполняемый» здесь значит
//      одно: гард сверяет текст промпта не сам с собой, а с ЖИВЫМ кодом — настоящим разбором
//      запросов, реестром свойств, валидатором записи, сидом смарт-листов, парсером чипов и
//      константами. Каждый помечен ниже своим номером [ГАРД N] и адресом оригинала;
//      двенадцатый — «продолжения последними» — живёт не здесь, а на СОБРАННОМ канале
//      (llm/context.test.ts, §Б7-6-2), и здесь только назван, чтобы счёт сходился глазами;
//   3. ГАРДЫ ВЫНОСА (новое в v6): в теле промпта нет ни одного финансового имени, а
//      перенесённые утверждения о бюджете стоят на ФРАГМЕНТЕ манифеста.
//
// ЧЕГО ЗДЕСЬ НЕТ по сравнению с v5.test.ts и почему: обратные половины двух негативных
// гардов («…а v4 эту форму содержал»). Голое имя поля и слово `meta` сняла версия v5, и
// сравнивать v6 с v5 по ним не с чем — двухверсионное сравнение осталось там, где ему место,
// в v5.test.ts. Здесь его роль играет механический дифф плюс гард «в теле v6 нет ни одного
// финансового имени», у которого обратная половина живая: v5 эти имена содержал.

import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  MODULE_MANIFESTS,
} from '@orbis/shared';
import { parseQueryAst, queryAstSchema, toParseRegistry } from '@orbis/shared/query';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { type PropsRegistry, validateEntityProps } from '../../registry/validate-props';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V5 } from './v5';
import { SYSTEM_PROMPT_V6, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v6';

/**
 * Строки v5, снятые в v6 ОСОЗНАННО: пять уехали в манифест Финансов (§Б8-1), три переписаны
 * без денег. Каждая — не переформулировка: проза модуля обязана уходить вместе с модулем
 * (§Б8-3), а текст версионированного снимка не правится (РП-18) — отсюда линейка, а не правка.
 *
 * Список САМ ПОД ГАРДОМ (проверка ниже): опечатка здесь не открывала бы дыру молча — мёртвая
 * строка исключения перестала бы что-либо прикрывать, а настоящая строка v5 уехала бы в потери.
 */
const REPLACED_V6 = new Set([
  '- Денежные суммы передавай в виде decimal-строк с двумя знаками после точки (например, "500.00") — никогда как числа с плавающей точкой.',
  '- orbis/finance_category — только uuid реально существующей категории: найди её через entity_query. Не подставляй выдуманный uuid.',
  '- Одно дело пользователя — ОДНА сущность. Срок или дата, сумма, статус — это СВОЙСТВА этой сущности, а не повод завести вторую: «оплатить страховку 12000 до пятницы» = одна сущность с аспектами orbis/task и orbis/financial и свойствами orbis/task_status, orbis/due_date, orbis/amount, orbis/direction, orbis/finance_category, orbis/planned=true, orbis/occurred_on — а НЕ отдельная задача плюс отдельная трата.',
  'Бюджет (тул budget_status):',
  '- Финансовые вопросы — «что по бюджету?», «могу позволить X?», остатки конвертов, распределение бюджета — решай вызовом budget_status: он возвращает готовые агрегаты месяца (конверты со spent/remaining/dailyPace, баланс, comingUp, planned, unbudgeted) и spend_class категорий. Не пересчитывай эти агрегаты вручную через entity_query/user_query.',
  '- Свободные деньги («могу позволить?»): сумма remaining конвертов категорий со spend_class=discretionary МИНУС будущие planned-оттоки — записи planned и comingUp из budget_status, брать только direction=expense: доходные инстансы (например, будущую зарплату из comingUp) НЕ вычитай. Будущие recurring-платежи УЖЕ входят туда как planned-инстансы — НЕ суммируй recurring отдельно: это двойной вычет.',
  '- Категорию без spend_class не включай в расчёт молча — явно попроси пользователя классифицировать её (fixed/discretionary).',
  '- Продолжения пиши от лица пользователя, коротко (до 60 символов): «что по бюджету?», «поставить срок», «показать все задачи».',
]);

/**
 * Реестр разбора — ВСТРОЕННЫЙ, тот же, что кладёт сид (`scripts/seed-registries.ts`).
 * Живая БД здесь не нужна и была бы хуже: промпт — статика, и гард обязан краснеть от правки
 * реестра в коде, а не от того, пересеяна ли локальная база.
 */
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

describe('SYSTEM_PROMPT_V6 (§7.1 слой 1, реформа свойств РП-18)', () => {
  // [ГАРД 1] Побайтная сверка с фикстурой (v5.test.ts:24-27). На v5 не тавтология: фикстура
  // снята из константы и лежит отдельным файлом — расхождение видно диффом при ревью.
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v6.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V6).toBe(fixture);
  });

  // [ГАРД 2] Версия — из константы модуля (v5.test.ts:29-31).
  test('версия промпта — v6', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v6');
  });

  // [ГАРД 3] Механический дифф против предыдущей версии (v5.test.ts:46-52 + REPLACED_V6-механика
  // routine-v2.test.ts:75-91). Сравнение по ЦЕЛОЙ строке (Set), а не подстрокой: при
  // `.includes(line)` строку v4 можно было бы ослабить дописыванием в её же хвост, и гард
  // промолчал бы.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v5 ⊇ v4 − REPLACED_V6) и
  // судит только о наличии строк — перестановка блоков и новый текст, противоречащий старому,
  // для него невидимы. Порядок и точный вид держит фикстура, смысл — гарды ниже.
  test('v6 не потерял ни одной строки v5, кроме осознанно заменённых', () => {
    const v6lines = new Set(SYSTEM_PROMPT_V6.split('\n'));
    const lost = SYSTEM_PROMPT_V5.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !REPLACED_V6.has(line))
      .filter((line) => !v6lines.has(line));
    expect(lost).toEqual([]);
  });

  test('каждое исключение — настоящая строка v5, и в v6 её действительно нет', () => {
    const v5lines = new Set(SYSTEM_PROMPT_V5.split('\n'));
    const v6lines = new Set(SYSTEM_PROMPT_V6.split('\n'));
    for (const line of REPLACED_V6) {
      expect(v5lines.has(line)).toBe(true);
      expect(v6lines.has(line)).toBe(false);
    }
  });

  // --- Пришло с v5: грамматика по реестру ----------------------------------

  // [ГАРД 4] Наследник гарда «пример шпаргалки разбирается настоящей грамматикой»
  // (v5.test.ts:59-74, там — умирающий `parseQuery`; здесь — `parseQueryAst` по реестру).
  //
  // Почему на v5 он НЕ тавтология: старый гард проверял единственный пример с `tags=`, а
  // здесь через живой разбор идут ВСЕ примеры-запросы шпаргалки, и разбор этот отвергает
  // голое имя поля кодом UNKNOWN_FIELD. Ровно та правка, ради которой заведена версия
  // (`status=` → `orbis/task_status=`), гарду и видна: верни любой пример к форме v4 — тест
  // красный. Проверено мутацией.
  test('шпаргалка: каждый пример-запрос разбирается настоящей грамматикой по реестру', () => {
    const examples = grammarExamples();
    // Страховка от «регулярка перестала находить»: пустой список прошёл бы цикл молча.
    // Не равенство: новый пример — законная правка, и он обязан попасть под ту же проверку,
    // а не уронить тест на счётчике.
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) {
      const r = parseQueryAst(example, PARSE_REG);
      expect(r.ok ? null : `${example}: ${r.error.code} ${r.error.message}`).toBeNull();
    }
    // Именно namespaced-примеры, ради которых заведена версия, — поимённо: гард выше
    // зеленел бы и на шпаргалке, из которой их просто убрали.
    const joined = examples.join('\n');
    expect(joined).toContain('orbis/task_status=!done&!cancelled');
    expect(joined).toContain('orbis/due_date<=today');
    expect(joined).toContain('has=orbis/recurrence');
  });

  // Обратная сторона гарда 4 и снятая ложь v4: голое имя поля разбор НЕ принимает, и промпт
  // об этом говорит. Негативный гард, потому что позитивные обходятся дописыванием — строка
  // v4 со `status=`, оставленная рядом с новой, прошла бы все проверки выше.
  test('голого имени поля в промпте нет, и грамматика его действительно не знает', () => {
    expect(SYSTEM_PROMPT_V6).toContain('голого имени поля грамматика не знает');
    // Проверяем ГОЛУЮ форму по её разделителю, а не по хвосту строки: `status=!done&!cancelled`
    // входит подстрокой в namespaced `orbis/task_status=!done&!cancelled`, который в v5 законен,
    // а прежняя редакция искала эту же подстроку с `\n` на конце — такой формы не было и в v4
    // (за ней всегда шло `, sortBy=` или `)`), то есть под-ассерт не мог покраснеть никогда.
    // `, status=` встречается в v4 ровно раз (`:58`) и в v5 ноль раз — гард стал несущим.
    expect(SYSTEM_PROMPT_V6).not.toContain(', status=');
    expect(SYSTEM_PROMPT_V6).not.toContain('(status=planned|in_progress)');
    expect(SYSTEM_PROMPT_V6).not.toContain('sortBy=updated_at:');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
    // Обратной половины («…а предыдущая версия эти формы содержала») здесь нет намеренно:
    // голое имя поля сняла v5, и сравнивать v6 с v5 по нему не с чем. Две версии сравнивает
    // v5.test.ts, а живость гарда держит `parseQueryAst` выше — он отвергает форму на самом
    // деле, а не по списку строк.
  });

  // [НОВЫЙ ГАРД] Пример дерева для входа `ast` тула `entity_query` (§А5-4): JSON из промпта
  // проверяется СХЕМОЙ КАНОНА, а каждый id внутри — реестром. У v4 носителя не было —
  // входа `ast` не существовало.
  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = SYSTEM_PROMPT_V6.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
    // Взаимное исключение входов названо промптом — иначе модель пришлёт оба и получит отказ
    expect(SYSTEM_PROMPT_V6).toContain('query и ast в одном вызове несовместимы');
  });

  // [НОВЫЙ ГАРД] Все namespaced-имена, названные промптом, — настоящие строки реестра.
  // У v4 такого гарда быть не могло: он называл два аспекта, а v5 называет два десятка key
  // свойств, и опечатка в любом стоила бы отказа UNKNOWN_PROPERTY на каждой записи.
  test('каждое имя orbis/… из промпта есть в реестре свойств, аспектов или ролей', () => {
    const known = new Set<string>([
      ...PARSE_REG.properties.keys(),
      ...PARSE_REG.aspects.keys(),
      ...PARSE_REG.roles.keys(),
    ]);
    const named = [
      ...new Set([...SYSTEM_PROMPT_V6.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    // Носителей должно быть много — иначе регулярка «перестала находить» тихо
    expect(named.length).toBeGreaterThanOrEqual(15);
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    // Роль из примера `via=` названа по key и существует
    expect(SYSTEM_PROMPT_V6).toContain('via=subitem');
    expect([...PARSE_REG.roles.values()].map((r) => r.key)).toContain('subitem');
  });

  // --- Гарды блока целей, унаследованные от v4/v5 ---------------------------

  // [ГАРД 5] v5.test.ts:85-90. Аспект назван по id — id обязан быть настоящим.
  test('блок целей: названный аспект существует в реестре', () => {
    expect(SYSTEM_PROMPT_V6).toContain('Цели и горизонты:');
    expect([...SYSTEM_PROMPT_V6.matchAll(/orbis\/goal/g)].length).toBeGreaterThan(0);
    expect(BUILTIN_ASPECT_IDS).toContain('orbis/goal');
  });

  // [ГАРД 6] v5.test.ts:95-107, переведённый с умирающей zod-схемы аспекта на ЖИВОЙ валидатор
  // записи по реестру (§А7-1) — тот самый, который отвечает модели на entity_create.
  //
  // Не тавтология: `progress_source` после реформы — свойство с json-схемой, куда вложен
  // КАНОН Q-AST, и ветка `count` запрещает `field`, а `sum`/`latest` его требуют. Гард
  // собирает значение по каждому названному промптом агрегату и ждёт ноль нарушений;
  // добавив `field` к `count`, получаем красноту (проверено мутацией).
  test('блок целей: каждый aggregate из промпта принимает валидатор записи orbis/goal', () => {
    const block = goalsBlock();
    const named = [...block.matchAll(/\b(sum|count|latest)\b/g)].map((m) => m[1] as string);
    expect(new Set(named)).toEqual(new Set(['sum', 'count', 'latest']));
    const query = { filter: { aspect: 'orbis/financial' } };
    for (const aggregate of new Set(named)) {
      const progressSource =
        aggregate === 'count' ? { query, aggregate } : { query, aggregate, field: 'orbis/amount' };
      const violations = validateEntityProps(PROPS_REG, {
        props: { 'orbis/progress_source': progressSource, 'orbis/target_value': '24' },
        aspects: ['orbis/goal'],
      });
      expect(violations).toEqual([]);
    }
  });

  // [ГАРД 7] v5.test.ts:111-117. Поля, названные промптом, — настоящие свойства ИМЕННО этого
  // аспекта (v4 проверял ключи zod-схемы; после реформы носитель — ссылки аспекта в реестре).
  test('блок целей: названные свойства объявлены аспектом orbis/goal', () => {
    const goal = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal');
    if (!goal) throw new Error('в реестре нет аспекта orbis/goal');
    const declared = goal.properties.map((ref) => ref.propertyId);
    for (const key of ['orbis/target_value', 'orbis/progress_source', 'orbis/current_value']) {
      expect(SYSTEM_PROMPT_V6).toContain(key);
      expect(declared).toContain(key);
    }
  });

  test('блок целей: orbis/current_value модель не заполняет', () => {
    expect(SYSTEM_PROMPT_V6).toMatch(/orbis\/current_value НЕ заполняй/);
    expect(SYSTEM_PROMPT_V6).toMatch(/прогресс цели считает сервер/i);
  });

  // [ГАРД 8] v5.test.ts:133-155. Каждый список, названный лестницей горизонтов, действительно
  // сидируется; названные несуществующими — действительно не сидируются. Реформа сида списков
  // не касалась, поэтому гард перенесён дословно — и именно поэтому он не выродился: носитель
  // (SEED_SMART_LISTS) остался тем же живым сидом.
  test('блок целей: каждый список, названный лестницей горизонтов, действительно сидируется', () => {
    const titles: string[] = SEED_SMART_LISTS.map((l) => l.title);
    const ladder = goalsBlock()
      .split('\n')
      .find((line) => line.includes('Горизонты планирования разложены'));
    if (!ladder) throw new Error('в блоке целей нет строки с лестницей горизонтов');

    const denied = ['День', 'Неделя', 'Месяц']; // названы как НЕсуществующие
    const named = [...ladder.matchAll(/«([^»]+)»/g)].map((m) => m[1] ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      if (denied.includes(name)) continue;
      expect(titles).toContain(name);
    }
    for (const carrier of ['Daily Planning', 'Upcoming', 'Год', 'Жизнь']) {
      expect(named).toContain(carrier);
      expect(titles).toContain(carrier);
    }
    for (const absent of denied) expect(titles).not.toContain(absent);
    expect(ladder).toContain('«День», «Неделя» и «Месяц» не существует');
  });

  test('блок целей: сначала entity_query, потом предложение — без дублей', () => {
    expect(goalsBlock()).toContain('entity_query');
    expect(goalsBlock()).toMatch(/Не заводи дубли/);
  });

  // --- Гарды блока продолжений (D19) ---------------------------------------

  // [ГАРД 9] v5.test.ts:166-173. Пример маркера из промпта разбирается НАСТОЯЩИМ парсером
  // чипов: формат в промпте и `ai/suggestions.ts` обязаны описывать один протокол.
  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V6).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V6.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.');
    expect(parsed.suggestions).toHaveLength(3);
  });

  // Однократность заголовка — условие деления на PROMPT_BODY/CONTINUATIONS_BLOCK
  // (llm/context.ts): при двух вхождениях часть текста уехала бы в хвост канала.
  // [ГАРД 12] «блок продолжений идёт ПОСЛЕДНИМ» проверяется НЕ здесь, а на СОБРАННОМ канале
  // (llm/context.test.ts, §Б7-6-2 + send-message.test.ts): «последний в тексте промпта» модели
  // ничего не обещает — после промпта канал дописывает дату, инструкции аспектов, память и якорь.
  test('блок продолжений — ровно один в промпте, блок целей стоит перед ним', () => {
    expect(SYSTEM_PROMPT_V6.split('Продолжения разговора:')).toHaveLength(2);
    expect(SYSTEM_PROMPT_V6.indexOf('Цели и горизонты:')).toBeLessThan(
      SYSTEM_PROMPT_V6.indexOf('Продолжения разговора:'),
    );
  });

  // [ГАРД 10] v5.test.ts:188-191 — «числа из констант»: потолки промпта и парсера едины.
  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V6).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V6).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V6).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V6).toMatch(/нечем — строку не добавляй/);
  });

  // --- Снятая ложь v4 (гард перенесён с v5) ---------------------------------

  // Обратный гард к v5.test.ts:198-204 («соглашение meta-ключей — дословно из PRD»).
  // `meta`-мешка в контрактах тулов больше нет (`entity_create` принимает props/aspects),
  // и строка про него учила бы модель писать в поле, которого схема не знает.
  test('слова meta в промпте нет: мешка структуры больше не существует', () => {
    expect(SYSTEM_PROMPT_V6).not.toMatch(/meta/i);
    // Обратная половина («…а v4 его содержал») осталась в v5.test.ts: ложь снята версией
    // раньше, и сравнивать v6 с v5 по ней нечем.
  });

  // --- Прочие гарды, унаследованные от v4/v5 --------------------------------

  test('правила поведения: тулы, decimal-значения, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V6).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V6).toContain('entity_query');
    expect(SYSTEM_PROMPT_V6).toMatch(/не выдумывай/i);
    // `orbis/finance_category` из этого гарда УЕХАЛО: имя свойства Финансов живёт теперь во
    // фрагменте `finance/amounts` манифеста и проверяется гардом фрагмента ниже.
  });

  // [ГАРД 11] v5.test.ts:213-216 — маркер протокола берётся из константы, а не переписан.
  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V6).toContain(TOOL_RESULT_MARKER);
  });

  // --- Новое в v6: вынос прозы Финансов в манифест (§Б8-1, §С8-22) ----------

  test('в теле v6 нет ни одного финансового имени — они уехали в манифест (§С8-22)', () => {
    for (const n of [
      'budget_status',
      'spend_class',
      'orbis/finance_category',
      'orbis/amount',
      'Денежные суммы',
      'что по бюджету?',
    ]) {
      expect(SYSTEM_PROMPT_V6).not.toContain(n);
    }
    // …а v5 их содержал — гард сравнивает две версии, а не ловит опечатку
    for (const n of ['budget_status', 'spend_class']) expect(SYSTEM_PROMPT_V5).toContain(n);
  });

  test('перенесённые гарды Budget стоят на ФРАГМЕНТЕ (03-budget §4.3)', () => {
    const text = MODULE_MANIFESTS.finance.promptFragments.map((f) => f.text).join('\n');
    for (const n of [
      'budget_status',
      'НЕ суммируй recurring отдельно',
      'двойной вычет',
      'spend_class',
      'только direction=expense',
      'orbis/amount',
      'orbis/finance_category',
    ]) {
      expect(text).toContain(n);
    }
    expect(text).toMatch(/доходные инстансы[^.\n]*не вычитай/i);
    // Имена orbis/… фрагментов — настоящие строки реестра (наследник гарда v5.test.ts:186)
    for (const name of text.match(/orbis\/[a-z_]+/g) ?? []) {
      expect(PARSE_REG.properties.has(name) || PARSE_REG.aspects.has(name)).toBe(true);
    }
  });

  test('decimal-правило осталось в ядре: цели тоже пишут число строкой', () => {
    expect(SYSTEM_PROMPT_V6).toContain('decimal-строками');
    expect(SYSTEM_PROMPT_V6).toContain('orbis/target_value');
  });

  test('одна сущность на намерение: пример остался ДВУХАСПЕКТНЫМ и без денег', () => {
    expect(SYSTEM_PROMPT_V6).toContain('Одна сущность на намерение');
    expect(SYSTEM_PROMPT_V6).toMatch(/не создавай втор|а НЕ втор/i);
    expect(SYSTEM_PROMPT_V6).toContain('attach_');
    // Пример правила «одна сущность» обязан оставаться ДВУХАСПЕКТНЫМ (иначе он ничего не
    // показывает), но денежная пара уехала во фрагмент `finance/one-intent` — здесь стоит
    // пара ядра: задача плюс встреча.
    const line = lineWith('Одно дело пользователя');
    expect(line).toContain('orbis/task');
    expect(line).toContain('orbis/schedule');
    expect(line).toContain('orbis/start_at');
    expect(line).not.toContain('orbis/amount');
  });

  // --- Пришло с v5: где брать имя свойства и как заводить своё --------------

  // §А9-3: единственные две поверхности, откуда модель узнаёт key свойства. Гард проверяет,
  // что промпт называет ОБЕ: назвав только attach_*, он оставил бы свободные и предложенные
  // свойства невидимыми, а модель — сочиняющей имена.
  test('где брать имя свойства: параметры attach_* и property_catalog названы оба', () => {
    const line = lineWith('Имя свойства');
    expect(line).toContain('attach_<аспект>');
    expect(line).toContain('property_catalog');
    expect(line).toMatch(/свободные свойства/);
  });

  // РУЛИНГ Р-19-1 (замер Задачи 17): описание тула это уже велит, и модель всё равно завела
  // 2 свойства из 2 со status=active. Проверяется В ОДНОЙ строке: «property_create» в одном
  // абзаце и «proposed» в другом складываются в смысл только в голове читателя гарда.
  test('своё свойство заводится со status=proposed, и только по тому, по чему фильтруют', () => {
    const line = lineWith('property_create');
    expect(line).toContain('status=proposed');
    expect(line).toMatch(/фильтровать или считать/);
    expect(line).toMatch(/status=active/); // назван как исключение, а не умолчание
  });
});

/**
 * Текст блока «Цели и горизонты» без соседей: гарды блока не должны ловить слова из остального
 * промпта. Для v5 это не формальность — `sum`, `count` и `latest` в других блоках не стоят, но
 * `orbis/amount` и `entity_query` стоят, и без отсечения соседей гарды блока зеленели бы на них.
 */
function goalsBlock(): string {
  const from = SYSTEM_PROMPT_V6.indexOf('Цели и горизонты:');
  const to = SYSTEM_PROMPT_V6.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока целей перед продолжениями');
  return SYSTEM_PROMPT_V6.slice(from, to);
}

/**
 * Примеры-ЗАПРОСЫ шпаргалки: «…»-фрагменты блока грамматики, начинающиеся с имени конструкции
 * и оператора. Отбор именно такой, потому что «…» в этом блоке носят и не-запросы — «|»,
 * «!v1&!v2», «Доходы с тегом savings», «часть внутри целого»: скормив их разбору, гард
 * краснел бы на честном тексте.
 */
function grammarExamples(): string[] {
  const from = SYSTEM_PROMPT_V6.indexOf('Шпаргалка грамматики запросов');
  // Конец блока — «Протокол tool-результатов», а не «Бюджет»: блок бюджета из v6 снят
  // целиком (он уехал во фрагмент `finance/budget` манифеста).
  const to = SYSTEM_PROMPT_V6.indexOf('Протокол tool-результатов');
  if (from < 0 || to < from) throw new Error('в промпте нет блока шпаргалки перед протоколом');
  return [...SYSTEM_PROMPT_V6.slice(from, to).matchAll(/«([^»]+)»/g)]
    .map((m) => m[1] as string)
    .filter((s) => /^[a-z_]+[=<>]/i.test(s));
}

/**
 * Строка промпта, содержащая подстроку. Гарды нового поведения смотрят В ОДНУ строку, а не в
 * весь текст: утверждение «заводя от себя, ставь proposed» рассыпается, если его половины
 * стоят в разных абзацах, — модель читает строку целиком, а гард по всему тексту этого не
 * заметит. Механика — та же, что в routine-v2.test.ts:255-261.
 */
function lineWith(needle: string): string {
  const found = SYSTEM_PROMPT_V6.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}
