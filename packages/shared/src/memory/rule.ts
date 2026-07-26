// packages/shared/src/memory/rule.ts
// Детерминированный формат memory-правила (01-arch §7.8 «Эскалация в правило», §3.7).
// Правило — обычная сущность с аспектом orbis/memory {kind:'rule', scope:'orbis/financial'};
// ВСЯ машиночитаемая часть правила живёт в её TITLE. Схему аспекта orbis/memory
// НЕ расширяем (решение K19.4): новое поле аспекта требует пересева реестра аспектов
// на проде — ловушка релиза, на которой уже стояла фаза C.
//
// ПОЧЕМУ КАТЕГОРИЯ ХРАНИТСЯ ПО НАЗВАНИЮ, А НЕ ПО id — осознанный компромисс (K19.4):
// связь правила с категорией через relation или через поле аспекта потребовала бы либо
// второго запроса на клиенте при показе правила, либо смены схемы аспекта. Цена:
// переименование категории «отвязывает» правило (резолв по названию перестаёт находить
// категорию), два одноимённых конверта неразличимы. Потребитель правила (D4) резолвит
// категорию по названию — иного источника истины у правила нет.
//
// Модуль чистый TS: ни Drizzle/tRPC/Hono/React, ни платформенных API.
import { normalizeCounterparty } from '../import/normalize';

/** Разделитель заголовка правила — U+2192 RIGHTWARDS ARROW, с пробелами вокруг. */
const RULE_ARROW = '→';

/** Токен из одних (ASCII-)цифр: сумма/номер карты/номер точки — в паттерн не входит. */
const DIGITS_ONLY = /^\d+$/;

/**
 * Заголовок правила: «<паттерн> → <название категории>» (стрелка U+2192, пробелы вокруг).
 * Паттерн — нормализованный текст без числовых токенов (rulePatternFromTitle).
 */
export function formatRuleTitle(args: { pattern: string; categoryTitle: string }): string {
  return `${args.pattern.trim()} ${RULE_ARROW} ${args.categoryTitle.trim()}`;
}

/**
 * Разбор заголовка правила обратно. null, если формат не распознан (нет стрелки или
 * одна из сторон пуста). Разделитель — ПЕРВОЕ вхождение стрелки: стрелка внутри
 * названия категории («Еда → Кафе») разбор не ломает.
 */
export function parseRuleTitle(title: string): { pattern: string; categoryTitle: string } | null {
  const at = title.indexOf(RULE_ARROW);
  if (at === -1) return null;
  const pattern = title.slice(0, at).trim();
  const categoryTitle = title.slice(at + RULE_ARROW.length).trim();
  if (pattern === '' || categoryTitle === '') return null;
  return { pattern, categoryTitle };
}

/**
 * Паттерн из заголовка транзакции: normalizeCounterparty(title) минус токены из одних
 * цифр. «ЯНДЕКС.ТАКСИ 450» → «яндекс такси». Пустая строка, если ничего не осталось
 * («450», «SBOL 1234») — такой паттерн правилом быть не может, вызывающий обязан выйти.
 * Своей нормализации не заводим: и дедуп импорта (§3.4.1), и резолв правил (D4) обязаны
 * видеть одни и те же байты.
 */
export function rulePatternFromTitle(title: string): string {
  const normalized = normalizeCounterparty(title);
  if (normalized === '') return '';
  return normalized
    .split(' ')
    .filter((token) => !DIGITS_ONLY.test(token))
    .join(' ');
}
