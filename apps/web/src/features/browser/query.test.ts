import { DAILY_PLANNING_BODY, SEED_SMART_LISTS } from '@orbis/server/src/seed/smart-lists';
import { parseBody } from '@orbis/shared/doc';
import { expect, test } from 'vitest';
import {
  bodySegments,
  browserQuery,
  buildFilterQuery,
  firstQueryBlock,
  queryBlocks,
  replaceQueryBlock,
} from './query';

test('browserQuery включает limit и сортировку по updated_at desc', () => {
  const q = browserQuery({ limit: 50, filters: '' });
  expect(q).toContain('limit=50');
  expect(q).toContain('sortBy=updated_at:desc');
});

test('browserQuery дописывает фильтры перед limit', () => {
  const q = browserQuery({ limit: 100, filters: 'aspect=orbis/task' });
  expect(q).toContain('aspect=orbis/task');
  expect(q).toContain('limit=100');
});

test('buildFilterQuery собирает строку из выбранных фильтров', () => {
  const s = buildFilterQuery({
    tags: ['работа', 'дом'],
    aspects: ['orbis/task'],
    status: 'inbox',
    priority: null,
    createdFrom: null,
    createdTo: null,
  });
  expect(s).toContain('tags=работа|дом');
  expect(s).toContain('aspect=orbis/task');
  expect(s).toContain('status=inbox');
});

test('firstQueryBlock извлекает первый {{query:...}} из body', () => {
  expect(firstQueryBlock('текст\n{{query:aspect=orbis/task}}\nещё {{query:tags=x}}')).toBe(
    'aspect=orbis/task',
  );
  expect(firstQueryBlock('без блоков')).toBeNull();
});

// 02-core-os §3.4: «Каждый {{query:...}}-блок в body рендерится виджетом». Первого блока
// достаточно только бейджу pinned (§3.2) — detail-экрану нужны все, иначе секции «Сегодня»
// и «Ожидание» сидированного Daily Planning (§3.3) недостижимы.
test('queryBlocks возвращает ВСЕ блоки body в порядке появления, обёртка снята', () => {
  const body = 'текст\n{{query: aspect=orbis/task, status=inbox}}\n\n{{query:\ntags=x\n}}\nхвост';
  expect(queryBlocks(body)).toEqual(['aspect=orbis/task, status=inbox', 'tags=x']);
  expect(queryBlocks('без блоков')).toEqual([]);
  // firstQueryBlock — тот же разбор, взятый по первому элементу (§3.2)
  expect(firstQueryBlock(body)).toBe(queryBlocks(body)[0]);
});

// --- сегментация body для просмотра (C4b) ----------------------------------------------
// Просмотр detail рендерит текст markdown'ом, а {{query:...}}-блоки — виджетами, ВПЕРЕМЕЖКУ
// и в порядке текста. queryBlocks для этого мало: она отдаёт только содержимое блоков, а
// текста «между блоками» как значения не существовало вовсе.

test('bodySegments чередует текст и блоки в порядке появления', () => {
  const body = 'вступление\n{{query: aspect=orbis/task}}\nсередина\n{{query:tags=x}}\nхвост';
  expect(bodySegments(body)).toEqual([
    { kind: 'text', text: 'вступление' },
    { kind: 'query', query: 'aspect=orbis/task' },
    { kind: 'text', text: 'середина' },
    { kind: 'query', query: 'tags=x' },
    { kind: 'text', text: 'хвост' },
  ]);
});

test('bodySegments не выдумывает текст там, где его нет', () => {
  // Между блоками сида — только перевод строки: пустой абзац между виджетами был бы
  // дырой в раскладке, а не текстом записи. Пустое тело — вовсе без сегментов
  // (приглашение «Заметки…» рисует экран, а не разбор).
  expect(bodySegments('{{query:a=1}}\n\n{{query:b=2}}')).toEqual([
    { kind: 'query', query: 'a=1' },
    { kind: 'query', query: 'b=2' },
  ]);
  expect(bodySegments('')).toEqual([]);
  expect(bodySegments('   \n ')).toEqual([]);
});

