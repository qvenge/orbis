interface AspectCardProps {
  title: string;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}

export function AspectCard({ title, children, headerRight }: AspectCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted">{title}</p>
        {headerRight}
      </div>
      {children}
    </div>
  );
}
