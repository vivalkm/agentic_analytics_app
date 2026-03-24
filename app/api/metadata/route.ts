import { auth } from '@/auth';
import {
  getMetadataCache,
  getAllTables,
  getSchemaTree,
  triggerBackgroundRefresh,
  isRefreshing,
  waitForRefresh,
  waitForPrioritySchemas,
} from '@/lib/metadata';

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const cache = getMetadataCache();

  return Response.json({
    catalogs: cache?.catalogs || [],
    schemas: cache?.schemas || {},
    tables: getAllTables().map((t) => ({
      catalog: t.catalog,
      schema: t.schema,
      table: t.table,
      columns: t.columns,
      comment: t.comment,
    })),
    tree: getSchemaTree(),
    lastRefreshed: cache?.lastRefreshed || null,
    isRefreshing: isRefreshing(),
    tableCount: getAllTables().length,
  });
}

export async function POST(request: Request) {
  try {
    const postSession = await auth();
    if (!postSession?.user?.email) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await request.json().catch(() => ({}));
    const blocking = body?.blocking === true;
    const priorityOnly = body?.priorityOnly === true;

    triggerBackgroundRefresh(/* force */ true);

    if (priorityOnly) {
      // Wait only for priority schemas (e.g. fpa) — much faster
      await waitForPrioritySchemas();
    } else if (blocking) {
      await waitForRefresh();
    }

    const cache = getMetadataCache();

    return Response.json({
      success: true,
      tableCount: getAllTables().length,
      lastRefreshed: cache?.lastRefreshed || null,
      isRefreshing: isRefreshing(),
    });
  } catch (error) {
    console.error('Metadata refresh error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Metadata refresh failed' },
      { status: 500 }
    );
  }
}
