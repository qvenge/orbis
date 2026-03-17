import { useState } from 'react';

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  formatTotal?: (v: number) => string;
}

export function DonutChart({
  segments,
  size = 120,
  strokeWidth = 14,
  formatTotal,
}: DonutChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;

  const viewSize = 100;
  const center = viewSize / 2;
  const radius = (viewSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulated = 0;
  const arcs = segments.map((s, i) => {
    const fraction = s.value / total;
    const dashLength = fraction * circumference;
    const gap = circumference - dashLength;
    const offset = -(accumulated * circumference) + circumference * 0.25;
    accumulated += fraction;

    return {
      ...s,
      index: i,
      fraction,
      dashArray: `${dashLength} ${gap}`,
      dashOffset: offset,
    };
  });

  const displayTotal = formatTotal ? formatTotal(total) : total.toLocaleString();

  return (
    <div className="relative inline-flex flex-col items-center">
      <svg
        viewBox={`0 0 ${viewSize} ${viewSize}`}
        width={size}
        height={size}
        className="overflow-visible"
      >
        {/* Background ring */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--color-surface-hover)"
          strokeWidth={strokeWidth}
        />

        {/* Segments */}
        {arcs.map((arc) => (
          <circle
            key={arc.index}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={hoveredIndex === arc.index ? strokeWidth + 3 : strokeWidth}
            strokeDasharray={arc.dashArray}
            strokeDashoffset={arc.dashOffset}
            strokeLinecap="butt"
            className="cursor-default transition-all duration-150"
            onMouseEnter={() => setHoveredIndex(arc.index)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}

        {/* Center text */}
        <text
          x={center}
          y={center - 3}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--color-text)"
          fontSize={12}
          fontWeight={700}
          fontFamily="inherit"
        >
          {displayTotal}
        </text>
        <text
          x={center}
          y={center + 10}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--color-text-muted)"
          fontSize={6}
          fontFamily="inherit"
        >
          total
        </text>
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div className="pointer-events-none absolute -bottom-7 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-text shadow-md">
          <span style={{ color: arcs[hoveredIndex].color }}>
            {arcs[hoveredIndex].label}
          </span>
          {' — '}
          {arcs[hoveredIndex].value.toLocaleString()}
          {' ('}
          {Math.round(arcs[hoveredIndex].fraction * 100)}
          {'%)'}
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {segments.map((s, i) => (
          <div
            key={i}
            className="flex items-center gap-1 text-[10px] text-text-secondary"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
