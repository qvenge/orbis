import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, mintGraph, truncateAll } from '../test/helpers';
import {
  type Identity,
  identitiesForScheduler,
  identityOfGrant,
  identityOfPerson,
  parseAccountId,
  parseGraphId,
} from './identity';

const { db, client } = appDb(); // { db, client } — как во всех сьютах (db/with-identity.test.ts:10)
// Константы несут БРЕНД (а не голый string): иначе `toBe` сравнивал бы `AccountId` со
// `string` и сам тест не компилировался бы — те же значения, что в брифе.
const ACCOUNT = parseAccountId('0aa00000-0000-4000-8000-0000000000a1');
const GRAPH = parseGraphId('0bb00000-0000-4000-8000-0000000000b1'); // НЕ равен аккаунту намеренно
// Граф-организация с четырьмя членами — фикстура предиката JOIN резолвера тика (см. последний кейс).
const GRAPH2 = parseGraphId('0cc00000-0000-4000-8000-0000000000c1');
const OPERATOR = parseAccountId('0dd00000-0000-4000-8000-0000000000d1');
const EX_OWNER = parseAccountId('0dd00000-0000-4000-8000-0000000000d2');
const OWNER = parseAccountId('0dd00000-0000-4000-8000-0000000000d3');
const LATE_OWNER = parseAccountId('0dd00000-0000-4000-8000-0000000000d4');
// ГРАФ БЕЗ `user_settings`, заведённый ЭТИМ файлом (а не оставшийся от соседних сьютов).
// Без него пин «онбординг не пройден → тик не обходит» (последний кейс резолвера 3) различающим
// НЕ был: в изолированном прогоне `truncateAll` сносит все графы, кроме личностей процесса, а
// этот файл ни одной не минтил — в базе оставался ровно `GRAPH`, у которого настройки ЕСТЬ.
// Измерено фикс-волной: с мутацией «снять источник `user_settings` у резолвера» изолированный
// `bun test src/identity.test.ts` был 8 pass / 0 fail. `mintGraph()` регистрирует `ensureGraphs`
// хуком этой области, а `truncateAll` личности процесса не сносит — граф жив к каждому кейсу.
const NO_SETTINGS = mintGraph();

test('границы внешнего мира: не-UUID отклоняется, регистр нормализуется', () => {
  expect(() => parseAccountId('не uuid')).toThrow(/UUID/);
  expect(() => parseGraphId('')).toThrow(/UUID/);
  expect(parseAccountId(ACCOUNT.toUpperCase())).toBe(ACCOUNT);
  expect(parseGraphId(GRAPH.toUpperCase())).toBe(GRAPH);
});

test('резолвер 1 (JWT): граф человека — его личный граф; тождество id живёт только здесь', () => {
  const who = identityOfPerson(parseAccountId(ACCOUNT));
  expect(who.actor).toBe(ACCOUNT);
  expect(who.graph as string).toBe(ACCOUNT);
});

test('резолвер 2 зовут РОВНО два Bearer-сайта прод-кода — третий был бы новым местом рождения пары', () => {
  // Смысл сторожа. `identityOfGrant` экспортирован и принимает ЛЮБУЮ пару брендов: граф берётся
  // из аргумента, а не из членства, — значит каждый новый вызов это новое место, где решается
  // «в каком графе идёт транзакция». Типу такое место невидимо, дно тут одно — RLS (нужен грант),
  // а в ЛИЧНОМ графе (актор = граф) оно не сработает и расхождение вылезет только на ступени 2.
  // Поэтому список сайтов пинится грепом — тем же приёмом, что сторож пометок
  // (`test/gate-c8-18.test.ts`), у которого литерал пометки собирается, а не пишется.
  // Сам вызов пишется в шаблоне, а не литералом: литерал в этом файле стал бы совпадением.
  const pattern = `\\b${['identity', 'Of', 'Grant'].join('')}\\(`;
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (root.status !== 0) throw new Error(`сторож: git rev-parse упал: ${root.stderr}`);
  const r = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '-P',
      '-e',
      pattern,
      '--',
      'apps',
      'packages',
      'scripts',
      ':!*.test.ts',
      ':!*.test.tsx',
      ':!apps/server/src/identity.ts',
    ],
    { cwd: root.stdout.trim(), encoding: 'utf8' },
  );
  // Код >1 — отказ окружения (нет PCRE2), и принять его за «чисто» нельзя: молчащий сторож
  // хуже отсутствующего (тот же разбор — `check-legacy-form.ts`).
  if (r.status !== null && r.status > 1) throw new Error(`сторож: git grep код ${r.status}`);
  const files = r.stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.slice(0, l.indexOf(':')));
  expect(files).toEqual(['apps/server/src/context.ts', 'apps/server/src/mcp/server.ts']);
});

