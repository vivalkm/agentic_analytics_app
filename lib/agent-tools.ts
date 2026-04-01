import Anthropic from '@anthropic-ai/sdk';
import { QueryResult, TableMetadata } from './types';
import { validateSQL } from './sql-validator';
import { executeTrinoMCP, describeTable, listTables as listTablesMCP } from './trino';
import { getMetadataCache } from './metadata';
import { getMetricsByName } from './metric-catalog';

// ── Tool definitions for the Anthropic tool-use API ──

export const TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: 'describe_table',
    description:
      'Get column names, types, and comments for a table. Use this to understand what data a table contains before writing queries. Returns the column metadata from the schema cache or by querying the information schema.',
    input_schema: {
      type: 'object' as const,
      properties: {
        schema: {
          type: 'string',
          description: 'The schema name (e.g. "fpa", "public")',
        },
        table: {
          type: 'string',
          description: 'The table name (e.g. "transaction_economics")',
        },
      },
      required: ['schema', 'table'],
    },
  },
  {
    name: 'list_tables',
    description:
      'List all table names in a schema. Use this to discover what tables are available when you need to find the right table for a query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        schema: {
          type: 'string',
          description: 'The schema name (e.g. "fpa", "public")',
        },
      },
      required: ['schema'],
    },
  },
  {
    name: 'run_exploratory_query',
    description:
      'Run a read-only SQL query against the Trino data warehouse for exploration purposes. Use this for: checking DISTINCT values in filter columns, counting rows, understanding data distributions, verifying date ranges, sampling data. Results are limited to 100 rows. Always use LIMIT and keep queries fast.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute (must be read-only SELECT/WITH)',
        },
        purpose: {
          type: 'string',
          description: 'Brief explanation of what you hope to learn from this query',
        },
      },
      required: ['sql', 'purpose'],
    },
  },
  {
    name: 'submit_final_query',
    description:
      'Submit your final, production-quality SQL query that answers the user\'s question. Only call this AFTER you have sufficiently explored the data and are confident in your query. This ends the exploration phase and triggers result analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string',
          description: 'The final SQL query that answers the user\'s question',
        },
        explanation: {
          type: 'string',
          description: 'Explanation of what the query does and any assumptions made',
        },
      },
      required: ['sql', 'explanation'],
    },
  },
  {
    name: 'ask_clarification',
    description:
      'Ask the user a clarifying question when the request is ambiguous and you cannot proceed without more information. Only use this when you truly cannot determine what the user wants.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'The clarifying question to ask the user',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_metric_sql',
    description:
      'Get the full backing SQL and detailed definitions for specific Statsig metrics. Call this EARLY (as your first tool call) when you identify relevant metrics from the metric catalog in the system prompt. The returned SQL shows exactly how each metric is calculated and which tables/columns to use — this saves you from exploring tables from scratch.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of metric names to look up (e.g. ["Revenue", "Active Users"]). Names are matched case-insensitively.',
        },
      },
      required: ['metric_names'],
    },
  },
];

// ── Tool execution ──

/** Max rows returned from exploratory queries (keeps token count manageable). */
const MAX_EXPLORATORY_ROWS = 20;
/** Max chars per cell value in exploratory results. */
const MAX_CELL_CHARS = 200;

export interface ToolResult {
  result: string;
  isError: boolean;
  /** Extra structured data for the agent loop to emit events. */
  metadata?: {
    type: 'query_result';
    queryResult: QueryResult;
  } | {
    type: 'clarification';
    question: string;
  };
}

