import { loadQueryLibrary, getQueryLibrary, getQuerySql } from '@/lib/query-matcher';

export async function GET() {
  let library = getQueryLibrary();
  if (library.length === 0) {
    library = loadQueryLibrary();
  }

  // Eagerly load SQL for the sidebar "Show SQL" panel
  const withSql = library.map((entry) => ({
    ...entry,
    sql: entry.sql || getQuerySql(entry.filename),
  }));

  return Response.json({ queries: withSql });
}