test('bodySegments: незакрытый блок остаётся текстом, а не съедает хвост body', () => {
  expect(bodySegments('до {{query:aspect=orbis/task после')).toEqual([
    { kind: 'text', text: 'до {{query:aspect=orbis/task после' },
  ]);
});

// Внутренняя структура текста (переводы строк, списки) — дело markdown; сегментация
// снимает только пустые края, иначе строка с отступом после блока стала бы блоком кода.
test('bodySegments сохраняет разметку текста, убирая лишь пустые края', () => {
  expect(bodySegments('# Итоги\n\n- раз\n- два\n\n{{query:a=1}}')[0]).toEqual({
    kind: 'text',
    text: '# Итоги\n\n- раз\n- два',
  });
});

// --- Р-v2-6: разбор первого кадра и схема документа согласны про начало блока -----------
// Первый кадр рисует bodySegments, редактор строится по parseBody. Разойдись правила —
// человек увидит виджет, который через мгновение станет фигурными скобками (или наоборот).

test('bodySegments: обёртка с отступом 1–3 пробела блоком НЕ считается', () => {
  for (const pad of [' ', '  ', '   ']) {
    const body = `${pad}{{query:a=1}}`;
    expect(bodySegments(body)).toEqual([{ kind: 'text', text: '{{query:a=1}}' }]);
    expect(queryBlocks(body)).toEqual([]);
  }
  // …и то же посреди текста, а не только в начале записи.
  const inside = `до\n\n  {{query:a=1}}\n\nпосле`;
  expect(queryBlocks(inside)).toEqual([]);
});

test('bodySegments: обёртка посреди строки блоком НЕ считается', () => {
  const body = 'смотри {{query:a=1}} тут';
  expect(bodySegments(body)).toEqual([{ kind: 'text', text: 'смотри {{query:a=1}} тут' }]);
  expect(queryBlocks(body)).toEqual([]);
  // Обёртка с колонки 1 в том же теле блоком остаётся: правило про КОЛОНКУ, а не про
  // «где-то есть текст».
  expect(queryBlocks('смотри {{query:a=1}} тут\n{{query:b=2}}')).toEqual(['b=2']);
});

test('bodySegments видит ровно те же блоки, что и схема документа', () => {
  // Сверка с parseBody — единственная честная: она сравнивает не с копией регэкспа, а с тем,
  // что построит редактор. Тела — пять сидов и краевые случаи правила про колонку.
  const bodies = [
    ...SEED_SMART_LISTS.map((s) => s.body),
    '{{query:a=1}}',
    ' {{query:a=1}}',
    '   {{query:a=1}}',
    'смотри {{query:a=1}} тут',
    'до\n{{query:a=1}}\nпосле',
    'до\n\n{{query:a=1}}\n\nпосле',
    '{{query: tags=a}}b}}',
    'текст {{query: aspect=orbis/task и всё',
  ];
  for (const body of bodies) {
    const fromDoc = (parseBody(body).doc.content ?? [])
      .filter((n) => n.type === 'queryBlock')
      .map((n) => String(n.attrs?.query ?? '').trim());
    expect([body, queryBlocks(body)]).toEqual([body, fromDoc]);
  }
});

test('firstQueryBlock (бейдж pinned) считает по тому же правилу колонки', () => {
  // §3.2: бейдж — «число результатов ПЕРВОГО query-блока body». Обёртка посреди строки
  // блоком не является ни для detail-экрана, ни для схемы — значит и бейджу не считать.
  expect(firstQueryBlock('смотри {{query:a=1}} тут')).toBeNull();
  expect(firstQueryBlock('смотри {{query:a=1}} тут\n{{query:b=2}}')).toBe('b=2');
  // У всех пяти сидов бейдж прежний: их блоки стоят с колонки 1.
  for (const s of SEED_SMART_LISTS) {
    expect([s.slug, firstQueryBlock(s.body)]).toEqual([s.slug, queryBlocks(s.body)[0] ?? null]);
    expect(firstQueryBlock(s.body)).not.toBeNull();
  }
});

