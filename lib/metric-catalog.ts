import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { MetricEntry, MetricCatalogCache } from './types';
import { fetchAllMetrics } from './statsig';
import { extractKeywords } from './stop-words';

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
    const tmp = CACHE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error('[metrics] Failed to write disk cache:', e);
  }
}

// --- In-memory state via globalThis (survives HMR — no local copies that desync) ---
interface MetricGlobals {
  __metricCache?: MetricCatalogCache | null;
  __metricSyncInProgress?: boolean;
  __metricSyncPromise?: Promise<void> | null;
}
const g = globalThis as typeof globalThis & MetricGlobals;

if (g.__metricCache === undefined) {
  g.__metricCache = loadCacheFromDisk();
}

function getMCache(): MetricCatalogCache | null { return g.__metricCache ?? null; }
function setMCache(c: MetricCatalogCache | null) { g.__metricCache = c; }
function getSyncPromise(): Promise<void> | null { return g.__metricSyncPromise ?? null; }
function setSyncPromise(p: Promise<void> | null) { g.__metricSyncPromise = p; }
function isSyncInProgress(): boolean { return g.__metricSyncInProgress ?? false; }
function setSyncInProgress(v: boolean) { g.__metricSyncInProgress = v; }

// --- Public API ---

export function getMetricCatalog(): MetricEntry[] {
  return getMCache()?.metrics ?? [];
}

export function getLastSynced(): string | null {
  return getMCache()?.lastSynced ?? null;
}

export function isMetricSyncing(): boolean {
  return isSyncInProgress();
}

function isCacheStale(): boolean {
  const cache = getMCache();
  if (!cache?.lastSynced) return true;
  const age = Date.now() - new Date(cache.lastSynced).getTime();
  return age > STALE_THRESHOLD_MS;
}

/**
 * Trigger a sync from Statsig API. Returns immediately if already syncing.
 * If force=false, skips sync if cache is fresh (< 24h).
 */
export function triggerMetricSync(force = false): Promise<void> {
  const existing = getSyncPromise();
  if (isSyncInProgress() && existing) return existing;
  if (!force && !isCacheStale()) return Promise.resolve();

  if (!process.env.STATSIG_CONSOLE_API_KEY) {
    console.log('[metrics] No STATSIG_CONSOLE_API_KEY set, skipping sync');
    return Promise.resolve();
  }

  setSyncInProgress(true);

  const promise = (async () => {
    try {
      console.log('[metrics] Syncing metrics from Statsig...');
      const metrics = await fetchAllMetrics();
      const cache: MetricCatalogCache = {
        metrics,
        lastSynced: new Date().toISOString(),
      };
      setMCache(cache);
      saveCacheToDisk(cache);
      console.log(`[metrics] Synced ${metrics.length} metrics`);
    } catch (e) {
      console.error('[metrics] Sync failed:', e);
    } finally {
      setSyncInProgress(false);
      setSyncPromise(null);
    }
  })();

  setSyncPromise(promise);
  return promise;
}

/**
 * Ensure metrics are loaded. Uses cache if available, triggers background sync if stale.
 */
export function ensureMetricsLoading(): Promise<void> {
  if (!getMCache() && process.env.STATSIG_CONSOLE_API_KEY) {
    return triggerMetricSync();
  } else if (isCacheStale() && process.env.STATSIG_CONSOLE_API_KEY) {
    return triggerMetricSync();
  }
  return Promise.resolve();
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
  const keywords = extractKeywords(questionLower);

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
