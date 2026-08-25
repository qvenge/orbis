/**
 * Встроенные роли рёбер v1 — решение §А4-3 спеки «Реформа свойств».
 *
 * Роль — единственная истина ребра: колонка `relations.role`, а прежняя колонка типа уходит
 * (Ч10-С1). Пять сегодняшних смыслов `parent` расщеплены поимённо (inv §1 п.8): «часть
 * внутри целого», «тикет проекта», «прогон исполнителя», «транзакция в конверте», «дерево
 * категорий» — раньше их различали по аспектам концов, то есть догадкой.
 *
 * Ограничения в срезе А ЛЕЖАТ, а не работают: `target_max_incoming` включает Задача 7a
 * (это переезд доменного инварианта «один budget-parent» из кода в реестр — единственный
 * инвариант, переезжающий уже в части А), `acyclic` для `category-parent` — НОВОЕ поведение
 * (сегодня циклы не запрещены, есть только visited-set в `aggregates.ts:213-223`),
 * `source_contract`/`target_contract` — часть Б, контрактов ещё нет.
 *
 * `rank` — позиция в `RELATION_ROLE_IDS`, см. шапку `builtin-properties.ts`.
 */
import type { z } from 'zod';
import { HIERARCHICAL_ROLE_IDS, RELATION_ROLE_IDS, type RelationRoleId } from '../constants';
import { type RelationRoleDefinition, relationRoleDefinitionSchema } from './property-type';

type RoleEntry = Omit<
  z.input<typeof relationRoleDefinitionSchema>,
  'id' | 'ownerId' | 'key' | 'rank' | 'hierarchical'
> & { id: RelationRoleId };

const HIERARCHICAL = new Set<string>(HIERARCHICAL_ROLE_IDS);

