import type { CustomViewConfig, StatusStripMetric } from './types.ts';

export interface ViewPackage {
  version: 1;
  aspect: {
    id: string;
    name: string;
    schema: Record<string, unknown>;
    aiInstructions?: string;
    tagMappings: string[];
  };
  view: CustomViewConfig;
  statusMetric?: StatusStripMetric;
  exportedAt: string;
}

export function exportViewPackage(
  aspect: ViewPackage['aspect'],
  view: CustomViewConfig,
  metric?: StatusStripMetric,
): string {
  const pkg: ViewPackage = {
    version: 1,
    aspect,
    view,
    ...(metric ? { statusMetric: metric } : {}),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(pkg, null, 2);
}

export function validateViewPackage(json: string): ViewPackage | { error: string } {
  try {
    const pkg = JSON.parse(json) as Record<string, unknown>;

    if (pkg.version !== 1) return { error: 'Unsupported package version' };
    if (!pkg.aspect || typeof pkg.aspect !== 'object') return { error: 'Missing aspect definition' };
    if (!pkg.view || typeof pkg.view !== 'object') return { error: 'Missing view config' };

    const aspect = pkg.aspect as Record<string, unknown>;
    if (!aspect.id || !aspect.name || !aspect.schema) {
      return { error: 'Aspect must have id, name, and schema' };
    }

    const view = pkg.view as Record<string, unknown>;
    if (!view.id || !view.name || !view.aspectId || !view.layout) {
      return { error: 'View must have id, name, aspectId, and layout' };
    }

    return pkg as unknown as ViewPackage;
  } catch {
    return { error: 'Invalid JSON' };
  }
}
