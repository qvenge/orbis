import { useState } from 'react';

interface BarDatum {
  label: string;
  value: number;
}

interface MiniBarChartProps {
  data: BarDatum[];
  color?: string;
  height?: number;
  formatValue?: (v: number) => string;
}

export function MiniBarChart({
  data,
  color = 'var(--color-primary)',
  height = 120,
  formatValue = (v) => String(v),
}: MiniBarChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (data.length === 0) return null;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const labelHeight = 18;
  const topPadding = 4;
  const chartHeight = height - labelHeight - topPadding;
  const barGap = 2;
  const totalWidth = 100;
  const barWidth = Math.max((totalWidth - barGap * (data.length - 1)) / data.length, 2);

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${totalWidth} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="overflow-visible"
      >
        {data.map((d, i) => {
          const barH = (d.value / maxVal) * chartHeight;
          const x = i * (barWidth + barGap);
          const y = topPadding + chartHeight - barH;
          const isHovered = hoveredIndex === i;

          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              className="cursor-default"
            >
              {/* Hit area */}
              <rect
                x={x}
                y={topPadding}
                width={barWidth}
                height={chartHeight + labelHeight}
                fill="transparent"
              />
              {/* Bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barH, 1)}
                rx={1}
                fill={color}
                opacity={isHovered ? 1 : 0.7}
                className="transition-opacity duration-150"
              />
              {/* Label */}
              <text
                x={x + barWidth / 2}
                y={height - 2}
                textAnchor="middle"
                fill="var(--color-text-muted)"
                fontSize={3.5}
                fontFamily="inherit"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute -top-7 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-text shadow-md"
          style={{
            left: `${((hoveredIndex * (barWidth + barGap) + barWidth / 2) / totalWidth) * 100}%`,
            transform: 'translateX(-50%)',
          }}
        >
          {formatValue(data[hoveredIndex].value)}
        </div>
      )}
    </div>
  );
}
