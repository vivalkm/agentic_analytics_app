'use client';

import { useState, useCallback, memo } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { QueryResult } from '@/lib/types';

interface CSVDownloadProps {
  results: QueryResult;
  filename?: string;
}

export const CSVDownload = memo(function CSVDownload({ results, filename }: CSVDownloadProps) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(() => {
    setDownloading(true);
    try {
      // Generate CSV client-side to avoid server round-trip
      const escapeCsvField = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const s = String(value);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const header = results.columns.map(escapeCsvField).join(',');
      const rows = results.rows.map((row) =>
        results.columns.map((col) => escapeCsvField(row[col])).join(',')
      );
      const csv = [header, ...rows].join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
});
