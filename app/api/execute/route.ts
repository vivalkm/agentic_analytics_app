import { validateSQL } from '@/lib/sql-validator';
import { executeTrinoMCP } from '@/lib/trino';
import { apiError } from '@/lib/api-error';

export async function POST(request: Request) {
  try {
    const { sql } = await request.json();

    if (!sql || typeof sql !== 'string') {
      return Response.json({ error: 'SQL query is required' }, { status: 400 });
    }
    if (sql.length > 50_000) {
      return Response.json({ error: 'SQL query too long (max 50,000 characters)' }, { status: 400 });
    }

    // Read-only enforcement
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return Response.json(
        { error: validation.error, blocked: true },
        { status: 403 }
      );
    }

    const result = await executeTrinoMCP(sql);

    return Response.json({
      columns: result.columns,
      columnTypes: result.columnTypes,
      rows: result.rows,
      rowCount: result.rows.length,
    });
  } catch (error) {
    return apiError('Query execution error', error);
  }
}
