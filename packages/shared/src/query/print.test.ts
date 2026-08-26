/**
 * Печать канонического Q-AST (§А5-2: «два рендера одного AST — key для машин, label
 * для человека»). Key-форма каноническая: по ней меряет дифф Ш1, и она обязана быть
 * обратимой — `parse(print(a)) ≡ a` доказывается прогоном, а не обещанием.
 */
import { expect, test } from 'bun:test';
import { AGENDA_QUERY_TEXTS, AST_FIXTURES, FIXTURE_PARSE_REGISTRY } from './ast-fixtures';
import { parseQueryAst } from './parse-ast';
import { printQueryAst } from './print';

const REG = FIXTURE_PARSE_REGISTRY;

test('key-форма обратима на всех текстовых фикстурах: print → parse → тот же AST', () => {
  const textual = AST_FIXTURES.filter((f) => f.keyText !== null);
  expect(textual.length).toBeGreaterThanOrEqual(10);
  for (const fixture of textual) {
    const printed = printQueryAst(fixture.ast, REG, 'key');
    expect(printed, fixture.name).toBe(fixture.keyText as string);
    const back = parseQueryAst(printed, REG);
    expect(back.ok, `${fixture.name}: ${back.ok ? '' : back.error.message}`).toBe(true);
    if (back.ok) expect(back.ast, fixture.name).toEqual(fixture.ast);
  }
});

test('AGENDA_QUERY_TEXTS (три key-формы) разбираются и печатаются обратимо', () => {
  const texts = Object.values(AGENDA_QUERY_TEXTS);
  expect(texts.length).toBe(3);
  for (const text of texts) {
    const r = parseQueryAst(text, REG);
    expect(r.ok, `${text}: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (!r.ok) continue;
    expect(printQueryAst(r.ast, REG, 'key')).toBe(text);
  }
  // Три запроса Agenda сегодня склеиваются на клиенте; Задача 10c подставит эти тексты
  // в useAgenda.ts дословно, поэтому имена свойств здесь — key реестра, а не голые поля.
  expect(AGENDA_QUERY_TEXTS.days).toContain('orbis/start_at=today|next_7d');
  expect(AGENDA_QUERY_TEXTS.overdueDue).toContain('orbis/task_status=!done&!cancelled');
  expect(AGENDA_QUERY_TEXTS.overdueStart).toContain('aspect=orbis/task, aspect=orbis/schedule');
});

test('label-форма — подписи по локали, имена полей закавычены (§А5-3б)', () => {
  const ast = parseQueryAst('aspect=orbis/task orbis/due_date<=today limit=5', REG);
  expect(ast.ok).toBe(true);
  if (!ast.ok) return;
  expect(printQueryAst(ast.ast, REG, 'label')).toBe('aspect="Задача", "Срок"<=today, limit=5');
  // Обе печати — одного дерева: label-форма читается тем же парсером обратно.
  const back = parseQueryAst(printQueryAst(ast.ast, REG, 'label'), REG);
  expect(back.ok).toBe(true);
  if (back.ok) expect(back.ast).toEqual(ast.ast);
});

test('дерево, невыразимое плоской грамматикой v1, печатается скобками и не разбирается назад', () => {
  const ast = {
    filter: {
      or: [
        { prop: 'orbis/task_status', op: 'eq' as const, value: 'done' },
        { prop: 'orbis/priority', op: 'eq' as const, value: 'high' },
      ],
    },
  };
  const printed = printQueryAst(ast, REG, 'key');
  expect(printed).toBe('(orbis/task_status=done | orbis/priority=high)');
  // §А5-3д: скобок в грамматике v1 НЕТ — печать тотальна, разбор такой формы отказывает.
  const back = parseQueryAst(printed, REG);
  expect(back.ok).toBe(false);
  if (!back.ok) expect(back.error.code).toBe('SYNTAX');
});
