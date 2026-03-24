import { MetricEntry } from './types';

const STATSIG_BASE_URL = 'https://statsigapi.net';
const MAX_PER_PAGE = 100;

/** Team filter for metric sources. Comma-separated, case-insensitive. */
const METRIC_TEAM_FILTER = new Set(
  (process.env.STATSIG_METRIC_TEAMS || 'squad-FPA,squad-INTA')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
);

function getApiKey(): string {
  const key = process.env.STATSIG_CONSOLE_API_KEY;
  if (!key) throw new Error('STATSIG_CONSOLE_API_KEY is not set');
  return key;
}

async function statsigFetch(path: string): Promise<unknown> {
  const res = await fetch(`${STATSIG_BASE_URL}${path}`, {
    headers: {
      'STATSIG-API-KEY': getApiKey(),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Statsig API ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- Metric Sources (base tables/queries) ---

interface MetricSource {
  id: string;
  name: string;
  description?: string;
  sql?: string;
  timestampColumn?: string;
  tags?: string[];
  owner?: { ownerName?: string; ownerEmail?: string };
  team?: string;
}

interface MetricSourceListResponse {
  data: MetricSource[];
  pagination?: {
    itemsPerPage: number;
    pageNumber: number;
    totalItems: number;
    nextPage?: string | null;
  };
}

/**
 * Fetch ALL metric sources from Statsig Console API, paginating through all pages.
 * Filters to sources owned by configured teams.
 */
export async function fetchMetricSources(): Promise<MetricSource[]> {
  const allSources: MetricSource[] = [];
  let page = 1;
  let totalItems = Infinity;

  while (allSources.length < totalItems) {
    const path = `/console/v1/metrics/metric_source/list?limit=${MAX_PER_PAGE}&page=${page}`;
    const response = (await statsigFetch(path)) as MetricSourceListResponse;

    if (response.pagination) {
      totalItems = response.pagination.totalItems;
    }

    if (!response.data || response.data.length === 0) break;
    allSources.push(...response.data);

    if (!response.pagination?.nextPage) break;
    page++;
  }

  const filtered = allSources.filter(
    (s) => METRIC_TEAM_FILTER.has((s.team || '').toLowerCase())
  );

  console.log(
    `[statsig] Fetched ${allSources.length} metric sources total, ${filtered.length} matching teams [${[...METRIC_TEAM_FILTER].join(', ')}]`
  );

  return filtered;
}

// --- Derived Metrics (catalog) ---

interface DerivedMetric {
  id: string;
  name: string;
  description?: string;
  type?: string; // e.g. "composite", "warehouse_native"
  tags?: string[];
  team?: string;
  owner?: { ownerName?: string; ownerEmail?: string };
  warehouseNative?: {
    aggregation?: string;
    metricSourceName?: string;
    valueColumn?: string;
    criteria?: Array<{
      type: string;
      column: string;
      condition: string;
      values: string[];
    }>;
  };
}

interface MetricCatalogListResponse {
  data: DerivedMetric[];
  pagination?: {
    itemsPerPage: number;
    pageNumber: number;
    totalItems: number;
    nextPage?: string | null;
  };
}

/**
 * Fetch ALL derived metrics from Statsig Console API, paginating through all pages.
 * Filters to metrics owned by configured teams.
 */
export async function fetchDerivedMetrics(): Promise<DerivedMetric[]> {
  const allMetrics: DerivedMetric[] = [];
  let page = 1;
  let totalItems = Infinity;

  while (allMetrics.length < totalItems) {
    const path = `/console/v1/metrics/list?limit=${MAX_PER_PAGE}&page=${page}`;
    const response = (await statsigFetch(path)) as MetricCatalogListResponse;

    if (response.pagination) {
      totalItems = response.pagination.totalItems;
    }

    if (!response.data || response.data.length === 0) break;
    allMetrics.push(...response.data);

    if (!response.pagination?.nextPage) break;
    page++;
  }

  const filtered = allMetrics.filter(
    (m) => METRIC_TEAM_FILTER.has((m.team || '').toLowerCase())
  );

  console.log(
    `[statsig] Fetched ${allMetrics.length} derived metrics total, ${filtered.length} matching teams [${[...METRIC_TEAM_FILTER].join(', ')}]`
  );

  return filtered;
}

// --- SQL fetching ---

/**
 * Fetch the generated SQL for a specific metric by ID.
 */
export async function fetchMetricSQL(metricId: string): Promise<string> {
  const response = (await statsigFetch(`/console/v1/metrics/${encodeURIComponent(metricId)}/sql`)) as
    | { sql: string }
    | string;

  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'sql' in response) {
    return response.sql;
  }
  return '';
}

// --- Combined fetch ---

/**
 * Fetch both metric sources and derived metrics, enrich with SQL, and return
 * combined MetricEntry[] for the catalog cache.
 * Derived metrics are prioritized (they define how business metrics are calculated).
 */
export async function fetchAllMetrics(): Promise<MetricEntry[]> {
  const [sources, derived] = await Promise.all([
    fetchMetricSources(),
    fetchDerivedMetrics(),
  ]);

  const CONCURRENCY = 5;
  const entries: MetricEntry[] = [];

  // --- Metric sources → MetricEntry (kind: 'source') ---
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (source) => {
        let sql = source.sql || '';
        if (!sql && source.id) {
          try {
            sql = await fetchMetricSQL(source.id);
          } catch {
            // If individual metric SQL fetch fails, use source SQL or empty
          }
        }
        return {
          id: source.id,
          name: source.name,
          description: source.description || '',
          sql,
          sourceName: source.name,
          tags: source.tags || [],
          kind: 'source' as const,
        } satisfies MetricEntry;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        entries.push(result.value);
      }
    }
  }

  // --- Derived metrics → MetricEntry (kind: 'derived') ---
  // Build a map of source names → source SQL for cross-referencing
  const sourceSqlMap = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'source' && entry.sql) {
      sourceSqlMap.set(entry.name.toLowerCase(), entry.sql);
    }
  }

  for (let i = 0; i < derived.length; i += CONCURRENCY) {
    const batch = derived.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (metric) => {
        let sql = '';
        // Try to get generated SQL for this derived metric
        if (metric.id) {
          try {
            sql = await fetchMetricSQL(metric.id);
          } catch {
            // Fall back to the source SQL if available
          }
        }
        // If no SQL from the metric endpoint, try the backing source
        if (!sql && metric.warehouseNative?.metricSourceName) {
          sql = sourceSqlMap.get(metric.warehouseNative.metricSourceName.toLowerCase()) || '';
        }

        const wn = metric.warehouseNative;
        return {
          id: metric.id,
          name: metric.name,
          description: metric.description || '',
          sql,
          sourceName: wn?.metricSourceName || '',
          tags: metric.tags || [],
          kind: 'derived' as const,
          aggregation: wn?.aggregation,
          valueColumn: wn?.valueColumn,
          criteria: wn?.criteria,
          metricType: metric.type,
        } satisfies MetricEntry;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        entries.push(result.value);
      }
    }
  }

  console.log(
    `[statsig] Combined: ${entries.filter((e) => e.kind === 'source').length} sources + ${entries.filter((e) => e.kind === 'derived').length} derived = ${entries.length} total`
  );

  return entries;
}
