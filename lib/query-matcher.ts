import { QueryLibraryEntry } from './types';
import fs from 'fs';
import path from 'path';

let queryLibrary: QueryLibraryEntry[] = [];

export function getQueryLibrary(): QueryLibraryEntry[] {
  return queryLibrary;
}

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
      const content = fs.readFileSync(path.join(libraryDir, file), 'utf-8');
      const { description, tags } = parseHeaderComment(content);

      queryLibrary.push({
        filename: file,
        description:
          description || file.replace('.sql', '').replace(/-/g, ' '),
        sql: content,
        tags,
      });
    }
  } catch (error) {
    console.error('Error loading query library:', error);
  }

  return queryLibrary;
}

function parseHeaderComment(sql: string): {
  description: string;
  tags: string[];
} {
  const lines = sql.split('\n');
  let description = '';
  const tags: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) {
      const comment = trimmed.slice(2).trim();
      if (comment.toLowerCase().startsWith('tags:')) {
        tags.push(
          ...comment
            .slice(5)
            .split(',')
            .map((t) => t.trim().toLowerCase())
        );
      } else if (comment.toLowerCase().startsWith('description:')) {
        description = comment.slice(12).trim();
      } else if (!description && comment && !comment.startsWith('=')) {
        description = comment;
      }
    } else if (trimmed && !trimmed.startsWith('/*')) {
      break;
    }
  }

  return { description, tags };
}

export function matchQueries(
  question: string,
  maxResults: number = 3
): QueryLibraryEntry[] {
  if (queryLibrary.length === 0) loadQueryLibrary();

  const questionLower = question.toLowerCase();
  const stopWords = new Set([
    'the', 'and', 'for', 'from', 'with', 'that', 'this',
  ]);
  const keywords = questionLower
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const scored = queryLibrary.map((entry) => {
    let score = 0;
    const entryText =
      `${entry.description} ${entry.filename} ${entry.tags.join(' ')}`.toLowerCase();

    for (const keyword of keywords) {
      if (entryText.includes(keyword)) score += 5;
      if (entry.sql.toLowerCase().includes(keyword)) score += 2;
    }

    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.entry);
}
