import Anthropic from '@anthropic-ai/sdk';
import { TableMetadata, QueryResult, QueryLibraryEntry, ValidationResult, ConversationTurn } from './types';

const getClient = () =>
  new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });

const getModel = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const SQL_SYSTEM_PROMPT = `You are a SQL analyst for a Trino-based data lakehouse. You write precise, efficient Trino SQL.

Rules:
- ONLY generate SELECT, WITH (CTE), SHOW, DESCRIBE, or EXPLAIN statements. NEVER generate INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, MERGE, or any other data-modification SQL. If the user asks you to modify data, politely decline and explain this is a read-only analytics tool.
- Always use fully qualified table names (catalog.schema.table). The catalog is ALWAYS "lakehouse" — e.g. lakehouse.fpa.transaction_economics, NOT fpa.analytics.transaction_economics. Never use a schema name as the catalog.
- Prefer CTEs over subqueries for readability
- Add LIMIT clauses unless the user explicitly asks for all rows
- Use table/column comments to understand business meaning
- IMPORTANT: When the user asks about actual/historical data (revenue, transactions, volumes), prefer tables with actual transaction records (e.g. transaction_economics, transactions) over forecast/outlook/budget tables (e.g. daily_outlook, forecast). Only use outlook/forecast tables when the user explicitly asks about forecasts, budgets, or projections.
- If you're unsure about a column's meaning, state your assumption
- Output the SQL in a \`\`\`sql code block, followed by a brief explanation
- After the explanation, list any assumptions you made`;

const ANALYSIS_SYSTEM_PROMPT = `You are a data analyst. Given the SQL query, the user's original question, and the query results, provide:
1. A 2-3 sentence executive summary
2. Key findings (bullet points)
3. Any notable outliers or patterns
4. 2-3 suggested follow-up questions the user might want to explore

Be concise and business-focused. Use specific numbers from the results. Format with markdown.

IMPORTANT — Chart recommendation:
At the very end of your response, you MUST include a chart configuration block. This tells the UI how to visualize the data. Use this exact format:

\`\`\`chart
{"type": "<bar|line|pie|none>", "xKey": "<column_name>", "yKeys": ["<column_name>"], "groupKey": "<column_name_or_null>", "title": "<short chart title>"}
\`\`\`

Rules for chart config:
- type: "line" for time series trends, "bar" for comparisons/categories, "pie" for proportions (2-8 slices), "none" if data is not suitable for charting
- xKey: the column for the x-axis (dates, categories, labels)
- yKeys: array of column names for the values to plot. Only include columns directly relevant to the question. Do NOT include every numeric column — exclude counts, margins, or metrics the user didn't ask about.
- groupKey: if the data has a secondary categorical dimension (e.g. region, product, segment) that should be shown as different colored bars/lines, set this to that column name. This pivots the data so each unique value of groupKey becomes a separate colored series. Set to null if no grouping is needed.
- title: a short descriptive title for the chart
- Use EXACT column names from the query results (case-sensitive)
- The chart block MUST be the very last thing in your response`;

const VALIDATION_SYSTEM_PROMPT = `You are a data quality validator. Given a user's question, query results, and available tables, determine if the results adequately answer the question.

Check for:
- Date range completeness: if the question asks for a specific period, the results MUST cover the FULL period. Q1 = Jan 1 – Mar 31. Q2 = Apr 1 – Jun 30. Q3 = Jul 1 – Sep 30. Q4 = Oct 1 – Dec 31. If data starts mid-quarter (e.g. Feb 1 instead of Jan 1 for Q1), mark as INVALID. This is the most common failure mode — check dates carefully.
- Row count reasonableness: 0 rows likely means wrong table/filter. Very few rows for a broad question may indicate a problem.
- Column relevance: do the returned columns contain the metrics/dimensions the user asked about?
- Data granularity: does the granularity (daily/weekly/monthly) match what was asked?
- Value sanity: are the values in expected ranges (e.g. no negative revenue, dates not in the future)?

IMPORTANT: If the data is incomplete or doesn't fully answer the question, look at the available tables list and SPECIFICALLY SUGGEST which alternative tables to try. Don't just say "try different tables" — name the exact tables from the available list that might have better data coverage.

Respond with ONLY a valid JSON object, no other text:
{"valid": true, "reason": "explanation", "suggestion": "what to try if invalid — name specific alternative tables"}

If the results look correct, set valid=true and explain why in reason.
If there's an issue, set valid=false, explain the problem in reason, and in suggestion name SPECIFIC alternative tables from the available list that might have the missing data.`;

