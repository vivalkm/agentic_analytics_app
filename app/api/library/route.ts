import { loadQueryLibrary, getQuerySql } from '@/lib/query-matcher';

export async function GET() {
  try {
    // Always reload from disk to pick up new/changed .sql files
    const library = loadQueryLibrary();

    // Eagerly load SQL for the sidebar "Show SQL" panel
    const withSql = library.map((entry) => ({
      ...entry,
      sql: entry.sql || getQuerySql(entry.filename),
    }));

    return Response.json({ queries: withSql });
  } catch (error) {
    console.error('Library load error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to load query library' },
      { status: 500 }
    );
  }
}