// --- замена текста одного блока (D2) ---------------------------------------------------
// Правка блока из виджета шлёт обычный entity.update с ЦЕЛЫМ body, поэтому всё, чего экран
// не собирался менять, обязано доехать до сервера байт-в-байт: соседние блоки, текст между
// ними и обёртка правимого блока.

test('replaceQueryBlock меняет ровно N-й блок, остальной body — байт-в-байт', () => {
  const body = 'до\n\n{{query: tags=work}}\n\nмежду\n\n{{query: tags=home}}\n\nпосле';
  expect(replaceQueryBlock(body, 1, 'tags=home, limit=5')).toBe(
    'до\n\n{{query: tags=work}}\n\nмежду\n\n{{query: tags=home, limit=5}}\n\nпосле',
  );
  expect(replaceQueryBlock(body, 0, 'tags=work, limit=5')).toBe(
    'до\n\n{{query: tags=work, limit=5}}\n\nмежду\n\n{{query: tags=home}}\n\nпосле',
  );
});

// Два блока с ОДИНАКОВЫМ текстом: адресация по индексу, а не по содержимому — replace(str)
// правил бы всегда первый, и правка второй секции молча переписывала бы первую.
test('replaceQueryBlock различает одинаковые по тексту блоки', () => {
  const body = '{{query:tags=x}}\n{{query:tags=x}}';
  expect(replaceQueryBlock(body, 1, 'tags=y')).toBe('{{query:tags=x}}\n{{query:tags=y}}');
});

// Обёртка сидированных списков — с пробелом после двоеточия и переносами внутри; редактор
// показывает тримленное содержимое, и вернуть его вплотную к {{query: значило бы переписать
// блок целиком там, где просили поменять одну клаузу.
test('replaceQueryBlock сохраняет обрамляющие пробелы блока', () => {
  const body = '{{query:\n  tags=work\n}}';
  expect(replaceQueryBlock(body, 0, 'tags=home')).toBe('{{query:\n  tags=home\n}}');
});

// Р3 «без изменений — без записи»: экран решает не слать мутацию по равенству body, поэтому
// у неизменного текста хелпер обязан вернуть ИСХОДНУЮ строку, а не пересобранную.
test('replaceQueryBlock: тот же текст — тот же body (пересборки нет)', () => {
  const blocks = queryBlocks(DAILY_PLANNING_BODY);
  for (const [i, block] of blocks.entries()) {
    expect(replaceQueryBlock(DAILY_PLANNING_BODY, i, block)).toBe(DAILY_PLANNING_BODY);
    // Лишние края в поле ввода — не правка запроса: они и в блок бы не попали.
    expect(replaceQueryBlock(DAILY_PLANNING_BODY, i, `\n${block}  `)).toBe(DAILY_PLANNING_BODY);
  }
});

// У пустой (пробельной) внутренности trimStart и trimEnd съедают её ЦЕЛИКОМ, и наивные
// lead/trail взяли бы одни и те же пробелы дважды. Путь бытовой: очистить поле и сохранить
// ({{query: }}), открыть снова и вписать запрос — края росли бы на каждом проходе.
test('replaceQueryBlock: пустая внутренность не удваивает края', () => {
  expect(replaceQueryBlock('{{query:   }}', 0, 'tags=x')).toBe('{{query:tags=x}}');
  const cleared = replaceQueryBlock('{{query: tags=x}}', 0, '');
  expect(cleared).toBe('{{query: }}');
  expect(replaceQueryBlock(cleared, 0, 'tags=y')).toBe('{{query:tags=y}}');
});

