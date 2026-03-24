import { analyzeResults } from '@/lib/anthropic';
import { QueryResult } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const { question, sql, results } = await request.json();

    if (!question || !sql || !results) {
      return Response.json(
        { error: 'question, sql, and results are required' },
        { status: 400 }
      );
    }

    const queryResult: QueryResult = {
      columns: results.columns || [],
      columnTypes: results.columnTypes || [],
      rows: results.rows || [],
      rowCount: results.rowCount || results.rows?.length || 0,
      executionTimeMs: results.executionTimeMs || 0,
    };

    const stream = await analyzeResults(question, sql, queryResult);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    );
  }
}
