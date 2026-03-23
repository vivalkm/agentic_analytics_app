'use client';

import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
import { ChevronRight, Table2 } from 'lucide-react';
import { QueryResult } from '@/lib/types';

interface RawDataPreviewProps {
  results: QueryResult;
  maxRows?: number;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (Math.abs(value) >= 1_000_000) return value.toLocaleString();
    if (value % 1 !== 0) return value.toFixed(2);
    return value.toLocaleString();
  }
  const s = String(value);
  return s.length > 50 ? s.substring(0, 47) + '...' : s;
}

export function RawDataPreview({ results, maxRows = 10 }: RawDataPreviewProps) {
  const [open, setOpen] = useState(false);

  if (results.rowCount === 0) return null;

  const previewRows = results.rows.slice(0, maxRows);
  const hasMore = results.rowCount > maxRows;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl border border-border/50 bg-muted/20 px-3.5 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40">
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span>
          Preview data ({results.rowCount} row{results.rowCount !== 1 ? 's' : ''}, {results.columns.length} column{results.columns.length !== 1 ? 's' : ''})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 overflow-x-auto rounded-xl border border-border shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                {results.columns.map((col) => (
                  <th
                    key={col}
                    className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-border/50 last:border-0 hover:bg-muted/20"
                >
                  {results.columns.map((col) => (
                    <td
                      key={col}
                      className="whitespace-nowrap px-3 py-1.5 text-foreground/80 font-mono"
                    >
                      {formatCellValue(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div className="border-t border-border/50 bg-muted/10 px-3 py-1.5 text-center text-[10px] text-muted-foreground">
              Showing {maxRows} of {results.rowCount} rows
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
