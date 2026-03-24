'use client';

import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
import { ChevronRight, Brain, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface ThinkingStepProps {
  content: string;
  iteration: number;
  collapsed: boolean;
  validationResult?: { valid: boolean; reason: string; suggestion?: string };
  intermediateSQL?: string;
}

export function ThinkingStep({
  content,
  iteration,
  collapsed: initialCollapsed,
  validationResult,
  intermediateSQL,
}: ThinkingStepProps) {
  const [open, setOpen] = useState(!initialCollapsed);

  // Build a one-line summary
  const summary = validationResult
    ? validationResult.valid
      ? `Attempt ${iteration}: Results validated`
      : `Attempt ${iteration}: ${validationResult.reason.slice(0, 80)}${validationResult.reason.length > 80 ? '...' : ''}`
    : `Attempt ${iteration}: ${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`;

  const StatusIcon = validationResult
    ? validationResult.valid
      ? CheckCircle2
      : AlertTriangle
    : Brain;

  const iconColor = validationResult
    ? validationResult.valid
      ? 'text-green-500'
      : 'text-amber-500'
    : 'text-blue-400';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl border border-border/50 bg-muted/30 px-3.5 py-2.5 text-left text-base text-muted-foreground transition-colors hover:bg-muted/50">
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <StatusIcon className={`h-5 w-5 shrink-0 ${iconColor}`} />
        <span className="truncate">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 border-l border-border/30 pl-4 pt-2 pb-1 space-y-2">
          <p className="text-base text-muted-foreground whitespace-pre-wrap">
            {content}
          </p>

          {validationResult && !validationResult.valid && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-base">
              <p className="font-medium text-amber-400">Issue detected</p>
              <p className="mt-1 text-muted-foreground">{validationResult.reason}</p>
              {validationResult.suggestion && (
                <p className="mt-1 text-muted-foreground">
                  <span className="font-medium">Suggestion:</span>{' '}
                  {validationResult.suggestion}
                </p>
              )}
            </div>
          )}

          {intermediateSQL && (
            <pre className="rounded bg-zinc-900 p-2 text-base text-zinc-400 overflow-x-auto">
              <code>{intermediateSQL}</code>
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
