// apps/server/src/executor/aspects-validate.ts
// Стадия 2 конвейера (§9.2) после реформы: валидация записи ПО РЕЕСТРУ СВОЙСТВ (§А7-1) —
// каждое свойство по своему типу, каждый аспект сущности по своим обязательным, неизвестных
// id в `props` нет.
//
// Файл остался на месте, а его содержимое сменилось целиком, и это не косметика: раньше он
// компилировал ajv по колонке `aspect_definitions.schema` (одна схема на аспект, поля внутри
// неё), теперь зовёт `validateEntityProps` — валидатор реестра, у которого схема есть у
// КАЖДОГО свойства отдельно (`registry/validate-props.ts`, Задача 2). Кеш скомпилированных
// валидаторов при этом сохранился (§А7-1) — он переехал туда же, к схемам, и ключуется
// текстом схемы: одинаковые типы делят один валидатор.
//
// Почему тонкая обёртка, а не вызов валидатора напрямую из executor.ts: валидатор возвращает
// СПИСОК нарушений (владелец правит форму целиком, и отказ по одному полю за раз превращает
// одну правку в пять заходов), а конвейер оперирует бросками ExecError. Перевод одного в
// другое обязан быть один на все три точки записи — create, update, attach.
import { type MemoryRuleViolation, ruleViolations } from '../memory/rules';
import type { RegistrySnapshot } from '../registry/load';
import { type PropsViolation, validateEntityProps } from '../registry/validate-props';
import { ExecError } from './errors';
import type { EntityState } from './props';

/**
 * Стадия 2: состояние сущности ПОСЛЕ слияния обязано проходить реестр.
 *
 * Проверяется всё состояние, а не только затронутая патчем часть, — так требует §А7-1
 * («композиционная над результатом слияния»), и это не педантизм: свойства слиты (В1),
 * поэтому правка через один аспект меняет обязательность у другого, а патч, снявший
 * `orbis/amount`, ломает не тот аспект, через который пришёл.
 *
 * ИСКЛЮЧЕНИЕ ровно одно и названо здесь, а не спрятано в валидаторе: `touched` — свойства,
 * ЗАТРОНУТЫЕ патчем, и по ним считается только `DEPRECATED`. Это единственный код, который
 * высказывается об АКТЕ ЗАПИСИ («заново не пиши»), а не о свойстве итогового состояния;
 * шесть остальных композиционны и обязаны идти по всему состоянию. Не передать `touched`
 * — законно (значит «затронуто всё»), и путь сида/тестов так и делает.
 *
 * `details.violations` — весь список; `details.aspect`/`details.property` не заводятся:
 * потребители кодов (карточка отказа, глаголы) читают структуру, а не разбирают текст.
 */
export function assertEntityProps(
  reg: RegistrySnapshot,
  state: EntityState,
  touched?: ReadonlySet<string>,
): void {
  // Форма правила памяти (§А8 «fail-closed», В7) проверяется ВТОРЫМ списком, а не внутри
  // валидатора реестра: обязательность там безусловная (пара «аспект → свойство»), а здесь
  // она условная — «если род записи правило». Граница названа в `memory/rules.ts`
  // (`ruleViolations`): условные ограничения выражает `requires_when` части Б.
  const violations: Array<PropsViolation | MemoryRuleViolation> = [
    ...validateEntityProps(reg, state, touched),
    ...ruleViolations(state),
  ];
  if (violations.length === 0) return;
  const first = violations[0];
  throw new ExecError('VALIDATION', `запись не проходит реестр свойств: ${describe(first)}`, {
    violations,
  });
}

function describe(violation: PropsViolation | MemoryRuleViolation | undefined): string {
  if (violation === undefined) return 'нарушение не названо'; // недостижимо: список непуст
  switch (violation.code) {
    case 'UNKNOWN_PROPERTY':
      return `неизвестное свойство «${violation.propertyId}»`;
    case 'UNKNOWN_ASPECT':
      return `неизвестный аспект «${violation.aspectId}»`;
    case 'DEPRECATED':
      return `свойство «${violation.propertyId}» выведено из обращения`;
    case 'REQUIRED':
      return `аспект «${violation.aspectId}» требует свойство «${violation.propertyId}»`;
    case 'TYPE':
      return `значение «${violation.propertyId}»: ${violation.message}`;
    case 'VALUE_TOO_DEEP':
      return (
        `значение «${violation.propertyId}» вложено глубже ${violation.cap} уровней — ` +
        'столько не нужно ни одному осмысленному значению'
      );
    case 'CORE_IN_PROPS':
      // Отказ НАЗЫВАЕТ ВЫХОД: у core-проекции есть законный путь записи, и он один — то же
      // имя в своём поле вызова (`title`/`archived` у `entity_create`/`entity_update`),
      // а `created_at`/`updated_at` ставит сервер. Без этой половины отказ отправлял бы
      // модель искать другой способ положить значение туда же.
      return (
        `свойство «${violation.propertyId}» хранится колонкой записи (storage: ` +
        `${violation.storage}) — в props его значению места нет: пишите его своим полем ` +
        'вызова (title, archived), время записи ставит сервер'
      );
    // Оба отказа НАЗЫВАЮТ ВЫХОД (иначе автор записи уйдёт искать обходной путь): у правила
    // памяти машиночитаемая часть живёт в свойствах, и класть её в заголовок больше некуда
    // — заголовок стал генерируемой подписью, которую никто не разбирает.
    case 'RULE_WITHOUT_PATTERN':
      return (
        'запись памяти рода «rule» без свойства «orbis/rule_pattern» не совпала бы ни с ' +
        'чем: положите образец в orbis/rule_pattern (заголовок правила больше не ' +
        'разбирается) — либо запишите это фактом, orbis/memory_kind: fact'
      );
    case 'RULE_WITHOUT_TARGET':
      return (
        `правило области «${violation.scope}» без свойства «orbis/rule_target» нечего ` +
        'подставить: положите ссылку на категорию в orbis/rule_target — либо снимите ' +
        'orbis/rule_scope, и правило станет глобальным (его читает только память промпта)'
      );
  }
}
