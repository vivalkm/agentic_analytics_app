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

function renderMarkdown(text: string): string {
  let html = text
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-xs font-mono">$1</code>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="font-semibold text-sm mt-3 mb-1">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="font-semibold text-base mt-4 mb-1">$1</h3>')
    // Bullet lists
    .replace(/^[\-\*] (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p class="mt-2">')
    // Single newlines within lists are fine
    .replace(/\n/g, '<br/>');

  return `<p>${html}</p>`;
}

export function AnalysisCard({
  analysis,
  streaming = false,
  iterations,
  onFollowUp,
}: AnalysisCardProps) {
  const followUps = streaming ? [] : parseFollowUps(analysis);

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-amber-500" />
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
          className="prose prose-sm prose-invert max-w-none text-sm leading-relaxed text-foreground"
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
