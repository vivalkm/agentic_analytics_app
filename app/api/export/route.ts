export async function POST(request: Request) {
  try {
    const { columns, rows, filename } = await request.json();

    if (!columns || !rows) {
      return Response.json(
        { error: 'columns and rows are required' },
        { status: 400 }
      );
    }

    const escapeCsvValue = (val: unknown): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const header = columns.map(escapeCsvValue).join(',');
    const dataRows = rows.map((row: Record<string, unknown>) =>
      columns.map((col: string) => escapeCsvValue(row[col])).join(',')
    );
    const csv = [header, ...dataRows].join('\n');

    const safeName = (filename || 'export').replace(/[^a-zA-Z0-9_-]/g, '_');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeName}.csv"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 }
    );
  }
}
