import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInterface, Interface } from 'readline';

/** Validate a SQL identifier (catalog/schema/table name) to prevent injection */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdentifier(value: string, label: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" — must be a simple identifier`);
  }
}

/** Resolve Python binary: prefer project .venv, fall back to system python3. */
function getPython(): string {
  const venvPython = join(process.cwd(), '.venv', 'bin', 'python');
  return existsSync(venvPython) ? venvPython : 'python3';
}

// ---------------------------------------------------------------------------
// Persistent Python process — singleton, HMR-safe via globalThis
// ---------------------------------------------------------------------------

interface TrinoProcess {
  child: ChildProcess;
  rl: Interface;
  /** Currently waiting for a response */
  pending: {
    resolve: (value: { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Queued requests waiting to be sent */
  queue: Array<{
    sql: string;
    resolve: (value: { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] }) => void;
    reject: (err: Error) => void;
  }>;
}

const g = globalThis as unknown as { __trinoProcess?: TrinoProcess };

function killProcess(): void {
  const tp = g.__trinoProcess;
  if (!tp) return;
  if (tp.pending) {
    tp.pending.reject(new Error('Trino process terminated'));
    clearTimeout(tp.pending.timer);
  }
  for (const queued of tp.queue) {
    queued.reject(new Error('Trino process terminated'));
  }
  tp.rl.close();
  tp.child.kill();
  g.__trinoProcess = undefined;
}

function processNext(tp: TrinoProcess): void {
  if (tp.pending || tp.queue.length === 0) return;

  const next = tp.queue.shift()!;
  const timer = setTimeout(() => {
    if (tp.pending) {
      tp.pending.reject(new Error('Trino query timed out after 300s'));
      tp.pending = null;
      // Kill the process so next query gets a fresh connection
      killProcess();
    }
  }, 300000);

  tp.pending = { resolve: next.resolve, reject: next.reject, timer };

  try {
    tp.child.stdin!.write(JSON.stringify({ sql: next.sql }) + '\n');
  } catch (err) {
    clearTimeout(timer);
    tp.pending = null;
    next.reject(new Error(`Failed to write to Trino process: ${err}`));
    killProcess();
  }
}

function ensureProcess(): TrinoProcess {
  if (g.__trinoProcess) return g.__trinoProcess;

  const scriptPath = join(process.cwd(), 'scripts', 'trino-query.py');
  const child = spawn(getPython(), [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout! });

  const tp: TrinoProcess = { child, rl, pending: null, queue: [] };

  rl.on('line', (line: string) => {
    if (!tp.pending) return;
    const { resolve, reject, timer } = tp.pending;
    clearTimeout(timer);
    tp.pending = null;

    try {
      const result = JSON.parse(line);
      if (result.error) {
        reject(new Error(result.error));
      } else {
        resolve({
          columns: result.columns || [],
          columnTypes: result.columnTypes || [],
          rows: result.rows || [],
        });
      }
    } catch {
      reject(new Error(`Failed to parse Trino output: ${line.slice(0, 200)}`));
    }

    // Process next queued request
    processNext(tp);
  });

  child.stderr!.on('data', (data: Buffer) => {
    console.error('[trino]', data.toString().trim());
  });

  child.on('close', (code) => {
    if (g.__trinoProcess === tp) {
      // Reject any pending request
      if (tp.pending) {
        tp.pending.reject(new Error(`Trino process exited (code ${code})`));
        clearTimeout(tp.pending.timer);
      }
      // Reject queued requests
      for (const queued of tp.queue) {
        queued.reject(new Error(`Trino process exited (code ${code})`));
      }
      g.__trinoProcess = undefined;
    }
  });

  child.on('error', (err) => {
    console.error('[trino] Process error:', err.message);
    if (g.__trinoProcess === tp) {
      if (tp.pending) {
        tp.pending.reject(new Error(`Trino process error: ${err.message}`));
        clearTimeout(tp.pending.timer);
      }
      for (const queued of tp.queue) {
        queued.reject(new Error(`Trino process error: ${err.message}`));
      }
      g.__trinoProcess = undefined;
    }
  });

  g.__trinoProcess = tp;
  return tp;
}

/**
 * Execute a SQL query against Trino via the persistent Python process.
 * The first call spawns the process (triggers one OAuth browser popup).
 * Subsequent calls reuse the same connection.
 */
export async function executeTrinoMCP(sql: string): Promise<{
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
}> {
  return new Promise((resolve, reject) => {
    const tp = ensureProcess();
    tp.queue.push({ sql, resolve, reject });
    processNext(tp);
  });
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

const getCatalog = () =>
  process.env.TRINO_CATALOG || process.env.TRINO_DEFAULT_CATALOG || 'lakehouse';

/**
 * List schemas in a catalog.
 */
export async function listSchemas(
  catalog: string = getCatalog()
): Promise<string[]> {
  assertIdentifier(catalog, 'catalog');
  const result = await executeTrinoMCP(`SHOW SCHEMAS FROM ${catalog}`);
  return result.rows.map((row) => {
    const val = row['Schema'] ?? row['schema_name'] ?? row['schema'] ?? Object.values(row)[0];
    return String(val || '');
  }).filter(Boolean);
}

/**
 * List tables in a schema.
 */
export async function listTables(
  schema: string,
): Promise<string[]> {
  assertIdentifier(schema, 'schema');
  const catalog = getCatalog();
  assertIdentifier(catalog, 'catalog');
  const result = await executeTrinoMCP(`SHOW TABLES FROM ${catalog}.${schema}`);
  return result.rows.map((row) => {
    const val = row['Table'] ?? row['table_name'] ?? row['table'] ?? Object.values(row)[0];
    return String(val || '');
  }).filter(Boolean);
}

/**
 * Describe a table's columns.
 */
export async function describeTable(
  tableName: string,
  schema: string = 'public',
): Promise<{ name: string; type: string; comment?: string }[]> {
  assertIdentifier(schema, 'schema');
  assertIdentifier(tableName, 'table');
  const catalog = getCatalog();
  assertIdentifier(catalog, 'catalog');

  const result = await executeTrinoMCP(
    `SELECT column_name, data_type, comment FROM ${catalog}.information_schema.columns ` +
    `WHERE table_schema = '${schema}' AND table_name = '${tableName}' ORDER BY ordinal_position`
  );

  return result.rows.map((row) => {
    const rawComment = row['comment'];
    const comment = rawComment && String(rawComment).trim() ? String(rawComment).trim() : undefined;
    return {
      name: String(row['column_name'] ?? ''),
      type: String(row['data_type'] ?? 'unknown'),
      comment,
    };
  });
}

/**
 * Fetch table-level comments for all tables in a schema.
 * Returns a map of tableName → comment.
 */
export async function getTableComments(
  catalog: string,
  schema: string,
): Promise<Map<string, string>> {
  assertIdentifier(catalog, 'catalog');
  assertIdentifier(schema, 'schema');
  const result = await executeTrinoMCP(
    `SELECT table_name, comment FROM system.metadata.table_comments ` +
    `WHERE catalog_name = '${catalog}' AND schema_name = '${schema}'`
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
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
 * Returns a map of tableName → columns[].
 */
export async function describeSchemaColumns(
  catalog: string,
  schema: string,
): Promise<Map<string, { name: string; type: string; comment?: string }[]>> {
  assertIdentifier(catalog, 'catalog');
  assertIdentifier(schema, 'schema');
  const result = await executeTrinoMCP(
    `SELECT table_name, column_name, data_type, comment ` +
    `FROM ${catalog}.information_schema.columns ` +
    `WHERE table_schema = '${schema}' ORDER BY table_name, ordinal_position`
  );
  const map = new Map<string, { name: string; type: string; comment?: string }[]>();
  for (const row of result.rows) {
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
