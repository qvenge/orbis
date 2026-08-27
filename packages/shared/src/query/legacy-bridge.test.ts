// packages/shared/src/query/legacy-bridge.test.ts
// Переходный мост «старая грамматика §6.1 → канон §А5-7» (Задача 9b, умирает в Задаче 21).
//
// Что здесь доказывается и почему именно это: с Задачи 9b сервер разбирает текст ТОЛЬКО
// каноном, а боевые тексты (тела смарт-листов, Agenda, конструкторы web) написаны старой
// формой. Значит проверять надо не «мост что-то вернул», а РАВЕНСТВО ДЕРЕВЬЕВ: текст старой
// формы и его канонический двойник обязаны давать один и тот же Q-AST, иначе выдача
// владельцу поменяется молча.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '../registry';
import { legacyCatalogFromRegistry, parseQueryAny, resolveLegacyFieldId } from './legacy-bridge';
import { type ParseRegistry, parseQueryAst, toParseRegistry } from './parse-ast';

const REG: ParseRegistry = toParseRegistry(
  {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  },
  'ru',
);

const anyAst = (text: string) => {
  const r = parseQueryAny(text, REG);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.ast;
};

const freshAst = (text: string) => {
  const r = parseQueryAst(text, REG);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.ast;
};

describe('parseQueryAny: обе формы текста дают ОДНО дерево', () => {
  test('голое имя core-свойства (UNKNOWN_FIELD у канона) — то же дерево, что namespaced key', () => {
    // Именно этот текст стоит в теле сидированного «Daily Planning» и в шаге 4 e2e.
    expect(anyAst('status=inbox')).toEqual(freshAst('orbis/task_status=inbox'));
  });

  test('незакавыченное значение с пробелом (SYNTAX у канона) — параметр заголовка целиком', () => {
    expect(anyAst('aspect=orbis/routine, title=Активные рутины')).toEqual({
      ...freshAst('aspect=orbis/routine'),
      title: 'Активные рутины',
    });
  });

  test('слово грамматики в старом имени (RESERVED у канона) — sortBy=title:asc резолвится в core-свойство', () => {
    // Оба боевых текста с вердиктом RESERVED — это CATEGORIES_QUERY бюджета (7 потребителей).
    expect(anyAst('aspect=orbis/category, sortBy=title:asc, limit=200')).toEqual(
      freshAst('aspect=orbis/category, sortBy=orbis/title:asc, limit=200'),
    );
  });

  test('значение булева свойства приезжает булевым, а не строкой (иначе гейт типа отвергнет дерево)', () => {
    expect(anyAst('aspect=orbis/agent-run, undecided=true')).toEqual(
      freshAst('aspect=orbis/agent-run, orbis/undecided=true'),
    );
  });

  test('списочное свойство: старое `aliases=такси` даёт вхождение элемента, а не равенство', () => {
    expect(anyAst('aspect=orbis/category, aliases=такси')).toEqual(
      freshAst('aspect=orbis/category, orbis/aliases=такси'),
    );
  });

  test('`&`-форма и excludeTags переводятся отрицанием над деревом', () => {
    expect(anyAst('status=!done&!cancelled')).toEqual(
      freshAst('orbis/task_status=!done&!cancelled'),
    );
    expect(anyAst('excludeTags=дом|дача')).toEqual(freshAst('excludeTags=дом|дача'));
  });

  test('excludeBlocked=true собирается ТЕМ ЖЕ сахаром, что у канона', () => {
    expect(anyAst('status=inbox, excludeBlocked=true')).toEqual(
      freshAst('orbis/task_status=inbox, excludeBlocked=true'),
    );
  });

  test('date-токены и диапазон дат сохраняют форму канона', () => {
    expect(anyAst('due_date=today|overdue')).toEqual(freshAst('orbis/due_date=today|overdue'));
    expect(anyAst('occurred_on=2026-06-01..2026-06-30')).toEqual(
      freshAst('orbis/occurred_on=2026-06-01..2026-06-30'),
    );
    expect(anyAst('amount>1000')).toEqual(freshAst('orbis/amount>1000'));
  });

  test('search и children_of переводятся узлами канона; search приезжает последним', () => {
    expect(anyAst('children_of=this, status=inbox, search=Еда')).toEqual(
      freshAst('children_of=this, orbis/task_status=inbox, search=Еда'),
    );
  });

  test('неоднозначное старое имя разводится aspect= — как и в старом резолве', () => {
    expect(anyAst('aspect=orbis/routine, stage=active')).toEqual(
      freshAst('aspect=orbis/routine, orbis/routine_stage=active'),
    );
    expect(anyAst('aspect=orbis/project, stage=active')).toEqual(
      freshAst('aspect=orbis/project, orbis/project_stage=active'),
    );
  });

  test('текст, который канон разбирает сам, мостом НЕ трогается', () => {
    expect(anyAst('tags=category, search=Еда')).toEqual(freshAst('tags=category, search=Еда'));
  });
});

describe('parseQueryAny: отказ наружу — всегда от НОВОЙ грамматики', () => {
  test('поле, удалённое §А8 (agent-run.project_id), — UNKNOWN_FIELD канона, а не отказ старого парсера', () => {
    const r = parseQueryAny('aspect=orbis/agent-run, project_id=x', REG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNKNOWN_FIELD');
    // Текст отказа обязан учить НОВОЙ адресации: старый парсер сказал бы «неизвестное поле».
    expect(r.error.message).toContain('namespaced key');
  });

  test('код вне списка «текст старой формы» мост не зовёт: class= остаётся CLASS_NOT_AVAILABLE', () => {
    const r = parseQueryAny('class=orbis/completable:done', REG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CLASS_NOT_AVAILABLE');
  });

  test('непереводимое значение (булево свойство со строкой) — отказ канона, а не кривое дерево', () => {
    const r = parseQueryAny('aspect=orbis/agent-run, undecided=ага', REG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('UNKNOWN_FIELD');
  });
});

describe('legacyCatalogFromRegistry / resolveLegacyFieldId', () => {
  test('каталог собран из реестра: удалённого §А8 поля в нём нет, слитое имя несут оба аспекта', () => {
    const catalog = legacyCatalogFromRegistry(REG);
    expect(catalog.fields.project_id).toBeUndefined();
    expect(catalog.fields.status?.map((i) => i.aspect)).toEqual(['orbis/task']);
    expect(catalog.fields.category_ref?.map((i) => i.aspect).sort()).toEqual([
      'orbis/budget',
      'orbis/financial',
    ]);
    // Тип и варианты приходят из реестра, а не из паттерна JSON Schema (§А2-2).
    expect(catalog.fields.aliases?.[0]?.type).toBe('array');
    expect(catalog.fields.status?.[0]?.enumValues).toContain('inbox');
  });

  test('имя поля агрегата: старое, key и id ведут в одно свойство; слитое — без aspect=', () => {
    expect(resolveLegacyFieldId('amount', REG)).toBe('orbis/amount');
    expect(resolveLegacyFieldId('orbis/amount', REG)).toBe('orbis/amount');
    // `category_ref` носят два аспекта, но свойство одно (§А8/В1) — имя однозначно.
    expect(resolveLegacyFieldId('category_ref', REG)).toBe('orbis/finance_category');
    // `stage` — два РАЗНЫХ свойства: без аспекта резолва нет.
    expect(resolveLegacyFieldId('stage', REG)).toBeUndefined();
    expect(resolveLegacyFieldId('stage', REG, new Set(['orbis/routine']))).toBe(
      'orbis/routine_stage',
    );
    expect(resolveLegacyFieldId('project_id', REG)).toBeUndefined();
  });
});
