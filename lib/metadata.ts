import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TableMetadata, MetadataCache } from './types';
import { listSchemas, listTables, describeTable, getTableComments } from './trino-mcp';

// --- Disk persistence ---
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'metadata.json');

function loadCacheFromDisk(): MetadataCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as MetadataCache;
    if (parsed?.tables?.length > 0) {
      console.log(`[metadata] Loaded ${parsed.tables.length} tables from disk cache (${parsed.lastRefreshed})`);
      return parsed;
    }
  } catch {
    // No cache file or invalid — that's fine
  }
  return null;
}

function saveCacheToDisk(cache: MetadataCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (e) {
    console.error('[metadata] Failed to write disk cache:', e);
  }
}

// --- In-memory state (globalThis survives hot reloads, disk survives restarts) ---
const g = globalThis as typeof globalThis & {
  __metadataCache?: MetadataCache | null;
  __metadataRefreshInProgress?: boolean;
  __metadataRefreshPromise?: Promise<void> | null;
  __metadataPriorityResolve?: (() => void) | null;
  __metadataPriorityPromise?: Promise<void> | null;
};

let metadataCache: MetadataCache | null = g.__metadataCache ?? loadCacheFromDisk();
let refreshInProgress = g.__metadataRefreshInProgress ?? false;
let refreshPromise: Promise<void> | null = g.__metadataRefreshPromise ?? null;
let priorityResolve: (() => void) | null = g.__metadataPriorityResolve ?? null;
let priorityPromise: Promise<void> | null = g.__metadataPriorityPromise ?? null;

function syncToGlobal() {
  g.__metadataCache = metadataCache;
  g.__metadataRefreshInProgress = refreshInProgress;
  g.__metadataRefreshPromise = refreshPromise;
  g.__metadataPriorityResolve = priorityResolve;
  g.__metadataPriorityPromise = priorityPromise;
}

/**
 * Read priority config from env vars.
 * TRINO_PRIORITY_SCHEMAS: comma-separated schemas to load first (e.g. "finance_platform,product")
 * TRINO_PRIORITY_TABLES: comma-separated fully-qualified tables (e.g. "lakehouse.finance_platform.transactions")
 * TRINO_DEFAULT_CATALOG: catalog to introspect (default: "lakehouse")
 * TRINO_SKIP_SCHEMAS: comma-separated schemas to skip entirely (e.g. "sandbox,information_schema")
 */