/**
 * Parse a chart config block from the analysis text.
 * Returns the parsed ChartConfig and the analysis text with the block removed.
 */
export function parseChartConfigFromAnalysis(
  analysisText: string
): { chartConfig: import('./types').ChartConfig | null; cleanedText: string } {
  const match = analysisText.match(/```chart\s*\n?([\s\S]*?)```/);
  if (!match) {
    return { chartConfig: null, cleanedText: analysisText };
  }

  const cleanedText = analysisText.replace(/```chart\s*\n?[\s\S]*?```/, '').trimEnd();

  try {
    const parsed = JSON.parse(match[1].trim());
    const validTypes = ['bar', 'line', 'pie', 'none'];
    if (!validTypes.includes(parsed.type)) {
      return { chartConfig: null, cleanedText };
    }

    return {
      chartConfig: {
        type: parsed.type,
        xKey: String(parsed.xKey || ''),
        yKeys: Array.isArray(parsed.yKeys) ? parsed.yKeys.map(String) : [],
        groupKey: parsed.groupKey && parsed.groupKey !== 'null' ? String(parsed.groupKey) : undefined,
        title: parsed.title ? String(parsed.title) : undefined,
      },
      cleanedText,
    };
  } catch {
    return { chartConfig: null, cleanedText };
  }
}

export function buildTableContext(tables: TableMetadata[]): string {
  return tables
    .map((t) => {
      const cols = t.columns
        .map(
          (c) =>
            `  - ${c.name} (${c.type})${c.comment ? ` -- ${c.comment}` : ''}`
        )
        .join('\n');
      return `Table: ${t.catalog}.${t.schema}.${t.table}${t.comment ? ` -- ${t.comment}` : ''}\nColumns:\n${cols}`;
    })
    .join('\n\n');
}

function buildHistoryMessages(history?: ConversationTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history ?? []) {
    messages.push({ role: 'user', content: turn.question });
    let resp = '';
    if (turn.sql) resp += `\`\`\`sql\n${turn.sql}\n\`\`\`\n`;
    if (turn.resultSummary) resp += `Results: ${turn.resultSummary}\n`;
    if (turn.analysis) resp += `Analysis: ${turn.analysis}`;
    if (resp) messages.push({ role: 'assistant', content: resp.trim() });
  }
  return messages;
}

export async function generateSQL(
  question: string,
  relevantTables: TableMetadata[],
  relevantQueries: QueryLibraryEntry[],
  history?: ConversationTurn[]
): Promise<ReadableStream> {
  const tableContext = buildTableContext(relevantTables);

  const queryContext =
    relevantQueries.length > 0
      ? '\n\nReference queries that may be relevant:\n' +
        relevantQueries
          .map((q) => `-- ${q.description}\n${q.sql}`)
          .join('\n\n')
      : '';

  const systemPrompt =
    SQL_SYSTEM_PROMPT +
    '\n\nAvailable tables and their schemas:\n' +
    tableContext +
    queryContext;

  const messages: Anthropic.MessageParam[] = [
    ...buildHistoryMessages(history),
    { role: 'user', content: question },
  ];

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
  });
}

