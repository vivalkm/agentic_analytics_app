import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TableMetadata, QueryResult, QueryLibraryEntry, MetricEntry, ConversationTurn, Attachment } from './types';
import { getEnv } from './env-config';

/** Load domain context file (cached via globalThis for HMR safety). */
const _DC_KEY = '__domain_context__';
function getDomainContext(): string {
  const g = globalThis as unknown as Record<string, string>;
  if (g[_DC_KEY] !== undefined) return g[_DC_KEY];
  try {
    g[_DC_KEY] = readFileSync(
      join(process.cwd(), 'domain-context.md'),
      'utf-8'
    ).trim();
  } catch {
    g[_DC_KEY] = '';
  }
  return g[_DC_KEY];
}

const getClient = (() => {
  const clientKey = '__anthropic_client__';
  const configKey = '__anthropic_config__';
  return () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const apiKey = getEnv('ANTHROPIC_API_KEY');
    const baseURL = getEnv('ANTHROPIC_BASE_URL') || undefined;
    const prevConfig = g[configKey] as { apiKey: string; baseURL?: string } | undefined;

    // Re-create client if API key or base URL changed (e.g., after .env.local edit + HMR)
    if (!g[clientKey] || !prevConfig || prevConfig.apiKey !== apiKey || prevConfig.baseURL !== baseURL) {
      g[clientKey] = new Anthropic({ apiKey, baseURL });
      g[configKey] = { apiKey, baseURL };
    }
    return g[clientKey] as Anthropic;
  };
})();

const getModel = () => getEnv('ANTHROPIC_MODEL') || 'claude-sonnet-4-20250514';

/** Wrap an Anthropic MessageStream in a ReadableStream with proper cancel support. */
function streamToReadable(stream: ReturnType<Anthropic['messages']['stream']>): ReadableStream {
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
    cancel() {
      stream.abort();
    },
  });
}