test('replaceQueryBlock: индекса нет — body не меняется', () => {
  // Тело с ОДНИМ блоком, а не с обёрткой посреди строки: после правила колонки такая обёртка
  // блоком не считается, тело стало «без блоков», и первые две строки выродились в дубликат
  // третьей — ветка «цикл прошёл по блокам, но ни один не совпал с индексом» не проверялась
  // бы ничем (найдено ревью раунда 1).
  const body = '{{query:tags=x}}';
  expect(queryBlocks(body)).toHaveLength(1); // страж вакуумности: блок для перебора ЕСТЬ
  expect(replaceQueryBlock(body, 1, 'tags=y')).toBe(body);
  expect(replaceQueryBlock(body, -1, 'tags=y')).toBe(body);
  expect(replaceQueryBlock('без блоков', 0, 'tags=y')).toBe('без блоков');
});

// Последний рубеж разметки тела. `}}` — не ошибка грамматики (парсер `tags=a}}b` принимает
// молча), а конец ОБЁРТКИ: рендерер закроет блок на первом же вхождении, хвост запроса
// станет текстом заметки, а `{{query:` в этом хвосте заведёт лишний блок и сдвинет
// нумерацию — на первом блоке стоит бейдж pinned-сущности (§3.2). Такую строку хелпер не
// пишет вовсе: body возвращается как есть (для экрана это «без изменений — без записи»), а
// объяснить причину человеку — забота редактора, который её и не пропускает.
test('replaceQueryBlock не пишет `}}`: обёртку блока не рвём', () => {
  const body = 'до\n\n{{query: tags=work}}\n\nмежду\n\n{{query: tags=home}}\n\nпосле';
  expect(replaceQueryBlock(body, 0, 'tags=a}}b')).toBe(body);
  // Вставленный целиком блок — тот же пролом: `{{query: {{query: … }}}}` порвался бы на
  // первом `}}`, а хвостовые скобки уехали бы текстом.
  expect(replaceQueryBlock(body, 1, '{{query: tags=x}}')).toBe(body);
  // Самый дорогой случай: лишний блок сдвигает нумерацию (было два — стало бы три).
  const shifted = replaceQueryBlock(body, 0, 'tags=a}} хвост {{query:');
  expect(queryBlocks(shifted)).toHaveLength(2);
  expect(shifted).toBe(body);
});

// Индекс приходит из сегментации просмотра, поэтому «N-й блок» обязан значить у обеих
// функций одно и то же — включая блоки внутри огороженного кода, которые сегментация
// виджетом рендерит наравне с остальными.
test('replaceQueryBlock индексирует блоки так же, как bodySegments', () => {
  const body = 'вступление\n\n```\n{{query:tags=code}}\n```\n\n{{query: tags=work}}\nхвост';
  const blocks = queryBlocks(body);
  expect(blocks).toHaveLength(2);
  for (const [i] of blocks.entries()) {
    const next = replaceQueryBlock(body, i, 'tags=НОВОЕ');
    expect(queryBlocks(next)).toEqual(blocks.map((b, j) => (j === i ? 'tags=НОВОЕ' : b)));
  }
});

// Разбор блоков не раздваивается: у §3.4 один контракт на два потребителя.
test('bodySegments и queryBlocks видят одни и те же блоки (сид Daily Planning)', () => {
  const queries = bodySegments(DAILY_PLANNING_BODY).flatMap((s) =>
    s.kind === 'query' ? [s.query] : [],
  );
  expect(queries).toEqual(queryBlocks(DAILY_PLANNING_BODY));
  expect(queries).toHaveLength(3);
  // Текст сида — вступление перед первым блоком, и только оно.
  expect(bodySegments(DAILY_PLANNING_BODY).filter((s) => s.kind === 'text')).toEqual([
    { kind: 'text', text: 'Утренний обзор: разобрать Inbox, пройтись по списку «Сегодня».' },
  ]);
});