export async function analyzeResults(
  question: string,
  sql: string,
  results: QueryResult,
  history?: ConversationTurn[]
): Promise<ReadableStream> {
  const resultsPreview = results.rows.slice(0, 50);
  const resultsText = JSON.stringify(resultsPreview, null, 2);

  const userContent = `Original question: ${question}

SQL query executed:
\`\`\`sql
${sql}
\`\`\`

Query returned ${results.rowCount} rows. Here are the first ${Math.min(results.rowCount, 50)} rows:
${resultsText}

Column names and types: ${results.columns.map((c, i) => `${c} (${results.columnTypes[i]})`).join(', ')}`;

  const messages: Anthropic.MessageParam[] = [
    ...buildHistoryMessages(history),
    { role: 'user', content: userContent },
  ];

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages,
  });

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
  });
}

export async function fixSQL(
  originalSQL: string,
  error: string,
  question: string,
  relevantTables: TableMetadata[]
): Promise<ReadableStream> {
  const tableContext = buildTableContext(relevantTables);
  const systemPrompt =
    SQL_SYSTEM_PROMPT +
    '\n\nAvailable tables and their schemas:\n' +
    tableContext;

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: question },
      {
        role: 'assistant',
        content: `\`\`\`sql\n${originalSQL}\n\`\`\``,
      },
      {
        role: 'user',
        content: `The query returned an error:\n${error}\n\nPlease fix the SQL and explain the correction.`,
      },
    ],
  });

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
  });
}

/**
 * Validate whether query results actually answer the user's question.
 * Non-streaming — returns structured JSON.
 */
export async function validateResults(
  question: string,
  sql: string,
  results: QueryResult,
  availableTables?: TableMetadata[],
): Promise<ValidationResult> {
  // Detect date ranges in results
  const dateInfo = detectDateRange(results);

  const sampleRows = results.rows.slice(0, 20);
  const tablesList = availableTables && availableTables.length > 0
    ? `\n\nAvailable tables that could be used instead:\n${availableTables.map((t) => `- ${t.catalog}.${t.schema}.${t.table}${t.comment ? ` (${t.comment})` : ''}`).join('\n')}`
    : '';

  const userContent = `User's question: "${question}"

SQL executed:
\`\`\`sql
${sql}
\`\`\`

Results summary:
- Row count: ${results.rowCount}
- Columns: ${results.columns.map((c, i) => `${c} (${results.columnTypes[i]})`).join(', ')}
${dateInfo ? `- Date range in data: ${dateInfo.min} to ${dateInfo.max} (column: ${dateInfo.column})` : '- No date columns detected'}

Sample rows (first ${sampleRows.length}):
${JSON.stringify(sampleRows, null, 2)}${tablesList}`;

  const client = getClient();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 512,
    system: VALIDATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        valid: Boolean(parsed.valid),
        reason: String(parsed.reason || ''),
        suggestion: parsed.suggestion ? String(parsed.suggestion) : undefined,
      };
    }
  } catch {
    // If parsing fails, assume valid to avoid blocking
  }

  return { valid: true, reason: 'Validation could not parse response, assuming valid.' };
}

/**
 * Generate revised SQL after a validation failure.
 * Multi-turn conversation with context about what went wrong.
 */
export async function generateRevisedSQL(
  question: string,
  previousSQL: string,
  validationReason: string,
  suggestion: string | undefined,
  relevantTables: TableMetadata[],
  relevantQueries: QueryLibraryEntry[],
  unusedTables?: TableMetadata[]
): Promise<ReadableStream> {
  const tableContext = buildTableContext(relevantTables);
  const queryContext =
    relevantQueries.length > 0
      ? '\n\nReference queries that may be relevant:\n' +
        relevantQueries
          .map((q) => `-- ${q.description}\n${q.sql}`)
          .join('\n\n')
      : '';

  const unusedTableContext =
    unusedTables && unusedTables.length > 0
      ? '\n\nIMPORTANT — Tables that have NOT been tried yet (prefer these):\n' +
        buildTableContext(unusedTables)
      : '';

  const systemPrompt =
    SQL_SYSTEM_PROMPT +
    '\n\nAvailable tables and their schemas:\n' +
    tableContext +
    queryContext +
    unusedTableContext;

  const fixMessage = [
    `The query executed successfully but the results don't adequately answer the question.`,
    `Problem: ${validationReason}`,
    suggestion ? `Suggestion: ${suggestion}` : '',
    unusedTables && unusedTables.length > 0
      ? `IMPORTANT: You MUST try different tables this time. The previous table didn't have adequate data. Try one of these untried tables: ${unusedTables.map((t) => `${t.catalog}.${t.schema}.${t.table}`).join(', ')}`
      : '',
    `Please write a corrected SQL query that better answers the original question. You MUST use a different table or approach — do NOT repeat the same query with minor tweaks.`,
  ]
    .filter(Boolean)
    .join('\n');

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: question },
      { role: 'assistant', content: `\`\`\`sql\n${previousSQL}\n\`\`\`` },
      { role: 'user', content: fixMessage },
    ],
  });

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
  });
}

