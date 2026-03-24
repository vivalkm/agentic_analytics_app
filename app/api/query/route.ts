import { auth } from '@/auth';
import { generateSQL } from '@/lib/anthropic';
import { findRelevantTables, ensureMetadataLoading, isRefreshing } from '@/lib/metadata';
import { matchQueries, loadQueryLibrary, getQueryLibrary } from '@/lib/query-matcher';

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { question } = await request.json();

    if (!question || typeof question !== 'string') {
      return Response.json({ error: 'Question is required' }, { status: 400 });
    }

    // Ensure query library is loaded
    if (getQueryLibrary().length === 0) {
      loadQueryLibrary();
    }

    // Kick off background metadata refresh (non-blocking)
    ensureMetadataLoading();

    // Get whatever context is available right now
    const relevantTables = findRelevantTables(question);
    const relevantQueries = matchQueries(question);

    console.log(
      `[query] Context: ${relevantTables.length} tables, ${relevantQueries.length} library queries` +
        (isRefreshing() ? ' (metadata still loading...)' : '')
    );

    const stream = await generateSQL(question, relevantTables, relevantQueries);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Query generation error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to generate SQL' },
      { status: 500 }
    );
  }
}
