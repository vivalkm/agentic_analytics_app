'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface ChatInputProps {
  onSubmit: (question: string) => void;
  isLoading: boolean;
  placeholder?: string;
  prefillValue?: string;
  prefillKey?: number;
}

export function ChatInput({
  onSubmit,
  isLoading,
  placeholder = 'Ask a question about your data... (⌘+Enter to submit)',
  prefillValue,
  prefillKey,
}: ChatInputProps) {
  // Derive initial value from prefillKey — each new key resets to prefillValue
  const [value, setValue] = useState('');
  const [appliedPrefillKey, setAppliedPrefillKey] = useState(prefillKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // When prefillKey changes, sync the prefill value into local state
  if (prefillKey !== appliedPrefillKey) {
    setAppliedPrefillKey(prefillKey);
    if (prefillValue !== undefined && prefillValue !== '') {
      setValue(prefillValue);
    }
  }

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSubmit(trimmed);
    setValue('');
  }, [value, isLoading, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [value]);

  // Focus on mount and when prefill changes
  useEffect(() => {
    textareaRef.current?.focus();
  }, [appliedPrefillKey]);

  return (
    <div className="flex items-end gap-2.5 rounded-xl border border-border bg-card p-3 shadow-sm transition-shadow focus-within:shadow-md focus-within:border-primary/30">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={isLoading}
        rows={1}
        className="flex-1 resize-none bg-transparent text-lg leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-50"
      />
      <Tooltip>
        <TooltipTrigger
          render={<Button size="icon" className="h-8 w-8 shrink-0" />}
          onClick={handleSubmit}
          disabled={!value.trim() || isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </TooltipTrigger>
        <TooltipContent>Send (⌘+Enter)</TooltipContent>
      </Tooltip>
    </div>
  );
}
