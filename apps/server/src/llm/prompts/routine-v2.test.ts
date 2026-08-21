// apps/server/src/llm/prompts/routine-v2.test.ts
// Снимок системного слоя раннера рутины (D42, «Пачка решений») — та же механика, что у
// routine-v1 и у линейки v1–v4: текст промпта версионированный артефакт, эталон —
// routine-v2.fixture.txt, фиксируется ОСОЗНАННО. Гарды routine-v1.test.ts перенесены все
// до одного: новая версия не имеет права молча потерять нормативный кусок слоя.
//
// Сверх переноса здесь два рода гардов, которых у v1 быть не могло:
//   1. МЕХАНИЧЕСКИЙ ДИФФ против v1 со списком осознанно заменённых строк (см. REPLACED);
//   2. позитивные гарды нового поведения среза (нетерминальный orbis_ask, отложенное
//      действие, кап пачки, толкование новых частей строки истории) и НЕГАТИВНЫЕ гарды
//      снятой лжи v1 («единственный способ спросить — orbis_checkpoint»).
import { describe, expect, test } from 'bun:test';
import { MAX_RUN_UNITS } from '../../routines/constants';
import {
  ROUTINE_SYSTEM_PROMPT as ROUTINE_SYSTEM_PROMPT_V1,
  routineModeSection as routineModeSectionV1,
} from './routine-v1';
import {
  ROUTINE_PROMPT_VERSION,
  ROUTINE_SYSTEM_PROMPT,
  routineModeSection,
  TOOL_RESULT_MARKER,
} from './routine-v2';
import { SYSTEM_PROMPT_V4 } from './v4';

/**
 * Строки routine-v1, снятые в v2 ОСОЗНАННО. Каждая — не «переформулировка», а утверждение,
 * которое срез «Пачка решений» сделал ложным или неполным:
 *
 * 1. история прогонов: перечисление обратной связи не знало ни про отложенные действия, ни
 *    про то, что у карточки есть судьба (D42 ОЧ.7) — модель читала бы новые части строки
 *    как незнакомый шум;
 * 2. propose без предложения: единственным выходом из тупика назван терминальный
 *    orbis_checkpoint — теперь выход из тупика начинается с нетерминального orbis_ask;
 * 3. «Единственный способ спросить — orbis_checkpoint» — прямая ложь с появлением
 *    orbis_ask (D42 ОЧ.5);
 * 4. «Спрашивай только тогда, когда без ответа работу не сделать» — это критерий
 *    ТЕРМИНАЛЬНОГО вопроса, и оставить его общим правилом значило бы запретить модели ровно
 *    тот нетерминальный вопрос, ради которого затеян срез. Первая половина строки («вопрос,
 *    написанный текстом, никто не прочитает») в v2 сохранена — отдельным гардом ниже.
 */
const REPLACED = new Set([
  '- Что было в прошлые срабатывания — в блоке «[история прогонов]»: что ты предлагал, чем это кончилось, о чём спрашивал и что владелец ответил. Это единственная обратная связь: не повторяй предложение, которое владелец уже отклонил, и считайся с его ответами.',
  '- Прогон, закончившийся без предложения, считается провалившимся — владелец останется без плана. Если предлагать нечего, не молчи: задай вопрос orbis_checkpoint.',
  '- Единственный способ спросить — orbis_checkpoint с run_id этого прогона и одним конкретным вопросом. Он тоже терминален: прогон останавливается и ждёт, а ответ ты увидишь в истории следующего срабатывания.',
  '- Вопрос, написанный текстом, никто не прочитает. Спрашивай только тогда, когда без ответа работу не сделать.',
]);