function getSQLSystemPrompt() {
  return `You are a SQL analyst for a Trino-based data lakehouse. You write precise, efficient Trino SQL.
Today's date is ${new Date().toISOString().slice(0, 10)}. When the user refers to relative time periods ("this month", "this quarter", "last year", "in March") without specifying a year, always assume the CURRENT year (${new Date().getFullYear()}) or use CURRENT_DATE-based expressions. Never default to a past year.
DEFAULT TIME WINDOW: If the user's question does NOT mention any specific time period, date range, or relative time reference, default to the most recent 12 months (CURRENT_DATE - INTERVAL '12' MONTH to CURRENT_DATE). Always include an explicit date filter — never query without a time boundary.

REFERENCE PRIORITY (use in this order):
1. **Metric catalog** (Statsig): If a matched metric definition is provided below, use its definition (aggregation, column, filters) and backing SQL as the primary reference. The metric catalog is the authoritative source for how business metrics are calculated.
2. **Query library**: If a matched reference query is provided below, adapt it for the user's question. These are vetted, production-quality queries.
3. **Schema metadata**: If no metric or library query matches, write SQL from scratch using the available table schemas below.

Rules:
- ONLY generate SELECT or WITH (CTE) statements. NEVER generate INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, MERGE, or any other data-modification SQL. If the user asks you to modify data, politely decline and explain this is a read-only analytics tool.
- Do NOT generate SHOW SCHEMAS, SHOW TABLES, DESCRIBE, or EXPLAIN statements. All table metadata (schemas, tables, columns, types) is already provided to you below. Use that metadata directly — never try to discover schema at runtime.
- CRITICAL: ONLY use table names and column names that appear in the "Available tables and their schemas" section below. Do NOT guess or invent column names. If a column you need is not listed in the metadata, say so in your explanation rather than guessing. Every column in your SQL must match exactly (case-sensitive) with the metadata provided.
- Always use fully qualified table names (catalog.schema.table). The catalog is ALWAYS "lakehouse" — e.g. lakehouse.fpa.transaction_economics, NOT fpa.analytics.transaction_economics. Never use a schema name as the catalog.
- Prefer CTEs over subqueries for readability
- Add LIMIT clauses unless the user explicitly asks for all rows
- Use table/column comments to understand business meaning
- When asked about "month to date" (MTD), "quarter to date" (QTD), "year to date" (YTD), or any "to date" metric, always use CURRENT_DATE - INTERVAL '1' DAY as the end date (T-1), because today's data is incomplete and would be misleading.
- Use Trino SQL syntax: DATE '2024-01-01' for date literals (NOT '2024-01-01'::date or CAST('...' AS DATE)). For integer date_key columns (e.g. 20240101), cast to date with date_parse(CAST(date_key AS VARCHAR), '%Y%m%d') or compare as integers (date_key >= 20240101). Use CURRENT_DATE and DATE_TRUNC for dates. For date arithmetic use interval expressions: CURRENT_DATE - INTERVAL '30' DAY, not DATE_ADD.
- IMPORTANT: When the user asks about actual/historical data (revenue, transactions, volumes), prefer tables with actual transaction records (e.g. transaction_economics, transactions) over forecast/outlook/budget tables (e.g. daily_outlook, forecast). Only use outlook/forecast tables when the user explicitly asks about forecasts, budgets, or projections.
- CRITICAL DEFAULT FILTERS — Core remittance: We focus on core remittance by default. When querying any table that has these columns, you MUST apply these filters unless the user explicitly asks otherwise:
  - \`customer_is_business = FALSE\` — excludes SMB (Remitly Business) data. Only use TRUE if user asks about SMB/business customers. Omit only if user asks about "all customers" or "total".
  - \`txn_is_core = TRUE\` — includes only core remittance transactions (excludes Rewire and other non-core). Omit only if the user explicitly asks about all transaction types, Rewire, or non-core transactions.
- FORECAST TABLES: For monthly forecast data, always use \`fpa.fpa_fcst_latest\`. For daily forecast allocations, always use \`fpa.fpa_fcst_latest_daily_ma\`. Do not use other forecast tables unless the user explicitly names one.
- PAYMENT METHOD / PAY-IN TYPE: The ONLY way to get payment method is by joining \`lakehouse.public.payment_profile_dimension\` using \`payment_profile_key = transaction_payment_profile_key\`. The column for pay-in type is \`payment_instrument_type\`. Do NOT use \`payment_route_dimension\` — it does not contain payment method names.
- If you're unsure about a column's meaning, state your assumption
- If the question is vague or ambiguous (e.g. "products", "return rate" with no clear column mapping), do NOT guess. Instead, skip the SQL block entirely and ask the user clarifying questions. Explain what specific terms could mean given the available tables, and ask the user to pick. Only generate SQL when you can confidently map the question to specific columns.
- Output the SQL in a \`\`\`sql code block, followed by a brief explanation
- After the explanation, list any assumptions you made`;
}

