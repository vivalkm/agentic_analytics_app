import { runAgentLoopV2 } from '@/lib/agent-loop-v2';

export async function POST(request: Request) {
  try {
    const { question, history, attachments } = await request.json();

    if (!question || typeof question !== 'string') {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }
    if (question.length > 10_000) {
      return Response.json({ error: 'Question too long (max 10,000 characters)' }, { status: 400 });
    }

    // Filter to well-shaped history entries
    const validHistory = Array.isArray(history)
      ? history
          .filter((h: unknown) => h && typeof h === 'object' && typeof (h as Record<string, unknown>).question === 'string')
          .slice(0, 20)
      : undefined;

    // Filter to well-shaped attachments with per-item size limit (10MB base64 ≈ 7.5MB raw)
    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
    const validAttachments = Array.isArray(attachments)
      ? attachments
          .filter(
            (a: unknown) =>
              a &&
              typeof a === 'object' &&
              typeof (a as Record<string, unknown>).name === 'string' &&
              typeof (a as Record<string, unknown>).mediaType === 'string' &&
              typeof (a as Record<string, unknown>).data === 'string' &&
              ((a as Record<string, unknown>).data as string).length <= MAX_ATTACHMENT_BYTES
          )
          .slice(0, 5)
      : undefined;

    const stream = runAgentLoopV2(question, validHistory, validAttachments);

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
