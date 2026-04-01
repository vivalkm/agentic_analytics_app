import { getAllSettings, writeEnvLocal, MANAGED_KEYS, getEnv } from '@/lib/env-config';
import { apiError } from '@/lib/api-error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const revealKey = searchParams.get('reveal');

  if (revealKey) {
    const mk = MANAGED_KEYS.find((k) => k.key === revealKey && k.secret);
    if (!mk) {
      return Response.json({ error: 'Invalid key' }, { status: 400 });
    }
    const raw = getEnv(revealKey) || '';
    return Response.json({ key: revealKey, value: raw });
  }

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
    return apiError('Settings update error', error);
  }
}
