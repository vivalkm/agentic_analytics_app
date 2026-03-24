import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(process.cwd(), '.user-config');

export interface UserConfig {
  // Trino
  trinoCatalog?: string;
  trinoPrioritySchemas?: string;
  trinoPriorityTables?: string;
  trinoSkipSchemas?: string;

  // Statsig
  statsigApiKey?: string;
  statsigMetricTeams?: string;

  // LLM
  anthropicApiKey?: string;
  anthropicModel?: string;

  // GitHub queries
  queryLibraryRepo?: string;
  githubToken?: string;
}

/** All valid keys for validation */
const VALID_KEYS = new Set<keyof UserConfig>([
  'trinoCatalog', 'trinoPrioritySchemas', 'trinoPriorityTables', 'trinoSkipSchemas',
  'statsigApiKey', 'statsigMetricTeams',
  'anthropicApiKey', 'anthropicModel',
  'queryLibraryRepo', 'githubToken',
]);

/** Sanitize email to a safe filename */
function emailToFilename(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_') + '.json';
}

function configPath(email: string): string {
  return join(CONFIG_DIR, emailToFilename(email));
}

/** Read a user's config overrides (empty object if none saved) */
export function getUserConfig(email: string): UserConfig {
  try {
    const raw = readFileSync(configPath(email), 'utf-8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return {};
  }
}

/** Save a user's config overrides */
export function saveUserConfig(email: string, config: UserConfig): void {
  // Strip unknown keys
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (VALID_KEYS.has(key as keyof UserConfig) && value !== undefined && value !== '') {
      clean[key] = value;
    }
  }

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath(email), JSON.stringify(clean, null, 2), 'utf-8');
}

/** Merge user overrides on top of env var defaults */
export function getEffectiveConfig(email: string): Required<UserConfig> {
  const user = getUserConfig(email);

  return {
    trinoCatalog: user.trinoCatalog || process.env.TRINO_DEFAULT_CATALOG || 'lakehouse',
    trinoPrioritySchemas: user.trinoPrioritySchemas || process.env.TRINO_PRIORITY_SCHEMAS || '',
    trinoPriorityTables: user.trinoPriorityTables || process.env.TRINO_PRIORITY_TABLES || '',
    trinoSkipSchemas: user.trinoSkipSchemas || process.env.TRINO_SKIP_SCHEMAS || 'information_schema,sys',
    statsigApiKey: user.statsigApiKey || process.env.STATSIG_CONSOLE_API_KEY || '',
    statsigMetricTeams: user.statsigMetricTeams || process.env.STATSIG_METRIC_TEAMS || 'squad-FPA,squad-INTA',
    anthropicApiKey: user.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: user.anthropicModel || process.env.ANTHROPIC_MODEL || '',
    queryLibraryRepo: user.queryLibraryRepo || process.env.QUERY_LIBRARY_REPO || '',
    githubToken: user.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  };
}

/** Mask a secret string, showing only the last 4 characters */
export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return value ? '****' : '';
  return '****' + value.slice(-4);
}
