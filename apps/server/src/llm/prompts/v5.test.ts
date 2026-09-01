// apps/server/src/llm/prompts/v5.test.ts
// Снимок системного промпта v5 — та же механика, что у v1–v4: текст промпта версионированный
// артефакт, эталон — файл-фикстура v5.fixture.txt, фиксируемая ОСОЗНАННО.
//
// Сверх снимка здесь три рода гардов:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v4 со списком осознанно заменённых строк (REPLACED) — образец
//      routine-v2.test.ts:42-91: перечисление кусков предыдущей версии руками ловит только то,
//      о чём вспомнил автор гарда;
//   2. ДВЕНАДЦАТЬ ИСПОЛНЯЕМЫХ ГАРДОВ v4, перенесённых на v5 (РП-18). «Исполняемый» здесь
//      значит одно: гард сверяет текст промпта не сам с собой, а с ЖИВЫМ кодом — настоящим
//      разбором запросов, реестром свойств, валидатором записи, сидом смарт-листов, парсером
//      чипов и константами. Каждый помечен ниже своим номером [ГАРД N] и адресом оригинала;
//      двенадцатый — «продолжения последними» — живёт не здесь, а на СОБРАННОМ канале
//      (llm/context.test.ts, §Б7-6-2), и здесь только назван, чтобы счёт сходился глазами;
//   3. НЕГАТИВНЫЕ гарды снятой лжи v4: слова `meta` в тексте нет, голого имени поля в
//      примерах нет. Позитивные обходятся дописыванием, негативные — нет.
//
// Перенос гарда — не копирование текста: гард, проверявший старую форму, на новой мог бы
// стать тавтологией. Поэтому у каждого исполняемого гарда есть ОБРАТНАЯ сторона (что именно
// он покраснеет увидев) — она записана рядом с ним, а не подразумевается.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import { parseQueryAst, queryAstSchema, toParseRegistry } from '@orbis/shared/query';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { type PropsRegistry, validateEntityProps } from '../../registry/validate-props';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V4 } from './v4';
import { SYSTEM_PROMPT_V5, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v5';

/**
 * Строки v4, снятые в v5 ОСОЗНАННО. Каждая — не переформулировка, а утверждение, которое
 * реформа свойств сделала ложным: `meta`-мешка нет, `aspects` в `entity_create` — список id,
 * имя поля — namespaced key свойства, `progress_source.query` — дерево.
 *
 * Список САМ ПОД ГАРДОМ (проверка ниже): опечатка здесь не открывала бы дыру молча — мёртвая
 * строка исключения перестала бы что-либо прикрывать, а настоящая строка v4 уехала бы в потери.
 */
const REPLACED = new Set([
  '- category_ref — только uuid реально существующей категории: найди её через entity_query. Не подставляй выдуманный uuid.',
  '- Одно дело пользователя — ОДНА сущность. Срок или дата, сумма, статус — это АСПЕКТЫ этой сущности, а не повод завести вторую: «оплатить страховку 12000 до пятницы» = одна сущность с orbis/task (status, due_date) и orbis/financial (amount, direction, category_ref, planned=true, occurred_on), а НЕ отдельная задача плюс отдельная трата.',
  '- Навешивай аспекты СРАЗУ, одним entity_create: aspects — объект, ключей в нём может быть несколько. Сущность без аспектов создавай только тогда, когда её тип из реплики не следует.',
  '- Если сущность уже создана (в этом же ходе или раньше в треде) — добавляй недостающий аспект К НЕЙ по её id: attach_<аспект> или entity_update. Никогда не создавай вторую сущность про то же дело. Id из прошлых ходов в контексте нет: прежде чем создавать что-то, о чём в треде уже шла речь, найди сущность через entity_query (search=<слова из названия>) и правь НАЙДЕННУЮ.',
  '- Сумма покупки живёт в orbis/financial (amount, direction, category_ref; будущая покупка — planned=true и occurred_on на плановую дату), а не в `meta`: meta — только для того, чему в реестре пока нет своего аспекта.',
  '- Дата в реплике: если она отвечает на «когда этим заняться» («к субботе», «в среду», «завтра в 19:00») — ставь И due_date в orbis/task, И orbis/schedule (start_at на этот день, у даты без времени — начало дня и all_day=true), чтобы дело было видно и в списке задач, и в дне. Если дата — только крайний срок («не позже конца месяца»), хватит одного due_date. Оба аспекта — на ТОЙ ЖЕ сущности.',
  '- Фильтры перечисляются через запятую и объединяются по И. Примеры: «aspect=orbis/category, search=Еда»; «aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, limit=20».',
  '- В значении «|» — ИЛИ (status=planned|in_progress), «!v1&!v2» — НЕ эти значения (status=!done&!cancelled); смешивать | и & в одном значении нельзя.',
  '- Date-токены для любого date-поля: today | overdue | next_7d | after_7d (например, due_date=today|overdue).',
  '- tags=<тег>|<тег> — отбор по тегам сущности (ключ во МНОЖЕСТВЕННОМ числе, `tag=` грамматика не знает); excludeTags=<тег> — исключение. «Доходы с тегом savings» = «aspect=orbis/financial, direction=income, tags=savings».',
  '- children_of=<uuid> — дети сущности (по parent-связи); sortBy=<поле>:asc|desc, search=<текст по title+body>, limit=<число>.',
  'Соглашение об именах meta-ключей (PRD §3.9, дословно):',
  'Правило для AI-инструкций (фиксируется в system prompt и в `ai_instructions` аспектов): **имена ключей в `meta` обязаны совпадать с именами полей аспектов**. AI, извлекая структуру из «потратил 500 на такси» до/помимо аспекта, пишет `meta: {amount: "500.00", direction: "expense"}` — те же имена и типы, что в схеме `orbis/financial`. Это делает ретроактивную миграцию (§3.10) механической операцией, а не угадыванием.',
  '- Измеримая цель пользователя («накопить 300 000», «прочитать 24 книги», «вес 80 кг») — ОДНА сущность с аспектом orbis/goal: target_value — целевое число decimal-строкой, progress_source — откуда берётся факт (запрос той же грамматики по графу плюс aggregate: sum, count или latest). Какие ключи требует каждый вариант aggregate — в инструкции аспекта orbis/goal ниже; не угадывай их состав.',
  '- current_value НЕ заполняй никогда: прогресс цели считает сервер, обходя граф запросом из progress_source при каждом чтении.',
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
  },
  'ru',
);

/** Тот же снимок для валидатора записи (§А7-1) — у него своя форма аргумента. */
const PROPS_REG: PropsRegistry = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
};

