import { QueryResult, ChartConfig } from './types';

export function detectChartType(result: QueryResult): ChartConfig {
  if (!result || result.rowCount === 0 || result.columns.length < 2) {
    return { type: 'none', xKey: '', yKeys: [] };
  }

  const { columns, columnTypes, rows } = result;

  const numericCols: number[] = [];
  const categoricalCols: number[] = [];
  const dateCols: number[] = [];

  columns.forEach((_, i) => {
    const type = (columnTypes[i] || '').toLowerCase();
    if (
      type.includes('int') ||
      type.includes('double') ||
      type.includes('float') ||
      type.includes('decimal') ||
      type.includes('bigint') ||
      type.includes('real')
    ) {
      numericCols.push(i);
    } else if (
      type.includes('date') ||
      type.includes('timestamp') ||
      type.includes('time')
    ) {
      dateCols.push(i);
    } else {
      categoricalCols.push(i);
    }
  });

  // Fallback: detect from data when types are unknown
  if (numericCols.length === 0 && categoricalCols.length === 0) {
    columns.forEach((col, i) => {
      const sample = rows.slice(0, 10).map((r) => r[col]);
      const allNumeric = sample.every(
        (v) => v !== null && v !== undefined && !isNaN(Number(v))
      );
      if (allNumeric) {
        numericCols.push(i);
      } else {
        categoricalCols.push(i);
      }
    });
  }

  // Pie chart: 1 categorical + 1 numeric, few rows
  if (
    categoricalCols.length >= 1 &&
    numericCols.length >= 1 &&
    rows.length <= 10
  ) {
    const catCol = categoricalCols[0];
    const uniqueValues = new Set(rows.map((r) => r[columns[catCol]]));
    if (uniqueValues.size <= 8 && uniqueValues.size === rows.length) {
      return {
        type: 'pie',
        xKey: columns[catCol],
        yKeys: [columns[numericCols[0]]],
        title: `${columns[numericCols[0]]} by ${columns[catCol]}`,
      };
    }
  }

  // Line chart: date column + numeric
  if (dateCols.length >= 1 && numericCols.length >= 1 && rows.length > 3) {
    return {
      type: 'line',
      xKey: columns[dateCols[0]],
      yKeys: numericCols.map((i) => columns[i]),
      title: `${numericCols.map((i) => columns[i]).join(', ')} over time`,
    };
  }

  // Bar chart: categorical + numeric
  if (categoricalCols.length >= 1 && numericCols.length >= 1) {
    return {
      type: 'bar',
      xKey: columns[categoricalCols[0]],
      yKeys: numericCols.slice(0, 3).map((i) => columns[i]),
      title: `${numericCols
        .slice(0, 3)
        .map((i) => columns[i])
        .join(', ')} by ${columns[categoricalCols[0]]}`,
    };
  }

  // Line chart fallback: multiple numeric cols
  if (numericCols.length >= 2) {
    return {
      type: 'line',
      xKey: columns[0],
      yKeys: numericCols
        .filter((i) => i !== 0)
        .slice(0, 3)
        .map((i) => columns[i]),
      title: 'Data trend',
    };
  }

  return { type: 'none', xKey: '', yKeys: [] };
}
