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

export interface SQLValidationResult {
  valid: boolean;
  error?: string;
}

function stripComments(sql: string): string {
  let cleaned = sql.replace(/--[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  return cleaned;
}

export function validateSQL(sql: string): SQLValidationResult {
  if (!sql || !sql.trim()) {
    return { valid: false, error: 'Empty query' };
  }

  const cleanedSQL = stripComments(sql).trim();

  if (!cleanedSQL) {
    return { valid: false, error: 'Query contains only comments' };
  }

  // Phase 0: Reject multi-statement SQL (semicolons outside string literals)
  // Strip string literals before checking so `WHERE x = 'a;b'` is allowed
  const noStrings = cleanedSQL.replace(/'[^']*'/g, "''");
  // Allow a single trailing semicolon (common copy-paste), reject anything else
  if (/;/.test(noStrings.replace(/;\s*$/, ''))) {
    return {
      valid: false,
      error: 'Multi-statement queries are not allowed. Please submit one query at a time.',
    };
  }

  // Phase 1: Regex pre-check on comment-stripped SQL
  if (BLOCKED_REGEX.test(cleanedSQL)) {
    const match = cleanedSQL.match(BLOCKED_REGEX);
    return {
      valid: false,
      error: `This app only supports read queries (SELECT). Modification statements like ${match?.[0]?.toUpperCase()} are not allowed.`,
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
    } catch (e) {
      // Parser may not support all Trino syntax — reject to be safe.
      // The regex pre-checks (Phases 1-2) already passed, but parser failure
      // means we can't verify the AST. Fail closed rather than approving blindly.
      console.warn('[sql-validator] Parser failed:', e instanceof Error ? e.message : e);
      return {
        valid: false,
        error: 'Query syntax is too complex to validate. Please simplify or use standard SELECT/WITH syntax.',
      };
    }
  }

  return { valid: true };
}