const ANALYSIS_SYSTEM_PROMPT = `You are a senior data analyst. Given the SQL query, the user's original question, and the query results, provide:
1. A 2-3 sentence executive summary
2. Key findings (bullet points)
3. Any notable outliers or patterns
4. 2-3 suggested follow-up questions the user might want to explore

IMPORTANT — Follow-up questions must be self-contained and unambiguous:
- Always include explicit date ranges (e.g. "in March 2026" not "this month", "from Jan 2026 to Mar 2026" not "last quarter")
- Always include explicit scope and filters (e.g. "for the US-to-India corridor" not "for this corridor")
- Never assume the reader knows the context of the current analysis — each follow-up should stand alone as a complete question
- Use the actual dates from the query results, not relative references like "this quarter" or "last month"

Be concise and business-focused. Use specific numbers from the results. Format with markdown. Do NOT use emojis anywhere in your response.

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

function buildMetricContext(metrics: MetricEntry[]): string {
  if (metrics.length === 0) return '';

  const derivedMetrics = metrics.filter((m) => m.kind === 'derived');
  const sourceMetrics = metrics.filter((m) => m.kind === 'source');

  let context = '\n\nMetric definitions from Statsig catalog (priority 1 — use these as the authoritative reference for how metrics are calculated):\n';

  if (derivedMetrics.length > 0) {
    context += derivedMetrics
      .map((m) => {
        let detail = `### ${m.name}\n${m.description}`;
        // Show a concise formula: e.g. SUM(revenue_usd) FROM source WHERE status = 'completed'
        const agg = (m.aggregation || 'count').toUpperCase();
        const col = m.valueColumn || '*';
        let formula = `${agg}(${col})`;
        if (m.sourceName) formula += ` FROM ${m.sourceName}`;
        if (m.criteria && m.criteria.length > 0) {
          formula += ` WHERE ${m.criteria.map((c) => `${c.column} ${c.condition} ${c.values.join(', ')}`).join(' AND ')}`;
        }
        detail += `\nDefinition: ${formula}`;
        if (m.sourceName) detail += `\nMetric source: ${m.sourceName}`;
        if (m.sql) detail += `\nBacking source SQL:\n\`\`\`sql\n${m.sql}\n\`\`\``;
        return detail;
      })
      .join('\n\n');
  }

  if (sourceMetrics.length > 0) {
    context +=
      '\n\nMetric sources (base tables/queries):\n' +
      sourceMetrics
        .map(
          (m) =>
            `### ${m.name}\n${m.description}${m.sql ? `\nBacking SQL:\n\`\`\`sql\n${m.sql}\n\`\`\`` : ''}`
        )
        .join('\n\n');
  }

  return context;
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

/**
 * Build multi-part user message content with optional attachments.
 * Images → ImageBlockParam, PDFs → DocumentBlockParam, CSV/TXT → TextBlockParam.
 */
function buildUserContent(
  text: string,
  attachments?: Attachment[]
): string | Anthropic.MessageCreateParams['messages'][number]['content'] {
  if (!attachments || attachments.length === 0) return text;

  const parts: Anthropic.Messages.ContentBlockParam[] = [];

  for (const att of attachments) {
    if (att.mediaType.startsWith('image/')) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          data: att.data,
          media_type: att.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        },
      });
    } else if (att.mediaType === 'application/pdf') {
      parts.push({
        type: 'document',
        source: {
          type: 'base64',
          data: att.data,
          media_type: 'application/pdf',
        },
      });
    } else {
      // CSV/TXT: include as a labelled text block
      parts.push({
        type: 'text',
        text: `--- Attached file: ${att.name} ---\n${att.data}`,
      });
    }
  }

  // The question text goes last so the model sees it after the attachments
  parts.push({ type: 'text', text });
  return parts;
}

export async function generateSQL(
  question: string,
  relevantTables: TableMetadata[],
  relevantQueries: QueryLibraryEntry[],
  history?: ConversationTurn[],
  relevantMetrics?: MetricEntry[],
  relevantGitHubQueries?: QueryLibraryEntry[],
  attachments?: Attachment[],
): Promise<ReadableStream> {
  const metricContext = buildMetricContext(relevantMetrics ?? []);

  const queryContext =
    relevantQueries.length > 0
      ? '\n\nReference queries from local query library (priority 2):\n' +
        relevantQueries
          .map((q) => `-- ${q.description}\n${q.sql}`)
          .join('\n\n')
      : '';

  const githubQueryContext =
    (relevantGitHubQueries ?? []).length > 0
      ? '\n\nReference queries from shared repo (priority 3):\n' +
        (relevantGitHubQueries ?? [])
          .map((q) => `-- ${q.description}\n${q.sql}`)
          .join('\n\n')
      : '';

  const tableContext = buildTableContext(relevantTables);

  const domain = getDomainContext();
  const systemPrompt =
    getSQLSystemPrompt() +
    metricContext +
    queryContext +
    githubQueryContext +
    '\n\nAvailable tables and their schemas:\n' +
    tableContext +
    (domain ? `\n\n--- CRITICAL DOMAIN RULES (override any assumptions) ---\n${domain}` : '');

  const messages: Anthropic.MessageParam[] = [
    ...buildHistoryMessages(history),
    { role: 'user', content: buildUserContent(question, attachments) },
  ];

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  return streamToReadable(stream);
}

export async function analyzeResults(
  question: string,
  sql: string,
  results: QueryResult,
  history?: ConversationTurn[]
): Promise<ReadableStream> {
  // Send all rows if ≤ 200 (covers grouped analytics); smart sample for larger sets
  const MAX_FULL_ROWS = 200;
  const HEAD_ROWS = 100;
  const TAIL_ROWS = 20;

  let resultsPreview: Record<string, unknown>[];
  let previewDescription: string;

  if (results.rows.length <= MAX_FULL_ROWS) {
    resultsPreview = results.rows;
    previewDescription = `Query returned ${results.rowCount} rows. Here are all ${results.rowCount} rows:`;
  } else {
    const head = results.rows.slice(0, HEAD_ROWS);
    const tail = results.rows.slice(-TAIL_ROWS);
    resultsPreview = [...head, ...tail];
    const omitted = results.rows.length - HEAD_ROWS - TAIL_ROWS;
    previewDescription = `Query returned ${results.rowCount} rows. Showing first ${HEAD_ROWS} and last ${TAIL_ROWS} rows (${omitted} middle rows omitted):`;
  }

  const resultsText = JSON.stringify(resultsPreview, null, 2);

  const userContent = `Original question: ${question}

SQL query executed:
\`\`\`sql
${sql}
\`\`\`

${previewDescription}
${resultsText}

Column names and types: ${results.columns.map((c, i) => `${c} (${results.columnTypes[i]})`).join(', ')}`;

  const messages: Anthropic.MessageParam[] = [
    ...buildHistoryMessages(history),
    { role: 'user', content: userContent },
  ];

  const client = getClient();
  const stream = client.messages.stream({
    model: getModel(),
    max_tokens: 8192,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages,
  });

  return streamToReadable(stream);
}

