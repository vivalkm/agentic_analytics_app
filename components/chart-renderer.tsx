'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { ChartConfig, QueryResult } from '@/lib/types';

interface ChartRendererProps {
  config: ChartConfig;
  results: QueryResult;
}

const COLORS = [
  'hsl(217, 91%, 60%)',  // blue
  'hsl(142, 71%, 45%)',  // green
  'hsl(38, 92%, 50%)',   // amber
  'hsl(350, 89%, 60%)',  // rose
  'hsl(262, 83%, 58%)',  // violet
  'hsl(190, 90%, 50%)',  // cyan
  'hsl(24, 95%, 53%)',   // orange
  'hsl(330, 81%, 60%)',  // pink
];

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const num = Number(value);
  if (isNaN(num)) return String(value);
  if (Math.abs(num) >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num % 1 === 0 ? num.toString() : num.toFixed(2);
}

function formatXLabel(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Shorten date strings for display
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(5, 10); // MM-DD
  }
  // Truncate long labels
  return s.length > 15 ? s.substring(0, 12) + '...' : s;
}

export function ChartRenderer({ config, results }: ChartRendererProps) {
  const data = useMemo(() => {
    return results.rows.map((row) => {
      const entry: Record<string, unknown> = {};
      entry[config.xKey] = row[config.xKey];
      for (const yKey of config.yKeys) {
        const val = row[yKey];
        entry[yKey] = val !== null && val !== undefined ? Number(val) : 0;
      }
      return entry;
    });
  }, [results.rows, config.xKey, config.yKeys]);

  if (config.type === 'none' || data.length === 0) return null;

  const commonTooltipStyle = {
    contentStyle: {
      backgroundColor: 'hsl(240, 10%, 12%)',
      border: '1px solid hsl(240, 6%, 20%)',
      borderRadius: '8px',
      fontSize: '12px',
      color: 'hsl(0, 0%, 90%)',
    },
    labelStyle: { color: 'hsl(0, 0%, 65%)' },
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {config.title && (
        <p className="mb-3 text-xs font-medium text-muted-foreground">
          {config.title}
        </p>
      )}
      <ResponsiveContainer width="100%" height={300}>
        {config.type === 'bar' ? (
          <BarChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(240, 6%, 20%)" />
            <XAxis
              dataKey={config.xKey}
              tickFormatter={formatXLabel}
              tick={{ fontSize: 11, fill: 'hsl(0, 0%, 55%)' }}
              axisLine={{ stroke: 'hsl(240, 6%, 20%)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatValue}
              tick={{ fontSize: 11, fill: 'hsl(0, 0%, 55%)' }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              formatter={(value) => formatValue(value)}
              labelFormatter={(label) => String(label)}
              {...commonTooltipStyle}
            />
            {config.yKeys.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: '11px', color: 'hsl(0, 0%, 65%)' }}
              />
            )}
            {config.yKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                fill={COLORS[i % COLORS.length]}
                radius={[3, 3, 0, 0]}
                maxBarSize={50}
              />
            ))}
          </BarChart>
        ) : config.type === 'line' ? (
          <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(240, 6%, 20%)" />
            <XAxis
              dataKey={config.xKey}
              tickFormatter={formatXLabel}
              tick={{ fontSize: 11, fill: 'hsl(0, 0%, 55%)' }}
              axisLine={{ stroke: 'hsl(240, 6%, 20%)' }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatValue}
              tick={{ fontSize: 11, fill: 'hsl(0, 0%, 55%)' }}
              axisLine={false}
              tickLine={false}
              width={60}
            />
            <Tooltip
              formatter={(value) => formatValue(value)}
              labelFormatter={(label) => String(label)}
              {...commonTooltipStyle}
            />
            {config.yKeys.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: '11px', color: 'hsl(0, 0%, 65%)' }}
              />
            )}
            {config.yKeys.map((key, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={data.length <= 30}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        ) : (
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={110}
              paddingAngle={2}
              dataKey={config.yKeys[0]}
              nameKey={config.xKey}
              label={({ name, percent }) =>
                `${formatXLabel(name)} ${((percent ?? 0) * 100).toFixed(0)}%`
              }
              labelLine={{ stroke: 'hsl(0, 0%, 45%)' }}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => formatValue(value)}
              {...commonTooltipStyle}
            />
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