describe('SYSTEM_PROMPT_V5 (§7.1 слой 1, реформа свойств РП-18)', () => {
  // [ГАРД 1] Побайтная сверка с фикстурой (v4.test.ts:24-27). На v5 не тавтология: фикстура
  // снята из константы и лежит отдельным файлом — расхождение видно диффом при ревью.
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v5.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V5).toBe(fixture);
  });

  // [ГАРД 2] Версия — из константы модуля (v4.test.ts:29-31).
  test('версия промпта — v5', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v5');
  });

  // [ГАРД 3] Механический дифф против предыдущей версии (v4.test.ts:46-52 + REPLACED-механика
  // routine-v2.test.ts:75-91). Сравнение по ЦЕЛОЙ строке (Set), а не подстрокой: при
  // `.includes(line)` строку v4 можно было бы ослабить дописыванием в её же хвост, и гард
  // промолчал бы.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v5 ⊇ v4 − REPLACED) и
  // судит только о наличии строк — перестановка блоков и новый текст, противоречащий старому,
  // для него невидимы. Порядок и точный вид держит фикстура, смысл — гарды ниже.
  test('v5 не потерял ни одной строки v4, кроме осознанно заменённых', () => {
    const v5lines = new Set(SYSTEM_PROMPT_V5.split('\n'));
    const lost = SYSTEM_PROMPT_V4.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !REPLACED.has(line))
      .filter((line) => !v5lines.has(line));
    expect(lost).toEqual([]);
  });

  test('каждое исключение — настоящая строка v4, и в v5 её действительно нет', () => {
    const v4lines = new Set(SYSTEM_PROMPT_V4.split('\n'));
    const v5lines = new Set(SYSTEM_PROMPT_V5.split('\n'));
    for (const line of REPLACED) {
      expect(v4lines.has(line)).toBe(true);
      expect(v5lines.has(line)).toBe(false);
    }
  });

  // --- Новое в v5: грамматика по реестру -----------------------------------

  // [ГАРД 4] Наследник гарда «пример шпаргалки разбирается настоящей грамматикой»
  // (v4.test.ts:59-74, там — умирающий `parseQuery`; здесь — `parseQueryAst` по реестру).
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
    expect(SYSTEM_PROMPT_V5).toContain('голого имени поля грамматика не знает');
    expect(SYSTEM_PROMPT_V5).not.toContain('status=!done&!cancelled\n');
    expect(SYSTEM_PROMPT_V5).not.toContain('(status=planned|in_progress)');
    expect(SYSTEM_PROMPT_V5).not.toContain('sortBy=updated_at:');
    for (const bare of ['aspect=orbis/task, status=done', 'aspect=orbis/note, tag=book']) {
      expect(parseQueryAst(bare, PARSE_REG).ok).toBe(false);
    }
    // …а v4 эти формы содержал — гард сравнивает две версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V4).toContain('(status=planned|in_progress)');
  });

  // [НОВЫЙ ГАРД] Пример дерева для входа `ast` тула `entity_query` (§А5-4): JSON из промпта
  // проверяется СХЕМОЙ КАНОНА, а каждый id внутри — реестром. У v4 носителя не было —
  // входа `ast` не существовало.
  test('пример {ast}: валиден по схеме канона, а имена в нём — настоящие строки реестра', () => {
    const raw = SYSTEM_PROMPT_V5.match(/\{"filter":.+?\},"limit":\d+\}/)?.[0];
    if (!raw) throw new Error('в шпаргалке нет примера дерева для входа ast');
    const parsed = queryAstSchema.safeParse(JSON.parse(raw));
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
    for (const id of [...raw.matchAll(/"(?:prop|aspect)":"([^"]+)"/g)].map((m) => m[1] as string)) {
      expect([...PARSE_REG.properties.keys(), ...PARSE_REG.aspects.keys()]).toContain(id);
    }
    // Взаимное исключение входов названо промптом — иначе модель пришлёт оба и получит отказ
    expect(SYSTEM_PROMPT_V5).toContain('query и ast в одном вызове несовместимы');
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
      ...new Set([...SYSTEM_PROMPT_V5.matchAll(/orbis\/[a-z0-9_-]+/g)].map((m) => m[0])),
    ];
    // Носителей должно быть много — иначе регулярка «перестала находить» тихо
    expect(named.length).toBeGreaterThanOrEqual(15);
    expect(named.filter((id) => !known.has(id))).toEqual([]);
    // Роль из примера `via=` названа по key и существует
    expect(SYSTEM_PROMPT_V5).toContain('via=subitem');
    expect([...PARSE_REG.roles.values()].map((r) => r.key)).toContain('subitem');
  });

  // --- Гарды блока целей, унаследованные от v4 ------------------------------

  // [ГАРД 5] v4.test.ts:85-90. Аспект назван по id — id обязан быть настоящим.
  test('блок целей: названный аспект существует в реестре', () => {
    expect(SYSTEM_PROMPT_V5).toContain('Цели и горизонты:');
    expect([...SYSTEM_PROMPT_V5.matchAll(/orbis\/goal/g)].length).toBeGreaterThan(0);
    expect(BUILTIN_ASPECT_IDS).toContain('orbis/goal');
  });

  // [ГАРД 6] v4.test.ts:95-107, переведённый с умирающей zod-схемы аспекта на ЖИВОЙ валидатор
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

  // [ГАРД 7] v4.test.ts:111-117. Поля, названные промптом, — настоящие свойства ИМЕННО этого
  // аспекта (v4 проверял ключи zod-схемы; после реформы носитель — ссылки аспекта в реестре).
  test('блок целей: названные свойства объявлены аспектом orbis/goal', () => {
    const goal = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal');
    if (!goal) throw new Error('в реестре нет аспекта orbis/goal');
    const declared = goal.properties.map((ref) => ref.propertyId);
    for (const key of ['orbis/target_value', 'orbis/progress_source', 'orbis/current_value']) {
      expect(SYSTEM_PROMPT_V5).toContain(key);
      expect(declared).toContain(key);
    }
  });

  test('блок целей: orbis/current_value модель не заполняет', () => {
    expect(SYSTEM_PROMPT_V5).toMatch(/orbis\/current_value НЕ заполняй/);
    expect(SYSTEM_PROMPT_V5).toMatch(/прогресс цели считает сервер/i);
  });

  // [ГАРД 8] v4.test.ts:133-155. Каждый список, названный лестницей горизонтов, действительно
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

  // [ГАРД 9] v4.test.ts:166-173. Пример маркера из промпта разбирается НАСТОЯЩИМ парсером
  // чипов: формат в промпте и `ai/suggestions.ts` обязаны описывать один протокол.
  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V5).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V5.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
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
    expect(SYSTEM_PROMPT_V5.split('Продолжения разговора:')).toHaveLength(2);
    expect(SYSTEM_PROMPT_V5.indexOf('Цели и горизонты:')).toBeLessThan(
      SYSTEM_PROMPT_V5.indexOf('Продолжения разговора:'),
    );
  });

  // [ГАРД 10] v4.test.ts:188-191 — «числа из констант»: потолки промпта и парсера едины.
  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V5).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V5).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V5).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V5).toMatch(/нечем — строку не добавляй/);
  });

  // --- Снятая ложь v4 -------------------------------------------------------

  // Обратный гард к v4.test.ts:198-204 («соглашение meta-ключей — дословно из PRD»).
  // `meta`-мешка в контрактах тулов больше нет (`entity_create` принимает props/aspects),
  // и строка про него учила бы модель писать в поле, которого схема не знает.
  test('слова meta в промпте нет: мешка структуры больше не существует', () => {
    expect(SYSTEM_PROMPT_V5).not.toMatch(/meta/i);
    // …а v4 его содержал — гард сравнивает две версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V4).toMatch(/meta/i);
  });

  // --- Прочие гарды, унаследованные от v4 -----------------------------------

  test('правила поведения: тулы, decimal-деньги, категория ссылкой, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V5).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V5).toContain('orbis/finance_category');
    expect(SYSTEM_PROMPT_V5).toContain('entity_query');
    expect(SYSTEM_PROMPT_V5).toMatch(/не выдумывай/i);
  });

  // [ГАРД 11] v4.test.ts:213-216 — маркер протокола берётся из константы, а не переписан.
  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V5).toContain(TOOL_RESULT_MARKER);
  });

  test('блок Budget: budget_status для финансовых вопросов, запрет двойного вычета recurring (03-budget §4.3)', () => {
    expect(SYSTEM_PROMPT_V5).toContain('budget_status');
    expect(SYSTEM_PROMPT_V5).toContain('НЕ суммируй recurring отдельно');
    expect(SYSTEM_PROMPT_V5).toContain('двойной вычет');
    expect(SYSTEM_PROMPT_V5).toContain('spend_class');
  });

  test('future_outflows — только direction=expense, доходные инстансы не вычитаются (§4.3)', () => {
    expect(SYSTEM_PROMPT_V5).toContain('только direction=expense');
    expect(SYSTEM_PROMPT_V5).toMatch(/доходные инстансы[^.\n]*не вычитай/i);
  });

  test('одна сущность на намерение: свойства на ТУ ЖЕ сущность, сумма — свойством orbis/amount', () => {
    expect(SYSTEM_PROMPT_V5).toContain('Одна сущность на намерение');
    expect(SYSTEM_PROMPT_V5).toMatch(/не создавай втор|а НЕ втор/i);
    expect(SYSTEM_PROMPT_V5).toContain('attach_');
    expect(SYSTEM_PROMPT_V5).toContain('orbis/schedule');
    expect(SYSTEM_PROMPT_V5).toContain('orbis/amount');
  });

  // --- Новое в v5: где брать имя свойства и как заводить своё ---------------

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
  const from = SYSTEM_PROMPT_V5.indexOf('Цели и горизонты:');
  const to = SYSTEM_PROMPT_V5.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока целей перед продолжениями');
  return SYSTEM_PROMPT_V5.slice(from, to);
}

/**
 * Примеры-ЗАПРОСЫ шпаргалки: «…»-фрагменты блока грамматики, начинающиеся с имени конструкции
 * и оператора. Отбор именно такой, потому что «…» в этом блоке носят и не-запросы — «|»,
 * «!v1&!v2», «Доходы с тегом savings», «часть внутри целого»: скормив их разбору, гард
 * краснел бы на честном тексте.
 */
function grammarExamples(): string[] {
  const from = SYSTEM_PROMPT_V5.indexOf('Шпаргалка грамматики запросов');
  const to = SYSTEM_PROMPT_V5.indexOf('Бюджет (тул budget_status):');
  if (from < 0 || to < from) throw new Error('в промпте нет блока шпаргалки перед бюджетом');
  return [...SYSTEM_PROMPT_V5.slice(from, to).matchAll(/«([^»]+)»/g)]
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
  const found = SYSTEM_PROMPT_V5.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}
