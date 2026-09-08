// Форма wire-контракта подписки Agenda (§А5-5): вход ручки и разбор ответа.
//
// Проверяется схемой, а не типом: тип стирается на границе провода, и «третья секция» либо
// лишний ключ входа доехали бы до клиента молча.
import { describe, expect, test } from 'bun:test';
import { AGENDA_DAYS_MAX, agendaListInput, agendaListResultSchema } from './agenda';

const ENT = {
  id: '019d48ea-4188-765d-8e96-93a0ad9c262a',
  ownerId: '019d48ea-4188-765d-8e96-93a0ad9c262b',
  title: 'Стендап',
  props: { 'orbis/start_at': '2026-09-03T09:00:00+03:00' },
  aspects: ['orbis/schedule'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archived: false,
};

describe('контракт agenda.list (§А5-5)', () => {
  test('вход: days по умолчанию 8, за границами и с лишним ключом — отказ', () => {
    expect(agendaListInput.parse({})).toEqual({ days: 8 });
    for (const bad of [{ days: 0 }, { days: AGENDA_DAYS_MAX + 1 }, { days: 8, tz: 'UTC' }]) {
      expect(() => agendaListInput.parse(bad)).toThrow();
    }
  });
  test('выход: сущность целиком, тег секции, дата слота; третья секция — отказ', () => {
    const row = {
      entity: ENT,
      section: 'window',
      at: '2026-09-03T09:00:00+03:00',
      slot: 'moment',
      allDay: false,
    };
    const ok = agendaListResultSchema.parse({
      today: '2026-09-03',
      timezone: 'Europe/Moscow',
      rows: [row],
      truncated: { window: false, overdue: false },
    });
    expect(ok.rows[0]?.entity.props['orbis/start_at']).toBe(ENT.props['orbis/start_at']);
    expect(() =>
      agendaListResultSchema.parse({ ...ok, rows: [{ ...row, section: 'later' }] }),
    ).toThrow();
  });
});
