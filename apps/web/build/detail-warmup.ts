import type { Plugin } from 'vite';

type Asset =
  | { type: 'asset' }
  | {
      type: 'chunk';
      facadeModuleId?: string | null;
      imports: readonly string[];
      viteMetadata?: { importedCss: ReadonlySet<string> };
    };

export function detailWarmupAssets(
  bundle: Readonly<Record<string, Asset>>,
  entry: string,
  base: string,
) {
  const detail = Object.keys(bundle).find((file) => {
    const asset = bundle[file];
    return (
      asset?.type === 'chunk' &&
      asset.facadeModuleId?.endsWith('/src/features/entity-detail/DetailScreen.tsx')
    );
  });
  if (!detail) return [];
  function closure(start: string) {
    const files = new Set<string>();
    function visit(file: string) {
      if (files.has(file)) return;
      const chunk = bundle[file];
      if (chunk?.type !== 'chunk') return;
      files.add(file);
      for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
      for (const imported of chunk.imports) visit(imported);
    }
    visit(start);
    return files;
  }
  const startup = closure(entry);
  return [...closure(detail)].filter((file) => !startup.has(file)).map((file) => base + file);
}

export function detailWarmup(): Plugin {
  let base = '/';
  return {
    name: 'orbis-detail-warmup',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk }) {
        if (!bundle || !chunk) return;
        const assets = detailWarmupAssets(bundle, chunk.fileName, base);
        if (assets.length)
          return [
            {
              tag: 'meta',
              attrs: { name: 'orbis-detail-warmup', content: JSON.stringify(assets) },
            },
          ];
      },
    },
  };
}