function getPriorityConfig() {
  const prioritySchemas = (process.env.TRINO_PRIORITY_SCHEMAS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const priorityTables = (process.env.TRINO_PRIORITY_TABLES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const skipSchemas = new Set(
    (process.env.TRINO_SKIP_SCHEMAS || 'information_schema,sys')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const defaultCatalog = process.env.TRINO_DEFAULT_CATALOG || 'lakehouse';

  return { prioritySchemas, priorityTables, skipSchemas, defaultCatalog };
}

export function getMetadataCache(): MetadataCache | null {
  return metadataCache;
}

export function setMetadataCache(cache: MetadataCache): void {
  metadataCache = cache;
  syncToGlobal();
}

export function isRefreshing(): boolean {
  return refreshInProgress;
}

/**
 * Trigger a background metadata refresh. Non-blocking — returns immediately.
 * Skips if already refreshed within REFRESH_INTERVAL_MS unless force=true.
 * Loads priority schemas first, then remaining schemas.
 */
export function triggerBackgroundRefresh(force = false): void {
  if (refreshInProgress) return;

  // Only refresh when forced (user clicked Refresh) or cache has no tables
  if (!force && metadataCache && metadataCache.tables.length > 0) return;

  refreshInProgress = true;

  // Create a promise that resolves when priority schemas are loaded
  priorityPromise = new Promise<void>((resolve) => {
    priorityResolve = resolve;
  });

  refreshPromise = refreshMetadata()
    .catch((err) => console.error('[metadata] Background refresh failed:', err))
    .finally(() => {
      refreshInProgress = false;
      refreshPromise = null;
      if (priorityResolve) {
        priorityResolve();
        priorityResolve = null;
      }
      priorityPromise = null;
      syncToGlobal();
    });

  syncToGlobal();
}

export async function waitForRefresh(): Promise<void> {
  if (refreshPromise) await refreshPromise;
}

/**
 * Wait only until priority schemas (e.g. fpa) are loaded — much faster than waitForRefresh.
 */
export async function waitForPrioritySchemas(): Promise<void> {
  if (priorityPromise) await priorityPromise;
}

/**
 * Ensure metadata is loading. If not yet started, kicks off background refresh.
 * Returns immediately — does NOT block.
 */
export function ensureMetadataLoading(): void {
  if (metadataCache || refreshInProgress) return;
  triggerBackgroundRefresh();
}

/**
 * Introspect tables for a single schema and add them to the tables array.
 * Updates metadataCache progressively after each table.
 */
async function introspectSchema(
  catalog: string,
  schema: string,
  catalogs: string[],
  allSchemas: Record<string, string[]>,
  tables: TableMetadata[]
): Promise<void> {
  try {
    // Use dedicated MCP tools instead of query_trino SQL
    const [tableNames, tableComments] = await Promise.all([
      listTables(schema),
      getTableComments(catalog, schema).catch(() => new Map<string, string>()),
    ]);

    // Describe each table to get columns (with column comments)
    for (const tableName of tableNames) {
      try {
        const columns = await describeTable(tableName, schema);
        tables.push({
          catalog,
          schema,
          table: tableName,
          columns,
          comment: tableComments.get(tableName),
          lastRefreshed: new Date().toISOString(),
        });
      } catch (e) {
        // If describe fails for a single table, still include it with no columns
        console.error(`[metadata] Failed to describe ${catalog}.${schema}.${tableName}:`, e);
        tables.push({
          catalog,
          schema,
          table: tableName,
          columns: [],
          comment: tableComments.get(tableName),
          lastRefreshed: new Date().toISOString(),
        });
      }
    }

    // Update cache progressively
    metadataCache = {
      catalogs,
      schemas: allSchemas,
      tables: [...tables],
      lastRefreshed: new Date().toISOString(),
    };
    syncToGlobal();
  } catch (e) {
    console.error(`[metadata] Failed to introspect ${catalog}.${schema}:`, e);
  }
}

async function refreshMetadata(): Promise<void> {
  const config = getPriorityConfig();
  console.log(
    `[metadata] Starting refresh... priority schemas: [${config.prioritySchemas.join(', ')}], ` +
      `skip: [${[...config.skipSchemas].join(', ')}]`
  );

  const catalogs: string[] = [];
  const schemas: Record<string, string[]> = {};
  const tables: TableMetadata[] = [];

  // Step 1: Only introspect the configured catalog (default: "lakehouse").
  // System catalogs (system, jmx, memory, etc.) cause errors when introspected
  // and are not useful for data queries.
  catalogs.push(config.defaultCatalog);

  // Preserve existing tables while refreshing so progress/sidebar don't flash empty
  const existingTables = metadataCache?.tables || [];
  metadataCache = { catalogs, schemas: {}, tables: existingTables, lastRefreshed: new Date().toISOString() };
  syncToGlobal();
  console.log(`[metadata] Introspecting catalog: ${config.defaultCatalog}`);

  // Step 2: List schemas for the target catalog using dedicated MCP tool
  for (const catalog of catalogs) {
    try {
      schemas[catalog] = await listSchemas(catalog);
    } catch (e) {
      console.error(`[metadata] Failed to list schemas for ${catalog}:`, e);
    }
  }

  metadataCache = { catalogs, schemas, tables: existingTables, lastRefreshed: new Date().toISOString() };
  syncToGlobal();
  const totalSchemas = Object.values(schemas).reduce((s, arr) => s + arr.length, 0);
  console.log(`[metadata] Found ${totalSchemas} schemas`);

  // Step 3: Introspect schemas — priority first, then the rest
  for (const [catalog, schemaList] of Object.entries(schemas)) {
    // Split into priority and non-priority
    const priority: string[] = [];
    const remaining: string[] = [];

    for (const schema of schemaList) {
      const lower = schema.toLowerCase();
      if (config.skipSchemas.has(lower)) continue;
      if (config.prioritySchemas.includes(lower)) {
        priority.push(schema);
      } else {
        remaining.push(schema);
      }
    }

    // Sort priority schemas to match the configured order
    priority.sort(
      (a, b) =>
        config.prioritySchemas.indexOf(a.toLowerCase()) -
        config.prioritySchemas.indexOf(b.toLowerCase())
    );

    // Load priority schemas first
    if (priority.length > 0) {
      console.log(`[metadata] Loading priority schemas: [${priority.join(', ')}]`);
    }
    for (const schema of priority) {
      await introspectSchema(catalog, schema, catalogs, schemas, tables);
    }

    if (priority.length > 0) {
      console.log(
        `[metadata] Priority schemas loaded: ${tables.length} tables. Loading remaining schemas...`
      );
    }

    // Signal that priority schemas are ready — callers using waitForPrioritySchemas() unblock here
    if (priorityResolve) {
      priorityResolve();
      priorityResolve = null;
      syncToGlobal();
      if (metadataCache) saveCacheToDisk(metadataCache);
    }

    // Then load remaining schemas
    for (const schema of remaining) {
      await introspectSchema(catalog, schema, catalogs, schemas, tables);
    }
  }

  console.log(`[metadata] Refresh complete: ${tables.length} tables loaded`);
  if (metadataCache) saveCacheToDisk(metadataCache);
}

export function findRelevantTables(
  question: string,
  maxTables: number = 10
): TableMetadata[] {
  if (!metadataCache) return [];

  const config = getPriorityConfig();
  const questionLower = question.toLowerCase();
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'that', 'this',
    'what', 'show', 'how', 'many', 'all', 'are', 'was',
    'were', 'been', 'have', 'has', 'had', 'will', 'would',
    'could', 'should', 'may', 'can', 'its', 'our', 'their',
  ]);
  const keywords = questionLower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const scored = metadataCache.tables.map((table) => {
    let score = 0;
    const tableName = table.table.toLowerCase();
    const schemaName = table.schema.toLowerCase();
    const fqn = `${table.catalog}.${schemaName}.${tableName}`;

    // Keyword matching
    for (const keyword of keywords) {
      if (tableName.includes(keyword)) score += 10;
      if (schemaName.includes(keyword)) score += 5;
      if (table.comment?.toLowerCase().includes(keyword)) score += 8;
      for (const col of table.columns) {
        if (col.name.toLowerCase().includes(keyword)) score += 3;
        if (col.comment?.toLowerCase().includes(keyword)) score += 4;
      }
    }

    // Table name word matching
    const tableWords = tableName.split(/[_-]/).filter((w) => w.length > 2);
    for (const tw of tableWords) {
      if (questionLower.includes(tw)) score += 6;
    }

    // Boost priority schemas/tables
    if (config.prioritySchemas.includes(schemaName)) {
      score += 5;
    }
    const shortFqn = `${schemaName}.${tableName}`;
    if (config.priorityTables.includes(fqn) || config.priorityTables.includes(shortFqn)) {
      score += 15;
    }

    return { table, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTables)
    .map((s) => s.table);
}

export function getAllTables(): TableMetadata[] {
  return metadataCache?.tables || [];
}

export function getSchemaTree(): Record<string, Record<string, string[]>> {
  if (!metadataCache) return {};

  const tree: Record<string, Record<string, string[]>> = {};
  for (const table of metadataCache.tables) {
    if (!tree[table.catalog]) tree[table.catalog] = {};
    if (!tree[table.catalog][table.schema])
      tree[table.catalog][table.schema] = [];
    tree[table.catalog][table.schema].push(table.table);
  }
  return tree;
}