/**
 * Execute a tool call and return the result text.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  switch (name) {
    case 'describe_table':
      return executeDescribeTable(input as { schema: string; table: string });

    case 'list_tables':
      return executeListTables(input as { schema: string });

    case 'run_exploratory_query':
      return executeExploratoryQuery(input as { sql: string; purpose: string }, signal);

    case 'submit_final_query':
      return executeSubmitFinalQuery(input as { sql: string; explanation: string }, signal);

    case 'ask_clarification':
      return {
        result: 'Clarification sent to user.',
        isError: false,
        metadata: { type: 'clarification', question: String(input.question) },
      };

    case 'get_metric_sql':
      return executeGetMetricSQL(input as { metric_names: string[] });

    default:
      return { result: `Unknown tool: ${name}`, isError: true };
  }
}

// ── Individual tool handlers ──

async function executeDescribeTable(
  input: { schema: string; table: string },
): Promise<ToolResult> {
  const { schema, table } = input;
  const catalog = 'lakehouse';

  // Try metadata cache first (fast, no MCP call)
  const cache = getMetadataCache();
  if (cache) {
    const cached = cache.tables.find(
      (t) =>
        t.schema.toLowerCase() === schema.toLowerCase() &&
        t.table.toLowerCase() === table.toLowerCase() &&
        t.columns.length > 0,
    );
    if (cached) {
      return { result: formatTableDescription(cached), isError: false };
    }
  }

  // Fall back to MCP
  try {
    const columns = await describeTable(table, schema);
    const formatted = columns
      .map((c) => `  ${c.name} (${c.type})${c.comment ? ` -- ${c.comment}` : ''}`)
      .join('\n');
    return {
      result: `Table: ${catalog}.${schema}.${table}\nColumns:\n${formatted}`,
      isError: false,
    };
  } catch (e) {
    return {
      result: `Failed to describe ${catalog}.${schema}.${table}: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

function formatTableDescription(t: TableMetadata): string {
  const cols = t.columns
    .map((c) => `  ${c.name} (${c.type})${c.comment ? ` -- ${c.comment}` : ''}`)
    .join('\n');
  return `Table: ${t.catalog}.${t.schema}.${t.table}${t.comment ? ` -- ${t.comment}` : ''}\nColumns:\n${cols}`;
}

async function executeListTables(
  input: { schema: string },
): Promise<ToolResult> {
  const { schema } = input;

  // Try metadata cache first
  const cache = getMetadataCache();
  if (cache) {
    const tables = cache.tables
      .filter((t) => t.schema.toLowerCase() === schema.toLowerCase())
      .map((t) => t.table);
    if (tables.length > 0) {
      return {
        result: `Tables in schema "${schema}" (${tables.length}):\n${tables.join('\n')}`,
        isError: false,
      };
    }
  }

  // Fall back to MCP
  try {
    const tables = await listTablesMCP(schema);
    return {
      result: `Tables in schema "${schema}" (${tables.length}):\n${tables.join('\n')}`,
      isError: false,
    };
  } catch (e) {
    return {
      result: `Failed to list tables in "${schema}": ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

async function executeExploratoryQuery(
  input: { sql: string; purpose: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  let { sql } = input;

  // Validate read-only
  const validation = validateSQL(sql);
  if (!validation.valid) {
    return { result: `SQL validation failed: ${validation.error}`, isError: true };
  }

  // Auto-append LIMIT if not present
  const upperSQL = sql.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!upperSQL.includes('LIMIT ')) {
    sql = sql.replace(/;\s*$/, '') + ' LIMIT 100';
  }

  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const startMs = Date.now();
    const raw = await executeTrinoMCP(sql);
    const queryResult: QueryResult = {
      columns: raw.columns,
      columnTypes: raw.columnTypes,
      rows: raw.rows,
      rowCount: raw.rows.length,
      executionTimeMs: Date.now() - startMs,
    };
    return {
      result: formatQueryResult(queryResult, MAX_EXPLORATORY_ROWS),
      isError: false,
      metadata: { type: 'query_result', queryResult },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return {
      result: `Query execution failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

async function executeSubmitFinalQuery(
  input: { sql: string; explanation: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { sql } = input;

  // Validate read-only
  const validation = validateSQL(sql);
  if (!validation.valid) {
    return { result: `SQL validation failed: ${validation.error}`, isError: true };
  }

  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const startMs = Date.now();
    const raw = await executeTrinoMCP(sql);
    const queryResult: QueryResult = {
      columns: raw.columns,
      columnTypes: raw.columnTypes,
      rows: raw.rows,
      rowCount: raw.rows.length,
      executionTimeMs: Date.now() - startMs,
    };
    return {
      result: formatQueryResult(queryResult, 50),
      isError: false,
      metadata: { type: 'query_result', queryResult },
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return {
      result: `Query execution failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

function executeGetMetricSQL(
  input: { metric_names: string[] },
): ToolResult {
  const { metric_names } = input;
  if (!metric_names || metric_names.length === 0) {
    return { result: 'No metric names provided.', isError: true };
  }

  const found = getMetricsByName(metric_names);
  if (found.length === 0) {
    return {
      result: `No metrics found matching: ${metric_names.join(', ')}. Check the metric catalog in the system prompt for exact names.`,
      isError: false,
    };
  }

  const lines: string[] = [`Found ${found.length} metric(s):\n`];
  for (const m of found) {
    lines.push(`### ${m.name}`);
    lines.push(`Description: ${m.description}`);
    lines.push(`Kind: ${m.kind}`);
    if (m.sourceName) lines.push(`Source: ${m.sourceName}`);
    if (m.aggregation) lines.push(`Aggregation: ${m.aggregation}`);
    if (m.valueColumn) lines.push(`Value column: ${m.valueColumn}`);
    if (m.criteria && m.criteria.length > 0) {
      lines.push(`Criteria: ${m.criteria.map((c) => `${c.column} ${c.condition} ${c.values.join(', ')}`).join(' AND ')}`);
    }
    if (m.sql) {
      lines.push(`Backing SQL:\n\`\`\`sql\n${m.sql}\n\`\`\``);
    }
    lines.push('');
  }

  return { result: lines.join('\n'), isError: false };
}

// ── Formatting helpers ──

function formatQueryResult(result: QueryResult, maxRows: number): string {
  const lines: string[] = [];
  lines.push(`Columns: ${result.columns.join(', ')}`);
  lines.push(`Row count: ${result.rowCount} (${result.executionTimeMs}ms)`);

  if (result.rows.length === 0) {
    lines.push('(no rows returned)');
    return lines.join('\n');
  }

  // Show rows as a simple table
  const rowsToShow = result.rows.slice(0, maxRows);
  lines.push('');
  for (const row of rowsToShow) {
    const cells = result.columns.map((col) => {
      const val = row[col];
      const str = val === null || val === undefined ? 'NULL' : String(val);
      return str.length > MAX_CELL_CHARS ? str.slice(0, MAX_CELL_CHARS) + '...' : str;
    });
    lines.push(cells.join(' | '));
  }

  if (result.rowCount > maxRows) {
    lines.push(`... (${result.rowCount - maxRows} more rows)`);
  }

  return lines.join('\n');
}
