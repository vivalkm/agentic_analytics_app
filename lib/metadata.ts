import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { TableMetadata, MetadataCache } from './types';
import { listSchemas, listTables, describeTable, describeSchemaColumns, getTableComments } from './trino-mcp';
import { extractKeywords } from './stop-words';

// --- Disk persistence ---
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'metadata.json');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    const tmp = CACHE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error('[metadata] Failed to write disk cache:', e);
  }
}

// --- In-memory state via globalThis (survives HMR — no local copies that desync) ---
interface MetadataGlobals {
  __metadataCache?: MetadataCache | null;
  __metadataRefreshInProgress?: boolean;
  __metadataRefreshPromise?: Promise<void> | null;
  __metadataPriorityResolve?: (() => void) | null;
  __metadataPriorityPromise?: Promise<void> | null;
}
const g = globalThis as typeof globalThis & MetadataGlobals;

// Initialize from disk on first load only
if (g.__metadataCache === undefined) {
  g.__metadataCache = loadCacheFromDisk();
}

// Accessor helpers — all state lives in globalThis, no local `let` copies
function getCache(): MetadataCache | null { return g.__metadataCache ?? null; }
function setCache(c: MetadataCache | null) { g.__metadataCache = c; }
function getRefreshPromise(): Promise<void> | null { return g.__metadataRefreshPromise ?? null; }
function setRefreshPromise(p: Promise<void> | null) { g.__metadataRefreshPromise = p; }
function getPriorityResolve(): (() => void) | null { return g.__metadataPriorityResolve ?? null; }
function setPriorityResolve(r: (() => void) | null) { g.__metadataPriorityResolve = r; }
function getPriorityPromise(): Promise<void> | null { return g.__metadataPriorityPromise ?? null; }
function setPriorityPromise(p: Promise<void> | null) { g.__metadataPriorityPromise = p; }
function isRefreshInProgress(): boolean { return g.__metadataRefreshInProgress ?? false; }
function setRefreshInProgress(v: boolean) { g.__metadataRefreshInProgress = v; }

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
  return getCache();
}

export function setMetadataCache(cache: MetadataCache): void {
  setCache(cache);
}

export { isRefreshInProgress as isRefreshing };

/**
 * Trigger a background metadata refresh. Non-blocking — returns immediately.
 * Skips if already refreshed within REFRESH_INTERVAL_MS unless force=true.
 * Loads priority schemas first, then remaining schemas.
 */
export function triggerBackgroundRefresh(force = false): void {
  // Use refreshPromise as the lock — set synchronously before any await
  if (getRefreshPromise()) return;

  const cache = getCache();
  // Only refresh when forced (user clicked Refresh) or cache has no tables
  if (!force && cache && cache.tables.length > 0) return;

  setRefreshInProgress(true);

  // Create a promise that resolves when priority schemas are loaded
  setPriorityPromise(new Promise<void>((resolve) => {
    setPriorityResolve(resolve);
  }));

  setRefreshPromise(refreshMetadata()
    .catch((err) => console.error('[metadata] Background refresh failed:', err))
    .finally(() => {
      setRefreshInProgress(false);
      setRefreshPromise(null);
      const pr = getPriorityResolve();
      if (pr) {
        pr();
        setPriorityResolve(null);
      }
      setPriorityPromise(null);
    }));
}

export async function waitForRefresh(): Promise<void> {
  const p = getRefreshPromise();
  if (p) await p;
}

/**
 * Wait only until priority schemas (e.g. fpa) are loaded — much faster than waitForRefresh.
 */
export async function waitForPrioritySchemas(): Promise<void> {
  const p = getPriorityPromise();
  if (p) await p;
}

/**
 * Ensure metadata is loading. If not yet started, kicks off background refresh.
 * Also triggers a background refresh if the cache is stale (>24h old).
 * Returns immediately — does NOT block.
 */
export function ensureMetadataLoading(): void {
  if (getRefreshPromise()) return; // already refreshing
  const cache = getCache();
  if (!cache) {
    triggerBackgroundRefresh();
    return;
  }
  // Check staleness — if cache is older than threshold, refresh in background
  const age = Date.now() - new Date(cache.lastRefreshed).getTime();
  if (age > STALE_THRESHOLD_MS) {
    console.log(`[metadata] Cache is ${Math.round(age / 3600000)}h old — triggering background refresh`);
    triggerBackgroundRefresh(true);
  }
}

/**
 * Phase 1: List table names for a schema and add them (with no columns) to the tables array.
 * This is fast — just one MCP call — so table names appear in the sidebar quickly.
 */
