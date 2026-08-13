// ProseMirror измеряет геометрию каретки и попадание мыши; jsdom этих API не имеет вовсе, и
// вызов уходит в uncaught exception. Тесты при этом ЗЕЛЁНЫЕ, а прогон падает с кодом 1 — то
// есть без полифилов сьют web красный в CI без единого упавшего теста.
//
// Полифилы намеренно возвращают нули и null: геометрия в jsdom всё равно ничего не значит, а
// задача — не уронить прогон, а не соврать про размеры. Всё, что зависит от настоящих координат
// (позиционирование меню, попадание мыши в блок), проверяется в браузере.
//
// Состав проверен на нашем jsdom 29: Range.prototype.getClientRects, .getBoundingClientRect и
// document.elementFromPoint отсутствуют; Element.prototype.getClientRects — есть. Guard'ы
// оставлены на всех четырёх: они дешевле, чем разбираться после обновления jsdom.
const ZERO_RECT: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

function rectList(): DOMRectList {
  const list = [ZERO_RECT] as unknown as DOMRectList;
  Object.defineProperty(list, 'item', { value: (i: number) => (i === 0 ? ZERO_RECT : null) });
  return list;
}

export function installProseMirrorJsdomPolyfills(): void {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = rectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => ZERO_RECT;
  if (!Element.prototype.getClientRects) Element.prototype.getClientRects = rectList;
  // Никто «не под курсором»: клик мимо текста ProseMirror переживает штатно.
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
}
