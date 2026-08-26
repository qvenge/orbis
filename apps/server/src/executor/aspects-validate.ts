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
import type { RegistrySnapshot } from '../registry/load';
import { validateEntityProps } from '../registry/validate-props';
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
 * `details.violations` — весь список; `details.aspect`/`details.property` не заводятся:
 * потребители кодов (карточка отказа, глаголы) читают структуру, а не разбирают текст.
 */
export function assertEntityProps(reg: RegistrySnapshot, state: EntityState): void {
  const violations = validateEntityProps(reg, state);
  if (violations.length === 0) return;
  const first = violations[0];
  throw new ExecError('VALIDATION', `запись не проходит реестр свойств: ${describe(first)}`, {
    violations,
  });
}

function describe(violation: ReturnType<typeof validateEntityProps>[number] | undefined): string {
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
  }
}
