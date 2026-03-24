import { loadQueryLibrary, getQueryLibrary } from '@/lib/query-matcher';

export async function GET() {
  let library = getQueryLibrary();
  if (library.length === 0) {
    library = loadQueryLibrary();
  }

  return Response.json({ queries: library });
}
