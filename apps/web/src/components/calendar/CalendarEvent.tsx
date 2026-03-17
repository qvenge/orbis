interface CalendarEventProps {
  title: string;
  startHour: number;
  startMinute: number;
  durationMin: number;
  color?: string;
  location?: string;
  onClick?: () => void;
}

export function CalendarEvent({
  title,
  startHour,
  startMinute,
  durationMin,
  color,
  location,
  onClick,
}: CalendarEventProps) {
  const topPx = (startHour * 60 + startMinute) * (48 / 60); // 48px per hour
  const heightPx = Math.max(durationMin * (48 / 60), 20); // min 20px
  const isShort = durationMin < 30;

  return (
    <button
      onClick={onClick}
      className="absolute left-0.5 right-0.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left transition-opacity duration-150 hover:opacity-90"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        backgroundColor: color ?? 'var(--color-primary)',
        opacity: 0.85,
      }}
    >
      <p className={`truncate font-medium text-white ${isShort ? 'text-[10px]' : 'text-xs'}`}>
        {title}
      </p>
      {!isShort && location && (
        <p className="truncate text-[10px] text-white/70">{location}</p>
      )}
    </button>
  );
}
