/**
 * Шаблон хоста — текст спеки §8.1 дословно (Р-16) и без единой проблемы тела (§5.8).
 *
 * Две сверки, и ни одна не заменяет другую. Литерал — ЧТО именно поставлено: правка текста в коде
 * без правки теста краснеет здесь. Блок спеки — ОТКУДА текст: литерал, переписанный вместе с
 * кодом, разошёлся бы со спекой молча, а спека — договор с владельцем.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bodyIssues } from '@orbis/shared/doc/placement';
import { expect, test } from 'vitest';
import { buildQueryRegistry } from '../../lib/query-blocks/catalog';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { HOST_TEMPLATE_NODES, HOST_TEMPLATE_TEXT } from './host-template';

const SPEC_LINES = [
  '{{title}}',
  '{{tags}}',
  '{{tabs}}',
  '{{tab: Запись}}',
  '{{card: orbis/goal}}',
  '{{card: orbis/assignment}}',
  '{{card: orbis/routine}}',
  '{{card: orbis/agent-run}}',
  '{{card: orbis/financial}}',
  '{{body}}',
  '{{/tab}}',
  '{{tab: Детали}}',
  '{{cards}}',
  '{{versions}}',
  '{{subtasks}}',
  '{{blockers}}',
  '{{backlinks}}',
  '{{/tab}}',
  '{{tab: Тред}}',
  '{{thread}}',
  '{{/tab}}',
  '{{/tabs}}',
];

test('HOST_TEMPLATE_TEXT побайтно равен блоку §8.1 (литерал)', () => {
  expect(HOST_TEMPLATE_TEXT).toBe(SPEC_LINES.join('\n'));
});

test('HOST_TEMPLATE_TEXT — тот же текст, что блок §8.1 в самой спеке', () => {
  // vitest запускается из apps/web; спека — в корне репозитория.
  const spec = readFileSync(
    resolve(process.cwd(), '../../docs/superpowers/specs/2026-09-23-pages-slice-1a-design.md'),
    'utf8',
  );
  const section = spec.slice(spec.indexOf('### 8.1'));
  const block = /```\n([\s\S]*?)\n```/.exec(section)?.[1];
  expect(block).toBe(HOST_TEMPLATE_TEXT);
});

test('шаблон хоста разбирается без единой проблемы тела шаблона', () => {
  expect(
    bodyIssues(HOST_TEMPLATE_NODES, 'template', buildQueryRegistry(BUILTIN_REGISTRY).parse),
  ).toEqual([]);
  // Один узел верхнего уровня на строку заголовка и тегов и один контейнер вкладок — не текст:
  // «дословно» не значит «разобрано как текст».
  expect(HOST_TEMPLATE_NODES.map((n) => n.kind).filter((k) => k !== 'text')).toEqual([
    'record',
    'record',
    'tabs',
  ]);
});
