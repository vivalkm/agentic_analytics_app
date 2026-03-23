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

  // --- Helper: detect if a column looks like a grouping dimension ---
  const isGroupingCol = (colIdx: number): boolean => {
    const col = columns[colIdx].toLowerCase();
    const groupPatterns = [
      'region', 'category', 'segment', 'channel', 'type', 'group',
      'country', 'state', 'city', 'department', 'team', 'brand',
      'product', 'status', 'tier', 'source', 'medium',
    ];
    return groupPatterns.some((p) => col.includes(p));
  };

  const isTimeAxisCol = (colIdx: number): boolean => {
    const col = columns[colIdx].toLowerCase();
    return (
      col.includes('month') || col.includes('quarter') || col.includes('year') ||
      col.includes('week') || col.includes('period') || col.includes('day') ||
      col.includes('date')
    );
  };

  // --- Helper: pick best xKey and groupKey from categorical columns ---
  const pickAxisAndGroup = (catIndices: number[]): { xIdx: number; groupIdx?: number } => {
    if (catIndices.length < 2) return { xIdx: catIndices[0] };

    // Prefer time-like columns for xAxis, grouping-like for groupKey
    const timeIdx = catIndices.find(isTimeAxisCol);
    const groupIdx = catIndices.find(isGroupingCol);

    if (timeIdx !== undefined && groupIdx !== undefined && timeIdx !== groupIdx) {
      return { xIdx: timeIdx, groupIdx };
    }

    // If we have 2 categorical cols, check which has fewer unique values (better for grouping)
    const uniqueCounts = catIndices.map((i) => ({
      idx: i,
      unique: new Set(rows.map((r) => r[columns[i]])).size,
    }));

    // The one with MORE unique values is the axis, fewer is the group
    uniqueCounts.sort((a, b) => b.unique - a.unique);
    const xCandidate = uniqueCounts[0];
    const groupCandidate = uniqueCounts[1];

    // Only use groupKey if group has 2-12 unique values (sensible for legend)
    if (groupCandidate && groupCandidate.unique >= 2 && groupCandidate.unique <= 12) {
      return { xIdx: xCandidate.idx, groupIdx: groupCandidate.idx };
    }

    return { xIdx: catIndices[0] };
  };

  // --- 1. Line chart: date/time column + numeric, enough data points for a series ---
  if (dateCols.length >= 1 && numericCols.length >= 1 && rows.length > 3) {
    const relevantCols = filterRelevantColumns(numericCols, columns, question || '', 2);
    const yKeys = relevantCols.map((i) => columns[i]);

    // Check for grouping dimension (e.g. date + region + revenue)
    let groupKey: string | undefined;
    if (categoricalCols.length >= 1 && numericCols.length === 1) {
      const groupIdx = categoricalCols.find(isGroupingCol) ?? categoricalCols[0];
      const uniqueGroups = new Set(rows.map((r) => r[columns[groupIdx]])).size;
      if (uniqueGroups >= 2 && uniqueGroups <= 12) {
        groupKey = columns[groupIdx];
      }
    }

    return {
      type: groupKey ? 'bar' : 'line',
      xKey: columns[dateCols[0]],
      yKeys,
      groupKey,
      title: groupKey
        ? `${yKeys.join(', ')} by ${groupKey} over time`
        : `${yKeys.join(', ')} over time`,
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

  // --- 3. Grouped bar: 2+ categorical cols + numeric → group by secondary dimension ---
  if (categoricalCols.length >= 2 && numericCols.length >= 1 && rows.length >= 2) {
    const relevantCols = filterRelevantColumns(numericCols, columns, question || '', 1);
    const yKeys = relevantCols.map((i) => columns[i]);
    const { xIdx, groupIdx } = pickAxisAndGroup(categoricalCols);

    return {
      type: 'bar',
      xKey: columns[xIdx],
      yKeys,
      groupKey: groupIdx !== undefined ? columns[groupIdx] : undefined,
      title: groupIdx !== undefined
        ? `${yKeys.join(', ')} by ${columns[xIdx]} and ${columns[groupIdx]}`
        : `${yKeys.join(', ')} by ${columns[xIdx]}`,
    };
  }

  // --- 4. Bar chart: single categorical + numeric (general case) ---
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

  // --- 5. Pie chart: only when 2-8 categories with a single metric ---
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

  // --- 6. Line chart fallback: multiple numeric cols, no categories ---
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
