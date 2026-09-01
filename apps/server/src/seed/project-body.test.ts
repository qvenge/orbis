// Заготовка тела проекта (С10): проверяется БЕЗ базы — шаблон это чистая строка, и обе
// его обязанности (каноничность и разбираемость блоков) выражаются на shared-схемах.
//
// Каноничность и key-форма пиннятся общим сторожем сидов (`seed-canon.test.ts`: заготовка
// входит в его перечень). Здесь остаётся то, что верно ТОЛЬКО про эту заготовку: чем
// достаются тикеты и чем — прогоны.
import { describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { parseQueryAst, printQueryAst } from '@orbis/shared/query';
import { FIXTURE_PARSE_REGISTRY } from '@orbis/shared/query/fixtures';
import { projectBodyTemplate } from './project-body';

/** Тела query-блоков шаблона: `parseBlock` живёт только в web, здесь снимаем сами. */
function queryBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/\{\{query:([\s\S]*?)\}\}/g)].map((m) => m[1] ?? '');
}

describe('projectBodyTemplate', () => {
  const projectId = newId();
  const body = projectBodyTemplate(projectId);

  test('все четыре query-блока разбираются СТРОГИМ разбором канона (§А5-3)', () => {
    const blocks = queryBlocks(body);
    expect(blocks.length).toBe(4);
    for (const block of blocks) {
      const parsed = parseQueryAst(block, FIXTURE_PARSE_REGISTRY);
      expect(parsed.ok ? true : parsed).toBe(true); // при провале в отчёт едет причина
      // …и печать разобранного равна исходному тексту: значит блок написан ровно тем, что
      // печатает канон, а не «чем-то, что разбор согласился принять».
      if (parsed.ok) expect(printQueryAst(parsed.ast, FIXTURE_PARSE_REGISTRY, 'key')).toBe(block);
    }
  });

  test('прогоны — по вычисляемому orbis/parent_project, тикеты — по children_of=<uuid>; слова `this` в шаблоне нет', () => {
    // Прогон — ВНУК проекта (проект → тикет → прогон), и `children_of=` его не достаёт:
    // связь спускается на один уровень. Достаёт вычисляемое `orbis/parent_project` (правило
    // `nearest_ancestor`), которое стоит на каждой сущности под проектом. Плоского
    // `project_id` больше нет вовсе: §А8 снял денормализацию, и блок на него отвечал
    // отказом `UNKNOWN_FIELD`, а не пустым списком.
    expect(body).toContain(`{{query:aspect=orbis/agent-run, orbis/parent_project=${projectId},`);
    expect(body).toContain(
      `children_of=${projectId}, aspect=orbis/task, orbis/task_status=waiting`,
    );
    expect(body).not.toContain('project_id');
    // `this` разрешается только в теле самого проекта, а блок читают и снаружи
    // (закреплённый список, Browser) — там он был бы ошибкой.
    expect(body).not.toContain('this');
  });
});
