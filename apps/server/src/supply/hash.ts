// apps/server/src/supply/hash.ts
// Отпечаток эталона поставки (срез 1б §9.1 п. 1, РП-6, Э-2).
//
// Отпечаток — sha256 КОДОВОЙ формы эталона, а не его печати в графе: кодовая форма одинакова в любом
// графе (страница — заголовок, эмодзи и текст эталона как он лежит в коде; оболочка — по КЛЮЧАМ записей),
// поэтому «эталон сменился» — это ровно «сменился код поставки», и ни канон тела этого графа, ни id его
// записей отпечаток не сдвигают. Считает только сервер: `node:crypto` в листовой сабпат web не везут.
import { createHash } from 'node:crypto';
import { printAppEtalon, printPageRecord, type SupplyEtalon } from '@orbis/shared/supply';

export function etalonHash(e: SupplyEtalon): string {
  const form =
    e.kind === 'app'
      ? printAppEtalon(e)
      : printPageRecord({ title: e.title, emoji: e.emoji, body: e.text });
  return createHash('sha256').update(form).digest('hex');
}
