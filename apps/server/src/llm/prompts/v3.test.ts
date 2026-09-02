// apps/server/src/llm/prompts/v3.test.ts
// Snapshot-тест системного промпта v3 (слайс 3, фаза E, D22) — та же механика, что у
// v1 и v2: текст промпта версионированный артефакт, эталон — файл-фикстура
// v3.fixture.txt, фиксируемая ОСОЗНАННО. Отличие v3 от v2 ровно одно — блок
// «Цели и горизонты». Семантические гарды v2 перенесены целиком: новая версия не
// имеет права молча потерять нормативные куски слоя 1.

import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_ASPECT_IDS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import { assertEntityProps } from '../../executor/aspects-validate';
import type { RegistrySnapshot } from '../../registry/load';

/** Снимок «как после свежего пересева»: только встроенные строки реестра. */
const GOAL_REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((x) => [x.id, x])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  ownerVersion: 0,
  systemVersion: 1,
};

import { extractSuggestions, SUGGESTION_MAX_LEN, SUGGESTIONS_MAX } from '../../ai/suggestions';
import { SEED_SMART_LISTS } from '../../seed/smart-lists';
import { SYSTEM_PROMPT_V2 } from './v2';
import { SYSTEM_PROMPT_V3, SYSTEM_PROMPT_VERSION, TOOL_RESULT_MARKER } from './v3';

