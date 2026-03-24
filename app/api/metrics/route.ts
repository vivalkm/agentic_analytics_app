import { auth } from '@/auth';
import {
  getMetricCatalog,
  getLastSynced,
  isMetricSyncing,
  triggerMetricSync,
  ensureMetricsLoading,
} from '@/lib/metric-catalog';

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  ensureMetricsLoading();

  return Response.json({
    metrics: getMetricCatalog(),
    lastSynced: getLastSynced(),
    isSyncing: isMetricSyncing(),
  });
}

export async function POST() {
  try {
    const postSession = await auth();
    if (!postSession?.user?.email) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
