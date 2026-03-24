import { auth } from '@/auth';
import { runAgentLoop } from '@/lib/agent-loop';
import { getEffectiveConfig } from '@/lib/user-config';

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userConfig = getEffectiveConfig(session.user.email);
    const { question, history, attachments } = await request.json();

    if (!question || typeof question !== 'string') {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }

    const stream = runAgentLoop(
      question,
      Array.isArray(history) ? history : undefined,
      Array.isArray(attachments) ? attachments : undefined,
      userConfig,
    );

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Agent error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Agent failed' },
      { status: 500 }
    );
  }
}