// ── Exploratory agent loop helpers ──

/**
 * Build the system prompt for the exploratory tool-use agent loop.
 * Same domain rules and SQL conventions as generateSQL, but reframed
 * for an agent that decides when to explore and when to answer.
 */
export function getExploratorySystemPrompt(
  relevantTables: TableMetadata[],
  relevantMetrics?: MetricEntry[],
  relevantQueries?: QueryLibraryEntry[],
  relevantGitHubQueries?: QueryLibraryEntry[],
): string {
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();

  let prompt = `You are a senior data analyst with access to a Trino data warehouse. You have tools to explore the database and run queries.

APPROACH:
1. Review the metric catalog below FIRST. If any metrics match the user's question, call get_metric_sql to retrieve their full SQL definitions — this is your best starting point.
2. Review the pre-loaded table metadata below (includes columns and types). Only use describe_table if you need a table whose columns are NOT already listed.
3. Use run_exploratory_query to check DISTINCT values, date ranges, row counts, and data distributions BEFORE writing your final query.
4. Once you understand the data well enough, call submit_final_query with your production-quality SQL.
5. If the question is truly ambiguous, call ask_clarification.

Today's date is ${today}. When the user refers to relative time periods ("this month", "this quarter", "last year", "in March") without specifying a year, always assume the CURRENT year (${year}) or use CURRENT_DATE-based expressions.
IMPORTANT: Always EXCLUDE today's date from actuals data pulls — today's data is always incomplete. Use \`CURRENT_DATE - INTERVAL '1' DAY\` as the upper bound. This does NOT apply to forecast tables, which may include future dates.
DEFAULT TIME WINDOW: If the user's question does NOT mention any specific time period, default to the most recent 12 months (CURRENT_DATE - INTERVAL '12' MONTH to CURRENT_DATE - INTERVAL '1' DAY). Always include an explicit date filter.

REFERENCE PRIORITY (use in this order):
1. **Metric catalog** (Statsig): If any metrics below match the question, call get_metric_sql FIRST to get their full SQL. Use the metric SQL as your primary reference — it shows the correct tables, columns, joins, and filters.
2. **Query library**: If a matched reference query is provided below, adapt it.
3. **Schema metadata**: Only explore tables from scratch if no metrics or queries match.

SQL RULES:
- ONLY generate SELECT or WITH (CTE) statements. Never generate data-modification SQL.
- Always use fully qualified table names: lakehouse.schema.table
- Prefer CTEs over subqueries for readability
- Use Trino SQL syntax: DATE '2024-01-01' for date literals, CURRENT_DATE for today, INTERVAL expressions for date arithmetic
- When asked about "month to date", "quarter to date", etc., use CURRENT_DATE - INTERVAL '1' DAY as the end date (today's data is incomplete)
- IMPORTANT: Prefer actual transaction tables over forecast/outlook tables unless user explicitly asks about forecasts

CRITICAL DEFAULT FILTERS — Core remittance:
- \`customer_is_business = FALSE\` — excludes SMB. Only use TRUE if user asks about SMB/business customers.
- \`txn_is_core = TRUE\` — excludes Rewire and non-core. Omit only if user asks about all transaction types or Rewire.

FORECAST TABLES: For monthly forecast data, use \`fpa.fpa_fcst_latest\`. For daily forecast allocations, use \`fpa.fpa_fcst_latest_daily_ma\`.

PAYMENT METHOD: Join \`lakehouse.public.payment_profile_dimension\` using \`payment_profile_key = transaction_payment_profile_key\`. Column: \`payment_instrument_type\`. Do NOT use \`payment_route_dimension\`.

EXPLORATION GUIDELINES:
- Keep exploratory queries fast: always use LIMIT, target small result sets
- Check DISTINCT values of filter columns before applying filters you're unsure about
- Verify date ranges with MIN/MAX queries before writing the final query
- If an exploratory query returns an error, investigate and try a different approach
- You typically need 2-5 exploratory queries before submitting the final answer`;

  // Add domain context EARLY — these rules override everything
  const domain = getDomainContext();
  if (domain) {
    prompt += `\n\n--- CRITICAL DOMAIN RULES (override any assumptions) ---\n${domain}`;
  }

  // Add metric context — compact grouped list (names only, call get_metric_sql for details)
  const metrics = relevantMetrics ?? [];
  if (metrics.length > 0) {
    // Group metrics by sourceName
    const grouped = new Map<string, string[]>();
    for (const m of metrics) {
      const source = m.sourceName || 'Other';
      if (!grouped.has(source)) grouped.set(source, []);
      grouped.get(source)!.push(m.name);
    }

    prompt += `\n\nMetric catalog from Statsig (${metrics.length} metrics grouped by source). Call get_metric_sql with metric names to get full definitions:`;
    for (const [source, names] of grouped) {
      prompt += `\n- **${source}**: ${names.join(', ')}`;
    }
  }

  // Add query library context
  const queries = relevantQueries ?? [];
  if (queries.length > 0) {
    prompt += '\n\nMatched reference queries from local query library (priority 2):';
    for (const q of queries) {
      prompt += `\n\n-- ${q.description}\n${q.sql}`;
    }
  }

  // Add GitHub query context
  const ghQueries = relevantGitHubQueries ?? [];
  if (ghQueries.length > 0) {
    prompt += '\n\nMatched reference queries from shared repo (priority 3):';
    for (const q of ghQueries) {
      prompt += `\n\n-- ${q.description}\n${q.sql}`;
    }
  }

  // Add table metadata
  if (relevantTables.length > 0) {
    prompt += '\n\nPre-loaded table metadata (tables most likely relevant to the question):\n';
    prompt += buildTableContext(relevantTables);
  }

  return prompt;
}

/** Re-export for use by agent-loop-v2 */
export { getClient, getModel, buildHistoryMessages, buildUserContent };
