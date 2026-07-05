export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Загрузка"
      className={`animate-pulse rounded-md bg-surface-2 ${className}`}
    />
  );
}
