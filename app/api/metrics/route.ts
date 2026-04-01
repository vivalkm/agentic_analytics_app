import {
  getMetricCatalog,
  getLastSynced,
  isMetricSyncing,
  triggerMetricSync,
  ensureMetricsLoading,
} from '@/lib/metric-catalog';
import { apiError } from '@/lib/api-error';

export async function GET() {
  try {
    ensureMetricsLoading();

    return Response.json({
      metrics: getMetricCatalog(),
      lastSynced: getLastSynced(),
      isSyncing: isMetricSyncing(),
    });
  } catch (error) {
    return apiError('Metrics GET error', error);
  }
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
    return apiError('Metric sync error', error);
  }
}
