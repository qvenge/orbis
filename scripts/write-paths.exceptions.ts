// Исключения сторожей путей записи (спека скорости §10.3): поимённо, с причиной и тем, кто снимет. Счёт — ТОЧНЫЙ.
export type Rule = 'graph' | 'journal' | 'chat' | 'body-columns' | 'dynamic-table';
export interface WriteException {
  readonly count: number;
  readonly reason: string;
  readonly removedBy: string;
}

export const WRITE_PATH_EXCEPTIONS: Record<Rule, Record<string, WriteException>> = {
  graph: {
    'apps/server/src/db/migrate-speed-a.ts': {
      count: 1,
      reason:
        'прод-операция переноса журнала, РП-2: UPDATE entities засевает только действие текущего тела',
      removedBy:
        'после переноса на проде в задаче 24 — модуль операции и исключение снимаются (остаток плана А)',
    },
    'apps/server/src/seed/setup-graph.ts': {
      count: 1,
      reason:
        'сев графа (§10.3): строка настроек при заведении — до неё executor не прочтёт ни зоны, ни маски',
      removedBy:
        'разводка «аккаунт / граф» D44 — настройки аккаунта уходят в инфраструктуру со своим модулем (§10.1)',
    },
    'apps/server/src/db/seed-registries.ts': {
      count: 7,
      reason:
        'ops-скрипт сева реестров платформы (§10.3): системные строки (graph_id IS NULL) шести реестров и переподпись дельт — другой процесс, админ-DSN',
      removedBy: 'не снимается: сев платформы — не граф владельца',
    },
    'apps/server/src/db/reset-world.ts': {
      count: 2,
      reason:
        'ops-скрипт разрушающего пересева (§10.3): TRUNCATE registry_deltas, сброс версии реестра в user_settings',
      removedBy: 'не снимается: прод-операция, другой процесс',
    },
    'apps/server/src/db/migrate-1v.ts': {
      count: 2,
      reason:
        'прод-операция 1в, --drop-agenda-rows по слову владельца: строки владельца подписки Повестки и дельты на неё (ops-скрипт, другой процесс)',
      removedBy:
        'после прода 1в операция отслужила — модуль и исключение снимаются (остаток плана А)',
    },
  },
  journal: {
    'apps/server/src/journal/transfer.ts': {
      count: 3,
      reason:
        'прод-операция переноса журнала из сообщений в таблицу (РП-2): два INSERT действий и отмен и один INSERT бокового индекса до-плановых записей',
      removedBy:
        'после переноса на проде — модуль и исключение снимаются (остаток плана А, remainders-a.md)',
    },
  },
  chat: {
    'apps/server/src/db/migrate-speed-a.ts': {
      count: 1,
      reason:
        'прод-операция переноса журнала, РП-2: DELETE chat_messages удаляет только перенесённые сообщения второго прохода',
      removedBy:
        'после переноса на проде в задаче 24 — модуль операции и исключение снимаются (остаток плана А)',
    },
  },
  'body-columns': {
    'apps/server/src/db/migrate-speed-a.ts': {
      count: 1,
      reason:
        'прод-операция переноса журнала, РП-2: body_action_id заполняется только при совпадении текущего текста',
      removedBy:
        'после переноса на проде в задаче 24 — модуль операции и исключение снимаются (остаток плана А)',
    },
  },
  'dynamic-table': {
    'apps/server/src/db/reset-world.ts': {
      count: 2,
      reason:
        'TRUNCATE списка WORLD_TABLES и DELETE строк владельца по DEFINITION_TABLES — имена таблиц из констант файла',
      removedBy: 'не снимается: прод-операция',
    },
  },
};
