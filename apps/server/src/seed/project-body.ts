// apps/server/src/seed/project-body.ts
// Заготовка тела проекта (С10). Живёт рядом с остальными сидами тел (smart-lists.ts),
// но засевается не онбордингом, а executor'ом — см. needsProjectSeed в normalize.ts.

/**
 * Заготовка тела проекта (С10): проза процесса + живые query-блоки. Засевается executor'ом,
 * когда на сущность приходит orbis/project при пустом теле — путь один для чата, MCP и UI.
 * `children_of=this` достаёт тикеты; прогоны — внуки (проект → тикет → прогон), `this` их не
 * достаёт, поэтому на прогоне есть project_id, а сюда подставляется реальный uuid проекта.
 *
 * Шаблон КАНОНИЧЕН (проверено project-body.test.ts): executor кладёт в тело результат
 * canonicalizeBody, и любое расхождение сдвигало бы заготовку на первом же сохранении.
 * Отсюда, в частности, отсутствие завершающего перевода строки: канон его снимает.
 */
export function projectBodyTemplate(projectId: string): string {
  return [
    '## Процесс',
    '',
    'Опишите, как исполнитель работает над тикетами проекта: стадии, где остановиться и спросить (чекпойнт), что считать готовым. Исполнитель читает этот раздел при захвате тикета (orbis_claim_task).',
    '',
    '## В работе',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=in_progress, sortBy=updated_at:desc, display=list, title=В работе}}',
    '',
    '## Ждут меня',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=waiting, sortBy=updated_at:asc, display=list, title=Ждут меня}}',
    '',
    '## Бэклог',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=inbox|planned, sortBy=priority:desc|created_at:asc, display=list, title=Бэклог}}',
    '',
    '## Последние прогоны',
    '',
    `{{query: aspect=orbis/agent-run, project_id=${projectId}, sortBy=created_at:desc, limit=10, display=compact, title=Последние прогоны}}`,
  ].join('\n');
}
