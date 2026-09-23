// apps/server/test/gate-delegable.test.ts
// СТОРОЖ ЗАПИСИ КЛАССОМ (задача 14а, Р-И-39). Три потребителя тикета обязаны знать КЛАССЫ контракта
// делегирования и не знать ни имени свойства, ни его вариантов: значения живут в базе и меняются
// данными, а код с литералами требует выкатки (довод владельца 20.09).
//
// ЗАПРЕЩЕНО и почему именно это: `orbis/task_status`, `orbis/waiting_for` — АДРЕСА свойств, их
// называет привязка (`propertyOfSlot`); `inbox`, `planned` — ВАРИАНТЫ, у которых нет одноимённого
// класса, встретиться они могут только литералом значения.
// НЕ запрещено: `new`, `queued`, `in_progress`, `waiting`, `done` — ИМЕНА КЛАССОВ контракта, и знать
// их код обязан (в этом и состоит решение). Тексты `'waiting'`/`'done'` в ответе глагола
// (`FinishResult.ticket_status`) — те же имена классов; второй словарь на то же понятие развёл бы
// ответ и состояние.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

/** Корень репозитория: `bun test` идёт из `apps/server`, а pathspec'ы git отсчитываются от cwd. */
function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gate: git rev-parse упал: ${r.stderr}`);
  return r.stdout.trim();
}
function gitGrep(pattern: string, pathspec: readonly string[]): string[] {
  const r = spawnSync('git', ['grep', '-n', '-a', '-P', '-e', pattern, '--', ...pathspec], {
    cwd: repoRoot(),
    encoding: 'utf8',
  });
  // 0 — совпадения есть, 1 — нет, >1 — ошибка (нет PCRE2). Молчащий гейт хуже отсутствующего.
  if (r.status !== null && r.status > 1)
    throw new Error(`gate: git grep код ${r.status}: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

const FORBIDDEN = String.raw`orbis/task_status|orbis/waiting_for|\binbox\b|\bplanned\b`;

describe('гейт 14а: состояние тикета — только классом контракта делегирования', () => {
  test('глаголы исполнителя', () => {
    expect(gitGrep(FORBIDDEN, ['apps/server/src/agent-loop/verbs.ts'])).toEqual([]);
  });
  test('подметание брошенных прогонов', () => {
    expect(gitGrep(FORBIDDEN, ['apps/server/src/agent-loop/sweep.ts'])).toEqual([]);
  });
  test('ручка ответа на чекпойнт', () => {
    expect(gitGrep(FORBIDDEN, ['apps/server/src/routers/agent-run.ts'])).toEqual([]);
  });
  test('шаблон рабочий: те же токены в файле-свидетеле находятся', () => {
    // Пустой результат обязан значить «в файлах чисто», а не «шаблон собран неверно»: привязка задачи
    // называет и свойства, и варианты — на ней сторож проверяет сам себя.
    expect(
      gitGrep(FORBIDDEN, ['packages/shared/src/registry/builtin-aspects.ts']).length,
    ).toBeGreaterThan(0);
  });
});