describe('ROUTINE_SYSTEM_PROMPT (D42, системный слой раннера)', () => {
  test('точная строка промпта совпадает с фикстурой (осознанная фиксация)', async () => {
    const fixture = await Bun.file(new URL('./routine-v2.fixture.txt', import.meta.url)).text();
    expect(ROUTINE_SYSTEM_PROMPT).toBe(fixture);
  });

  test('версия промпта — routine-v2', () => {
    expect(ROUTINE_PROMPT_VERSION).toBe('routine-v2');
  });

  // Механический гард «новая версия ничего не потеряла» (образец — v3.test.ts:38-44):
  // перечисление кусков v1 руками ловит только то, о чём вспомнил автор гарда. Здесь —
  // построчно весь v1, за вычетом ЯВНОГО списка снятого.
  //
  // Сравнение — по ЦЕЛОЙ строке (Set), а не подстрокой: при `.includes(line)` строку v1
  // можно было бы ослабить дописыванием в её же хвост («…спрашивай только тогда, когда без
  // ответа работу не сделать. Впрочем, спрашивай когда угодно.»), подстрока осталась бы на
  // месте, и гард промолчал бы.
  //
  // Список исключений САМ ПОД ГАРДОМ (проверка ниже): опечатка в REPLACED не открывала бы
  // дыру молча — мёртвая строка исключения перестала бы что-либо прикрывать, а настоящая
  // строка v1 уехала бы в потери.
  //
  // Чего гард НЕ ловит и не притворяется, что ловит: он ОДНОСТОРОННИЙ (v2 ⊇ v1 − REPLACED)
  // и судит только о наличии строк — перестановка блоков и новый текст, противоречащий
  // старому, для него невидимы. Порядок и точный вид держит фикстура, смысл — гарды ниже.
  test('v2 не потерял ни одной строки v1, кроме осознанно заменённых', () => {
    const v2lines = new Set(ROUTINE_SYSTEM_PROMPT.split('\n'));
    const lost = ROUTINE_SYSTEM_PROMPT_V1.split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !REPLACED.has(line))
      .filter((line) => !v2lines.has(line));
    expect(lost).toEqual([]);
  });

  test('каждое исключение — настоящая строка v1, и в v2 её действительно нет', () => {
    const v1lines = new Set(ROUTINE_SYSTEM_PROMPT_V1.split('\n'));
    const v2lines = new Set(ROUTINE_SYSTEM_PROMPT.split('\n'));
    for (const line of REPLACED) {
      expect(v1lines.has(line)).toBe(true);
      expect(v2lines.has(line)).toBe(false);
    }
  });

  // --- Перенос гардов routine-v1 -------------------------------------------

  test('нет блока продолжений разговора: маркера [[suggest: в тексте нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('[[suggest:');
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('Продолжения разговора');
    // и в чат-промпте он ЕСТЬ — гард сравнивает две версии, а не проверяет опечатку
    expect(SYSTEM_PROMPT_V4).toContain('[[suggest:');
  });

  test('нет собеседника: сказано прямо, что текст по ходу работы никто не читает', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/Собеседника нет/);
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/Вопрос, написанный текстом, никто не прочитает/);
  });

  test('orbis_propose: терминален, обязателен в propose, форма операций сужена', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis_propose');
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/orbis_propose ТЕРМИНАЛЕН/);
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/без предложения[^.\n]*провалившимся/);
    // предусловия снимает сервер (V1.7) — модель их не передаёт
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/[Пп]редусловия[^.\n]*не передавай/);
  });

  test('вопрос — с run_id прогона; отчёт — финальным текстом', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis_checkpoint');
    expect(ROUTINE_SYSTEM_PROMPT).toContain('run_id');
    expect(ROUTINE_SYSTEM_PROMPT).toMatch(/отчёт ФИНАЛЬНЫМ текстом/);
  });

  test('запрет по объекту назван словами (V1.10): рутины и назначения не трогаем', () => {
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis/routine');
    expect(ROUTINE_SYSTEM_PROMPT).toContain('orbis/assignment');
  });

  test('протокол tool-результатов — тот же маркер, что сериализует toolResultMessage', () => {
    expect(TOOL_RESULT_MARKER).toBe('[tool_result:');
    expect(ROUTINE_SYSTEM_PROMPT).toContain(TOOL_RESULT_MARKER);
  });

  // --- Новое в v2 -----------------------------------------------------------

  // ОЧ.5. Ради этой пары строк и заведена версия: механизм построен Задачами 5–9, но
  // модель узнаёт о нём только отсюда. Утверждения проверяются В ОДНОЙ строке, а не
  // порознь по тексту: «orbis_ask» в одном абзаце и «прогон продолжается» в другом
  // складываются в смысл только в голове читателя гарда.
  test('orbis_ask объявлен НЕтерминальным: прогон продолжается, в результате pending_id', () => {
    const line = lineWith('orbis_ask — ');
    expect(line).toMatch(/НЕтерминальн/);
    expect(line).toMatch(/прогон ПРОДОЛЖАЕТСЯ/);
    expect(line).toContain('pending_id');
    expect(line).toMatch(/истори[юя] следующего прогона/);
  });

  test('orbis_checkpoint объявлен терминальным и оставлен для тупика', () => {
    const line = lineWith('orbis_checkpoint — ');
    expect(line).toMatch(/ТЕРМИНАЛЕН/);
    expect(line).toMatch(/бессмысленн/i);
  });

  // Ф-6b: снятая ложь v1. Негативный гард, потому что позитивные обходятся дописыванием —
  // строка «Единственный способ спросить — orbis_checkpoint», оставленная рядом с новой,
  // прошла бы все гарды выше и продолжила бы учить модель не пользоваться orbis_ask.
  test('ложь v1 снята: «единственного способа спросить» в тексте больше нет', () => {
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('Единственный способ спросить');
    expect(ROUTINE_SYSTEM_PROMPT).not.toContain('Он тоже терминален');
    expect(ROUTINE_SYSTEM_PROMPT_V1).toContain('Единственный способ спросить'); // v1 её содержит
  });

  // ОЧ.4. Отложенное действие возвращается моделью прочитанным как ОТКАЗ, если промпт о нём
  // молчит: status с незнакомым значением — самый похожий на ошибку ответ сервера.
  test('отложка в act: pending_confirmation с pendingId, это не ошибка, работа продолжается', () => {
    const line = lineWith('pending_confirmation');
    expect(line).toContain('pendingId');
    expect(line).toMatch(/НЕ ошибка/);
    expect(line).toMatch(/продолжай/);
  });

  test('запрещённое по объекту отклоняется сразу и не откладывается никогда', () => {
    const line = lineWith('не откладывается никогда');
    expect(line).toMatch(/автономи/);
    expect(line).toMatch(/инструкц/);
    expect(line).toMatch(/повтор/);
  });

  // ОЧ.10. Число в промпте — то же, что в константе сервера: разойдясь, они дадут модели
  // «пачка полна» на счёте, которого она не ждала, и она будет чинить не то.
  test('кап пачки: число из MAX_RUN_UNITS, отказ «пачка полна», требование группировать', () => {
    const line = lineWith('пачка полна');
    expect(line).toContain(`не больше ${MAX_RUN_UNITS}`);
    expect(line).toMatch(/Группируй/);
    expect(line).toMatch(/шаг/i);
  });

  // Ф-9a. Задача 9 добавила в строку истории новые части; их формат обязан быть объявлен —
  // иначе усечение «и ещё N решений» модель прочитает как отмену остальных карточек.
  test('история: новые части строки прогона названы промптом дословно', () => {
    const line = lineWith('и ещё N решений');
    expect(line).toContain('спрашивал:');
    expect(line).toContain('откладывал:');
    expect(line).toMatch(/не поместились/);
  });

  test('история: перечисление обратной связи включает отложенное и решения владельца', () => {
    const line = lineWith('[история прогонов]');
    expect(line).toMatch(/что откладывал/);
    expect(line).toMatch(/не переспрашивай/);
  });
});

