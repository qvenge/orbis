export * from './aspect-registry';
export * from './constants';
export * from './contracts/agent-loop';
export * from './contracts/budget';
export * from './contracts/import';
export * from './contracts/tools';
// date.ts — почти весь внутренний модуль (fromParts/partsFromEpochDays/…); наружу выходит
// сдвиг даты (у сервера была своя копия в recurring/materialize.ts, третьей копии быть не
// должно) и календарь рутин: планировщик V1 считает по нему «сегодня подходит по дням» и
// «наступил ли слот» — своей копии алфавита и своего парсера 'ЧЧ:ММ' у него быть не должно.
export {
  addDays,
  epochDays,
  HHMM_RE,
  hasValidCalendar,
  mondayIndex,
  parseHHMM,
  toParts,
  WEEKDAY_INDEX,
  WEEKDAYS,
  type Weekday,
  weekdayOfDate,
} from './date';
export * from './fast-path';
export * from './ids';
export * from './import/normalize';
export * from './memory/rule';
export * from './nav/links';
// Старая грамматика §6.1 живёт в корневом барреле до Задачи 21 (РП-11): её `QueryAst`
// прямо сейчас держат серверный компилятор, материализация и конструктор запросов в web.
// КАНОН Q-AST (§А5-7) заведён Задачей 8 РЯДОМ и выходит отдельным входом
// `@orbis/shared/query`: имена `QueryAst`, `QueryDateToken`, `QuerySortField` и
// `QueryDisplayMode` в этом барреле уже заняты, а два `export *` с общим именем — не
// «последний побеждает», а ошибка типизации TS2308. Задача 9b переключает потребителей,
// Задача 21 сносит старую грамматику, и канон переезжает сюда под теми же именами.
export * from './query/grammar';
export * from './query/parse';
export * from './query/serialize';
export * from './recurrence';
export * from './registry';
export * from './schemas/aspects';
export * from './schemas/entity';
export * from './schemas/relation';
