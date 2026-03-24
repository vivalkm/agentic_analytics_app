import { runAgentLoop } from '@/lib/agent-loop';

export async function POST(request: Request) {
  try {
    const { question, history, attachments } = await request.json();

    if (!question || typeof question !== 'string') {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }

    const stream = runAgentLoop(
      question,
      Array.isArray(history) ? history : undefined,
      Array.isArray(attachments) ? attachments : undefined,
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
