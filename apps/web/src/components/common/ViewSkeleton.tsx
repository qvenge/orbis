export function ViewSkeleton() {
  return (
    <div className="flex h-full flex-col animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="h-4 w-4 rounded bg-surface-hover" />
        <div className="h-4 w-24 rounded bg-surface-hover" />
      </div>

      {/* Content skeleton */}
      <div className="space-y-3 p-4">
        <div className="h-20 rounded-lg bg-surface-hover" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-16 rounded-lg bg-surface-hover" />
          <div className="h-16 rounded-lg bg-surface-hover" />
        </div>
        <div className="h-32 rounded-lg bg-surface-hover" />
      </div>
    </div>
  );
}
