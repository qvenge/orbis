/** Строка построчного сравнения: общая, только «сейчас у вас» или только «в поставке». */
export interface LineDiff {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Построчное двустороннее сравнение (срез 1б §9.1 п. 2) — для записи-приложения, чья печать —
 * канонический JSON по строке на значение (`printAppProps`): так видно, какой раздел добавлен, убран
 * или переставлен. Наибольшая общая подпоследовательность строк; печать приложения — десятки строк,
 * квадрат здесь неизмерим. Внутри строки не сравнивается: строка печати — одно значение.
 */
export function lineDiff(before: string, after: string): LineDiff[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // lcs[i][j] — длина общей подпоследовательности хвостов a[i..], b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as string;
    const y = b[j] as string;
    if (x === y) {
      out.push({ kind: 'same', text: x });
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      out.push({ kind: 'removed', text: x });
      i++;
    } else {
      out.push({ kind: 'added', text: y });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: 'removed', text: a[i] as string });
  for (; j < b.length; j++) out.push({ kind: 'added', text: b[j] as string });
  return out;
}
