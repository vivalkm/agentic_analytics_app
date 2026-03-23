import { QueryResult } from './types';
import { spawn, ChildProcess } from 'child_process';

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

  async ensureStarted(): Promise<void> {
    if (this.initialized && this.process && !this.process.killed) return;
    if (this.initPromise) return this.initPromise;

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
        reject(err);
      });

      this.process.on('exit', (code) => {
        console.error(`[trino-mcp] Process exited with code ${code}`);
        this.initialized = false;
        this.initPromise = null;
        this.process = null;
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
        reject(new Error(`MCP tool call '${name}' timed out after 120s`));
      }, 120000);

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

  try {
    const parsed = JSON.parse(textContent.text);

    if (parsed.success === false) {
      throw new Error(parsed.error || 'Query failed');
    }

    const data: Record<string, unknown>[] = parsed.data || [];
    const columns: string[] =
      parsed.columns || (data.length > 0 ? Object.keys(data[0]) : []);

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
  } catch (e) {
    if (e instanceof Error && e.message !== 'Query failed') {
      // Try to parse as plain text
      return parseTextResult(textContent.text);
    }
    throw e;
  }
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

/**
 * Execute a SQL query via the Trino MCP server subprocess.
 */
export async function executeTrinoMCP(sql: string): Promise<{
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
}> {
  const mcpClient = getClient();

  const result = await mcpClient.callTool('query_trino', {
    sql,
    environment: process.env.TRINO_ENVIRONMENT || 'preprod',
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
