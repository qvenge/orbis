// apps/server/src/seed/project-body.ts
// Заготовка тела проекта (С10). Живёт рядом с остальными сидами тел (smart-lists.ts),
// но засевается не онбордингом, а executor'ом — см. needsProjectSeed в normalize.ts.

/**
 * Заготовка тела проекта (С10): проза процесса + живые query-блоки. Засевается executor'ом,
 * когда на сущность приходит orbis/project при пустом теле — путь один для чата, MCP и UI.
 * Тикеты — дети проекта; прогоны — внуки (проект → тикет → прогон), поэтому их достаёт не
 * связь, а плоское поле project_id самого прогона.
 *
 * ВЕЗДЕ ПОДСТАВЛЕН UUID, а не `this`, — и это про место чтения, а не про грамматику. `this`
 * разрешается только из контекста сущности (compile.ts → entityRefId), то есть работает,
 * пока блок читают в теле САМОГО проекта. Но текст блока живёт дольше своего места: его
 * копируют в закреплённый список, открывают из Browser, показывают бейджем в боковой
 * панели, — и там контекст записи не передаётся намеренно (`this` означал бы «проект, из чьего
 * тела блок скопировали», а не «текущий экран»), блок отвечает структурной ошибкой. Проект
 * уже известен в момент засева, и заготовке незачем зависеть от того, откуда на неё смотрят.
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
    `{{query: children_of=${projectId}, aspect=orbis/task, status=in_progress, sortBy=updated_at:desc, display=list, title=В работе}}`,
    '',
    '## Ждут меня',
    '',
    `{{query: children_of=${projectId}, aspect=orbis/task, status=waiting, sortBy=updated_at:asc, display=list, title=Ждут меня}}`,
    '',
    '## Бэклог',
    '',
    `{{query: children_of=${projectId}, aspect=orbis/task, status=inbox|planned, sortBy=priority:desc|created_at:asc, display=list, title=Бэклог}}`,
    '',
    '## Последние прогоны',
    '',
    `{{query: aspect=orbis/agent-run, project_id=${projectId}, sortBy=created_at:desc, limit=10, display=compact, title=Последние прогоны}}`,
  ].join('\n');
}
