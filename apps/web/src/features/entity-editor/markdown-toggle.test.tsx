import { type BodyDoc, DOC_SCHEMA_VERSION, parseBody, serializeBody } from '@orbis/shared/doc';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, type Mock, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { MarkdownToggle } from './MarkdownToggle';

// «Применить» и «Отмена» — обработчики DOM-событий: брошенное там jsdom гасит, ассерты
// остаются зелёными, а прогон падает кодом 1. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// Мок СТРОГИЙ и ФУНКЦИЕЙ: тумблер — чистая правка текста, у сервера ему спрашивать нечего.
// Молчаливая заглушка `() => ({})` приняла бы любой запрос и скрыла бы лишний поход в сеть.
const noServer = (path: string): unknown => {
  throw new Error(`тумблер не ходит на сервер, а спросил ${path}`);
};

function mount(doc: BodyDoc) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const { calls } = renderWithProviders(
    <MarkdownToggle doc={doc} onChange={onChange} onClose={onClose} />,
    noServer,
  );
  return {
    onChange,
    onClose,
    calls,
    area: screen.getByTestId('markdown-source') as HTMLTextAreaElement,
    apply: screen.getByRole('button', { name: 'Применить' }),
  };
}

/** Документ первого вызова onChange. Сам факт вызова тесты сверяют отдельной строкой до этого. */
const savedDoc = (onChange: Mock): BodyDoc => onChange.mock.calls[0]?.[0] as BodyDoc;

/** Типы блоков верхнего уровня сохранённого документа — по ним видно, разобрана разметка или нет. */
const blockTypes = (doc: BodyDoc): (string | undefined)[] =>
  (doc.doc.content ?? []).map((n) => n.type);

/** Тело, часть которого конверсия уводит в rawBlock (проверено пробой, см. тест премис ниже). */
const WITH_RAW = 'обычный текст\n\n![подпись](https://example.com/a.png)';

// --- премиса примеров ---------------------------------------------------------------------

test('премиса: картинка и определение ссылки уходят в raw, сноска GFM — нет', () => {
  // Пример из брифа (`текст[^1]` + определение сноски) в raw НЕ уходит: сносок в лексере нет,
  // и `[^1]` разбирается обычным текстом с экранированием. Настоящие raw-случаи — картинка
  // (нода схемы отсутствует) и reference-определение ссылки (форму не восстановить).
  // Страж премисы, а не тест конверсии: без него тесты ниже стали бы проверять тумблер на
  // разметке, которая на самом деле разбирается, — и молчали бы о смене поведения Задачи 2.
  expect(blockTypes(parseBody(WITH_RAW))).toEqual(['paragraph', 'rawBlock']);
  expect(blockTypes(parseBody('см. [док][d]\n\n[d]: https://example.com'))).toEqual(['rawBlock']);
  expect(blockTypes(parseBody('текст[^1]\n\n[^1]: определение сноски'))).toEqual([
    'paragraph',
    'paragraph',
  ]);
});

// --- что показано -------------------------------------------------------------------------

test('показывает ровно serializeBody(doc) — канон, а не исходную строку', () => {
  // Исходник НАРОЧНО неканоничен (два пробела после `#`, `__жирный__`): в `body` лежит канон,
  // и его читают FTS, промпт и MCP. Покажи тумблер исходную строку — тест увидит разницу.
  const source = '#  Заголовок\n\nтекст __жирный__';
  const doc = parseBody(source);
  const { area, calls } = mount(doc);

  expect(area.value).toBe(serializeBody(doc));
  expect(area.value).toBe('# Заголовок\n\nтекст **жирный**');
  // Стражи вакуумности: канон непуст, отличается от исходника и несёт саму разметку
  // (сборка из голого текста нод потеряла бы `#` и `**`).
  expect(area.value).not.toBe(source);
  expect(area.value).toContain('**жирный**');
  // Тумблер ничего не спрашивает у сервера: любой запрос попал бы в `calls` (и строгий мок
  // на него бросил бы) — правка текста обязана быть чистой.
  expect(calls).toEqual([]);
});

// --- запись -------------------------------------------------------------------------------