describe('SYSTEM_PROMPT_V3 (§7.1 слой 1)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./v3.fixture.txt', import.meta.url)).text();
    expect(SYSTEM_PROMPT_V3).toBe(fixture);
  });

  test('версия промпта — v3', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v3');
  });

  // Механический гард «новая версия ничего не потеряла»: перечисление кусков v2
  // руками ловит только то, о чём вспомнил автор гарда. Здесь — построчно весь v2.
  //
  // Сравнение — по ЦЕЛОЙ строке (Set), а не подстрокой. Разница не косметическая:
  // при `SYSTEM_PROMPT_V3.includes(line)` строку v2 можно было бы ослабить дописыванием
  // в её же хвост («…до 60 символов: … Впрочем, длина не важна — пиши как удобно.») —
  // подстрока осталась бы на месте, и гард промолчал бы. Проверено мутацией: с includes
  // такая правка давала 20 pass, с Set — красноту.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v3 ⊇ v2) и
  // судит только о наличии строк — перестановка блоков, потеря пустых строк между ними
  // и новый текст, противоречащий старому, для него невидимы. Порядок держит отдельный
  // гард позиции блока продолжений, всё остальное — фикстура и гарды блока целей.
  test('v3 не потерял ни одной строки v2 (включая протокол чипов)', () => {
    const v3lines = new Set(SYSTEM_PROMPT_V3.split('\n'));
    const lost = SYSTEM_PROMPT_V2.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !v3lines.has(line));
    expect(lost).toEqual([]);
  });

  // --- Новое в v3 -----------------------------------------------------------

  // Промпт называет аспект по id — id обязан быть настоящим. Опечатка здесь стоила бы
  // отказа валидации на КАЖДОЙ цели, созданной моделью, и выглядела бы как каприз LLM.
  test('блок целей: названный аспект существует в реестре', () => {
    expect(SYSTEM_PROMPT_V3).toContain('Цели и горизонты:');
    const named = [...SYSTEM_PROMPT_V3.matchAll(/orbis\/goal/g)];
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
      // Форму значения даёт РЕЕСТР свойств: `orbis/progress_source` объявлен аспектом
      // `orbis/goal`, и его json-схема — единственное описание этой формы (§А3-1).
      // Прежде здесь стояла zod-схема аспекта старой формы — второе описание тех же полей,
      // снятое «Пересевом мира».
      const progress_source =
        aggregate === 'count'
          ? { query: 'aspect=orbis/task, orbis/task_status=done', aggregate }
          : { query: 'aspect=orbis/financial', aggregate, field: 'orbis/amount' };
      expect(() =>
        assertEntityProps(GOAL_REG, {
          props: { 'orbis/progress_source': progress_source, 'orbis/target_value': '24' },
          aspects: ['orbis/goal'],
        }),
      ).not.toThrow();
    }
  });

  // Поля, названные в промпте, — настоящие ключи схемы. Гард ловит переименование
  // поля аспекта, сделанное без правки промпта.
  test('блок целей: названные поля есть в схеме аспекта', () => {
    // Свойства аспекта — по РЕЕСТРУ: локальная часть key совпадает с именем, которое
    // называет промпт. Гард ловит переименование свойства, сделанное без правки промпта.
    const declared = new Set(
      (BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/goal')?.properties ?? []).map((r) =>
        r.propertyId.split('/').at(-1),
      ),
    );
    for (const field of ['target_value', 'progress_source', 'current_value']) {
      expect(SYSTEM_PROMPT_V3).toContain(field);
      expect(declared).toContain(field);
    }
  });

  // Кэш пишет сервер (01-architecture §10, правило 3), и промпт обязан это запрещать,
  // а не умалчивать: заполненный моделью current_value разошёлся бы с графом молча.
  test('блок целей: current_value модель не заполняет', () => {
    expect(SYSTEM_PROMPT_V3).toMatch(/current_value НЕ заполняй/);
    expect(SYSTEM_PROMPT_V3).toMatch(/прогресс цели считает сервер/i);
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
    expect(SYSTEM_PROMPT_V3).toContain('Продолжения разговора:');
    const example = SYSTEM_PROMPT_V3.match(/\[\[suggest:[^\]\n]+\]\]/)?.[0];
    if (!example) throw new Error('в промпте нет примера маркера продолжений');
    const parsed = extractSuggestions(`Ответ модели.\n${example}`);
    expect(parsed.text).toBe('Ответ модели.'); // маркер вырезан целиком
    expect(parsed.suggestions).toHaveLength(3); // «первое | второе | третье»
  });

  // Блок продолжений обязан остаться ПОСЛЕДНИМ в тексте: его инструкция «в КОНЦЕ
  // ответа отдельной последней строкой» теряет силу примера, если после неё в промпте
  // идёт ещё что-то. Блок целей поэтому вставлен ПЕРЕД ним, а не дописан в хвост.
  test('блок продолжений — последний в промпте, блок целей стоит перед ним', () => {
    expect(SYSTEM_PROMPT_V3.indexOf('Цели и горизонты:')).toBeLessThan(
      SYSTEM_PROMPT_V3.indexOf('Продолжения разговора:'),
    );
    expect(SYSTEM_PROMPT_V3.trimEnd().endsWith('строку не добавляй вовсе.')).toBe(true);
  });

  test('блок продолжений: потолки промпта — те же числа, что в парсере', () => {
    expect(SYSTEM_PROMPT_V3).toContain(`2–${SUGGESTIONS_MAX} коротких продолжения`);
    expect(SYSTEM_PROMPT_V3).toContain(`до ${SUGGESTION_MAX_LEN} символов`);
  });

  test('блок продолжений: это реплики ПОЛЬЗОВАТЕЛЯ, а нечего предложить — строки нет', () => {
    expect(SYSTEM_PROMPT_V3).toContain('следующей реплики ПОЛЬЗОВАТЕЛЯ');
    expect(SYSTEM_PROMPT_V3).toMatch(/нечем — строку не добавляй/);
  });

  test('соглашение meta-ключей §3.9 — дословно из PRD', () => {
    expect(SYSTEM_PROMPT_V3).toContain(
      '**имена ключей в `meta` обязаны совпадать с именами полей аспектов**',
    );
    expect(SYSTEM_PROMPT_V3).toContain('meta: {amount: "500.00", direction: "expense"}');
    expect(SYSTEM_PROMPT_V3).toContain('механической операцией, а не угадыванием');
  });

  test('правила поведения: тулы, decimal-деньги, category_ref, запрет выдумывать id', () => {
    expect(SYSTEM_PROMPT_V3).toContain('decimal-строк');
    expect(SYSTEM_PROMPT_V3).toContain('category_ref');
    expect(SYSTEM_PROMPT_V3).toContain('entity_query');
    expect(SYSTEM_PROMPT_V3).toMatch(/не выдумывай/i);
  });

  test('протокол tool-результатов MVP описан и согласован с маркером (Task 9)', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(SYSTEM_PROMPT_V3).toContain(TOOL_RESULT_MARKER);
  });

  test('блок Budget: budget_status для финансовых вопросов, запрет двойного вычета recurring (03-budget §4.3)', () => {
    expect(SYSTEM_PROMPT_V3).toContain('budget_status');
    expect(SYSTEM_PROMPT_V3).toContain('НЕ суммируй recurring отдельно');
    expect(SYSTEM_PROMPT_V3).toContain('двойной вычет');
    expect(SYSTEM_PROMPT_V3).toContain('spend_class');
  });

  test('future_outflows — только direction=expense, доходные инстансы не вычитаются (§4.3)', () => {
    expect(SYSTEM_PROMPT_V3).toContain('только direction=expense');
    expect(SYSTEM_PROMPT_V3).toMatch(/доходные инстансы[^.\n]*не вычитай/i);
  });

  test('одна сущность на намерение: аспекты на ТУ ЖЕ сущность, сумма — в orbis/financial (00-product §7)', () => {
    expect(SYSTEM_PROMPT_V3).toContain('Одна сущность на намерение');
    expect(SYSTEM_PROMPT_V3).toMatch(/не создавай втор|а НЕ втор/i);
    expect(SYSTEM_PROMPT_V3).toContain('attach_');
    expect(SYSTEM_PROMPT_V3).toContain('orbis/schedule');
    expect(SYSTEM_PROMPT_V3).toMatch(/сумма[^.\n]*orbis\/financial[^.\n]*не в `meta`/i);
  });

  test('шпаргалка грамматики §6 — модель видит синтаксис entity_query', () => {
    expect(SYSTEM_PROMPT_V3).toContain('status=!done&!cancelled'); // NOT-синтаксис
    expect(SYSTEM_PROMPT_V3).toContain('today | overdue | next_7d | after_7d'); // date-токены
    expect(SYSTEM_PROMPT_V3).toContain('children_of='); // дети сущности
    expect(SYSTEM_PROMPT_V3).toContain('sortBy='); // сортировка
    expect(SYSTEM_PROMPT_V3).toContain('status=planned|in_progress'); // OR внутри значения
  });
});

/** Текст блока «Цели и горизонты» без соседей: гарды блока не должны ловить слова из v2. */
function goalsBlock(): string {
  const from = SYSTEM_PROMPT_V3.indexOf('Цели и горизонты:');
  const to = SYSTEM_PROMPT_V3.indexOf('Продолжения разговора:');
  if (from < 0 || to < from) throw new Error('в промпте нет блока целей перед продолжениями');
  return SYSTEM_PROMPT_V3.slice(from, to);
}
