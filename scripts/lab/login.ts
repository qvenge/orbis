// scripts/lab/login.ts — один раз войти в прод в лабораторном профиле (ПВ-2, РП-25).
import { chromium } from 'playwright-core';
import { LAB_URL, PROFILE_DIR } from './scenario';

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(LAB_URL);
console.log(
  `Профиль: ${PROFILE_DIR}. Запросите ссылку входа в ЭТОМ окне; письмо откроется в обычном браузере —`,
);
console.log(
  'скопируйте из него ссылку и вставьте в адресную строку этого окна. Ждём экран приложения (до 15 минут)…',
);
await page.waitForSelector('main[data-testid="screen-content"]', { timeout: 15 * 60_000 });
console.log('Вход сохранён в профиле.');
await ctx.close();
