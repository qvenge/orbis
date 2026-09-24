import { parsePageText } from '@orbis/shared/doc/page-grammar';
import { type ParseAstResult, type ParseRegistry, parseQueryAst } from '@orbis/shared/query';

/**
 * Разбор ТЕЛА блока: обёртку `{{query:…}}` снимаем здесь, внутрь идёт содержимое (§2: обёртку
 * парсер не снимает).
 *
 * Грамматика — канон §А5-3, и разбор СТРОГИЙ, ровно как на сервере (`query/parse-text.ts`).
 * Мост старой формы стоял здесь до Задачи 21b: тела сидированных смарт-листов и заготовка
 * проекта были написаны старой грамматикой, а сервер их исполнял, — разбирай экран строго,
 * и каждый сидированный список встретил бы владельца красной плашкой при живом ответе
 * сервера. Той же задачей тексты переведены в key-форму, а мост удалён, и сходиться этим
 * двум сторонам стало не с чем расходиться: форма текста одна.
 *
 * Неизвестное имя свойства — отказ с позицией, а не молчаливый ноль результатов (§А5-3ж).
 *
 * Обёртку узнаёт препроход тела (`parsePageText`), а не свой регэксп: маркеры `{{…}}` знает одна
 * копия правил (РП-6), и вторая рано или поздно разошлась бы с ней.
 */
export function parseBlock(blockText: string, reg: ParseRegistry): ParseAstResult {
  const wrapped = parsePageText(blockText).find((n) => n.kind === 'query');
  const inner = (wrapped?.kind === 'query' ? wrapped.text : blockText).trim();
  return parseQueryAst(inner, reg);
}
