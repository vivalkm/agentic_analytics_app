'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Loader2 } from 'lucide-react';

interface AnalysisCardProps {
  analysis: string;
  streaming?: boolean;
  iterations?: number;
  onFollowUp?: (question: string) => void;
}

function parseFollowUps(text: string): string[] {
  const questions: string[] = [];
  // Match numbered questions or lines ending with ?
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^[\d\-\*\.\)]+\s*/, '').trim();
    if (trimmed.endsWith('?') && trimmed.length > 15) {
      questions.push(trimmed);
    }
  }
  return questions.slice(-5); // Last few questions are usually the follow-ups
}

/**
 * Convert a markdown table block into a styled HTML table.
 */
function renderTable(tableLines: string[]): string {
  // Filter out the separator line (|---|---|)
  const dataLines = tableLines.filter((line) => !/^\|[\s\-:|]+\|$/.test(line));
  if (dataLines.length === 0) return '';

  const parseRow = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const headers = parseRow(dataLines[0]);
  const bodyRows = dataLines.slice(1).map(parseRow);

  const thCells = headers
    .map(
      (h) =>
        `<th class="px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">${inlineFormat(h)}</th>`
    )
    .join('');

  const tbodyRows = bodyRows
    .map((row, ri) => {
      const cells = row
        .map(
          (cell) =>
            `<td class="px-3 py-1.5 text-xs text-foreground/90 whitespace-nowrap font-mono">${inlineFormat(cell)}</td>`
        )
        .join('');
      const rowClass = ri % 2 === 1 ? ' class="bg-muted/15"' : '';
      return `<tr${rowClass}>${cells}</tr>`;
    })
    .join('');

  return `<div class="my-3 overflow-x-auto rounded-lg border border-border"><table class="w-full"><thead><tr class="border-b border-border bg-muted/30">${thCells}</tr></thead><tbody class="divide-y divide-border/30">${tbodyRows}</tbody></table></div>`;
}

/** Apply inline formatting (bold, italic, code) */
function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-xs font-mono">$1</code>');
}

function renderMarkdown(text: string): string {
  // Strip ```chart blocks before rendering (LLM chart config)
  const cleaned = text.replace(/```chart\s*\n?[\s\S]*?```/g, '').trimEnd();
  const lines = cleaned.split('\n');
  const outputParts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Skip partial chart block at the end (during streaming, may not have closing ```)
    if (lines[i].trim() === '```chart') {
      break; // Stop rendering — rest is chart config being streamed
    }

    // Detect table blocks: consecutive lines starting with |
    if (/^\|/.test(lines[i])) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      outputParts.push(renderTable(tableLines));
      continue;
    }

    const line = lines[i];
    i++;

    // Headers
    if (/^### (.+)$/.test(line)) {
      outputParts.push(line.replace(/^### (.+)$/, '<h4 class="font-semibold text-sm mt-3 mb-1">$1</h4>'));
      continue;
    }
    if (/^## (.+)$/.test(line)) {
      outputParts.push(line.replace(/^## (.+)$/, '<h3 class="font-semibold text-base mt-4 mb-1">$1</h3>'));
      continue;
    }
    if (/^# (.+)$/.test(line)) {
      outputParts.push(line.replace(/^# (.+)$/, '<h3 class="font-semibold text-lg mt-4 mb-2">$1</h3>'));
      continue;
    }

    // Bullet lists
    const bulletMatch = line.match(/^[\-\*] (.+)$/);
    if (bulletMatch) {
      outputParts.push(`<li class="ml-4 list-disc">${inlineFormat(bulletMatch[1])}</li>`);
      continue;
    }

    // Numbered lists — render as unordered (bullet) lists
    const numMatch = line.match(/^\d+\. (.+)$/);
    if (numMatch) {
      outputParts.push(`<li class="ml-4 list-disc">${inlineFormat(numMatch[1])}</li>`);
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === '') {
      outputParts.push('</p><p class="mt-2">');
      continue;
    }

    // Regular text with inline formatting
    outputParts.push(inlineFormat(line) + '<br/>');
  }

  return `<p>${outputParts.join('\n')}</p>`;
}

export function AnalysisCard({
  analysis,
  streaming = false,
  iterations,
  onFollowUp,
}: AnalysisCardProps) {
  const followUps = streaming ? [] : parseFollowUps(analysis);

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-[0.85rem] font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          Analysis
          {streaming && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {!streaming && iterations && iterations > 1 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground">
              Resolved after {iterations} attempts
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="prose prose-sm prose-invert max-w-none text-[0.85rem] leading-relaxed text-foreground"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(analysis) }}
        />

        {followUps.length > 0 && onFollowUp && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">Follow-up:</span>
            {followUps.map((q, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="cursor-pointer text-xs hover:bg-accent"
                onClick={() => onFollowUp(q)}
              >
                {q.length > 60 ? q.slice(0, 57) + '...' : q}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
