// `/vitest` entry augments Vitest's `expect` with jest-dom matchers (types + runtime);
// the bare '@testing-library/jest-dom' import only augments Jest, not Vitest 4.
import '@testing-library/jest-dom/vitest';
