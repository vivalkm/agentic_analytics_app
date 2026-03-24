import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Metadata for each managed env var. */
export interface ManagedKey {
  key: string;
  label: string;
  group: 'llm' | 'trino' | 'statsig' | 'github';
  secret: boolean;
  placeholder?: string;
}

export const MANAGED_KEYS: ManagedKey[] = [
  { key: 'ANTHROPIC_API_KEY', label: 'API Key', group: 'llm', secret: true, placeholder: 'sk-ant-...' },
  { key: 'ANTHROPIC_BASE_URL', label: 'Base URL', group: 'llm', secret: false, placeholder: 'https://api.anthropic.com' },
  { key: 'ANTHROPIC_MODEL', label: 'Model', group: 'llm', secret: false, placeholder: 'claude-sonnet-4-20250514' },
  { key: 'TRINO_ENVIRONMENT', label: 'Environment', group: 'trino', secret: false, placeholder: 'prod' },
  { key: 'TRINO_PRIORITY_SCHEMAS', label: 'Priority Schemas', group: 'trino', secret: false, placeholder: 'fpa,marketing' },
  { key: 'TRINO_PRIORITY_TABLES', label: 'Priority Tables', group: 'trino', secret: false, placeholder: 'lakehouse.fpa.table1' },
  { key: 'STATSIG_CONSOLE_API_KEY', label: 'Console API Key', group: 'statsig', secret: true, placeholder: 'console-...' },
  { key: 'STATSIG_METRIC_TEAMS', label: 'Metric Owners (teams)', group: 'statsig', secret: false, placeholder: 'squad-FPA,squad-INTA' },
  { key: 'QUERY_LIBRARY_REPO', label: 'Query Library Repo', group: 'github', secret: false, placeholder: 'https://github.com/org/repo' },
  { key: 'GITHUB_TOKEN', label: 'GitHub Token', group: 'github', secret: true, placeholder: 'ghp_...' },
];

const ENV_LOCAL_PATH = join(process.cwd(), '.env.local');

/**
 * Runtime overrides: values written via the settings API that take effect
 * immediately without restarting the server.
 * Uses globalThis for HMR survival in dev.
 */
const g = globalThis as unknown as { __envOverrides?: Record<string, string> };
if (!g.__envOverrides) g.__envOverrides = {};
const runtimeOverrides = g.__envOverrides;

/**
 * Get an env var value with runtime override priority:
 * runtimeOverrides → process.env
 */
export function getEnv(key: string): string | undefined {
  return runtimeOverrides[key] ?? process.env[key];
}

/**
 * Parse the .env.local file into a key-value map.
 * Handles quoted values and comments.
 */
export function readEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL_PATH)) return {};

  const content = readFileSync(ENV_LOCAL_PATH, 'utf-8');
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Write updates to .env.local.
 * Merges with existing content, preserving comments and unmanaged keys.
 * Also updates the runtime override cache.
 */
export function writeEnvLocal(updates: Record<string, string>): void {
  // Update runtime cache immediately
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      runtimeOverrides[key] = value;
    } else {
      delete runtimeOverrides[key];
    }
  }

  // Read existing file
  const existing = readEnvLocal();

  // Merge updates
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      existing[key] = value;
    } else {
      delete existing[key];
    }
  }

  // Write back
  const lines = Object.entries(existing)
    .map(([key, value]) => {
      // Quote values that contain spaces or special chars
      if (value.includes(' ') || value.includes('#') || value.includes('"')) {
        return `${key}="${value.replace(/"/g, '\\"')}"`;
      }
      return `${key}=${value}`;
    });

  writeFileSync(ENV_LOCAL_PATH, lines.join('\n') + '\n', 'utf-8');
}

/** Mask a secret value, showing only the last 4 characters. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

/** Load runtime overrides from .env.local on startup. */
export function initEnvOverrides(): void {
  const envLocal = readEnvLocal();
  const managedKeySet = new Set(MANAGED_KEYS.map((k) => k.key));

  for (const [key, value] of Object.entries(envLocal)) {
    if (managedKeySet.has(key) && value) {
      runtimeOverrides[key] = value;
    }
  }
}

// Auto-init on module load
initEnvOverrides();

export interface SettingValue {
  key: string;
  label: string;
  group: string;
  secret: boolean;
  placeholder?: string;
  value: string; // masked if secret
  hasValue: boolean;
}

/** Get all managed settings with their current values (masked for secrets). */
export function getAllSettings(): SettingValue[] {
  return MANAGED_KEYS.map((mk) => {
    const raw = getEnv(mk.key) || '';
    return {
      key: mk.key,
      label: mk.label,
      group: mk.group,
      secret: mk.secret,
      placeholder: mk.placeholder,
      value: mk.secret && raw ? maskSecret(raw) : raw,
      hasValue: Boolean(raw),
    };
  });
}
