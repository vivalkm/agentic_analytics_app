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

/**
 * Pivot raw rows into grouped bar data.
 * Input rows: [{month: "Jan", region: "US", revenue: 100}, {month: "Jan", region: "EU", revenue: 80}, ...]
 * Output: [{month: "Jan", "US": 100, "EU": 80}, ...] with groupValues = ["US", "EU"]
 */
function pivotGroupedData(
  rows: Record<string, unknown>[],
  xKey: string,
  groupKey: string,
  valueKey: string
): { pivotedData: Record<string, unknown>[]; groupValues: string[] } {
  // Collect unique group values in order of appearance
  const groupSet = new Set<string>();
  const xMap = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const xVal = String(row[xKey] ?? '');
    const gVal = String(row[groupKey] ?? '');
    const numVal = row[valueKey] !== null && row[valueKey] !== undefined ? Number(row[valueKey]) : 0;

    groupSet.add(gVal);

    if (!xMap.has(xVal)) {
      xMap.set(xVal, { [xKey]: row[xKey] });
    }
    const entry = xMap.get(xVal)!;
    entry[gVal] = numVal;
  }

  const groupValues = Array.from(groupSet);
  const pivotedData = Array.from(xMap.values());

  return { pivotedData, groupValues };
}

export function ChartRenderer({ config, results }: ChartRendererProps) {
  // Standard (non-grouped) data transformation
  const data = useMemo(() => {
    if (config.groupKey) return []; // handled by pivoted data
    return results.rows.map((row) => {
      const entry: Record<string, unknown> = {};
      entry[config.xKey] = row[config.xKey];
      for (const yKey of config.yKeys) {
        const val = row[yKey];
        entry[yKey] = val !== null && val !== undefined ? Number(val) : 0;
      }
      return entry;
    });
  }, [results.rows, config.xKey, config.yKeys, config.groupKey]);

  // Grouped bar data (pivoted)
  const { pivotedData, groupValues } = useMemo(() => {
    if (!config.groupKey || config.yKeys.length === 0) {
      return { pivotedData: [], groupValues: [] };
    }
    return pivotGroupedData(results.rows, config.xKey, config.groupKey, config.yKeys[0]);
  }, [results.rows, config.xKey, config.groupKey, config.yKeys]);

  const isGrouped = config.groupKey && groupValues.length > 0;
  const chartData = isGrouped ? pivotedData : data;

  if (config.type === 'none' || chartData.length === 0) return null;

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

  const showLegend = isGrouped || config.yKeys.length > 1;

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {config.title && (
        <p className="mb-3 text-xs font-medium text-muted-foreground">
          {config.title}
        </p>
      )}
      <ResponsiveContainer width="100%" height={300}>
        {config.type === 'bar' ? (
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
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
            {showLegend && (
              <Legend
                wrapperStyle={{ fontSize: '11px', color: 'hsl(0, 0%, 65%)' }}
              />
            )}
            {isGrouped
              ? groupValues.map((gv, i) => (
                  <Bar
                    key={gv}
                    dataKey={gv}
                    name={gv}
                    fill={COLORS[i % COLORS.length]}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={50}
                  />
                ))
              : config.yKeys.map((key, i) => (
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
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
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
                dot={chartData.length <= 30}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        ) : (
          <PieChart>
            <Pie
              data={chartData}
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
              {chartData.map((_, i) => (
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
