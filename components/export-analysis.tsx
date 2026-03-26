'use client';

import { useCallback } from 'react';
import { FileDown, FileText, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { renderMarkdown } from '@/components/analysis-card';
import { NotebookCell } from '@/lib/types';

interface ExportAnalysisProps {
  cells: NotebookCell[];
  disabled?: boolean;
}

interface ExportableRun {
  question: string;
  sql: string;
  analysis: string;
  chartHtml?: string;
  rowCount?: number;
  executionTimeMs?: number;
}

/**
 * Walk the original (in-DOM) SVG tree and its cloned copy in parallel,
 * resolving any CSS var() references in inline styles/attributes to their
 * computed values so the exported SVG is fully self-contained.
 */
function resolveCssVars(original: Element, clone: Element) {
  const computed = getComputedStyle(original);
  const cloneStyle = (clone as HTMLElement | SVGElement).style;
  const origStyle = (original as HTMLElement | SVGElement).style;

  if (cloneStyle && origStyle) {
    for (let i = 0; i < origStyle.length; i++) {
      const prop = origStyle[i];
      const value = origStyle.getPropertyValue(prop);
      if (value.includes('var(')) {
        cloneStyle.setProperty(prop, computed.getPropertyValue(prop));
      }
    }
  }

  for (const attr of ['fill', 'stroke', 'stop-color', 'color']) {
    const attrVal = clone.getAttribute(attr);
    if (attrVal && attrVal.includes('var(')) {
      clone.setAttribute(attr, computed.getPropertyValue(attr) || attrVal);
    }
  }

  const origChildren = original.children;
  const cloneChildren = clone.children;
  for (let i = 0; i < origChildren.length && i < cloneChildren.length; i++) {
    resolveCssVars(origChildren[i], cloneChildren[i]);
  }
}

function buildExportableRuns(cells: NotebookCell[]): ExportableRun[] {
  const runs = new Map<
    string,
    { question?: string; sql?: string; analysis?: string; agentRunId?: string; rowCount?: number; executionTimeMs?: number }
  >();

  for (const cell of cells) {
    const runId = cell.metadata?.agentRunId;
    if (!runId) continue;
    if (!runs.has(runId)) runs.set(runId, { agentRunId: runId });
    const run = runs.get(runId)!;
    if (cell.type === 'question') run.question = cell.content;
    if (cell.type === 'sql' && cell.metadata?.sql && !cell.metadata.isIntermediate)
      run.sql = cell.metadata.sql;
    if (cell.type === 'results' && cell.metadata?.results && !cell.metadata.isIntermediate) {
      run.rowCount = cell.metadata.results.rowCount;
      run.executionTimeMs = cell.metadata.results.executionTimeMs;
    }
    if (cell.type === 'analysis') run.analysis = cell.content;
  }

  const result: ExportableRun[] = [];
  for (const run of runs.values()) {
    if (!run.question || !run.analysis) continue;
    // Capture the full chart (SVG + legend) from the DOM
    let chartHtml: string | undefined;
    if (run.agentRunId) {
      const wrapper = document.querySelector(
        `[data-run-id="${run.agentRunId}"] .recharts-wrapper`
      );
      if (wrapper) {
        const clone = wrapper.cloneNode(true) as HTMLElement;
        resolveCssVars(wrapper, clone);
        // Make the clone self-contained: replace absolute positioning with static flow
        clone.style.position = 'relative';
        chartHtml = clone.outerHTML;
      }
    }
    result.push({
      question: run.question,
      sql: run.sql || '',
      analysis: run.analysis,
      chartHtml,
      rowCount: run.rowCount,
      executionTimeMs: run.executionTimeMs,
    });
  }
  return result;
}

/** Inline CSS that resolves the Tailwind classes used by renderMarkdown() */
const EXPORT_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; background: #fff; max-width: 900px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 0.5rem; color: #1a1a2e; }
  h2 { font-size: 1.25rem; font-weight: 600; margin: 2rem 0 0.5rem; color: #1a1a2e; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
  h3 { font-size: 1.125rem; font-weight: 600; margin: 1.5rem 0 0.25rem; color: #1a1a2e; }
  h4 { font-size: 1rem; font-weight: 600; margin: 1rem 0 0.25rem; color: #1a1a2e; }
  p { margin: 0.5rem 0; }
  ul { margin-left: 1rem; list-style-type: disc; }
  ol { margin-left: 1rem; list-style-type: decimal; }
  li { margin: 0.15rem 0; }
  strong { font-weight: 600; }
  em { font-style: italic; }
  code { background: #f3f4f6; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.875em; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; border: 1px solid #e5e7eb; border-radius: 0.5rem; overflow: hidden; }
  thead tr { background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
  th { padding: 0.5rem 0.75rem; text-align: left; font-weight: 500; color: #6b7280; white-space: nowrap; font-size: 0.875rem; }
  td { padding: 0.375rem 0.75rem; white-space: nowrap; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.875rem; }
  tbody tr:nth-child(even) { background: #f9fafb; }
  tbody tr { border-top: 1px solid #f3f4f6; }
  .question-block { background: #f0f4ff; border-left: 3px solid #4f6ef7; padding: 0.75rem 1rem; margin: 1.5rem 0 1rem; border-radius: 0.375rem; }
  .question-block p { margin: 0; font-weight: 500; color: #1e3a8a; }
  .sql-block { background: #1e1e2e; color: #a6adc8; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.75rem 0; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8rem; line-height: 1.5; white-space: pre; }
  .chart-container { margin: 1rem 0; }
  .chart-container .recharts-wrapper { max-width: 100%; }
  .chart-container svg { max-width: 100%; height: auto; }
  .recharts-legend-wrapper { position: static !important; width: auto !important; text-align: center; padding-top: 0.5rem; }
  .recharts-legend-item { display: inline-flex; align-items: center; margin: 0 0.5rem; font-size: 0.8rem; }
  .recharts-legend-item svg { margin-right: 4px; }
  .meta { color: #6b7280; font-size: 0.875rem; margin: 0.25rem 0 0.75rem; }
  .separator { border: none; border-top: 1px solid #e5e7eb; margin: 2rem 0; }
  .header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 2px solid #e5e7eb; }
  .header-icon { font-size: 1.5rem; }
  .timestamp { color: #9ca3af; font-size: 0.75rem; }
`;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateStandaloneHTML(runs: ExportableRun[]): string {
  const now = new Date().toLocaleString();
  let body = '';

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (i > 0) body += '<hr class="separator" />\n';

    body += `<div class="question-block"><p>${escapeHtml(run.question)}</p></div>\n`;

    if (run.sql) {
      body += `<div class="sql-block">${escapeHtml(run.sql)}</div>\n`;
    }

    if (run.rowCount !== undefined) {
      body += `<p class="meta">${run.rowCount} rows returned`;
      if (run.executionTimeMs && run.executionTimeMs > 0) {
        body += ` in ${run.executionTimeMs}ms`;
      }
      body += '</p>\n';
    }

    if (run.chartHtml) {
      body += `<div class="chart-container">${run.chartHtml}</div>\n`;
    }

    // Use renderMarkdown to get the analysis HTML, then strip Tailwind classes
    // and use our inline CSS instead
    const analysisHtml = renderMarkdown(run.analysis);
    body += `<div class="analysis">${analysisHtml}</div>\n`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cortex Analytics Export — ${escapeHtml(now)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<div class="header">
  <span class="header-icon">📊</span>
  <div>
    <h1 style="margin:0;border:none;">Cortex Analytics</h1>
    <span class="timestamp">Exported on ${escapeHtml(now)}</span>
  </div>
</div>
${body}
</body>
</html>`;
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportAnalysis({ cells, disabled }: ExportAnalysisProps) {
  const handleExportHTML = useCallback(() => {
    const runs = buildExportableRuns(cells);
    if (runs.length === 0) return;
    const html = generateStandaloneHTML(runs);
    const timestamp = new Date().toISOString().slice(0, 10);
    downloadBlob(html, `cortex-export-${timestamp}.html`, 'text/html');
  }, [cells]);

  const handleExportPDF = useCallback(() => {
    window.print();
  }, []);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  disabled={disabled}
                />
              }
            >
              <FileDown className="h-4 w-4" />
            </DropdownMenuTrigger>
          }
        />
        <TooltipContent>Export analysis</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleExportPDF}>
          <Printer className="mr-2 h-4 w-4" />
          Export as PDF
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleExportHTML}>
          <FileText className="mr-2 h-4 w-4" />
          Export as HTML
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
