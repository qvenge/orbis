/**
 * Модель-обращённая поверхность реестра (§А9-1): имя `attach_*`-тула и JSON Schema его
 * `data` — из ЭФФЕКТИВНОГО НАБОРА аспекта, а не из колонки `aspect_definitions.schema`.
 *
 * Зачем это здесь, в shared, а не на сервере: имя тула собирают ТРИ места — реестр,
 * который его публикует (`tools/registry.ts`), диспатч, который переводит вызов в
 * исполнительную форму (`tools/dispatch.ts`), и сам исполнитель, который по имени находит
 * аспект (`executor/executor.ts`). Пока нормализаций было две («/» и «-» → «_» у реестра,
 * только «/» → «_» у исполнителя), они расходились на КАЖДОМ аспекте с дефисом в ключе:
 * модель видела `attach_user_sleep_log`, а исполнитель ждал `attach_user_sleep-log`, и
 * держал их вместе один переводчик посередине. Одна функция снимает и переводчика, и повод
 * им разойтись.
 *
 * Схема значения свойства строится ТОЛЬКО `propertyValueJsonSchema` (§А7-1): своей ветки по
 * `kind` здесь нет и быть не должно — вторая правда о том, что такое `decimal` или `select`,
 * разошлась бы с валидатором записи молча.
 */
import { type AspectDefinition, type PropertyDefinition, writableFromTool } from './property-type';
import { effectiveLabel } from './types';
import { propertyValueJsonSchema } from './value-schema';

/**
 * Имя `attach_*`-тула по КЛЮЧУ аспекта: `orbis/agent-run` → `attach_orbis_agent_run`.
 *
 * Из ключа, а не из id: у встроенных они совпадают, а свой аспект владелец адресует именем,
 * которое сам и дал (тот же довод, что у `resolveAttachAspect` исполнителя).
 *
 * Заменяются и «/», и «-»: имя тула LLM/MCP — `[a-z0-9_]` (пин в `registry.test.ts`).
 * Нормализация НЕОБРАТИМА (два разных ключа могут дать одно имя), поэтому обратного
 * преобразования здесь нет: аспект по имени тула ищут перебором реестра, а не разбором
 * строки.
 */
export function attachToolName(aspectKey: string): string {
  return `attach_${aspectKey.replaceAll('/', '_').replaceAll('-', '_')}`;
}

/** Минимум реестра, нужный генератору: словарь свойств по id. */
export interface ToolSchemaRegistry {
  properties: Map<string, PropertyDefinition>;
}

/**
 * Описание параметра тула: `label — description` в локали читателя плюс варианты `select`.
 *
 * Варианты названы ТЕКСТОМ, хотя они же лежат в `enum` схемы: `enum` видит валидатор
 * провайдера, а модель читает описание — и без списка ключей она пишет подпись («Расход»)
 * вместо ключа (`expense`). В данных лежит ключ (Р3), поэтому в описании — ключи.
 */
function parameterDescription(def: PropertyDefinition, locale: string): string {
  const head = `${effectiveLabel(def.label, locale)} — ${effectiveLabel(def.description, locale)}`;
  if (def.type.kind !== 'select') return head;
  return `${head} (варианты: ${def.type.options.map((o) => o.key).join('|')})`;
}

/**
 * JSON Schema `data` тула `attach_<аспект>` — эффективный набор аспекта (§А9-1).
 *
 * Имена параметров — **key свойства** (`orbis/task_status`), а не локальная часть и не
 * подпись: тем же именем модель читает значение в проекции `entity_query` (§А9-2, Р12
 * «key для машин»), и два имени одного поля означали бы, что прочитанное нельзя записать.
 * Кириллица в именах при этом не возникает по построению — key ASCII-слаг (§А2-1).
 *
 * ПОРЯДОК свойств — по `rank` ссылки аспекта (§Б7-3): JSON сохраняет порядок вставки, и
 * модель читает поля в том же порядке, в каком их видит владелец на форме. Сортировка
 * СТАБИЛЬНАЯ (копия через `[...]` и `Array.prototype.sort`, который в ES2019+ стабилен) —
 * при равных `rank` порядок остаётся объявленным.
 *
 * СЛУЖЕБНЫЕ И ВЫЧИСЛЯЕМЫЕ СВОЙСТВА В СХЕМУ НЕ ПОПАДАЮТ (§А2-5, №33). `system_writable`
 * (`orbis/bank_txn_id` — пишет импорт, `orbis/carryover` — правило rollover, поля прогона —
 * глаголы) и `model_writable: false` (`orbis/current_value` — кэш вычисления) тулу недоступны
 * по построению: назвав их в `data`, модель получает гарантированный `COMPUTED_WRITE`.
 * Спека вынесла их из `attach_*` ровно затем, чтобы ПОВЕРХНОСТЬ НЕ ОБЕЩАЛА ЗАПРЕЩЁННОГО, —
 * предикат один на shared (`writableFromTool`) и сверен с гейтом прав тестом.
 *
 * Обязательность при этом не подделывается: отфильтрованное свойство не попадает и в
 * `required`. Служебных ОБЯЗАТЕЛЬНЫХ полей у неслужебных аспектов нет (все пять
 * обязательных `system_writable` — у `orbis/agent-run`, а он тула не получает вовсе), так
 * что неисполнимого тула эта ветка породить не может; появись такой аспект — он и должен
 * быть служебным.
 *
 * Ссылка на свойство, которого нет в снимке, ПРОПУСКАЕТСЯ, а не роняет тул: снимок
 * скоупится RLS и правилами модулей, и аспект, у которого одно поле стало невидимым, обязан
 * остаться вызываемым по остальным. Молчаливой такая дыра не будет — валидатор записи
 * ответит `UNKNOWN_PROPERTY` тому, кто пришлёт пропущенное поле.
 */
export function aspectToolJsonSchema(
  aspect: AspectDefinition,
  reg: ToolSchemaRegistry,
  locale: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const ref of [...aspect.properties].sort((a, b) => a.rank - b.rank)) {
    const def = reg.properties.get(ref.propertyId);
    if (def === undefined) continue;
    if (!writableFromTool(def)) continue;
    properties[def.key] = {
      ...propertyValueJsonSchema(def.type),
      description: parameterDescription(def, locale),
    };
    if (ref.required) required.push(def.key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
