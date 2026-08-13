// `/vitest` entry augments Vitest's `expect` with jest-dom matchers (types + runtime);
// the bare '@testing-library/jest-dom' import only augments Jest, not Vitest 4.
import '@testing-library/jest-dom/vitest';

// Порог ожидания Testing Library намеренно НЕ трогаем. Сьют плавал не из-за него, а из-за
// переподписки процессора воркерами — лечится `maxWorkers` в vite.config.ts. На четырёх
// воркерах дефолтная секунда держит нагрузку: четыре стресс-прогона из четырёх зелёные.
// (Ещё четыре зелёных стресс-прогона на четырёх воркерах шли с поднятым порогом и про
// саму секунду не говорят ничего — засчитывать их сюда нельзя.)
//
// Поднимать `asyncUtilTimeout` до 5000 прямо вредно: это ровно дефолтный `testTimeout`
// Vitest, а `waitFor` стартует не в нулевой момент теста, поэтому бюджет теста истекает
// РАНЬШЕ бюджета ожидания — всегда. Вместо «Unable to find an element by: [data-testid=…]»
// с дампом DOM и строкой самого ожидания падение приходит как «Test timed out in 5000ms»
// со строкой it(), то есть без единой улики о том, чего тест не дождался. Побочно и сами
// 5000 недостижимы: реальный потолок ожидания равен 5000 минус уже потраченное.
// Если порог когда-нибудь понадобится — поднимать его только вместе с `testTimeout`,
// с заметным зазором между ними.

import { installProseMirrorJsdomPolyfills } from './prosemirror-polyfill';

installProseMirrorJsdomPolyfills();
