import { auth } from '@/auth';
import { loadQueryLibrary, getQueryLibrary } from '@/lib/query-matcher';

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let library = getQueryLibrary();
  if (library.length === 0) {
    library = loadQueryLibrary();
  }

  return Response.json({ queries: library });
}
