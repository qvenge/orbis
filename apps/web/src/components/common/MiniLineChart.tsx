import { useState } from 'react';

interface LineDatum {
  label: string;
  value: number;
}

interface MiniLineChartProps {
  data: LineDatum[];
  color?: string;
  height?: number;
  formatValue?: (v: number) => string;
  showArea?: boolean;
}

export function MiniLineChart({
  data,
  color = 'var(--color-primary)',
  height = 120,
  formatValue = (v) => String(v),
  showArea = true,
}: MiniLineChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (data.length < 2) return null;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const minVal = Math.min(...data.map((d) => d.value), 0);
  const range = maxVal - minVal || 1;

  const labelHeight = 18;
  const topPadding = 8;
  const chartHeight = height - labelHeight - topPadding;
  const totalWidth = 100;
  const paddingX = 4;
  const innerWidth = totalWidth - paddingX * 2;

  const points = data.map((d, i) => ({
    x: paddingX + (i / (data.length - 1)) * innerWidth,
    y: topPadding + chartHeight - ((d.value - minVal) / range) * chartHeight,
  }));

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');

  const areaPath = [
    `M ${points[0].x},${topPadding + chartHeight}`,
    `L ${points.map((p) => `${p.x},${p.y}`).join(' L ')}`,
    `L ${points[points.length - 1].x},${topPadding + chartHeight}`,
    'Z',
  ].join(' ');

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${totalWidth} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="overflow-visible"
      >
        {/* Area fill */}
        {showArea && (
          <path d={areaPath} fill={color} opacity={0.1} />
        )}

        {/* Line */}
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dots + hit areas */}
        {points.map((p, i) => (
          <g
            key={i}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {/* Hit area */}
            <rect
              x={p.x - (innerWidth / (data.length - 1)) / 2}
              y={topPadding}
              width={innerWidth / (data.length - 1)}
              height={chartHeight + labelHeight}
              fill="transparent"
            />
            {/* Dot */}
            <circle
              cx={p.x}
              cy={p.y}
              r={hoveredIndex === i ? 2.5 : 1.5}
              fill={color}
              className="transition-all duration-150"
            />
            {/* Label */}
            <text
              x={p.x}
              y={height - 2}
              textAnchor="middle"
              fill="var(--color-text-muted)"
              fontSize={3.5}
              fontFamily="inherit"
            >
              {data[i].label}
            </text>
          </g>
        ))}
      </svg>

      {/* Tooltip */}
      {hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute -top-7 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-text shadow-md"
          style={{
            left: `${(points[hoveredIndex].x / totalWidth) * 100}%`,
            transform: 'translateX(-50%)',
          }}
        >
          {formatValue(data[hoveredIndex].value)}
        </div>
      )}
    </div>
  );
}