describe('routineModeSection (V1.10, копия v1 без правок)', () => {
  const RUN_ID = '019e4466-aaaa-7e07-b5d4-64be9721da51';

  // Секция скопирована из routine-v1 БАЙТ В БАЙТ (правок в ней срез не требует), а
  // реэкспортировать её из v1 запрещено правилом версионирования. Копия без гарда
  // разъезжается молча, поэтому в каждом из трёх случаев результат сверяется с v1.
  test('propose: назван режим, run_id и бакет; сказано, что белый список не действует', () => {
    const args = {
      mode: 'propose' as const,
      allowedTools: [],
      runId: RUN_ID,
      bucket: '2026-08-17T07:00',
    };
    const s = routineModeSection(args);
    expect(s).toContain('режим: propose');
    expect(s).toContain(RUN_ID);
    expect(s).toContain('2026-08-17T07:00');
    expect(s).toContain('orbis_propose');
    expect(s).not.toContain('белый список правок:');
    expect(s).toBe(routineModeSectionV1(args));
  });

  test('act: перечислен ровно белый список владельца', () => {
    const args = {
      mode: 'act' as const,
      allowedTools: ['entity_update', 'relation_create'],
      runId: RUN_ID,
      bucket: 'manual:2026-08-17T12:00:00.000Z',
    };
    const s = routineModeSection(args);
    expect(s).toContain('режим: act');
    expect(s).toContain('entity_update, relation_create');
    expect(s).toContain('manual:2026-08-17T12:00:00.000Z');
    expect(s).toBe(routineModeSectionV1(args));
  });

  test('act с пустым списком: сказано, что менять граф нечем (а не молчание)', () => {
    const args = {
      mode: 'act' as const,
      allowedTools: [],
      runId: RUN_ID,
      bucket: '2026-08-17T07:00',
    };
    const s = routineModeSection(args);
    expect(s).toMatch(/белый список правок пуст/);
    expect(s).toBe(routineModeSectionV1(args));
  });
});

/**
 * Строка промпта, содержащая подстроку. Гарды нового поведения смотрят В ОДНУ строку, а не
 * в весь текст: утверждение «orbis_ask нетерминален» рассыпается, если его половины стоят в
 * разных абзацах, — модель читает строку целиком, а гард по всему тексту этого не заметит.
 */
function lineWith(needle: string): string {
  const found = ROUTINE_SYSTEM_PROMPT.split('\n').filter((line) => line.includes(needle));
  if (found.length !== 1) {
    throw new Error(`ожидалась ровно одна строка с «${needle}», найдено ${found.length}`);
  }
  return found[0] as string;
}
