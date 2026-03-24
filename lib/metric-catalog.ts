import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { MetricEntry, MetricCatalogCache } from './types';
import { fetchAllMetrics } from './statsig';

// --- Disk persistence ---
const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'metrics.json');

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadCacheFromDisk(): MetricCatalogCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as MetricCatalogCache;
    if (parsed?.metrics?.length > 0) {
      console.log(
        `[metrics] Loaded ${parsed.metrics.length} metrics from disk cache (${parsed.lastSynced})`
      );
      return parsed;
    }
  } catch {
    // No cache file or invalid
  }
  return null;
}

function saveCacheToDisk(cache: MetricCatalogCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (e) {
    console.error('[metrics] Failed to write disk cache:', e);
  }
}

// --- In-memory state (globalThis survives hot reloads) ---
const g = globalThis as typeof globalThis & {
  __metricCache?: MetricCatalogCache | null;
  __metricSyncInProgress?: boolean;
  __metricSyncPromise?: Promise<void> | null;
};

let metricCache: MetricCatalogCache | null = g.__metricCache ?? loadCacheFromDisk();
let syncInProgress = g.__metricSyncInProgress ?? false;
let syncPromise: Promise<void> | null = g.__metricSyncPromise ?? null;

function syncToGlobal() {
  g.__metricCache = metricCache;
  g.__metricSyncInProgress = syncInProgress;
  g.__metricSyncPromise = syncPromise;
}

// --- Public API ---

export function getMetricCatalog(): MetricEntry[] {
  return metricCache?.metrics ?? [];
}

export function getLastSynced(): string | null {
  return metricCache?.lastSynced ?? null;
}

export function isMetricSyncing(): boolean {
  return syncInProgress;
}

function isCacheStale(): boolean {
  if (!metricCache?.lastSynced) return true;
  const age = Date.now() - new Date(metricCache.lastSynced).getTime();
  return age > STALE_THRESHOLD_MS;
}

/**
 * Trigger a sync from Statsig API. Returns immediately if already syncing.
 * If force=false, skips sync if cache is fresh (< 24h).
 */
export function triggerMetricSync(force = false): Promise<void> {
  if (syncInProgress && syncPromise) return syncPromise;
  if (!force && !isCacheStale()) return Promise.resolve();

  if (!process.env.STATSIG_CONSOLE_API_KEY) {
    console.log('[metrics] No STATSIG_CONSOLE_API_KEY set, skipping sync');
    return Promise.resolve();
  }

  syncInProgress = true;
  syncToGlobal();

  syncPromise = (async () => {
    try {
      console.log('[metrics] Syncing metrics from Statsig...');
      const metrics = await fetchAllMetrics();
      metricCache = {
        metrics,
        lastSynced: new Date().toISOString(),
      };
      saveCacheToDisk(metricCache);
      console.log(`[metrics] Synced ${metrics.length} metrics`);
    } catch (e) {
      console.error('[metrics] Sync failed:', e);
    } finally {
      syncInProgress = false;
      syncPromise = null;
      syncToGlobal();
    }
  })();

  syncToGlobal();
  return syncPromise;
}

/**
 * Ensure metrics are loaded. Uses cache if available, triggers background sync if stale.
 */
export function ensureMetricsLoading(): void {
  if (!metricCache && process.env.STATSIG_CONSOLE_API_KEY) {
    triggerMetricSync();
  } else if (isCacheStale() && process.env.STATSIG_CONSOLE_API_KEY) {
    triggerMetricSync();
  }
}

/**
 * Match metrics against a user question using keyword scoring.
 * Same pattern as query-matcher's matchQueries.
 */
export function matchMetrics(
  question: string,
  maxResults: number = 3
): MetricEntry[] {
  const metrics = getMetricCatalog();
  if (metrics.length === 0) return [];

  const questionLower = question.toLowerCase();
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'that', 'this',
    'what', 'how', 'show', 'give', 'tell', 'about',
  ]);
  const keywords = questionLower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  if (keywords.length === 0) return [];

  const scored = metrics.map((metric) => {
    let score = 0;
    const metaText =
      `${metric.name} ${metric.description} ${metric.sourceName} ${metric.tags.join(' ')}`.toLowerCase();

    for (const keyword of keywords) {
      // Exact name match is highly relevant
      if (metric.name.toLowerCase().includes(keyword)) score += 10;
      // Description/tags match
      else if (metaText.includes(keyword)) score += 5;
    }

    // Bonus if metric SQL references keyword tables/columns
    if (score > 0 && metric.sql) {
      const sqlLower = metric.sql.toLowerCase();
      for (const keyword of keywords) {
        if (sqlLower.includes(keyword)) score += 2;
      }
    }

    // Derived metrics are more useful (they define how metrics are calculated)
    if (score > 0 && metric.kind === 'derived') score += 3;

    return { metric, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.metric);
}
