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
// Worker pool of persistent Python processes — HMR-safe via globalThis
// ---------------------------------------------------------------------------

const MAX_WORKERS = 5;
const QUERY_TIMEOUT_MS = 300_000;
const IDLE_TIMEOUT_MS = 5 * 60_000; // Kill idle workers after 5 min
const QUEUE_TIMEOUT_MS = 60_000;    // Reject queued requests after 60s waiting

type QueryResult = { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] };

interface TrinoWorker {
  child: ChildProcess;
  rl: Interface;
  /** Currently waiting for a response */
  pending: {
    resolve: (value: QueryResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Timer that kills the worker after IDLE_TIMEOUT_MS of inactivity */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface TrinoPool {
  workers: TrinoWorker[];
  /** Global queue — requests waiting for an available worker */
  queue: Array<{
    sql: string;
    resolve: (value: QueryResult) => void;
    reject: (err: Error) => void;
  }>;
}

const g = globalThis as unknown as { __trinoPool?: TrinoPool };

function getPool(): TrinoPool {
  if (!g.__trinoPool) {
    g.__trinoPool = { workers: [], queue: [] };
  }
  return g.__trinoPool;
}

function killWorker(worker: TrinoWorker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;
  if (worker.pending) {
    worker.pending.reject(new Error('Trino worker terminated'));
    clearTimeout(worker.pending.timer);
    worker.pending = null;
  }
  worker.rl.close();
  worker.child.kill();
  const pool = getPool();
  const idx = pool.workers.indexOf(worker);
  if (idx >= 0) pool.workers.splice(idx, 1);
}

/** Reset the idle timer — call when a worker becomes idle. */
function resetIdleTimer(worker: TrinoWorker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => {
    if (!worker.pending) {
      console.log(`[trino] Killing idle worker (${IDLE_TIMEOUT_MS / 1000}s timeout)`);
      killWorker(worker);
    }
  }, IDLE_TIMEOUT_MS);
}

/** Try to dispatch a queued request to an idle worker, or spawn a new one. */
function dispatch(): void {
  const pool = getPool();
  if (pool.queue.length === 0) return;

  // Find an idle worker
  let worker = pool.workers.find((w) => !w.pending);

  // No idle worker — spawn a new one if under limit
  if (!worker && pool.workers.length < MAX_WORKERS) {
    worker = spawnWorker();
  }

  if (!worker) return; // All busy and at max — request stays queued

  const next = pool.queue.shift()!;
  sendToWorker(worker, next.sql, next.resolve, next.reject);
}

function sendToWorker(
  worker: TrinoWorker,
  sql: string,
  resolve: (value: QueryResult) => void,
  reject: (err: Error) => void,
): void {
  // Clear idle timer — worker is now busy
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = null;

  const timer = setTimeout(() => {
    if (worker.pending) {
      worker.pending.reject(new Error('Trino query timed out after 300s'));
      worker.pending = null;
      killWorker(worker);
      dispatch(); // try queued requests on remaining workers
    }
  }, QUERY_TIMEOUT_MS);

  worker.pending = { resolve, reject, timer };

  try {
    worker.child.stdin!.write(JSON.stringify({ sql }) + '\n');
  } catch (err) {
    clearTimeout(timer);
    worker.pending = null;
    reject(new Error(`Failed to write to Trino worker: ${err}`));
    killWorker(worker);
    dispatch();
  }
}

function spawnWorker(): TrinoWorker {
  const pool = getPool();
  const scriptPath = join(process.cwd(), 'scripts', 'trino-query.py');
  const child = spawn(getPython(), [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout! });
  const worker: TrinoWorker = { child, rl, pending: null, idleTimer: null };

  rl.on('line', (line: string) => {
    if (!worker.pending) return;
    const { resolve, reject, timer } = worker.pending;
    clearTimeout(timer);
    worker.pending = null;

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

    // Worker is now idle — start idle timer and dispatch next queued request
    resetIdleTimer(worker);
    dispatch();
  });

  child.stderr!.on('data', (data: Buffer) => {
    console.error(`[trino:${pool.workers.length}]`, data.toString().trim());
  });

  child.on('close', (code) => {
    const idx = pool.workers.indexOf(worker);
    if (idx >= 0) {
      if (worker.pending) {
        worker.pending.reject(new Error(`Trino worker exited (code ${code})`));
        clearTimeout(worker.pending.timer);
        worker.pending = null;
      }
      pool.workers.splice(idx, 1);
      dispatch(); // try queued requests on remaining workers
    }
  });

  child.on('error', (err) => {
    console.error('[trino] Worker error:', err.message);
    const idx = pool.workers.indexOf(worker);
    if (idx >= 0) {
      if (worker.pending) {
        worker.pending.reject(new Error(`Trino worker error: ${err.message}`));
        clearTimeout(worker.pending.timer);
        worker.pending = null;
      }
      pool.workers.splice(idx, 1);
      dispatch();
    }
  });

  pool.workers.push(worker);
  console.log(`[trino] Spawned worker ${pool.workers.length}/${MAX_WORKERS}`);
  return worker;
}

/**
 * Execute a SQL query against Trino via the worker pool.
 * The first call spawns a worker (triggers one OAuth browser popup).
 * Concurrent calls use idle workers or spawn new ones (up to 5).
 */
export async function executeTrinoMCP(sql: string): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const pool = getPool();

    // Queue timeout — reject if no worker picks this up within QUEUE_TIMEOUT_MS
    const queueTimer = setTimeout(() => {
      const idx = pool.queue.findIndex((q) => q.resolve === wrappedResolve);
      if (idx >= 0) {
        pool.queue.splice(idx, 1);
        reject(new Error(`Trino queue timeout: no worker available after ${QUEUE_TIMEOUT_MS / 1000}s`));
      }
    }, QUEUE_TIMEOUT_MS);

    const wrappedResolve = (value: QueryResult) => {
      clearTimeout(queueTimer);
      resolve(value);
    };
    const wrappedReject = (err: Error) => {
      clearTimeout(queueTimer);
      reject(err);
    };

    pool.queue.push({ sql, resolve: wrappedResolve, reject: wrappedReject });
    dispatch();
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
