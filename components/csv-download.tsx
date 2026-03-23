'use client';

import { useState, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QueryResult } from '@/lib/types';

interface CSVDownloadProps {
  results: QueryResult;
  filename?: string;
}

export function CSVDownload({ results, filename }: CSVDownloadProps) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns: results.columns,
          rows: results.rows,
          filename: filename || `export-${Date.now()}`,
        }),
      });

      if (!res.ok) throw new Error('Export failed');

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename || `export-${Date.now()}`}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('CSV download failed:', err);
    } finally {
      setDownloading(false);
    }
  }, [results, filename]);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={handleDownload}
      disabled={downloading}
    >
      {downloading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      {results.rowCount} rows CSV
    </Button>
  );
}
