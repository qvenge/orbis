// Русские подписи известных полей аспектов (карточки чата, свойства в Detail).
// Ключи вне словаря показываются как есть — честная деградация для кастомных аспектов.
const FIELD_LABELS: Record<string, string> = {
  status: 'статус',
  priority: 'приоритет',
  due_date: 'срок',
  amount: 'сумма',
  currency: 'валюта',
  category: 'категория',
  category_ref: 'категория',
  direction: 'тип',
  start_at: 'начало',
  end_at: 'конец',
  all_day: 'весь день',
  target_value: 'цель',
  current_value: 'сейчас',
  unit: 'единица',
  progress_source: 'источник прогресса',
  // Поля аспектов ADE-среза 1 (project/repo/assignment/agent-run): их показывают карточки
  // чата и свойства в Detail ровно тем же путём, что и остальные — без подписи приехал бы
  // сырой ключ схемы.
  stage: 'стадия',
  url: 'адрес',
  default_branch: 'ветка по умолчанию',
  executor: 'исполнитель',
  grant_id: 'доступ агента',
  assignee: 'кто',
  may_close: 'может закрывать',
  outcome: 'исход',
  started_at: 'начало',
  finished_at: 'конец',
  last_step_at: 'последний шаг',
  step_count: 'шагов',
  session_url: 'сессия',
  report: 'отчёт',
  project_id: 'проект',
  // Поля аспектов V1 (routine/agent-run): те же карточки и те же свойства в Detail —
  // без подписи владелец читал бы в них сырые ключи схемы.
  at: 'время',
  days: 'дни',
  mode: 'режим',
  allowed_tools: 'разрешённые инструменты',
  routine_id: 'рутина',
  bucket: 'бакет',
  attempt: 'попытка',
  fail_note: 'причина сбоя',
  proposal: 'предложение',
  // Поле САМОЙ ЗАПИСИ, а не аспекта (D42 Р0-7): в строках отложенного действия и в
  // расхождениях его предусловия `archived` приезжает БЕЗ аспекта — носителя у core-свойства
  // `orbis/archived` (§А1-3) нет, и подставлять ему выдуманный больше нечем (псевдо-аспект
  // `orbis/entity` снят Задачей 5). Без подписи владелец читал бы машинный ключ колонки.
  // Слово — то же, что у сервера (routines/constants.ts CORE_FIELD_LABELS): ленту и карточку
  // он читает подряд, и два разных слова про одно поле были бы двумя полями.
  archived: 'архив',
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

// Подписи агрегатов query_result (op приходит от сервера; неизвестный — как есть).
const AGGREGATE_LABELS: Record<string, string> = {
  sum: 'сумма',
  count: 'количество',
  avg: 'среднее',
  min: 'минимум',
  max: 'максимум',
};

export function aggregateLabel(op: string): string {
  return AGGREGATE_LABELS[op] ?? op;
}

// Человеческие имена встроенных аспектов (реестр хранит английские name).
const ASPECT_LABELS: Record<string, string> = {
  'orbis/task': 'Задача',
  'orbis/financial': 'Финансы',
  'orbis/schedule': 'Расписание',
  'orbis/category': 'Категория',
  'orbis/note': 'Заметка',
  // Форма-редактор query-блока показывает ВЕСЬ реестр списком выбора: без подписи
  // единственный неназванный аспект стоял бы в нём сырым 'orbis/budget'.
  'orbis/budget': 'Бюджет',
  // DetailScreen — единственный редактор памяти (D3b), так что подпись нужна: без неё
  // секция правила подписана сырым 'orbis/memory'.
  'orbis/memory': 'Память',
  // Форма query-блока и карточки аспектов показывают весь реестр: без подписи цель
  // стояла бы в списке сырым 'orbis/goal'.
  'orbis/goal': 'Цель',
  // Аспекты ADE-среза 1: тот же список выбора в форме query-блока и те же карточки —
  // без подписи стояли бы сырыми id.
  'orbis/project': 'Проект',
  'orbis/repo': 'Репозиторий',
  'orbis/assignment': 'Назначение',
  'orbis/agent-run': 'Прогон исполнителя',
  // Рутина (V1) — не служебная: она есть и в форме query-блока, и в карточках аспектов
  'orbis/routine': 'Рутина',
};

export function aspectLabel(id: string): string {
  return ASPECT_LABELS[id] ?? id;
}
