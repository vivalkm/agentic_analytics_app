import { writeFileSync, readFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { QueryLibraryEntry } from './types';
import { extractKeywords } from './stop-words';
import { parseSqlHeader } from './sql-header';

// --- Config ---

interface RepoConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

/**
 * Parse QUERY_LIBRARY_REPO env var.
 * Expects: https://github.com/{owner}/{repo}/tree/{branch}/{path}
 */
function parseRepoUrl(): RepoConfig | null {
  const url = process.env.QUERY_LIBRARY_REPO;
  if (!url) return null;

  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/
  );
  if (!match) {
    console.error('[github-queries] Could not parse QUERY_LIBRARY_REPO:', url);
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    branch: match[3],
    path: match[4].replace(/\/$/, ''),
  };
}

// --- Disk cache ---

const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'github-queries.json');
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

interface GitHubQueryCache {
  entries: QueryLibraryEntry[];
  lastSynced: string;
}

function loadCacheFromDisk(): GitHubQueryCache | null {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as GitHubQueryCache;
    if (parsed?.entries?.length > 0) {
      console.log(
        `[github-queries] Loaded ${parsed.entries.length} queries from disk cache`
      );
      return parsed;
    }
  } catch {
    // No cache
  }
  return null;
}

function saveCacheToDisk(cache: GitHubQueryCache): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error('[github-queries] Failed to write disk cache:', e);
  }
}

// --- In-memory state (survives HMR via globalThis accessors) ---

interface GitHubQueryGlobals {
  __githubQueryCache?: GitHubQueryCache | null;
  __githubQuerySyncInProgress?: boolean;
  __githubQuerySyncPromise?: Promise<void> | null;
}
const g = globalThis as typeof globalThis & GitHubQueryGlobals;

// Initialize from disk on first load
if (g.__githubQueryCache === undefined) {
  g.__githubQueryCache = loadCacheFromDisk();
}

function getCache() { return g.__githubQueryCache ?? null; }
function setCache(c: GitHubQueryCache | null) { g.__githubQueryCache = c; }
function getSyncInProgress() { return g.__githubQuerySyncInProgress ?? false; }
function setSyncInProgress(v: boolean) { g.__githubQuerySyncInProgress = v; }
function getSyncPromise() { return g.__githubQuerySyncPromise ?? null; }
function setSyncPromise(p: Promise<void> | null) { g.__githubQuerySyncPromise = p; }

// --- GitHub API ---

async function githubFetch(apiPath: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'cortex-analytics',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`https://api.github.com${apiPath}`, { headers });
  if (!res.ok) {
    // Don't throw noisy stack traces when token is simply not configured
    if (!token && (res.status === 401 || res.status === 403 || res.status === 404)) {
      console.warn(`[github-queries] Skipping — no GITHUB_TOKEN set (${res.status} from ${apiPath})`);
      return [];
    }
    throw new Error(
      `GitHub API ${apiPath} returned ${res.status}: ${await res.text()}`
    );
  }
  return res.json();
}

interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
  size: number;
}

/**
 * List SQL files in the GitHub repo directory (non-recursive).
 */
async function listSqlFiles(config: RepoConfig): Promise<GitHubFile[]> {
  const apiPath = `/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const items = (await githubFetch(apiPath)) as GitHubFile[];
  return items.filter((f) => f.type === 'file' && f.name.endsWith('.sql'));
}

/**
 * Fetch raw file content from GitHub.
 */
async function fetchFileContent(config: RepoConfig, filePath: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.raw',
    'User-Agent': 'cortex-analytics',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${filePath}?ref=${config.branch}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub fetch ${filePath} returned ${res.status}`);
  }
  return res.text();
}

// --- Public API ---

export function getGitHubQueries(): QueryLibraryEntry[] {
  return getCache()?.entries ?? [];
}

export function getGitHubQueriesLastSynced(): string | null {
  return getCache()?.lastSynced ?? null;
}

export function isGitHubQuerySyncing(): boolean {
  return getSyncInProgress();
}

function isCacheStale(): boolean {
  const c = getCache();
  if (!c?.lastSynced) return true;
  const age = Date.now() - new Date(c.lastSynced).getTime();
  return age > STALE_THRESHOLD_MS;
}

/**
 * Fetch SQL files from GitHub and build query library entries.
 */
async function fetchGitHubQueries(): Promise<QueryLibraryEntry[]> {
  const config = parseRepoUrl();
  if (!config) return [];

  console.log(
    `[github-queries] Fetching from ${config.owner}/${config.repo}/${config.path}...`
  );

  const files = await listSqlFiles(config);
  console.log(`[github-queries] Found ${files.length} SQL files`);

  const CONCURRENCY = 5;
  const entries: QueryLibraryEntry[] = [];

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await fetchFileContent(config, file.path);
        const { description, tags } = parseSqlHeader(content);
        return {
          filename: `github:${file.name}`,
          description: description || file.name.replace('.sql', '').replace(/[-_]/g, ' '),
          sql: content,
          tags,
        } satisfies QueryLibraryEntry;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        entries.push(result.value);
      }
    }
  }

  console.log(`[github-queries] Loaded ${entries.length} queries`);
  return entries;
}

/**
 * Trigger a sync from GitHub. Returns immediately if already syncing.
 */
export function triggerGitHubQuerySync(force = false): Promise<void> {
  if (getSyncInProgress() && getSyncPromise()) return getSyncPromise()!;
  if (!force && !isCacheStale()) return Promise.resolve();
  if (!process.env.QUERY_LIBRARY_REPO) return Promise.resolve();

  setSyncInProgress(true);

  const promise = (async () => {
    try {
      const entries = await fetchGitHubQueries();
      const newCache = { entries, lastSynced: new Date().toISOString() };
      setCache(newCache);
      saveCacheToDisk(newCache);
    } catch (e) {
      console.error('[github-queries] Sync failed:', e);
    } finally {
      setSyncInProgress(false);
      setSyncPromise(null);
    }
  })();

  setSyncPromise(promise);
  return promise;
}

/**
 * Ensure GitHub queries are loading (non-blocking).
 */
export function ensureGitHubQueriesLoading(): void {
  if (!getCache() && process.env.QUERY_LIBRARY_REPO) {
    triggerGitHubQuerySync();
  } else if (isCacheStale() && process.env.QUERY_LIBRARY_REPO) {
    triggerGitHubQuerySync();
  }
}

/**
 * Match GitHub queries against a user question using keyword scoring.
 */
export function matchGitHubQueries(
  question: string,
  maxResults: number = 3
): QueryLibraryEntry[] {
  const entries = getGitHubQueries();
  if (entries.length === 0) return [];

  const questionLower = question.toLowerCase();
  const keywords = extractKeywords(questionLower);

  if (keywords.length === 0) return [];

  const scored = entries.map((entry) => {
    let score = 0;
    const metaText =
      `${entry.description} ${entry.filename} ${entry.tags.join(' ')}`.toLowerCase();

    for (const keyword of keywords) {
      if (metaText.includes(keyword)) score += 5;
    }

    // If metadata didn't match well, check SQL body
    if (score < 5) {
      const sqlLower = entry.sql.toLowerCase();
      for (const keyword of keywords) {
        if (sqlLower.includes(keyword)) score += 2;
      }
    }

    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.entry);
}
