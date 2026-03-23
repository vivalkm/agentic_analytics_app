import { QueryResult, ChartConfig } from './types';

/**
 * Score how relevant a column name is to the user's question.
 * Higher score = more relevant.
 */
function scoreColumnRelevance(colName: string, question: string): number {
  const col = colName.toLowerCase();
  const q = question.toLowerCase();
  let score = 0;

  // Extract keywords from question (split on spaces, filter short/stop words)
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'that', 'this', 'what', 'show',
    'how', 'many', 'all', 'are', 'was', 'trend', 'daily', 'monthly',
    'weekly', 'over', 'time', 'last', 'past', 'give', 'tell',
  ]);
  const keywords = q
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Direct keyword match in column name
  for (const kw of keywords) {
    if (col.includes(kw)) score += 10;
  }

  // Column word match in question
  const colWords = col.split(/[_\-\s]/).filter((w) => w.length > 2);
  for (const cw of colWords) {
    if (q.includes(cw)) score += 8;
  }

  return score;
}

/**
 * Filter numeric columns to only those relevant to the question.
 * Falls back to first 2 columns if no relevance signal.
 */
function filterRelevantColumns(
  numericColIndices: number[],
  columns: string[],
  question: string,
  maxCols: number = 2
): number[] {
  if (!question || numericColIndices.length <= maxCols) {
    return numericColIndices.slice(0, maxCols);
  }

  // Score each numeric column
  const scored = numericColIndices.map((i) => ({
    index: i,
    name: columns[i],
    relevance: scoreColumnRelevance(columns[i], question),
  }));

  // Filter out "noise" columns that are clearly not asked about:
  // - cumulative/running totals when asking about daily/trend
  // - count columns when asking about revenue/value
  // - variance/pct columns unless explicitly asked
  const q = question.toLowerCase();
  const filtered = scored.filter((c) => {
    const col = c.name.toLowerCase();

    // Always exclude cumulative columns from trend charts (different scale)
    if (col.includes('cumulative') || col.includes('running_total') || col.includes('ytd_') || col.includes('mtd_')) {
      return false;
    }

    // If asking about revenue/value, deprioritize count columns
    if ((q.includes('revenue') || q.includes('value') || q.includes('amount') || q.includes('volume')) &&
        (col.includes('count') || col.includes('_cnt') || col.includes('num_'))) {
      return false;
    }

    // If asking about counts/transactions, deprioritize margin/revenue columns
    if ((q.includes('count') || q.includes('transaction')) && !q.includes('revenue') &&
        (col.includes('margin') || col.includes('treasury'))) {
      return false;
    }

    return true;
  });

  // Sort by relevance, take top N
  const relevant = filtered
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxCols);

  // If we got relevant columns, use them; otherwise fall back to first N from filtered
  if (relevant.length > 0) {
    return relevant.map((c) => c.index);
  }

  return numericColIndices.slice(0, maxCols);
}

export function detectChartType(result: QueryResult, question?: string): ChartConfig {
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

  // --- 1. Line chart: date/time column + numeric, enough data points for a series ---
  if (dateCols.length >= 1 && numericCols.length >= 1 && rows.length > 3) {
    const relevantCols = filterRelevantColumns(numericCols, columns, question || '', 2);
    const yKeys = relevantCols.map((i) => columns[i]);
    return {
      type: 'line',
      xKey: columns[dateCols[0]],
      yKeys,
      title: `${yKeys.join(', ')} over time`,
    };
  }

  // --- 2. Single row with multiple numeric cols → bar comparing the metrics ---
  if (rows.length === 1 && numericCols.length >= 2) {
    const relevantCols = filterRelevantColumns(numericCols, columns, question || '', 5);
    const yKeys = relevantCols.map((i) => columns[i]);
    return {
      type: 'bar',
      xKey: categoricalCols.length > 0 ? columns[categoricalCols[0]] : columns[numericCols[0]],
      yKeys,
      title: yKeys.join(' vs '),
    };
  }

  // --- 3. Bar chart: categorical + numeric (general case) ---
  if (categoricalCols.length >= 1 && numericCols.length >= 1 && rows.length >= 2) {
    const relevantCols = filterRelevantColumns(numericCols, columns, question || '', 3);
    const yKeys = relevantCols.map((i) => columns[i]);
    return {
      type: 'bar',
      xKey: columns[categoricalCols[0]],
      yKeys,
      title: `${yKeys.join(', ')} by ${columns[categoricalCols[0]]}`,
    };
  }

  // --- 4. Pie chart: only when 2-8 categories with a single metric ---
  if (
    categoricalCols.length >= 1 &&
    numericCols.length === 1 &&
    rows.length >= 2 &&
    rows.length <= 8
  ) {
    const catCol = categoricalCols[0];
    const uniqueValues = new Set(rows.map((r) => r[columns[catCol]]));
    if (uniqueValues.size === rows.length) {
      return {
        type: 'pie',
        xKey: columns[catCol],
        yKeys: [columns[numericCols[0]]],
        title: `${columns[numericCols[0]]} by ${columns[catCol]}`,
      };
    }
  }

  // --- 5. Line chart fallback: multiple numeric cols, no categories ---
  if (numericCols.length >= 2) {
    const relevantCols = filterRelevantColumns(
      numericCols.filter((i) => i !== 0), columns, question || '', 3
    );
    return {
      type: 'line',
      xKey: columns[0],
      yKeys: relevantCols.map((i) => columns[i]),
      title: 'Data trend',
    };
  }

  return { type: 'none', xKey: '', yKeys: [] };
}
