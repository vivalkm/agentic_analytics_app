import {
  getMetadataCache,
  getAllTables,
  getSchemaTree,
  getPrioritySchemaNames,
  triggerBackgroundRefresh,
  isRefreshing,
  waitForRefresh,
  waitForPrioritySchemas,
} from '@/lib/metadata';

export async function GET() {
  try {
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
      prioritySchemas: getPrioritySchemaNames(),
      lastRefreshed: cache?.lastRefreshed || null,
      isRefreshing: isRefreshing(),
      tableCount: getAllTables().length,
    });
  } catch (error) {
    console.error('Metadata GET error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to load metadata' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
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