test('резолвер 2 (Bearer): оба id — из строки гранта, и они НЕ обязаны совпадать', () => {
  const who = identityOfGrant({ accountId: parseAccountId(ACCOUNT), graphId: parseGraphId(GRAPH) });
  // Сверяется ПРОЕКЦИЯ из двух полей, а не форма целиком, и это ограничение названо вслух:
  // `toEqual(<литерал>)` прямо на `Identity` не компилируется (замок типа Р-ИГ-12 — литерал
  // парой не является), а проекция лишнего поля в паре не поймала бы. Форму ЦЕЛИКОМ держит
  // `toContainEqual` резолвера 3 ниже: он сверяет элемент массива глубоким равенством, и пара
  // с лишним полем ему уже не равна.
  expect({ actor: who.actor, graph: who.graph }).toEqual({ actor: ACCOUNT, graph: GRAPH });
});

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end(); // незакрытый пул держит прогон
});

test('замок типа: пару нельзя собрать литералом снаружи резолверов (Р-ИГ-11)', () => {
  // Смысл пина: до Р-ИГ-11 литерал с ВЕРНЫМИ брендами полей был законной парой — не приведением,
  // и компилятор его пропускал (мутация MR2 ре-ревью). Держал его только построчный греп-гейт,
  // слепой к многострочной записи (Ф-Г-50): biome её не схлопывает — измерено. Теперь обе формы
  // отбивает тип, а гейт остаётся вторым барьером.
  //
  // Р-ИГ-12 добавил третью форму — ПРОИЗВОДНУЮ пару (`{ ...who, graph: other }`): она обходила и
  // тип (спред фантомного поля-символа не требовал), и маркер (в спреде нет второго слова).
  // Пин на неё — ниже, отдельным кейсом: она вероятнее прочих, `Identity` лежит в `ctx.identity`
  // на каждом прод-пути.
  // @ts-expect-error — однострочный литерал: поля верных брендов, но нет приватного поля-замка
  const oneLine: Identity = { actor: ACCOUNT, graph: GRAPH };
  // @ts-expect-error — ТА ЖЕ сборка, разложенная на строки: греп её не видит, тип видит
  const multiLine: Identity = {
    actor: ACCOUNT,
    graph: GRAPH,
  };
  void oneLine;
  void multiLine;
  // Законный путь — резолвер; он же доказывает, что пин запрещает именно ЛИТЕРАЛ, а не форму.
  expect(identityOfGrant({ accountId: ACCOUNT, graphId: GRAPH }).graph).toBe(GRAPH);
});

test('замок типа: производную пару не сделать спредом из готовой (Р-ИГ-12)', () => {
  const who = identityOfPerson(ACCOUNT);
  // @ts-expect-error — спред даёт обычный объект: приватного поля-замка у него нет
  const derived: Identity = { ...who, graph: GRAPH };
  void derived;
  // `Object.assign` компилятор ПРОПУСКАЕТ (пересечение типов приватное поле сохраняет) — эту
  // форму ловит только греп-маркер `identity-pair`, и потому директивы здесь нет. Барьеров два,
  // и это честнее, чем обещать один непробиваемый: см. докблок замка в `identity.ts`.
  expect(identityOfGrant({ accountId: who.actor, graphId: GRAPH }).graph).toBe(GRAPH);
});

