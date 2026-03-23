import { TableMetadata, MetadataCache } from './types';
import { executeTrinoMCP } from './trino-mcp';

let metadataCache: MetadataCache | null = null;
let refreshInProgress = false;
let refreshPromise: Promise<void> | null = null;

// Refresh at most once per 24 hours unless forced
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

  if (!force && metadataCache?.lastRefreshed) {
    const age = Date.now() - new Date(metadataCache.lastRefreshed).getTime();
    if (age < REFRESH_INTERVAL_MS) return;
  }

  refreshInProgress = true;

  refreshPromise = refreshMetadata()
    .catch((err) => console.error('[metadata] Background refresh failed:', err))
    .finally(() => {
      refreshInProgress = false;
      refreshPromise = null;
    });
}

export async function waitForRefresh(): Promise<void> {
  if (refreshPromise) await refreshPromise;
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
    const tableResult = await executeTrinoMCP(
      `SHOW TABLES FROM "${catalog}"."${schema}"`
    );

    for (const row of tableResult.rows) {
      const tableName = Object.values(row)[0];
      if (typeof tableName !== 'string') continue;

      try {
        const descResult = await executeTrinoMCP(
          `DESCRIBE "${catalog}"."${schema}"."${tableName}"`
        );

        const columns = descResult.rows.map((r) => ({
          name: String(r['Column'] || r['column'] || r[descResult.columns[0]] || ''),
          type: String(r['Type'] || r['type'] || r[descResult.columns[1]] || 'unknown'),
          comment:
            r['Comment'] || r['comment'] || r[descResult.columns[3]]
              ? String(r['Comment'] || r['comment'] || r[descResult.columns[3]])
              : undefined,
        }));

        tables.push({
          catalog,
          schema,
          table: tableName,
          columns,
          lastRefreshed: new Date().toISOString(),
        });

        // Update cache progressively
        metadataCache = {
          catalogs,
          schemas: allSchemas,
          tables: [...tables],
          lastRefreshed: new Date().toISOString(),
        };
      } catch (e) {
        console.error(`[metadata] Failed to describe ${catalog}.${schema}.${tableName}:`, e);
      }
    }
  } catch (e) {
    console.error(`[metadata] Failed to list tables for ${catalog}.${schema}:`, e);
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

  // Step 1: List catalogs
  try {
    const catalogResult = await executeTrinoMCP('SHOW CATALOGS');
    for (const row of catalogResult.rows) {
      const val = Object.values(row)[0];
      if (typeof val === 'string') catalogs.push(val);
    }
  } catch (e) {
    console.error('[metadata] Failed to list catalogs:', e);
    catalogs.push(config.defaultCatalog);
  }

  metadataCache = { catalogs, schemas: {}, tables: [], lastRefreshed: new Date().toISOString() };
  console.log(`[metadata] Found ${catalogs.length} catalogs`);

  // Step 2: List schemas per catalog
  for (const catalog of catalogs) {
    try {
      const schemaResult = await executeTrinoMCP(`SHOW SCHEMAS FROM "${catalog}"`);
      const schemaNames: string[] = [];
      for (const row of schemaResult.rows) {
        const val = Object.values(row)[0];
        if (typeof val === 'string') schemaNames.push(val);
      }
      schemas[catalog] = schemaNames;
    } catch (e) {
      console.error(`[metadata] Failed to list schemas for ${catalog}:`, e);
    }
  }

  metadataCache = { catalogs, schemas, tables: [], lastRefreshed: new Date().toISOString() };
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

    // Then load remaining schemas
    for (const schema of remaining) {
      await introspectSchema(catalog, schema, catalogs, schemas, tables);
    }
  }

  console.log(`[metadata] Refresh complete: ${tables.length} tables loaded`);
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
