/**
 * ПЕЧАТЬ E-ДЕРЕВА — читаемый текст для диффа предложений (Ш1) и карточек реестра.
 *
 * ОБРАТИМОСТЬ НЕ ОБЕЩАНА и не проверяется — в отличие от `query/print.ts`, где на равенстве
 * `parse(print(ast)) === ast` стоит целый корпус. Причина простая: текстового парсера у E в
 * срезе Б-1 нет вовсе (текст — сахар Р18), а обещание, которое некому проверить, — это
 * обещание, которое разойдётся с кодом на первой правке.
 *
 * Что печать ОБЯЗАНА давать — РАЗЛИЧИМОСТЬ: дифф Ш1 меряет правку декларации именно этим
 * текстом, и два разных дерева, слипшихся в одну строку, спрятали бы правку от владельца.
 * Пиннится тестом «разные деревья — разные тексты» на всех положительных фикстурах §С8-28.
 *
 * ИМЕНА ПЕЧАТАЮТСЯ КЛЮЧОМ, А НЕ ПОДПИСЬЮ, и это не экономия: подпись зависит от локали
 * читателя, а дифф двух версий декларации обязан отличать правку выражения от смены языка
 * интерфейса. Контракт печатается как лежит в дереве: у `ParseRegistry` словаря контрактов
 * нет, нормализация уже свела имя к id, а у встроенных контрактов id и есть key (§1.3).
 *
 * СКОБКИ СТАВИТ КОНТЕКСТ. `and`/`or` группируют сами и потому печатают своих детей ГОЛЫМИ;
 * везде ещё инфиксный узел берётся в скобки — иначе `not (a in b)` и `not a in b`
 * читались бы одинаково, а это разные деревья.
 */
import type { ParseRegistry } from '../query/parse-ast';
import type { ExprNode } from './ast';

/** Имя записи реестра ключом; неизвестный адрес печатается как есть — отказ не наше дело. */
function propertyName(id: string, reg: ParseRegistry): string {
  return reg.properties.get(id)?.key ?? id;
}
function roleName(id: string, reg: ParseRegistry): string {
  return reg.roles.get(id)?.key ?? id;
}

function print(node: ExprNode, reg: ParseRegistry, bare: boolean): string {
  if ('const' in node) return JSON.stringify(node.const);
  if ('duration' in node) return node.duration;
  if ('prop' in node) return propertyName(node.prop, reg);
  if ('slot' in node) return `slot:${node.slot}`;
  if ('param' in node) return `@${node.param}`;
  if ('ctx' in node) return node.ctx;
  if ('agg' in node) return `agg:${node.agg}`;
  if ('phase' in node) return `phase=${node.phase}`;
  if ('agg_via' in node)
    return `agg_via(${roleName(node.agg_via.role, reg)}, ${node.agg_via.name})`;
  if ('deref' in node) {
    const base =
      node.deref.slot === undefined
        ? propertyName(node.deref.prop as string, reg)
        : `slot:${node.deref.slot}`;
    return `deref(${base}).${propertyName(node.deref.read, reg)}`;
  }
  if ('has' in node) return `has(${propertyName(node.has, reg)})`;
  if ('has_relation' in node) {
    const h = node.has_relation;
    const inSet = h.in_set === undefined ? '' : `, in_set=${h.in_set.contract}:${h.in_set.set}`;
    // `alive` печатается флагом, когда он истинен, и явной парой — когда ложен: «дальний
    // конец архивен» встречается редко и молчаливым отсутствием флага не выражается.
    const alive = h.alive === undefined ? '' : h.alive ? ', alive' : ', alive=false';
    return `has_relation(${roleName(h.role, reg)}${inSet}${alive})`;
  }
  if ('class' in node) return `class(${node.class.contract})`;
  if ('date_add' in node) return call('date_add', node.date_add, reg);
  if ('date_diff' in node) return call('date_diff', node.date_diff, reg);
  if ('days_inclusive' in node) return call('days_inclusive', node.days_inclusive, reg);
  const args = node.args;
  if (node.op === 'and' || node.op === 'or') {
    return `(${args.map((a) => print(a, reg, true)).join(` ${node.op} `)})`;
  }
  if (node.op === 'not') return `not (${print(args[0] as ExprNode, reg, false)})`;
  if (node.op === 'if') return call('if', args, reg);
  const text = `${print(args[0] as ExprNode, reg, false)} ${node.op} ${print(args[1] as ExprNode, reg, false)}`;
  return bare ? text : `(${text})`;
}

function call(name: string, args: readonly ExprNode[], reg: ParseRegistry): string {
  return `${name}(${args.map((a) => print(a, reg, false)).join(', ')})`;
}

/**
 * Текст выражения. Печать ТОТАЛЬНА: любая из 17 форм канона получает вид, и «нет ветки»
 * здесь невозможно — иначе дифф молча терял бы часть декларации.
 */
export function printExpr(expr: ExprNode, reg: ParseRegistry): string {
  return print(expr, reg, false);
}