test('резолвер 3 (тик): пара берётся из graph_members, а не из равенства id', async () => {
  // Граф, у которого держатель гранта owner — ДРУГОЙ uuid: в бою такого в v1 нет (личный граф),
  // но только так видно, что актор приходит из строки членства, а не копируется из id графа.
  const admin = adminDb();
  await admin.db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${GRAPH}::uuid, 'organization', NULL)`,
    );
    await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${GRAPH}::uuid, ${ACCOUNT}::uuid, 'owner', ${ACCOUNT}::uuid)`);
    await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${GRAPH}::uuid)`);
  });
  await admin.client.end();
  const pairs = await identitiesForScheduler(db); // под orbis_app, без идентичности
  expect(pairs).toContainEqual({ actor: ACCOUNT, graph: GRAPH });
  const graphs = pairs.map((p) => p.graph);
  expect(graphs).toEqual([...graphs].sort()); // порядок обхода детерминирован (два деплоя Render)
  expect(new Set(graphs).size).toBe(graphs.length); // один актор на граф
});

test('резолвер 3: граф без строки настроек (онбординг не пройден) тик не обходит', async () => {
  // Различающим кейс делает СВОЙ граф `NO_SETTINGS`: он заведён этим файлом, грант owner у него
  // есть, а строки `user_settings` нет — ровно «онбординг не пройден». Раньше на его месте были
  // графы, оставленные ДРУГИМИ файлами, и в изолированном прогоне кейс проходил при любом
  // резолвере (см. докблок константы).
  const pairs = await identitiesForScheduler(db);
  // Сравнение СПИСКОМ, а не `every`: на пустом массиве `every` истинен, и тест был бы
  // зелёным даже если бы резолвер не возвращал вообще ничего (находка гейт-ревью Г-3).
  expect(pairs.map((p) => p.graph)).toEqual([GRAPH]);
  // И тот, кого в списке быть не должно, назван поимённо — иначе читателю не видно, чем
  // именно этот кейс отличается от соседнего.
  expect(pairs.map((p) => p.graph)).not.toContain(NO_SETTINGS);
});

test('резолвер 3: актор — держатель ДЕЙСТВУЮЩЕГО гранта owner, а не первый член графа', async () => {
  // Три клаузы предиката JOIN пинятся ОДНОЙ фикстурой, и каждая — своим «отвлекающим» членом:
  //   `grant_kind = 'owner'`  — оператор с САМЫМ РАННИМ issued_at не должен стать актором;
  //   `revoked_at IS NULL`    — отозванный owner, тоже более ранний, не должен стать актором;
  //   ORDER BY issued_at      — из двух ДЕЙСТВУЮЩИХ owner'ов берётся ранний (DISTINCT ON).
  // Случай «у графа не осталось действующего owner» не проверяется здесь НАМЕРЕННО: его
  // запрещает отложенный триггер И-1 (`graph_members_keep_owner`, 0020) — отзыв последнего
  // владельца даёт 23514 на коммите, то есть такого графа в базе не бывает по построению.
  const admin = adminDb();
  await admin.db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${GRAPH2}::uuid, 'organization', NULL)`,
    );
    await tx.execute(sql`INSERT INTO graph_members
      (id, graph_id, account_id, grant_kind, issued_by, issued_at, revoked_at) VALUES
      (gen_random_uuid(), ${GRAPH2}::uuid, ${OPERATOR}::uuid, 'operator', ${OPERATOR}::uuid, '2020-01-01Z', NULL),
      (gen_random_uuid(), ${GRAPH2}::uuid, ${EX_OWNER}::uuid, 'owner',    ${EX_OWNER}::uuid, '2021-01-01Z', now()),
      (gen_random_uuid(), ${GRAPH2}::uuid, ${OWNER}::uuid,    'owner',    ${OWNER}::uuid,    '2022-01-01Z', NULL),
      (gen_random_uuid(), ${GRAPH2}::uuid, ${LATE_OWNER}::uuid, 'owner',  ${LATE_OWNER}::uuid, '2023-01-01Z', NULL)`);
    await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${GRAPH2}::uuid)`);
  });
  await admin.client.end();
  const pairs = await identitiesForScheduler(db);
  expect(pairs).toContainEqual({ actor: OWNER, graph: GRAPH2 });
  // И ровно одна пара на граф: `DISTINCT ON (graph_id)` не отдаёт трёх владельцев тремя строками.
  expect(pairs.filter((p) => p.graph === GRAPH2)).toHaveLength(1);
});
