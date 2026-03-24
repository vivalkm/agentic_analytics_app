import { getAllSettings, writeEnvLocal, MANAGED_KEYS, getEnv } from '@/lib/env-config';

export async function GET() {
  return Response.json({ settings: getAllSettings() });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const updates: Record<string, string> = {};
    const managedKeySet = new Set(MANAGED_KEYS.map((k) => k.key));

    for (const [key, value] of Object.entries(body)) {
      if (managedKeySet.has(key) && typeof value === 'string') {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: 'No valid settings provided' }, { status: 400 });
    }

    writeEnvLocal(updates);

    return Response.json({
      success: true,
      updated: Object.keys(updates),
      hasApiKey: Boolean(getEnv('ANTHROPIC_API_KEY')),
    });
  } catch (error) {
    console.error('Settings update error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to update settings' },
      { status: 500 }
    );
  }
}
