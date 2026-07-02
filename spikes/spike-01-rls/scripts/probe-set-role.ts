// B7-пробник: вариант «SET LOCAL ROLE authenticated» внутри транзакции.
// Вопрос: снимает ли он граблю grants на схему auth (у authenticated они есть
// из коробки) при сохранении изоляции. Не полная матрица — быстрый вердикт для findings.
import postgres from 'postgres';

const A = crypto.randomUUID();
const B = crypto.randomUUID();

const admin = postgres(process.env.DATABASE_URL_ADMIN!, { max: 1, prepare: false, onnotice: () => {} });
const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, prepare: false, onnotice: () => {} });

const claims = (sub: string) => JSON.stringify({ sub, role: 'authenticated' });
const report: Record<string, unknown> = {};

try {
  // Членство: SET ROLE доступен только членам роли
  await admin`grant authenticated to orbis_app`;
  // Гранты для authenticated (зеркало default privileges Supabase на своих таблицах)
  await admin`grant select, insert, update, delete on spike_items to authenticated`;
  await admin`truncate table spike_items`;

  await app.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims(A)}, true)`;
    await tx.unsafe('set local role authenticated');
    await tx`insert into spike_items (owner_id, title) values (${A}, 'role-a')`;
    report['insert_as_A'] = 'ok';
    report['current_user_inside'] = (await tx`select current_user`)[0]!.current_user;
    // Прямой auth.uid() — под authenticated должен работать (грабля orbis_app снята?)
    report['auth_uid_direct'] = (await tx`select auth.uid() as uid`)[0]!.uid;
  });

  await app.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims(B)}, true)`;
    await tx.unsafe('set local role authenticated');
    report['B_sees_A_rows'] = (await tx`select 1 from spike_items where owner_id = ${A}`).length;
  });

  report['current_user_after_tx'] = (await app`select current_user`)[0]!.current_user;
  report['bare_select_rows'] = (await app`select 1 from spike_items`).length;

  console.log(JSON.stringify(report, null, 2));
  const ok =
    report['current_user_inside'] === 'authenticated' &&
    report['auth_uid_direct'] === A &&
    report['B_sees_A_rows'] === 0 &&
    report['current_user_after_tx'] === 'orbis_app' &&
    report['bare_select_rows'] === 0;
  console.log(ok ? 'B7: PASS — SET LOCAL ROLE authenticated работает и изолирует' : 'B7: FAIL');
  process.exit(ok ? 0 : 1);
} finally {
  await admin`truncate table spike_items`.catch(() => {});
  await admin.end();
  await app.end();
}