export interface SQLReviewResult {
  approved: boolean;
  correctedSQL?: string;
  issues: string[];
}

const SQL_REVIEW_SYSTEM_PROMPT = `You are a SQL reviewer for a Trino-based data lakehouse. Your job is to catch logical errors in SQL queries BEFORE they are executed.

Review the query for these common mistakes:
1. **Join fan-out / many-to-many**: JOINs on non-unique keys that multiply rows (e.g. joining two fact tables on day_of_quarter creates a cross product). This is the most critical issue — look for it first.
2. **Wrong date ranges**: Query asks about "this quarter" but filters include multiple quarters, or compares the wrong periods.
3. **Incorrect aggregation**: GROUP BY is missing columns, or aggregating over a dimension that should be filtered.
4. **Wrong table qualifiers**: The catalog must always be "lakehouse" (e.g. lakehouse.fpa.table, NOT fpa.analytics.table).
5. **Ambiguous column references**: Columns used in JOINs or WHERE that could belong to multiple tables but aren't qualified.
6. **Logic errors**: Conditions that contradict each other, OR/AND precedence issues, comparing incompatible types.

Respond with ONLY a valid JSON object, no other text:
{"approved": true, "issues": [], "correctedSQL": null}

If you find issues, set approved=false, list each issue, and put the full corrected SQL in correctedSQL as a plain SQL string (no markdown fences):
{"approved": false, "issues": ["issue 1", "issue 2"], "correctedSQL": "SELECT ... FROM ..."}

Only provide correctedSQL if you found actual issues. Do NOT rewrite a correct query just to improve style.`;

/**
 * Review a SQL query for logical errors before execution.
 * Non-streaming — returns structured JSON.
 */
export async function reviewSQL(
  question: string,
  sql: string,
  tables: TableMetadata[],
): Promise<SQLReviewResult> {
  const tableContext = buildTableContext(tables);

  const userContent = `User's question: "${question}"

SQL to review:
\`\`\`sql
${sql}
\`\`\`

Available tables:
${tableContext}`;

  const client = getClient();
  const response = await client.messages.create({
    model: getModel(),
    max_tokens: 2048,
    system: SQL_REVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      let correctedSQL: string | undefined;
      if (parsed.correctedSQL && parsed.correctedSQL !== 'null') {
        const raw = String(parsed.correctedSQL).trim();
        // Handle both fenced and plain SQL
        const sqlMatch = raw.match(/```sql\n?([\s\S]*?)```/);
        correctedSQL = sqlMatch ? sqlMatch[1].trim() : raw;
      }
      return {
        approved: Boolean(parsed.approved),
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
        correctedSQL,
      };
    }
  } catch {
    // Parse failure — approve to avoid blocking
  }

  return { approved: true, issues: [] };
}

/**
 * Detect min/max date range from results by scanning date-like columns.
 */
function detectDateRange(
  results: QueryResult
): { column: string; min: string; max: string } | null {
  for (let i = 0; i < results.columns.length; i++) {
    const colType = (results.columnTypes[i] || '').toLowerCase();
    const colName = results.columns[i].toLowerCase();
    const isDateCol =
      colType.includes('date') ||
      colType.includes('timestamp') ||
      colName.includes('date') ||
      colName.includes('day') ||
      colName.includes('month');

    if (!isDateCol) continue;

    const values = results.rows
      .map((r) => r[results.columns[i]])
      .filter((v) => v !== null && v !== undefined)
      .map(String)
      .filter((v) => /^\d{4}-\d{2}/.test(v))
      .sort();

    if (values.length > 0) {
      return {
        column: results.columns[i],
        min: values[0],
        max: values[values.length - 1],
      };
    }
  }
  return null;
}

