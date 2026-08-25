// Исполняемый эталон мутационной проверки П1 (проба 2026-08-25): 17 из 17 испорченных ответов
// отвергаются схемой, оба валидных — принимаются (отчёт docs/superpowers/reviews/2026-08-25-probe-p1.md §1).
// Запуск: `bun p1-mutation-check.ts` из каталога assets (путь './p1-schemas.json' — относительно cwd).
// Перенесён из .superpowers/probe/p1/mutation-check.ts побайтно; правка одна — имя файла схемы.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const SCHEMA = JSON.parse(readFileSync('./p1-schemas.json', 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const v = ajv.compile(SCHEMA);
const base = { declarations: [], clarification_needed: null, wrong_form: { detected: false, suggested: null } };
const cases: [string, unknown][] = [
  ['эталонный пустой ответ (ДОЛЖЕН пройти)', base],
  ['валидная binding (ДОЛЖНА пройти)', { ...base, declarations: [{ kind: 'binding', aspect: 'user/x', implements: [{ contract: 'orbis/when', bind: { moment: 'user/p' } }] }] }],
  ['неизвестный kind', { ...base, declarations: [{ kind: 'view_definition', foo: 1 }] }],
  ['aspect_delta: вариант без value_map (Б5)', { ...base, declarations: [{ kind: 'aspect_delta', aspect: 'orbis/task', add_variants: [{ property: 'orbis/task_status', key: 'review', label: { ru: 'ревью' } }] }] }],
  ['property: label строкой, не по локалям', { ...base, declarations: [{ kind: 'property_definition', key: 'user/e', label: 'энергия', description: { ru: 'x' }, type: { kind: 'text' } }] }],
  ['property: несуществующий kind url', { ...base, declarations: [{ kind: 'property_definition', key: 'user/e', label: { ru: 'a' }, description: { ru: 'b' }, type: { kind: 'url' } }] }],
  ['property: select без variants', { ...base, declarations: [{ kind: 'property_definition', key: 'user/e', label: { ru: 'a' }, description: { ru: 'b' }, type: { kind: 'select' } }] }],
  ['property: key кириллицей', { ...base, declarations: [{ kind: 'property_definition', key: 'user/энергия', label: { ru: 'a' }, description: { ru: 'b' }, type: { kind: 'text' } }] }],
  ['property: key без namespace', { ...base, declarations: [{ kind: 'property_definition', key: 'energy', label: { ru: 'a' }, description: { ru: 'b' }, type: { kind: 'text' } }] }],
  ['action без sensitivity', { ...base, declarations: [{ kind: 'action_definition', key: 'user/a', label: { ru: 'a' }, description: { ru: 'b' }, steps: [{ tool: 'entity_update', args: {} }] }] }],
  ['action: шаг без tool', { ...base, declarations: [{ kind: 'action_definition', key: 'user/a', label: { ru: 'a' }, description: { ru: 'b' }, steps: [{ args: {} }], sensitivity: [] }] }],
  ['rule assign_level без level', { ...base, declarations: [{ kind: 'rule', template: 'assign_level', when: { const: true } }] }],
  ['rule: шаблон не из каталога', { ...base, declarations: [{ kind: 'rule', template: 'on_change', property: 'x' }] }],
  ['выражение: неизвестный op date_add', { ...base, declarations: [{ kind: 'rule', template: 'assign_level', level: 'discuss', when: { op: 'date_add', args: [{ ctx: '$today' }, { const: 1 }] } }] }],
  ['выражение: лишний ключ в узле', { ...base, declarations: [{ kind: 'rule', template: 'assign_level', level: 'discuss', when: { prop: 'orbis/amount', foo: 1 } }] }],
  ['subscription: несуществующая поверхность', { ...base, declarations: [{ kind: 'subscription_delta', surface: 'dashboard' }] }],
  ['wrong_form: suggested вне списка', { ...base, wrong_form: { detected: true, suggested: 'action' } }],
  ['нет поля wrong_form', { declarations: [], clarification_needed: null }],
  ['лишнее поле верхнего уровня', { ...base, notes: 'hi' }],
];
for (const [name, val] of cases) console.log(`${v(val) ? 'ПРОШЛО ' : 'ОТВЕРГНУТО'}  ${name}`);
