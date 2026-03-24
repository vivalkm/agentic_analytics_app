'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, Play } from 'lucide-react';

interface AnalysisCardProps {
  analysis: string;
  streaming?: boolean;
  iterations?: number;
  onFollowUp?: (question: string) => void;
}

/**
 * Split analysis text into main body and follow-up questions.
 * Detects headings like "Suggested Follow-Up Questions", "Follow-Up", etc.
 */
function splitFollowUps(text: string): { body: string; questions: string[] } {
  // Match a follow-up heading (##, ###, or bold line)
  const headingPattern = /\n(#{1,3}\s+.*(?:follow[\s\-]?up|next\s+question|suggested\s+question).*)\n/i;
  const match = text.match(headingPattern);

  if (!match || match.index === undefined) {
    return { body: text, questions: [] };
  }

  const body = text.slice(0, match.index).trimEnd();
  const followUpSection = text.slice(match.index);

  // Extract questions from the follow-up section (lines containing ?)
  const questions: string[] = [];
  for (const line of followUpSection.split('\n')) {
    const trimmed = line
      .replace(/^[\d\-\*\.\)]+\s*/, '')
      .trim()
      .replace(/^\*{1,2}/, '')
      .replace(/\*{1,2}$/, '')
      .trim();
    if (trimmed.includes('?') && trimmed.length > 15) {
      const qMatch = trimmed.match(/^(.+?\?)/);
      if (qMatch) {
        questions.push(qMatch[1].trim());
      }
    }
  }

  return { body, questions: questions.slice(0, 5) };
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
        `<th class="px-3 py-2 text-left text-base font-medium text-muted-foreground whitespace-nowrap">${inlineFormat(h)}</th>`
    )
    .join('');

  const tbodyRows = bodyRows
    .map((row, ri) => {
      const cells = row
        .map(
          (cell) =>
            `<td class="px-3 py-1.5 text-base text-foreground/90 whitespace-nowrap font-mono">${inlineFormat(cell)}</td>`
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
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-base font-mono">$1</code>');
}

export function renderMarkdown(text: string): string {
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
      outputParts.push(line.replace(/^### (.+)$/, '<h4 class="font-semibold text-lg mt-3 mb-1">$1</h4>'));
      continue;
    }
    if (/^## (.+)$/.test(line)) {
      outputParts.push(line.replace(/^## (.+)$/, '<h3 class="font-semibold text-lg mt-4 mb-1">$1</h3>'));
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
  const { body, questions } = useMemo(
    () => (streaming ? { body: analysis, questions: [] } : splitFollowUps(analysis)),
    [analysis, streaming]
  );

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          Analysis
          {streaming && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          {!streaming && iterations && iterations > 1 && (
            <Badge variant="outline" className="text-xs px-1.5 py-0 font-normal text-muted-foreground">
              Resolved after {iterations} attempts
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="prose prose-sm prose-invert max-w-none text-base leading-relaxed text-foreground"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
        />

        {questions.length > 0 && onFollowUp && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm font-medium text-muted-foreground mb-3">Suggested Follow-Up Questions</p>
            {questions.map((q, i) => (
              <div key={i} className={`flex items-start gap-2.5 py-2.5 ${i > 0 ? 'border-t border-border/40' : ''}`}>
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <p className="flex-1 text-base text-foreground/85 leading-snug pt-0.5">
                  {q}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 text-xs"
                  onClick={() => onFollowUp(q)}
                >
                  <Play className="h-3 w-3" />
                  Ask
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