/**
 * Quarter boundaries for date range validation.
 */
const QUARTER_MONTHS: Record<string, [number, number]> = {
  q1: [1, 3],
  q2: [4, 6],
  q3: [7, 9],
  q4: [10, 12],
};

/**
 * Detect if the user's question implies a specific time period,
 * then check if the results actually cover that period.
 * Returns null if no issue detected, or a ValidationResult if coverage is incomplete.
 */
export function checkDateCompleteness(
  question: string,
  results: QueryResult
): ValidationResult | null {
  const dateRange = detectDateRange(results);
  if (!dateRange) return null;

  const q = question.toLowerCase();
  const currentYear = new Date().getFullYear();

  // Detect quarter references: "Q1", "Q1 2026", "this quarter", "first quarter"
  const quarterNames: Record<string, string> = {
    first: 'q1', second: 'q2', third: 'q3', fourth: 'q4',
    '1st': 'q1', '2nd': 'q2', '3rd': 'q3', '4th': 'q4',
  };

  let detectedQuarter: string | null = null;
  let detectedYear: number = currentYear;

  // Match "Q1", "Q1 2026", etc.
  const qMatch = q.match(/\bq([1-4])(?:\s+(\d{4}))?\b/);
  if (qMatch) {
    detectedQuarter = `q${qMatch[1]}`;
    if (qMatch[2]) detectedYear = parseInt(qMatch[2]);
  }

  // Match "first quarter", "2nd quarter", etc.
  if (!detectedQuarter) {
    for (const [word, quarter] of Object.entries(quarterNames)) {
      if (q.includes(`${word} quarter`)) {
        detectedQuarter = quarter;
        break;
      }
    }
  }

  // Match "this quarter"
  if (!detectedQuarter && q.includes('this quarter')) {
    const currentMonth = new Date().getMonth() + 1;
    if (currentMonth <= 3) detectedQuarter = 'q1';
    else if (currentMonth <= 6) detectedQuarter = 'q2';
    else if (currentMonth <= 9) detectedQuarter = 'q3';
    else detectedQuarter = 'q4';
  }

  if (detectedQuarter && QUARTER_MONTHS[detectedQuarter]) {
    const [startMonth, endMonth] = QUARTER_MONTHS[detectedQuarter];
    const expectedStart = `${detectedYear}-${String(startMonth).padStart(2, '0')}-01`;

    // Get the actual month range in the data
    const dataStartMonth = parseInt(dateRange.min.substring(5, 7));
    const dataStartYear = parseInt(dateRange.min.substring(0, 4));

    const quarterStartDate = new Date(detectedYear, startMonth - 1, 1);
    const dataStartDate = new Date(dataStartYear, dataStartMonth - 1, 1);

    // If data starts more than 15 days after the quarter start, it's missing data
    const daysDiff = (dataStartDate.getTime() - quarterStartDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysDiff > 15) {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
      const missingMonths: string[] = [];
      for (let m = startMonth; m < dataStartMonth; m++) {
        missingMonths.push(monthNames[m - 1]);
      }

      return {
        valid: false,
        reason: `The question asks about ${detectedQuarter.toUpperCase()} ${detectedYear} (${monthNames[startMonth - 1]}–${monthNames[endMonth - 1]}), but the data only starts from ${dateRange.min}. Missing: ${missingMonths.join(', ')}. The table used likely doesn't have data for the full quarter.`,
        suggestion: `Use a DIFFERENT table that has data starting from ${expectedStart} or earlier. The current table is missing ${missingMonths.join(', ')} data. You MUST try alternative tables — do not reuse the same table with different filters.`,
      };
    }
  }

  return null;
}
