import {
  getMetadataCache,
  getAllTables,
  getSchemaTree,
  triggerBackgroundRefresh,
  isRefreshing,
  waitForRefresh,
} from '@/lib/metadata';

export async function GET() {
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
    const body = await request.json().catch(() => ({}));
    const blocking = body?.blocking === true;

    triggerBackgroundRefresh(/* force */ true);

    if (blocking) {
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
