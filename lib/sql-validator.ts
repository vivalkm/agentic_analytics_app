import { Parser } from 'node-sql-parser';

const BLOCKED_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'MERGE',
  'REPLACE',
  'GRANT',
  'REVOKE',
  'CALL',
  'EXECUTE',
];

const ALLOWED_PREFIXES = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN'];

const BLOCKED_REGEX = new RegExp(
  `\\b(${BLOCKED_KEYWORDS.join('|')})\\b`,
  'i'
);

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function stripComments(sql: string): string {
  let cleaned = sql.replace(/--[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  return cleaned;
}

export function validateSQL(sql: string): ValidationResult {
  if (!sql || !sql.trim()) {
    return { valid: false, error: 'Empty query' };
  }

  const cleanedSQL = stripComments(sql).trim();

  if (!cleanedSQL) {
    return { valid: false, error: 'Query contains only comments' };
  }

  // Phase 1: Regex pre-check on comment-stripped SQL
  if (BLOCKED_REGEX.test(cleanedSQL)) {
    const match = cleanedSQL.match(BLOCKED_REGEX);
    return {
      valid: false,
      error: `This app only supports read queries (SELECT, SHOW, DESCRIBE). Modification statements like ${match?.[0]?.toUpperCase()} are not allowed.`,
    };
  }

  // Phase 2: Allowlist - first keyword must be allowed
  const firstWord = cleanedSQL.split(/\s+/)[0]?.toUpperCase();
  if (!ALLOWED_PREFIXES.includes(firstWord)) {
    return {
      valid: false,
      error: `This app only supports read queries (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH). Statements starting with "${firstWord}" are not allowed.`,
    };
  }

  // Phase 3: SQL parser for SELECT/WITH (SHOW/DESCRIBE are Trino-specific)
  if (firstWord === 'SELECT' || firstWord === 'WITH') {
    try {
      const parser = new Parser();
      const ast = parser.astify(cleanedSQL, { database: 'trino' });
      const statements = Array.isArray(ast) ? ast : [ast];

      for (const stmt of statements) {
        if (
          stmt &&
          typeof stmt === 'object' &&
          'type' in stmt &&
          typeof stmt.type === 'string' &&
          stmt.type.toLowerCase() !== 'select'
        ) {
          return {
            valid: false,
            error: `This app only supports read queries (SELECT, SHOW, DESCRIBE). Modification statements like ${stmt.type.toUpperCase()} are not allowed.`,
          };
        }
      }
    } catch {
      // Parser may not support all Trino syntax; fall through to regex-only
    }
  }

  return { valid: true };
}
