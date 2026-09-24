// Индекс аспектов системного канала (срез 1а, спека §10 п. 1): чистая часть без БД.
//
// Снимок собирается из встроенных словарей — тех же, что кладёт сид: форма строки, порядок,
// граница служебных и маска модулей проверяются на реестре, который реально живёт в проде,
// а не на выдуманной фикстуре из одной строки. Сборка канала целиком (эффективный реестр
// владельца, чат и рутина) — `llm/context.test.ts`.
//
// ПОРЯДОК ВСТАВКИ НАМЕРЕННО НЕ СОВПАДАЕТ С rank. `BUILTIN_ASPECT_DEFS` уже лежат по rank, и снимок
// из них «как есть» делал тест порядка тавтологией: сортировку в `aspectIndexLines` можно было
// снять, и он оставался зелёным (находка гейт-ревью I1). В проде порядок строк снимка — порядок
// `loadRegistryRows` (ORDER BY graph_id, id), то есть алфавит id, а не rank. Поэтому встроенные
// аспекты вставляются в ОБРАТНОМ порядке, а два своих аспекта с РАВНЫМ rank — ключом по убыванию:
// без добора по key они вышли бы в порядке вставки.
import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  effectiveLabel,
  OWNER_LOCALE,
} from '@orbis/shared';
import type { RegistrySnapshot } from '../registry/load';
import { aspectIndexLines, SERVICE_BOUNDARY_PREFIX, SERVICE_BOUNDARY_SUFFIX } from './aspect-index';

/** Свой аспект графа поверх встроенной заметки: rank общий у пары, key различает. */
function ownAspect(id: string, rank: number) {
  const note = BUILTIN_ASPECT_DEFS.find((a) => a.id === 'orbis/note');
  if (note === undefined) throw new Error('нет встроенного аспекта orbis/note');
  return { ...note, id, key: id, rank, label: { ru: `Свой ${id}` }, description: { ru: 'свой' } };
}
/** Равный rank, и ключ по УБЫВАНИЮ в порядке вставки — добор по key обязан их переставить. */
const TIED = [ownAspect('own/zeta', 100), ownAspect('own/alpha', 100)];

const REG: RegistrySnapshot = {
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(
    [...BUILTIN_ASPECT_DEFS]
      .reverse()
      .concat(TIED)
      .map((a) => [a.id, a]),
  ),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  // Подписки индексу не нужны: пустой словарь — честнее, чем перекладка их строк в форму снимка.
  subscriptions: new Map(),
  actions: new Map(BUILTIN_ACTION_DEFS.map((a) => [a.id, a])),
  ownerVersion: 0,
  systemVersion: 0,
};

function aspectOf(id: string) {
  const a = REG.aspects.get(id);
  if (a === undefined) throw new Error(`нет встроенного аспекта ${id}`);
  return a;
}
const label = (id: string) => effectiveLabel(aspectOf(id).label, OWNER_LOCALE);
const description = (id: string) => effectiveLabel(aspectOf(id).description, OWNER_LOCALE);

describe('aspectIndexLines: индекс аспектов вместо ai_instructions (§10 п. 1 спеки 1а)', () => {
  test('строка индекса: id — подпись: описание, порядок rank', () => {
    const lines = aspectIndexLines(REG, []);
    expect(lines[0]).toBe(
      `- orbis/schedule — ${label('orbis/schedule')}: ${description('orbis/schedule')}`,
    );
    const ids = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf(' — ')));
    // Страховка от тавтологии: порядок вставки снимка действительно отличается от ожидаемого
    expect([...REG.aspects.keys()].filter((id) => ids.includes(id))).not.toEqual(ids);
    expect(ids).toEqual(
      [...REG.aspects.values()]
        .filter((a) => !a.service)
        .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
        .map((a) => a.id),
    );
  });
  test('равный rank: добор по key, а не по порядку вставки', () => {
    const ids = aspectIndexLines(REG, []).map((l) => l.slice(2, l.indexOf(' — ')));
    expect(ids.indexOf('own/alpha')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('own/alpha') + 1).toBe(ids.indexOf('own/zeta'));
  });
  test('служебный аспект — не строкой индекса, а в строке-границе без описания (РП-26)', () => {
    const lines = aspectIndexLines(REG, []);
    expect(lines.some((l) => l.startsWith('- orbis/agent-run '))).toBe(false);
    // Полная строка, а не префикс: граница держит и запрет записи, и способ чтения
    expect(lines.at(-1)).toBe(
      'Служебные — не навешивай и не правь сам: orbis/agent-run (в выдачах их нет — запрашивай явно aspect=<id>)',
    );
    expect(lines.at(-1)).toBe(
      `${SERVICE_BOUNDARY_PREFIX}orbis/agent-run${SERVICE_BOUNDARY_SUFFIX}`,
    );
  });
  test('маска модулей: аспекты выключенного модуля исчезают, прочие на месте', () => {
    const off = aspectIndexLines(REG, ['finance']);
    expect(off.some((l) => l.startsWith('- orbis/financial '))).toBe(false);
    expect(off.some((l) => l.startsWith('- orbis/task '))).toBe(true);
  });
  test('в индексе нет ни одного текста ai_instructions', () => {
    const text = aspectIndexLines(REG, []).join('\n');
    for (const a of REG.aspects.values())
      if (a.aiInstructions) expect(text).not.toContain(a.aiInstructions);
  });
});
