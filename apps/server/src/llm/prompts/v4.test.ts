// apps/server/src/llm/prompts/v4.test.ts
// Snapshot-тест системного промпта v4 — та же механика, что у v1, v2 и v3: текст
// промпта версионированный артефакт, эталон — файл-фикстура v4.fixture.txt,
// фиксируемая ОСОЗНАННО. Отличий v4 от v3 ровно два, оба найдены живой пробой
// второго провайдера (2026-08-06-openai-probe.md §2.3): ключ tags= в шпаргалке
// грамматики и запрет дублирующего attach. Семантические гарды v3 перенесены
// целиком: новая версия не имеет права молча потерять нормативные куски слоя 1.

import { describe, expect, test } from 'bun:test';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  BUILTIN_ASPECT_META,
  buildFieldCatalog,
  goalAspectSchema,
  parseQuery,
} from '@orbis/shared';
import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V3 } from './v3';
import { SYSTEM_PROMPT_V4, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v4';

describe('SYSTEM_PROMPT_V4 (§7.1 слой 1)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v4.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V4).toBe(fixture);
  });

  test('версия промпта — v4', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v4');
  });

  // Механический гард «новая версия ничего не потеряла»: перечисление кусков v3
  // руками ловит только то, о чём вспомнил автор гарда. Здесь — построчно весь v3.
  //
  // Сравнение — по ЦЕЛОЙ строке (Set), а не подстрокой. Разница не косметическая:
  // при `SYSTEM_PROMPT_V4.includes(line)` строку v3 можно было бы ослабить дописыванием
  // в её же хвост («…до 60 символов: … Впрочем, длина не важна — пиши как удобно.») —
  // подстрока осталась бы на месте, и гард промолчал бы. Проверено мутацией: с includes
  // такая правка давала 20 pass, с Set — красноту.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v4 ⊇ v3) и
  // судит только о наличии строк — перестановка блоков, потеря пустых строк между ними
  // и новый текст, противоречащий старому, для него невидимы. Порядок держит отдельный
  // гард позиции блока продолжений, всё остальное — фикстура и гарды блока целей.
  test('v4 не потерял ни одной строки v3 (включая протокол чипов)', () => {
    const v4lines = new Set(SYSTEM_PROMPT_V4.split('\n'));
    const lost = SYSTEM_PROMPT_V3.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !v4lines.has(line));
    expect(lost).toEqual([]);
  });

  // --- Новое в v4 -----------------------------------------------------------

  // Д1 пробы 2026-08-06: модель сочиняла `tag=`, грамматика отвечала «неизвестное
  // поле 'tag'», и цель приезжала без прогресса молча. Гард исполняемый, а не
  // toContain: ключ из шпаргалки прогоняется через НАСТОЯЩИЙ parseQuery.
  test('шпаргалка грамматики: ключ tags= назван и разбирается настоящей грамматикой', () => {
    expect(SYSTEM_PROMPT_V4).toContain('tags=');
    expect(SYSTEM_PROMPT_V4).toContain('excludeTags=');
    // единственное число названо как НЕсуществующее — иначе модель его и придумает
    expect(SYSTEM_PROMPT_V4).toMatch(/`tag=` грамматика не знает/);

    const catalog = buildFieldCatalog(
      BUILTIN_ASPECT_META.map((m) => ({ id: m.id, schema: aspectJsonSchema(m.id) })),
    );
    // Пример из самого промпта обязан разбираться — иначе промпт учит неверному
    const example = SYSTEM_PROMPT_V4.match(/«(aspect=orbis\/financial[^»]+)»/)?.[1];
    if (!example) throw new Error('в шпаргалке нет примера запроса с tags=');
    expect(parseQuery(example, catalog).ok).toBe(true);
    // и обратная сторона: единственное число действительно НЕ разбирается
    expect(parseQuery('aspect=orbis/note, tag=book', catalog).ok).toBe(false);
  });

  // Д2 пробы: модель передаёт аспект в entity_create и следом дублирует attach-вызов.
  test('одна сущность на намерение: дублирующий attach после entity_create запрещён', () => {
    expect(SYSTEM_PROMPT_V4).toMatch(/повторно attach-тулом НЕ навешивай/);
  });

  // --- Гарды, унаследованные от v3 -----------------------------------------

  // Промпт называет аспект по id — id обязан быть настоящим. Опечатка здесь стоила бы
  // отказа валидации на КАЖДОЙ цели, созданной моделью, и выглядела бы как каприз LLM.
  test('блок целей: названный аспект существует в реестре', () => {
    expect(SYSTEM_PROMPT_V4).toContain('Цели и горизонты:');
    const named = [...SYSTEM_PROMPT_V4.matchAll(/orbis\/goal/g)];
    expect(named.length).toBeGreaterThan(0);
    expect(BUILTIN_ASPECT_IDS).toContain('orbis/goal');
  });

  // Исполняемый гард, а не toContain: каждое значение aggregate, названное промптом,
  // прогоняется через НАСТОЯЩУЮ схему аспекта — вместе с тем набором ключей, который
  // эта ветка требует. Промпт, назвавший несуществующий агрегат, красит тест.
  test('блок целей: каждый aggregate из промпта принимает схема orbis/goal', () => {
    const block = goalsBlock();
    const named = [...block.matchAll(/\b(sum|count|latest)\b/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(['sum', 'count', 'latest']));
    for (const aggregate of new Set(named)) {
      const progress_source =
        aggregate === 'count'
          ? { query: 'aspect=orbis/task, status=done', aggregate }
          : { query: 'aspect=orbis/financial', aggregate, field: 'amount' };
      const parsed = goalAspectSchema.safeParse({ progress_source, target_value: '24' });
      expect(parsed.success).toBe(true);
    }
  });

  // Поля, названные в промпте, — настоящие ключи схемы. Гард ловит переименование
  // поля аспекта, сделанное без правки промпта.
  test('блок целей: названные поля есть в схеме аспекта', () => {
    const shape = Object.keys(goalAspectSchema.shape);
    for (const field of ['target_value', 'progress_source', 'current_value']) {
      expect(SYSTEM_PROMPT_V4).toContain(field);
      expect(shape).toContain(field);
    }
  });

  // Кэш пишет сервер (01-architecture §10, правило 3), и промпт обязан это запрещать,
  // а не умалчивать: заполненный моделью current_value разошёлся бы с графом молча.
  test('блок целей: current_value модель не заполняет', () => {
    expect(SYSTEM_PROMPT_V4).toMatch(/current_value НЕ заполняй/);
    expect(SYSTEM_PROMPT_V4).toMatch(/прогресс цели считает сервер/i);
  });

  // Р29: сидируются ДВА верхних горизонта («Год» и «Жизнь»), а день/неделю/месяц
  // закрывают Daily Planning и Upcoming — отдельных списков «День»/«Неделя»/«Месяц»
  // НЕ существует. Гард направлен так же, как риск: опасно НЕ то, что какой-то
  // сидированный список не назван (All Tasks — страховочный, к лестнице отношения не
  // имеет), а то, что промпт назвал список, которого сид не создаёт, — это выдуманная
  // ссылка в каждом ответе про планирование. Поэтому проверяется включение имён из
  // строки лестницы в сид, а не наоборот.
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
    // Носители лестницы названы все четыре — иначе «где у меня неделя» не отвечается
    for (const carrier of ['Daily Planning', 'Upcoming', 'Год', 'Жизнь']) {
      expect(named).toContain(carrier);
      expect(titles).toContain(carrier);
    }
    // И обратная сторона: то, что промпт объявил несуществующим, сид и не создаёт
    for (const absent of denied) expect(titles).not.toContain(absent);
    expect(ladder).toContain('«День», «Неделя» и «Месяц» не существует');
  });

  test('блок целей: сначала entity_query, потом предложение — без дублей', () => {
    expect(goalsBlock()).toContain('entity_query');
    expect(goalsBlock()).toMatch(/Не заводи дубли/);
  });

  // --- Гарды, унаследованные от v2 -----------------------------------------

  // D19: чипы приходят маркером в конце ответа, второго вызова LLM нет — формат в
  // промпте и парсер (ai/suggestions.ts) обязаны описывать ОДИН И ТОТ ЖЕ протокол.
  test('блок продолжений разговора (D19): пример маркера разбирается парсером', () => {
    expect(SYSTEM_PROMPT_V4).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V4.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.'); // маркер вырезан целиком
    expect(parsed.suggestions).toHaveLength(3); // «первое | второе | третье»
  });

  // Гард «блок продолжений идёт ПОСЛЕДНИМ» переехал отсюда на СОБРАННЫЙ канал
  // (llm/context.test.ts, §Б7-6-2): «последний в тексте промпта» модели ничего не
  // обещал — buildContext дописывал после промпта дату, инструкции аспектов, память и
  // якорь, и в бою пример «отдельной последней строкой» тонул в середине канала.
  // Здесь остаётся то, что про сам ТЕКСТ: блок ровно один (на однократность заголовка
  // опирается деление на PROMPT_BODY/CONTINUATIONS_BLOCK) и блок целей стоит перед ним.
  test('блок продолжений — ровно один в промпте, блок целей стоит перед ним', () => {
    expect(SYSTEM_PROMPT_V4.split('Продолжения разговора:')).toHaveLength(2);
    expect(SYSTEM_PROMPT_V4.indexOf('Цели и горизонты:')).toBeLessThan(
      SYSTEM_PROMPT_V4.indexOf('Продолжения разговора:'),
    );
  });

  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V4).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V4).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V4).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V4).toMatch(/нечем — строку не добавляй/);
  });

  test('соглашение meta-ключей §3.9 — дословно из PRD', () => {
    expect(SYSTEM_PROMPT_V4).toContain(
      '**имена ключей в `meta` обязаны совпадать с именами полей аспектов**',
    );
    expect(SYSTEM_PROMPT_V4).toContain('meta: {amount: "500.00", direction: "expense"}');
    expect(SYSTEM_PROMPT_V4).toContain('механической операцией, а не угадыванием');
  });

  test('правила поведения: тулы, decimal-деньги, category_ref, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V4).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V4).toContain('category_ref');
    expect(SYSTEM_PROMPT_V4).toContain('entity_query');
    expect(SYSTEM_PROMPT_V4).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V4).toContain(TOOL_RESULT_MARKER);
  });

  test('блок Budget: budget_status для финансовых вопросов, запрет двойного вычета recurring (03-budget §4.3)', () => {
    expect(SYSTEM_PROMPT_V4).toContain('budget_status');
    expect(SYSTEM_PROMPT_V4).toContain('НЕ суммируй recurring отдельно');
    expect(SYSTEM_PROMPT_V4).toContain('двойной вычет');
    expect(SYSTEM_PROMPT_V4).toContain('spend_class');
  });

  test('future_outflows — только direction=expense, доходные инстансы не вычитаются (§4.3)', () => {
    expect(SYSTEM_PROMPT_V4).toContain('только direction=expense');
    expect(SYSTEM_PROMPT_V4).toMatch(/доходные инстансы[^.\n]*не вычитай/i);
  });

  test('одна сущность на намерение: аспекты на ТУ ЖЕ сущность, сумма — в orbis/financial (00-product §7)', () => {
    expect(SYSTEM_PROMPT_V4).toContain('Одна сущность на намерение');
    expect(SYSTEM_PROMPT_V4).toMatch(/не создавай втор|а НЕ втор/i);
    expect(SYSTEM_PROMPT_V4).toContain('attach_');
    expect(SYSTEM_PROMPT_V4).toContain('orbis/schedule');
    expect(SYSTEM_PROMPT_V4).toMatch(/сумма[^.\n]*orbis\/financial[^.\n]*не в `meta`/i);
  });

  test('шпаргалка грамматики §6 — модель видит синтаксис entity_query', () => {
    expect(SYSTEM_PROMPT_V4).toContain('status=!done&!cancelled'); // NOT-синтаксис
    expect(SYSTEM_PROMPT_V4).toContain('today | overdue | next_7d | after_7d'); // date-токены
    expect(SYSTEM_PROMPT_V4).toContain('children_of='); // дети сущности
    expect(SYSTEM_PROMPT_V4).toContain('sortBy='); // сортировка
    expect(SYSTEM_PROMPT_V4).toContain('status=planned|in_progress'); // OR внутри значения
  });
});

/**
 * Текст блока «Цели и горизонты» без соседей: гарды блока не должны ловить слова из
 * остального промпта. Для v4 это не формальность — обе новые строки лежат ВЫШЕ блока
 * целей (шпаргалка грамматики и «одна сущность на намерение»), и без отсечения соседей
 * пример «tags=savings» попал бы под грепы этого блока.
 */
function goalsBlock(): string {
  const from = SYSTEM_PROMPT_V4.indexOf('Цели и горизонты:');
  const to = SYSTEM_PROMPT_V4.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока целей перед продолжениями');
  return SYSTEM_PROMPT_V4.slice(from, to);
}
