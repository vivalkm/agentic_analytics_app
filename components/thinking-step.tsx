'use client';

import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
import { ChevronRight, Brain, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

interface ThinkingStepProps {
  content: string;
  collapsed: boolean;
  validationResult?: { valid: boolean; reason: string; suggestion?: string };
  intermediateSQL?: string;
  /** When true, shows a spinning loader instead of the static Brain icon */
  inProgress?: boolean;
}

export function ThinkingStep({
  content,
  collapsed: initialCollapsed,
  validationResult,
  intermediateSQL,
  inProgress = false,
}: ThinkingStepProps) {
  const [open, setOpen] = useState(!initialCollapsed);

  // Build a one-line summary
  const summary = validationResult
    ? validationResult.valid
      ? 'Results validated'
      : validationResult.reason.slice(0, 100) + (validationResult.reason.length > 100 ? '...' : '')
    : content.slice(0, 100) + (content.length > 100 ? '...' : '');

  const StatusIcon = validationResult
    ? validationResult.valid
      ? CheckCircle2
      : AlertTriangle
    : inProgress
      ? Loader2
      : Brain;

  const iconColor = validationResult
    ? validationResult.valid
      ? 'text-green-500'
      : 'text-amber-500'
    : 'text-blue-400';

  const iconSpin = inProgress && !validationResult ? 'animate-spin' : '';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl border border-border/50 bg-muted/30 px-3.5 py-2.5 text-left text-base text-muted-foreground transition-colors hover:bg-muted/50">
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <StatusIcon className={`h-5 w-5 shrink-0 ${iconColor} ${iconSpin}`} />
        <span className="truncate">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 border-l border-border/30 pl-4 pt-2 pb-1 space-y-2">
          {/* Only show full content if it's longer than the truncated summary */}
          {content.length > 100 && (
            <p className="text-base text-muted-foreground whitespace-pre-wrap">
              {content}
            </p>
          )}

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
