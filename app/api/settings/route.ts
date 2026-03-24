import { auth } from '@/auth';
import { getEffectiveConfig, getUserConfig, saveUserConfig, maskSecret, UserConfig } from '@/lib/user-config';

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const effective = getEffectiveConfig(session.user.email);
  const overrides = getUserConfig(session.user.email);

  // Return effective config with secrets masked, plus raw overrides (also masked)
  return Response.json({
    effective: {
      ...effective,
      statsigApiKey: maskSecret(effective.statsigApiKey),
      anthropicApiKey: maskSecret(effective.anthropicApiKey),
      githubToken: maskSecret(effective.githubToken),
    },
    overrides: {
      ...overrides,
      statsigApiKey: overrides.statsigApiKey ? maskSecret(overrides.statsigApiKey) : undefined,
      anthropicApiKey: overrides.anthropicApiKey ? maskSecret(overrides.anthropicApiKey) : undefined,
      githubToken: overrides.githubToken ? maskSecret(overrides.githubToken) : undefined,
    },
    user: {
      email: session.user.email,
      name: session.user.name,
    },
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as UserConfig;
  saveUserConfig(session.user.email, body);

  return Response.json({ success: true });
}