test('правка и «Применить» отдают документ, чья сериализация равна тексту', async () => {
  const { area, apply, onChange, onClose } = mount(parseBody('старое тело'));
  const next = '# Новый заголовок\n\n- один\n- два';
  fireEvent.change(area, { target: { value: next } });
  await userEvent.click(apply);

  expect(onChange).toHaveBeenCalledTimes(1);
  const saved = savedDoc(onChange);
  expect(serializeBody(saved)).toBe(next);
  // Страж вакуумности: равенство сериализации даёт и rawBlock (он отдаёт текст дословно),
  // поэтому проверяем, что разметка РАЗОБРАНА, а не сохранена «как есть».
  expect(blockTypes(saved)).toEqual(['heading', 'bulletList']);
  // Хранимая форма — с версией: голый документ сервер не примет.
  expect(saved.v).toBe(DOC_SCHEMA_VERSION);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('текст без изменений не отправляет onChange вовсе', async () => {
  // Лишняя мутация подняла бы updated_at ни за что.
  const { area, apply, onChange, onClose } = mount(parseBody('# Тело\n\nтекст'));
  await userEvent.click(apply);
  expect(onChange).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: молчание выше — про отсутствие правки, а не про
  // сломанную кнопку. Тумблер после первого «Применить» не размонтирован (родителя тут нет).
  fireEvent.change(area, { target: { value: '# Тело\n\nтекст и ещё абзац' } });
  await userEvent.click(apply);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(serializeBody(savedDoc(onChange))).toBe('# Тело\n\nтекст и ещё абзац');
});

test('очистка тела — это правка, а не «без изменений»', async () => {
  // Пустой текст !== исходный: тело должно очиститься, а не молча остаться прежним.
  const { area, apply, onChange, onClose } = mount(parseBody('было тело'));
  fireEvent.change(area, { target: { value: '' } });
  await userEvent.click(apply);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(serializeBody(savedDoc(onChange))).toBe('');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('«Отмена» закрывает, ничего не записав', async () => {
  const { area, onChange, onClose } = mount(parseBody('тело'));
  fireEvent.change(area, { target: { value: 'другое тело' } });
  await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
  expect(onChange).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

// --- неразобранная разметка ---------------------------------------------------------------

test('неразбираемое не сохраняется молча: предупреждение и второе «Применить»', async () => {
  const { area, apply, onChange, onClose } = mount(parseBody('обычный текст'));
  fireEvent.change(area, { target: { value: WITH_RAW } });
  await userEvent.click(apply);

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('не разобрана');
  // Р-13: предупреждение красится text-alert. text-warning на белом листе даёт 3.18:1 и в
  // этом репозитории для ТЕКСТА уже отвергнут (GoalProgress.tsx:55-57, NativeRow.tsx:92).
  expect(alert.className).toContain('text-alert');
  // ГЛАВНОЕ (И12): тумблер ОСТАЁТСЯ открытым и НИЧЕГО не записал. Закройся он в том же тике,
  // предупреждение в проде не увидел бы никто, а тест БЕЗ двух строк ниже остался бы зелёным:
  // спай onClose компонент не размонтирует, и `getByRole('alert')` выше нашёл бы плашку даже
  // у закрытого тумблера. Ровно так предупреждение и умерло в версии v1.
  expect(onChange).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(area.value).toBe(WITH_RAW);

  // Второе «Применить» — явное подтверждение: теперь сохраняем «как есть».
  await userEvent.click(apply);
  expect(onChange).toHaveBeenCalledTimes(1);
  const saved = savedDoc(onChange);
  // Raw — ВТОРОЙ блок из двух: предупреждение обязано ловить частичную неразобранность,
  // а не только «всё тело одним блоком».
  expect(blockTypes(saved)).toEqual(['paragraph', 'rawBlock']);
  expect(serializeBody(saved)).toBe(WITH_RAW);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('правка текста снимает подтверждение — оно не переносится на новый текст', async () => {
  const { area, apply, onChange } = mount(parseBody('обычный текст'));
  fireEvent.change(area, { target: { value: WITH_RAW } });
  await userEvent.click(apply);
  expect(screen.getByRole('alert')).toBeInTheDocument();

  // Правка снимает и предупреждение (оно про прежний текст), и само подтверждение.
  const other = 'обычный текст\n\n![другая](https://example.com/b.png)';
  fireEvent.change(area, { target: { value: other } });
  expect(screen.queryByRole('alert')).toBeNull();

  await userEvent.click(apply);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeInTheDocument();

  await userEvent.click(apply);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(serializeBody(savedDoc(onChange))).toBe(other);
});

test('разобранная разметка сохраняется с первого «Применить» — подтверждения не требует', async () => {
  // Контроль на другую сторону: двухшаговость обязана касаться ТОЛЬКО неразобранного.
  const { area, apply, onChange, onClose } = mount(parseBody('обычный текст'));
  fireEvent.change(area, { target: { value: 'обычный текст\n\n> цитата' } });
  await userEvent.click(apply);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(blockTypes(savedDoc(onChange))).toEqual(['paragraph', 'blockquote']);
  expect(onClose).toHaveBeenCalledTimes(1);
});
