// `/vitest` entry augments Vitest's `expect` with jest-dom matchers (types + runtime);
// the bare '@testing-library/jest-dom' import only augments Jest, not Vitest 4.
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// waitFor/findBy по умолчанию ждут 1 с. Сьют гоняет 57 файлов в параллель в jsdom, и на
// загруженной машине этого не хватало: три прогона на одном коммите дали 3, 2 и 0 падений
// — каждый раз по таймауту и каждый раз в РАЗНЫХ файлах. Порог поднят до 5 с: тест, который
// не дождётся никогда, всё равно упадёт, просто позже, а ложные падения от планировщика
// исчезают. Это не запас «на всякий случай»: без зелёной базы регресс неотличим от шума.
configure({ asyncUtilTimeout: 5000 });
