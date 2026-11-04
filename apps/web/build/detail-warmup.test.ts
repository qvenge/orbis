import { expect, test } from 'vitest';
import { detailWarmupAssets } from './detail-warmup';

test('the hashed detail assets exclude entry dependencies and retain the deployment base', () => {
  const bundle = {
    'assets/index-1.js': { type: 'chunk', imports: ['assets/shared-2.js'] },
    'assets/shared-2.js': {
      type: 'chunk',
      imports: [],
      viteMetadata: { importedCss: new Set(['assets/shared-3.css']) },
    },
    'assets/DetailScreen-4.js': {
      type: 'chunk',
      facadeModuleId: '/build/apps/web/src/features/entity-detail/DetailScreen.tsx',
      imports: ['assets/shared-2.js', 'assets/detail-dep-5.js'],
      viteMetadata: { importedCss: new Set(['assets/detail-6.css', 'assets/shared-3.css']) },
    },
    'assets/detail-dep-5.js': { type: 'chunk', imports: [] },
    'assets/BodyEditor-7.js': { type: 'chunk', imports: [] },
  } as const;
  expect(detailWarmupAssets(bundle, 'assets/index-1.js', '/nested/app/')).toEqual([
    '/nested/app/assets/DetailScreen-4.js',
    '/nested/app/assets/detail-6.css',
    '/nested/app/assets/detail-dep-5.js',
  ]);
  expect(detailWarmupAssets(bundle, 'assets/index-1.js', './')[0]).toBe(
    './assets/DetailScreen-4.js',
  );
});
