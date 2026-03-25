import { QueryResult } from './types';
import { spawn, ChildProcess } from 'child_process';

/** Validate a SQL identifier (catalog/schema/table name) to prevent injection */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdentifier(value: string, label: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" — must be a simple identifier`);
  }
}

/**
 * MCP Client that spawns trino-mcp as a subprocess and communicates via stdio JSON-RPC.
 */
class TrinoMCPClient {
  private process: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  async ensureStarted(): Promise<void> {
    if (this.initialized && this.process && !this.process.killed) return;
    if (this.initPromise) {
      await this.initPromise;
      // Re-check: process may have died while we were waiting
      if (this.initialized && this.process && !this.process.killed) return;
      // Process died — fall through to restart
      this.initPromise = null;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    if (this.consecutiveFailures > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, this.consecutiveFailures - 1), 30000);
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < backoffMs) {
        const waitMs = backoffMs - elapsed;
        console.log(`[trino-mcp] Backoff: waiting ${Math.round(waitMs / 1000)}s before reconnect (failure #${this.consecutiveFailures})`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.initPromise = this._start();
    return this.initPromise;
  }

  private async _start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Trino MCP server startup timed out after 30s'));
      }, 30000);

      this.process = spawn(
        'uvx',
        [
          '--from',
          'git+https://github.com/Remitly/toolbox.git#subdirectory=trino',
          'trino-mcp',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        }
      );

      this.process.stderr?.on('data', (data: Buffer) => {
        // Log MCP server stderr (auth prompts, debug info) to our stderr
        const msg = data.toString();
        console.error('[trino-mcp]', msg.trim());
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this._processBuffer();
      });

      this.process.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[trino-mcp] Process error:', err);
        this.initialized = false;
        this.initPromise = null;
        this.consecutiveFailures++;
        this.lastFailureTime = Date.now();
        reject(err);
      });

      this.process.on('exit', (code) => {
        console.error(`[trino-mcp] Process exited with code ${code}`);
        this.initialized = false;
        this.initPromise = null;
        this.process = null;
        this.consecutiveFailures++;
        this.lastFailureTime = Date.now();
        // Reject all pending requests
        for (const [, req] of this.pendingRequests) {
          req.reject(new Error(`MCP process exited with code ${code}`));
        }
        this.pendingRequests.clear();
      });

      // Send initialize request per MCP protocol
      const initId = this.nextId++;
      this.pendingRequests.set(initId, {
        resolve: () => {
          // Send initialized notification
          this._sendNotification('notifications/initialized', {});
          this.initialized = true;
          this.consecutiveFailures = 0;
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this._sendRaw({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'lakehouse-analytics', version: '0.1.0' },
        },
      });
    });
  }

  private _processBuffer(): void {
    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const req = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            req.reject(
              new Error(msg.error.message || JSON.stringify(msg.error))
            );
          } else {
            req.resolve(msg.result);
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  private _sendRaw(msg: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP process stdin not available');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private _sendNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    this._sendRaw({ jsonrpc: '2.0', method, params });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    await this.ensureStarted();

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP tool call '${name}' timed out after 300s`));
      }, 300000);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timeout);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this._sendRaw({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    });
  }

  kill(): void {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.initialized = false;
    this.initPromise = null;
  }
}

// Singleton client — reused across requests
let client: TrinoMCPClient | null = null;

function getClient(): TrinoMCPClient {
  if (!client) {
    client = new TrinoMCPClient();
  }
  return client;
}

/**
 * Parse the MCP tool call result into our standard format.
 */
function parseMCPResult(result: unknown): {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
} {
  // MCP returns { content: [{ type: 'text', text: '...' }] }
  const content = (result as { content?: { type: string; text: string }[] })
    ?.content;
  if (!content || content.length === 0) {
    return { columns: [], columnTypes: [], rows: [] };
  }

  const textContent = content.find((c) => c.type === 'text');
  if (!textContent) {
    return { columns: [], columnTypes: [], rows: [] };
  }

  // Try JSON first
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textContent.text);
  } catch {
    // Not JSON — fall back to text parsing
    return parseTextResult(textContent.text);
  }

  // JSON parsed successfully — check for Trino errors
  if (parsed.success === false) {
    throw new Error((parsed.error as string) || 'Query failed');
  }

  const data: Record<string, unknown>[] = (parsed.data as Record<string, unknown>[]) || [];
  const columns: string[] =
    (parsed.columns as string[]) || (data.length > 0 ? Object.keys(data[0]) : []);

  // Infer column types from data
  const columnTypes = columns.map((col) => {
    const sample = data.find((r) => r[col] !== null && r[col] !== undefined);
    if (!sample) return 'varchar';
    const val = sample[col];
    if (typeof val === 'number') {
      return Number.isInteger(val) ? 'bigint' : 'double';
    }
    if (typeof val === 'boolean') return 'boolean';
    // Check for date-like strings
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return val.includes('T') || val.includes(' ') ? 'timestamp' : 'date';
    }
    return 'varchar';
  });

  return { columns, columnTypes, rows: data };
}

function parseTextResult(text: string): {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
} {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim());
  if (lines.length === 0) {
    return { columns: ['result'], columnTypes: ['varchar'], rows: [] };
  }

  if (lines.length >= 2 && lines[0].includes('|')) {
    const headers = lines[0]
      .split('|')
      .map((h) => h.trim())
      .filter(Boolean);
    const rows = lines.slice(2).map((line) => {
      const values = line
        .split('|')
        .map((v) => v.trim())
        .filter(Boolean);
      const row: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        row[h] = values[i] ?? null;
      });
      return row;
    });
    return {
      columns: headers,
      columnTypes: headers.map(() => 'varchar'),
      rows,
    };
  }

  return {
    columns: ['value'],
    columnTypes: ['varchar'],
    rows: lines.map((l) => ({ value: l.trim() })),
  };
}

// ---------------------------------------------------------------------------
// Dedicated MCP metadata tools — use these instead of query_trino for
// metadata queries. They avoid the LIMIT-appending issue with SHOW/DESCRIBE.
// ---------------------------------------------------------------------------

const ENV = () => process.env.TRINO_ENVIRONMENT || 'prod';

/**
 * List schemas in a catalog using the dedicated list_schemas MCP tool.
 */
export async function listSchemas(
  catalog: string = 'lakehouse'
): Promise<string[]> {
  const mcpClient = getClient();
  const result = await mcpClient.callTool('list_schemas', {
    catalog,
    environment: ENV(),
  });
  const parsed = parseMCPResult(result);
  // The tool returns rows with a "Schema" or "schema_name" column
  return parsed.rows.map((row) => {
    const val = row['Schema'] ?? row['schema_name'] ?? row['schema'] ?? Object.values(row)[0];
    return String(val || '');
  }).filter(Boolean);
}

/**
 * List tables in a schema using the dedicated list_tables MCP tool.
 */
export async function listTables(
  schema: string,
): Promise<string[]> {
  const mcpClient = getClient();
  const result = await mcpClient.callTool('list_tables', {
    schema,
    environment: ENV(),
  });
  const parsed = parseMCPResult(result);
  return parsed.rows.map((row) => {
    const val = row['Table'] ?? row['table_name'] ?? row['table'] ?? Object.values(row)[0];
    return String(val || '');
  }).filter(Boolean);
}

/**
 * Describe a table's structure using the dedicated describe_table MCP tool.
 */
export async function describeTable(
  tableName: string,
  schema: string = 'public',
): Promise<{ name: string; type: string; comment?: string }[]> {
  const mcpClient = getClient();
  const result = await mcpClient.callTool('describe_table', {
    table_name: tableName,
    schema,
    environment: ENV(),
  });
  const parsed = parseMCPResult(result);
  return parsed.rows.map((row) => {
    const rawComment = row['Comment'] ?? row['comment'];
    const comment = rawComment && String(rawComment).trim() ? String(rawComment).trim() : undefined;
    return {
      name: String(row['Column'] ?? row['column_name'] ?? row['name'] ?? ''),
      type: String(row['Type'] ?? row['data_type'] ?? row['type'] ?? 'unknown'),
      comment,
    };
  });
}

/**
 * Fetch table-level comments for all tables in a schema via system.metadata.table_comments.
 * Returns a map of tableName → comment.
 */
export async function getTableComments(
  catalog: string,
  schema: string,
): Promise<Map<string, string>> {
  assertIdentifier(catalog, 'catalog');
  assertIdentifier(schema, 'schema');
  const mcpClient = getClient();
  const result = await mcpClient.callTool('query_trino', {
    sql: `SELECT table_name, comment FROM system.metadata.table_comments WHERE catalog_name = '${catalog}' AND schema_name = '${schema}'`,
    environment: ENV(),
    limit: 10000,
  });
  const parsed = parseMCPResult(result);
  const map = new Map<string, string>();
  for (const row of parsed.rows) {
    const name = String(row['table_name'] ?? '');
    const comment = row['comment'];
    if (name && comment && String(comment).trim()) {
      map.set(name, String(comment).trim());
    }
  }
  return map;
}

/**
 * Bulk-fetch all columns for every table in a schema using a single SQL query.
 * Much faster than calling describeTable per table (1 round-trip vs N).
 * Returns a map of tableName → columns[].
 */
export async function describeSchemaColumns(
  catalog: string,
  schema: string,
): Promise<Map<string, { name: string; type: string; comment?: string }[]>> {
  assertIdentifier(catalog, 'catalog');
  assertIdentifier(schema, 'schema');
  const mcpClient = getClient();
  const result = await mcpClient.callTool('query_trino', {
    sql: `SELECT table_name, column_name, data_type, comment FROM ${catalog}.information_schema.columns WHERE table_schema = '${schema}' ORDER BY table_name, ordinal_position`,
    environment: ENV(),
    limit: 50000,
  });
  const parsed = parseMCPResult(result);
  const map = new Map<string, { name: string; type: string; comment?: string }[]>();
  for (const row of parsed.rows) {
    const tableName = String(row['table_name'] ?? '');
    if (!tableName) continue;
    if (!map.has(tableName)) map.set(tableName, []);
    const rawComment = row['comment'];
    const comment = rawComment && String(rawComment).trim() ? String(rawComment).trim() : undefined;
    map.get(tableName)!.push({
      name: String(row['column_name'] ?? ''),
      type: String(row['data_type'] ?? 'unknown'),
      comment,
    });
  }
  return map;
}

/**
 * Route SHOW/DESCRIBE SQL to dedicated MCP metadata tools.
 * Returns null if the SQL is not a metadata command.
 */
async function routeMetadataCommand(sql: string): Promise<{
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
} | null> {
  const trimmed = sql.trim();

  // SHOW SCHEMAS FROM <catalog>
  const showSchemas = trimmed.match(/^SHOW\s+SCHEMAS\s+FROM\s+(\w+)/i);
  if (showSchemas) {
    const names = await listSchemas(showSchemas[1]);
    return {
      columns: ['schema_name'],
      columnTypes: ['varchar'],
      rows: names.map((n) => ({ schema_name: n })),
    };
  }

  // SHOW TABLES FROM <catalog>.<schema>  or  SHOW TABLES FROM <schema>
  const showTables = trimmed.match(/^SHOW\s+TABLES\s+FROM\s+(?:\w+\.)?(\w+)/i);
  if (showTables) {
    const names = await listTables(showTables[1]);
    return {
      columns: ['table_name'],
      columnTypes: ['varchar'],
      rows: names.map((n) => ({ table_name: n })),
    };
  }

  // DESCRIBE <catalog>.<schema>.<table>  or  DESCRIBE <schema>.<table>
  const describe3 = trimmed.match(/^DESCRIBE\s+\w+\.(\w+)\.(\w+)/i);
  const describe2 = trimmed.match(/^DESCRIBE\s+(\w+)\.(\w+)/i);
  const descMatch = describe3 ?? describe2;
  if (descMatch) {
    const schema = descMatch[1];
    const table = descMatch[2];
    const cols = await describeTable(table, schema);
    return {
      columns: ['column_name', 'data_type', 'comment'],
      columnTypes: ['varchar', 'varchar', 'varchar'],
      rows: cols.map((c) => ({ column_name: c.name, data_type: c.type, comment: c.comment ?? null })),
    };
  }

  return null;
}

/**
 * Execute a SQL query via the Trino MCP server subprocess.
 * SHOW/DESCRIBE statements are automatically routed to dedicated MCP
 * metadata tools (list_schemas, list_tables, describe_table) to avoid
 * the LIMIT-appending issue with query_trino.
 */
export async function executeTrinoMCP(sql: string): Promise<{
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
}> {
  // Route metadata commands to dedicated tools
  const metadataResult = await routeMetadataCommand(sql);
  if (metadataResult) return metadataResult;

  const mcpClient = getClient();
  const result = await mcpClient.callTool('query_trino', {
    sql,
    environment: ENV(),
    limit: 10000,
  });

  return parseMCPResult(result);
}

/**
 * Client-side helper to call the execute API.
 */
export async function executeTrinoQuery(sql: string): Promise<QueryResult> {
  const startTime = Date.now();

  const response = await fetch(`${getBaseUrl()}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Query execution failed');
  }

  const data = await response.json();
  return {
    columns: data.columns || [],
    columnTypes: data.columnTypes || [],
    rows: data.rows || [],
    rowCount: data.rows?.length || 0,
    executionTimeMs: Date.now() - startTime,
  };
}

function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  return process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
}
