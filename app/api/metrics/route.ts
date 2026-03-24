import {
  getMetricCatalog,
  getLastSynced,
  isMetricSyncing,
  triggerMetricSync,
  ensureMetricsLoading,
} from '@/lib/metric-catalog';

export async function GET() {
  ensureMetricsLoading();

  return Response.json({
    metrics: getMetricCatalog(),
    lastSynced: getLastSynced(),
    isSyncing: isMetricSyncing(),
  });
}

export async function POST() {
  try {
    await triggerMetricSync(true);
    return Response.json({
      metrics: getMetricCatalog(),
      lastSynced: getLastSynced(),
      isSyncing: isMetricSyncing(),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    );
  }
}
