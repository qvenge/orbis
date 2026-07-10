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
};

export function aspectLabel(id: string): string {
  return ASPECT_LABELS[id] ?? id;
}
