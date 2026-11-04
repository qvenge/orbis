/** The foreground loader used by the route and startup. */
export function loadDetailScreen() {
  return import('../features/entity-detail/DetailScreen').then(({ DetailScreen }) => ({
    default: DetailScreen,
  }));
}

let warming = false;

/** Warm HTTP cache without executing Vite's import or occupying the module map. */
export function warmDetailScreen(): void {
  if (warming) return;
  const content = document.querySelector<HTMLMetaElement>(
    'meta[name="orbis-detail-warmup"]',
  )?.content;
  if (!content) return;
  warming = true;
  try {
    const assets: unknown = JSON.parse(content);
    if (!Array.isArray(assets)) return;
    for (const asset of assets) {
      if (typeof asset !== 'string') continue;
      const url = new URL(asset, document.baseURI);
      if (url.origin !== location.origin) continue;
      void fetch(url, { cache: 'force-cache', redirect: 'error' })
        .then(async (response) => {
          if (response.ok) await response.arrayBuffer();
          else await response.body?.cancel();
        })
        .catch(() => {});
    }
  } catch {
    // Invalid metadata or unavailable asset affects only the speculative warmup.
  }
}
