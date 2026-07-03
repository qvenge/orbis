// Общий сетап тестов. Admin-клиент используется ТОЛЬКО здесь и в контрольных
// ассертах ((ж), (л)) — ни один продуктовый путь спайка его не знает.
import postgres from 'postgres';

export const USER_A = crypto.randomUUID();
export const USER_B = crypto.randomUUID();

export function makeAdmin() {
  return postgres(process.env.DATABASE_URL_ADMIN!, { max: 1, prepare: false, onnotice: () => {} });
}

export async function truncateItems() {
  const admin = makeAdmin();
  try {
    await admin`truncate table spike_items`;
  } finally {
    await admin.end();
  }
}

export function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