const ENTRIES: readonly RoleEntry[] = [
  {
    id: 'subitem',
    label: { ru: 'Подпункт', en: 'Subitem' },
    description: {
      ru: 'Обычная иерархия: часть внутри целого — дефолт для «сделай список дел»',
      en: 'Ordinary hierarchy: a part inside a whole — the default parent relation',
    },
    sourceLabel: { ru: 'Родитель', en: 'Parent' },
    targetLabel: { ru: 'Подпункт', en: 'Subitem' },
    constraints: { created_by: 'any' },
    module: null, // роль ядра (§Б1-2): доступна всем сразу
  },
  {
    id: 'ticket',
    label: { ru: 'Тикет', en: 'Ticket' },
    description: {
      ru: 'Единица работы проекта: то, что исполнитель берёт в прогон',
      en: 'A unit of project work: what the executor picks up for a run',
    },
    sourceLabel: { ru: 'Проект', en: 'Project' },
    targetLabel: { ru: 'Тикет', en: 'Ticket' },
    // §А4-3: цель — завершаемость. `source_contract` не ставится: «проект» контрактом v1
    // не выражается (§Б1-2 — восемь контрактов, проекта среди них нет), а придумывать
    // девятый ради одной роли значит заводить понятие без потребителя.
    constraints: { target_contract: 'orbis/completable', created_by: 'any' },
    module: 'ade',
  },
  {
    id: 'run',
    label: { ru: 'Прогон', en: 'Run' },
    description: {
      ru: 'Прогон исполнителя, порождённый тикетом или рутиной',
      en: 'An executor run spawned by a ticket or a routine',
    },
    sourceLabel: { ru: 'Субъект прогона', en: 'Run subject' },
    targetLabel: { ru: 'Прогон', en: 'Run' },
    constraints: { created_by: 'system' },
    module: null, // ядро-исполнитель, не модуль ADE (§Б8-2)
  },
  {
    id: 'envelope-binding',
    label: { ru: 'Привязка к конверту', en: 'Envelope binding' },
    description: {
      ru: 'Транзакция, которую считает конверт бюджета',
      en: 'A transaction counted by a budget envelope',
    },
    sourceLabel: { ru: 'Конверт', en: 'Envelope' },
    targetLabel: { ru: 'Транзакция', en: 'Transaction' },
    // Замена доменного инварианта «один budget-parent» (01 §4.2/§13-7) декларацией.
    constraints: { target_max_incoming: 1, created_by: 'system' },
    module: 'finance',
  },
  {
    id: 'category-parent',
    label: { ru: 'Родительская категория', en: 'Category parent' },
    description: {
      ru: 'Дерево категорий финансов: подкатегория внутри категории',
      en: 'The finance category tree: a subcategory inside a category',
    },
    sourceLabel: { ru: 'Родительская категория', en: 'Parent category' },
    targetLabel: { ru: 'Подкатегория', en: 'Subcategory' },
    constraints: { acyclic: true, created_by: 'any' },
    module: 'finance',
  },
  {
    id: 'dependency',
    label: { ru: 'Зависимость', en: 'Dependency' },
    description: {
      ru: 'Работа не начнётся, пока не сделана другая',
      en: 'Work will not start until another one is done',
    },
    sourceLabel: { ru: 'Блокирующая работа', en: 'Blocking work' },
    targetLabel: { ru: 'Заблокированная работа', en: 'Blocked work' },
    // Цикл выражается декларацией: `source ∈ descendants_of(target) via role` (паспорт C).
    constraints: { acyclic: true, created_by: 'any' },
    module: null, // роль ядра (§Б1-2)
  },
  {
    id: 'mention',
    label: { ru: 'Упоминание', en: 'Mention' },
    description: {
      ru: 'Запись упоминает другую по смыслу, без подчинения',
      en: 'A record mentions another by meaning, without subordination',
    },
    sourceLabel: { ru: 'Упоминает', en: 'Mentions' },
    targetLabel: { ru: 'Упомянуто', en: 'Mentioned' },
    constraints: { created_by: 'any' },
    module: null, // роль ядра (§Б1-2)
  },
  {
    id: 'instance-of',
    label: { ru: 'Экземпляр шаблона', en: 'Instance of' },
    description: {
      ru: 'Запись порождена шаблоном повторения',
      en: 'A record spawned by a recurrence template',
    },
    // РП-5: направление как у сегодняшнего `derived_from` — источник ШАБЛОН, цель экземпляр.
    sourceLabel: { ru: 'Шаблон', en: 'Template' },
    targetLabel: { ru: 'Экземпляр', en: 'Instance' },
    constraints: { created_by: 'system' },
    module: null, // слот `origin_role` контракта «повторяемость», а он — ядро (В6)
  },
  {
    id: 'ref',
    label: { ru: 'Ссылка свойства', en: 'Property reference' },
    description: {
      ru: 'Зеркало значения ссылочного свойства в графе: истина — свойство, ребро производно',
      en: 'The graph mirror of a reference property value: the property is the truth, the edge is derived',
    },
    sourceLabel: { ru: 'Откуда ссылка', en: 'Referrer' },
    targetLabel: { ru: 'Цель ссылки', en: 'Referenced' },
    constraints: { created_by: 'system' },
    module: null, // тип `ref` — ядро (№14)
  },
  {
    id: 'alternative-of',
    label: { ru: 'Альтернатива', en: 'Alternative of' },
    description: {
      ru: 'Другой способ добиться того же результата',
      en: 'Another way to achieve the same result',
    },
    sourceLabel: { ru: 'Альтернатива', en: 'Alternative' },
    targetLabel: { ru: 'Исходный вариант', en: 'Original option' },
    constraints: { created_by: 'any' },
    module: null,
  },
  {
    id: 'supersedes',
    label: { ru: 'Замещает', en: 'Supersedes' },
    description: {
      ru: 'Запись отменяет прежнюю и встаёт на её место',
      en: 'A record cancels the previous one and takes its place',
    },
    sourceLabel: { ru: 'Замена', en: 'Replacement' },
    targetLabel: { ru: 'Замещённое', en: 'Superseded' },
    constraints: { created_by: 'any' },
    module: null,
  },
];

/** Одиннадцать системных ролей §А4-3 в нормативном порядке `RELATION_ROLE_IDS`. */
export const BUILTIN_RELATION_ROLE_META: readonly RelationRoleDefinition[] = ENTRIES.map(
  (entry, index) =>
    relationRoleDefinitionSchema.parse({
      ...entry,
      ownerId: null,
      key: entry.id,
      // Признак иерархии выводится из одного списка `HIERARCHICAL_ROLE_IDS`, а не пишется
      // второй раз здесь: компилятор запросов читает список, реестр — поле, и разъехаться
      // они не должны.
      hierarchical: HIERARCHICAL.has(entry.id),
      rank: index + 1,
    }),
);

// Порядок записей обязан совпадать с нормативным списком: `rank` выводится из позиции.
if (ENTRIES.map((e) => e.id).join(',') !== RELATION_ROLE_IDS.join(',')) {
  throw new Error('BUILTIN_RELATION_ROLE_META разошёлся с RELATION_ROLE_IDS');
}
