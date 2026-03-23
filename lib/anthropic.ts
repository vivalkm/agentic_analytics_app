import Anthropic from '@anthropic-ai/sdk';
import { TableMetadata, QueryResult, QueryLibraryEntry, ValidationResult } from './types';

const getClient = () =>
  new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });

const getModel = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

const SQL_SYSTEM_PROMPT = `You are a SQL analyst for a Trino-based data lakehouse. You write precise, efficient Trino SQL.

Rules:
- ONLY generate SELECT, WITH (CTE), SHOW, DESCRIBE, or EXPLAIN statements. NEVER generate INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, MERGE, or any other data-modification SQL. If the user asks you to modify data, politely decline and explain this is a read-only analytics tool.
- Always use fully qualified table names (catalog.schema.table)
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

Be concise and business-focused. Use specific numbers from the results. Format with markdown.`;

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

export async function generateSQL(
  question: string,
  relevantTables: TableMetadata[],
  relevantQueries: QueryLibraryEntry[]
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

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
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
  results: QueryResult
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

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
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
