/**
 * Shared SQL header parser for query library files.
 *
 * Parses the `-- description` / `-- tags:` header block from SQL content.
 * Supports both `--` line comments and `/* ... *​/` block comments.
 */
export function parseSqlHeader(content: string): {
  description: string;
  tags: string[];
} {
  const lines = content.split('\n');
  const descParts: string[] = [];
  const tags: string[] = [];
  let inDescription = false;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track block comments
    if (trimmed.startsWith('/*')) inBlockComment = true;
    if (inBlockComment && trimmed.includes('*/')) {
      inBlockComment = false;
      continue;
    }

    // Process -- comments
    if (trimmed.startsWith('--')) {
      const comment = trimmed.slice(2).trim();

      // Separator → end of header
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

      // Description keyword
      if (comment.toLowerCase() === 'description') {
        inDescription = true;
        continue;
      }
      if (comment.toLowerCase().startsWith('description:')) {
        descParts.push(comment.slice(12).trim());
        inDescription = true;
        continue;
      }

      if (inDescription && comment) {
        descParts.push(comment);
      }

      // Legacy fallback: first non-empty comment becomes description
      if (!inDescription && comment && descParts.length === 0 && !comment.startsWith('=')) {
        descParts.push(comment);
        inDescription = true;
      }

      continue;
    }

    // If we hit actual SQL (not a comment, not empty), stop
    if (!inBlockComment && trimmed && !trimmed.startsWith('/*')) break;
  }

  return { description: descParts.join(' ').trim(), tags };
}