async function listSchemaTableNames(
  catalog: string,
  schema: string,
  catalogs: string[],
  allSchemas: Record<string, string[]>,
  tables: TableMetadata[]
): Promise<string[]> {
  try {
    const [tableNames, tableComments] = await Promise.all([
      listTables(schema),
      getTableComments(catalog, schema).catch(() => new Map<string, string>()),
    ]);

    for (const tableName of tableNames) {
      tables.push({
        catalog,
        schema,
        table: tableName,
        columns: [],
        comment: tableComments.get(tableName),
        lastRefreshed: new Date().toISOString(),
      });
    }

    // Update cache so sidebar sees table names immediately
    setCache({
      catalogs,
      schemas: allSchemas,
      tables: [...tables],
      lastRefreshed: new Date().toISOString(),
    });
    return tableNames;
  } catch (e) {
    console.error(`[metadata] Failed to list tables for ${catalog}.${schema}:`, e);
    return [];
  }
}

/**
 * Phase 2: Bulk-fetch columns for all tables in a schema using a single SQL query.
 * Updates the existing table entries in-place with column data.
 */
async function loadSchemaColumns(
  catalog: string,
  schema: string,
  catalogs: string[],
  allSchemas: Record<string, string[]>,
  tables: TableMetadata[]
): Promise<void> {
  try {
    const columnMap = await describeSchemaColumns(catalog, schema);

    // Build a new tables array with columns merged (avoid mutating shared references)
    const updatedTables = tables.map((t) => {
      if (t.catalog === catalog && t.schema === schema && t.columns.length === 0) {
        const cols = columnMap.get(t.table);
        if (cols) return { ...t, columns: cols };
      }
      return t;
    });
    // Replace the shared reference so future phases use the updated entries
    tables.length = 0;
    tables.push(...updatedTables);

    setCache({
      catalogs,
      schemas: allSchemas,
      tables: [...updatedTables],
      lastRefreshed: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[metadata] Failed to load columns for ${catalog}.${schema}:`, e);
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
  const existingTables = getCache()?.tables || [];
  setCache({ catalogs, schemas: {}, tables: existingTables, lastRefreshed: new Date().toISOString() });
  console.log(`[metadata] Introspecting catalog: ${config.defaultCatalog}`);

  // Step 2: List schemas for the target catalog using dedicated MCP tool
  for (const catalog of catalogs) {
    try {
      schemas[catalog] = await listSchemas(catalog);
    } catch (e) {
      console.error(`[metadata] Failed to list schemas for ${catalog}:`, e);
    }
  }

  setCache({ catalogs, schemas, tables: existingTables, lastRefreshed: new Date().toISOString() });
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

    // --- Priority schemas: full load (table names + columns) ---
    if (priority.length > 0) {
      console.log(`[metadata] Loading priority schemas: [${priority.join(', ')}]`);
    }
    for (const schema of priority) {
      await listSchemaTableNames(catalog, schema, catalogs, schemas, tables);
      await loadSchemaColumns(catalog, schema, catalogs, schemas, tables);
    }

    if (priority.length > 0) {
      console.log(
        `[metadata] Priority schemas loaded: ${tables.length} tables. Loading remaining schemas...`
      );
    }

    // Signal that priority schemas are ready — callers using waitForPrioritySchemas() unblock here
    const pr = getPriorityResolve();
    if (pr) {
      pr();
      setPriorityResolve(null);
      const c = getCache();
      if (c) saveCacheToDisk(c);
    }

    // --- Remaining schemas: Phase 1 — list all table names first (fast) ---
    console.log(`[metadata] Phase 1: listing table names for ${remaining.length} schemas...`);
    for (const schema of remaining) {
      await listSchemaTableNames(catalog, schema, catalogs, schemas, tables);
    }
    console.log(`[metadata] Phase 1 done: ${tables.length} tables listed. Phase 2: loading columns...`);

    // --- Remaining schemas: Phase 2 — bulk-load columns per schema ---
    for (const schema of remaining) {
      await loadSchemaColumns(catalog, schema, catalogs, schemas, tables);
    }
  }

  console.log(`[metadata] Refresh complete: ${tables.length} tables loaded`);
  const finalCache = getCache();
  if (finalCache) saveCacheToDisk(finalCache);
}

export function findRelevantTables(
  question: string,
  maxTables: number = 10
): TableMetadata[] {
  const cache = getCache();
  if (!cache) return [];

  const config = getPriorityConfig();
  const questionLower = question.toLowerCase();
  const keywords = extractKeywords(questionLower);

  const scored = cache.tables.map((table) => {
    let score = 0;
    const tableName = table.table.toLowerCase();
    const schemaName = table.schema.toLowerCase();
    const fqn = `${table.catalog}.${schemaName}.${tableName}`;

    // Keyword matching (cap column matches to prevent wide-table score inflation)
    const MAX_COL_MATCHES_PER_KEYWORD = 3;
    for (const keyword of keywords) {
      if (tableName.includes(keyword)) score += 10;
      if (schemaName.includes(keyword)) score += 5;
      if (table.comment?.toLowerCase().includes(keyword)) score += 8;
      let colMatches = 0;
      for (const col of table.columns) {
        if (colMatches >= MAX_COL_MATCHES_PER_KEYWORD) break;
        const nameMatch = col.name.toLowerCase().includes(keyword);
        const commentMatch = col.comment?.toLowerCase().includes(keyword);
        if (nameMatch || commentMatch) {
          if (nameMatch) score += 3;
          if (commentMatch) score += 4;
          colMatches++;
        }
      }
    }

    // Table name word matching
    const tableWords = tableName.split(/[_-]/).filter((w) => w.length > 2);
    for (const tw of tableWords) {
      if (questionLower.includes(tw)) score += 6;
    }

    // Boost priority schemas/tables
    if (config.prioritySchemas.includes(schemaName)) {
      score += 50;
    }
    const shortFqn = `${schemaName}.${tableName}`;
    if (config.priorityTables.includes(fqn) || config.priorityTables.includes(shortFqn)) {
      score += 200;
    }

    return { table, score };
  });

  const ranked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const topTables = ranked.slice(0, maxTables).map((s) => s.table);

  // Guarantee priority tables are always included if they scored > 0
  const topFqns = new Set(topTables.map((t) => `${t.catalog}.${t.schema}.${t.table}`));
  for (const entry of ranked.slice(maxTables)) {
    const entryFqn = `${entry.table.catalog}.${entry.table.schema}.${entry.table.table}`;
    const entryShort = `${entry.table.schema}.${entry.table.table}`;
    if (
      config.priorityTables.includes(entryFqn) ||
      config.priorityTables.includes(entryShort)
    ) {
      if (!topFqns.has(entryFqn)) {
        topTables.push(entry.table);
        topFqns.add(entryFqn);
      }
    }
  }

  return topTables;
}

export function getAllTables(): TableMetadata[] {
  return getCache()?.tables || [];
}

export function getSchemaTree(): Record<string, Record<string, string[]>> {
  const cache = getCache();
  if (!cache) return {};

  const config = getPriorityConfig();
  const skipSchemas = config.skipSchemas;

  const tree: Record<string, Record<string, string[]>> = {};

  // First, seed the tree with all known schemas (even those with no tables yet)
  // so they render as empty expandable nodes during progressive loading
  for (const [catalog, schemaList] of Object.entries(cache.schemas || {})) {
    if (!tree[catalog]) tree[catalog] = {};
    for (const schema of schemaList) {
      if (skipSchemas.has(schema.toLowerCase())) continue;
      if (!tree[catalog][schema]) tree[catalog][schema] = [];
    }
  }

  // Then populate with actual tables
  for (const table of cache.tables) {
    if (!tree[table.catalog]) tree[table.catalog] = {};
    if (!tree[table.catalog][table.schema])
      tree[table.catalog][table.schema] = [];
    tree[table.catalog][table.schema].push(table.table);
  }

  // Reorder schemas within each catalog: priority schemas first
  for (const catalog of Object.keys(tree)) {
    const schemas = tree[catalog];
    const ordered: Record<string, string[]> = {};

    // Priority schemas first (in configured order)
    for (const ps of config.prioritySchemas) {
      for (const schema of Object.keys(schemas)) {
        if (schema.toLowerCase() === ps) {
          ordered[schema] = schemas[schema];
        }
      }
    }
    // Then remaining schemas alphabetically
    for (const schema of Object.keys(schemas).sort()) {
      if (!ordered[schema]) {
        ordered[schema] = schemas[schema];
      }
    }

    tree[catalog] = ordered;
  }

  return tree;
}

export function getPrioritySchemaNames(): string[] {
  return getPriorityConfig().prioritySchemas;
}

/**
 * Load columns on-demand for tables that were matched by findRelevantTables
 * but whose columns haven't been loaded yet (non-priority schemas still in Phase 2).
 * Mutates the cache in-place so subsequent calls see the columns.
 */
export async function ensureColumnsLoaded(tables: TableMetadata[]): Promise<TableMetadata[]> {
  const needColumns = tables.filter((t) => t.columns.length === 0);
  if (needColumns.length === 0) return tables;

  const cache = getCache();

  // Describe individual tables (fast) instead of entire schemas (slow for large schemas like public)
  const results = await Promise.allSettled(
    needColumns.map(async (t) => {
      console.log(`[metadata] On-demand column load for ${t.catalog}.${t.schema}.${t.table}`);
      const cols = await describeTable(t.table, t.schema);
      return { key: `${t.catalog}.${t.schema}.${t.table}`, cols };
    })
  );

  const columnsByFqn = new Map<string, { name: string; type: string; comment?: string }[]>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      columnsByFqn.set(r.value.key, r.value.cols);
    } else {
      console.warn('[metadata] On-demand column load failed:', r.reason);
    }
  }

  // Update cache entries in-place so future calls also benefit
  if (cache) {
    for (const ct of cache.tables) {
      const fqn = `${ct.catalog}.${ct.schema}.${ct.table}`;
      const cols = columnsByFqn.get(fqn);
      if (cols && ct.columns.length === 0) {
        ct.columns = cols;
      }
    }
    saveCacheToDisk(cache);
  }

  return tables.map((t) => {
    if (t.columns.length > 0) return t;
    const fqn = `${t.catalog}.${t.schema}.${t.table}`;
    const cols = columnsByFqn.get(fqn);
    return cols ? { ...t, columns: cols } : t;
  });
}
