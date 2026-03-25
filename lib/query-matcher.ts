import { QueryLibraryEntry } from './types';
import { extractKeywords } from './stop-words';
import fs from 'fs';
import path from 'path';

let queryLibrary: QueryLibraryEntry[] = [];

export function getQueryLibrary(): QueryLibraryEntry[] {
  return queryLibrary;
}

/**
 * Load query library with metadata from headers only.
 * Full SQL is left empty ('') and loaded on demand in matchQueries()
 * or via getQuerySql().
 *
 * Expected header format in .sql files:
 *   -- description
 *   -- <description lines...>
 *   -- tags: tag1, tag2
 *   -- ------------
 *   <actual SQL>
 *
 * Falls back to first comment line as description for legacy files.
 */
export function loadQueryLibrary(): QueryLibraryEntry[] {
  const libraryDir = path.join(process.cwd(), 'query-library');
  queryLibrary = [];

  try {
    if (!fs.existsSync(libraryDir)) {
      fs.mkdirSync(libraryDir, { recursive: true });
      return queryLibrary;
    }

    const files = fs.readdirSync(libraryDir).filter((f) => f.endsWith('.sql'));

    for (const file of files) {
      const filePath = path.join(libraryDir, file);
      const header = readHeader(filePath);
      const { description, tags } = parseHeaderComment(header);

      queryLibrary.push({
        filename: file,
        description:
          description || file.replace('.sql', '').replace(/-/g, ' '),
        sql: '',
        tags,
      });
    }
  } catch (error) {
    console.error('Error loading query library:', error);
  }

  return queryLibrary;
}

/** Read the full SQL content of a query library entry on demand. */
export function getQuerySql(filename: string): string {
  const filePath = path.join(process.cwd(), 'query-library', filename);
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Ensure full SQL is loaded for an entry (lazy-load once, then cached).
 */
function ensureSqlLoaded(entry: QueryLibraryEntry): void {
  if (!entry.sql) {
    entry.sql = getQuerySql(entry.filename);
  }
}

/**
 * Read only the header portion of a .sql file (up to and including the
 * "------------" separator). If no separator is found, reads the leading
 * comment block.
 */
function readHeader(filePath: string): string {
  // Read only the first 2KB — headers are typically <500 bytes.
  // Avoids loading multi-KB SQL bodies just to parse a 3-line comment block.
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(2048);
  const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
  fs.closeSync(fd);
  const content = buf.toString('utf-8', 0, bytesRead);
  const lines = content.split('\n');
  const headerLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Check for separator line: "-- ------------" or "-- ----------" etc.
    if (trimmed.startsWith('--') && /^--\s*-{4,}/.test(trimmed)) {
      headerLines.push(line);
      break;
    }
    // Still in comment block
    if (trimmed.startsWith('--') || trimmed === '' || trimmed.startsWith('/*')) {
      headerLines.push(line);
    } else {
      // Hit actual SQL — no separator found, return what we have
      break;
    }
  }

  return headerLines.join('\n');
}

function parseHeaderComment(header: string): {
  description: string;
  tags: string[];
} {
  const lines = header.split('\n');
  const descParts: string[] = [];
  const tags: string[] = [];
  let inDescription = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('--')) continue;

    const comment = trimmed.slice(2).trim();

    // Separator line — end of header
    if (/^-{4,}$/.test(comment)) break;

    // Tags line
    if (comment.toLowerCase().startsWith('tags:')) {
      tags.push(
        ...comment
          .slice(5)
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      );
      continue;
    }

    // "description" keyword starts the description block
    if (comment.toLowerCase() === 'description') {
      inDescription = true;
      continue;
    }

    // Explicit "description: <text>" on one line (legacy format)
    if (comment.toLowerCase().startsWith('description:')) {
      descParts.push(comment.slice(12).trim());
      inDescription = true;
      continue;
    }

    // Accumulate description lines
    if (inDescription && comment) {
      descParts.push(comment);
    }

    // Legacy fallback: first non-empty comment becomes description
    if (!inDescription && comment && descParts.length === 0 && !comment.startsWith('=')) {
      descParts.push(comment);
      inDescription = true;
    }
  }

  const description = descParts.join(' ').trim();
  return { description, tags };
}

const METADATA_SCORE_THRESHOLD = 5;

export function matchQueries(
  question: string,
  maxResults: number = 3
): QueryLibraryEntry[] {
  if (queryLibrary.length === 0) loadQueryLibrary();

  const questionLower = question.toLowerCase();
  const keywords = extractKeywords(questionLower);

  // Pass 1: score on metadata only (description, filename, tags)
  const scored = queryLibrary.map((entry) => {
    let score = 0;
    const metaText =
      `${entry.description} ${entry.filename} ${entry.tags.join(' ')}`.toLowerCase();

    for (const keyword of keywords) {
      if (metaText.includes(keyword)) score += 5;
    }

    return { entry, score };
  });

  const metadataResults = scored.filter((s) => s.score >= METADATA_SCORE_THRESHOLD);

  // Pass 2: if metadata didn't produce enough matches, scan full SQL
  if (metadataResults.length < maxResults) {
    for (const item of scored) {
      if (item.score >= METADATA_SCORE_THRESHOLD) continue; // already matched
      ensureSqlLoaded(item.entry);
      const sqlLower = item.entry.sql.toLowerCase();
      for (const keyword of keywords) {
        if (sqlLower.includes(keyword)) item.score += 2;
      }
    }
  }

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.entry);
}
