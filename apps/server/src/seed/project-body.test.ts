// Заготовка тела проекта (С10): проверяется БЕЗ базы — шаблон это чистая строка, и обе
// его обязанности (каноничность и разбираемость блоков) выражаются на shared-схемах.
import { describe, expect, test } from 'bun:test';
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  newId,
  parseQuery,
} from '@orbis/shared';
import { canonicalizeBody } from '@orbis/shared/doc';
import { projectBodyTemplate } from './project-body';

// Каталог грамматики — из схем реестра shared, а не из БД: `project_id` и `stage`
// объявлены там же, где аспекты, и тесту шаблона база не нужна.
const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);

/** Тела query-блоков шаблона: `parseBlock` живёт только в web, здесь снимаем сами. */
function queryBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/\{\{query:([\s\S]*?)\}\}/g)].map((m) => m[1] ?? '');
}

describe('projectBodyTemplate', () => {
  const projectId = newId();
  const body = projectBodyTemplate(projectId);

  test('шаблон каноничен: повторная канонизация не меняет ни байта', () => {
    // Иначе первое же сохранение сдвинуло бы тело, и «пустое тело» перестало бы отличаться
    // от «заготовки, которую никто не трогал».
    expect(canonicalizeBody(body).body).toBe(body);
  });

  test('все query-блоки разбираются грамматикой §6.1', () => {
    const blocks = queryBlocks(body);
    expect(blocks.length).toBe(4);
    for (const block of blocks) {
      const parsed = parseQuery(block, catalog);
      expect(parsed.ok ? true : parsed).toBe(true); // при провале в отчёт едет причина
    }
  });

  test('прогоны достаются по project_id, тикеты — по children_of=this', () => {
    // Прогон — внук проекта (проект → тикет → прогон), `this` его не достаёт: поэтому в
    // блок прогонов подставляется реальный uuid, а не `this`.
    expect(body).toContain(`{{query: aspect=orbis/agent-run, project_id=${projectId}`);
    expect(body).toContain('children_of=this, aspect=orbis/task, status=waiting');
    expect(body).not.toContain('children_of=this, aspect=orbis/agent-run');
  });
});
