'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
import { ChevronRight, Brain, Loader2 } from 'lucide-react';

interface ThinkingStepProps {
  content: string;
  collapsed: boolean;
  /** When true, shows a spinning loader instead of the static Brain icon */
  inProgress?: boolean;
}

export function ThinkingStep({
  content,
  collapsed: initialCollapsed,
  inProgress = false,
}: ThinkingStepProps) {
  const [open, setOpen] = useState(!initialCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Auto-scroll to bottom when new content arrives (unless user scrolled up)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || userScrolledUp.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If user is within 40px of bottom, consider them "following"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledUp.current = !atBottom;
  }, []);

  // Collapse when agent finishes (prop changes from false to true)
  useEffect(() => {
    if (initialCollapsed) setOpen(false);
  }, [initialCollapsed]);

  const StatusIcon = inProgress ? Loader2 : Brain;
  const iconColor = 'text-blue-400';
  const iconSpin = inProgress ? 'animate-spin' : '';
  const summary = inProgress ? 'Thinking...' : 'Exploration complete';

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
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="ml-4 border-l border-border/30 pl-4 pt-2 pb-1 overflow-y-auto"
          style={{ maxHeight: '50vh' }}
        >
          <p className="text-base text-muted-foreground whitespace-pre-wrap">
            {content}
          </p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
