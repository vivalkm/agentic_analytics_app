'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const ACCEPTED_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/csv', 'text/plain',
];
const ACCEPT_STRING = ACCEPTED_TYPES.join(',');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

interface ChatInputProps {
  onSubmit: (question: string, files?: File[]) => void;
  onStop?: () => void;
  isLoading: boolean;
  placeholder?: string;
  prefillValue?: string;
  prefillKey?: number;
}

export function ChatInput({
  onSubmit,
  onStop,
  isLoading,
  placeholder = 'Ask a question about your data... (⌘+Enter to submit)',
  prefillValue,
  prefillKey,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [appliedPrefillKey, setAppliedPrefillKey] = useState(prefillKey);
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // When prefillKey changes, sync the prefill value into local state
  if (prefillKey !== appliedPrefillKey) {
    setAppliedPrefillKey(prefillKey);
    if (prefillValue !== undefined && prefillValue !== '') {
      setValue(prefillValue);
    }
  }

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!ACCEPTED_TYPES.includes(file.type)) continue;
      if (file.size > MAX_FILE_SIZE) {
        alert(`File "${file.name}" exceeds the 10 MB limit.`);
        continue;
      }
      valid.push(file);
    }
    if (valid.length > 0) {
      setFiles((prev) => [...prev, ...valid]);
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSubmit(trimmed, files.length > 0 ? files : undefined);
    setValue('');
    setFiles([]);
  }, [value, files, isLoading, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape' && isLoading && onStop) {
        e.preventDefault();
        onStop();
      }
    },
    [handleSubmit, isLoading, onStop]
  );

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  // Paste handler for images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && ACCEPTED_TYPES.includes(file.type)) {
            pastedFiles.push(file);
          }
        }
      }
      if (pastedFiles.length > 0) {
        addFiles(pastedFiles);
      }
    },
    [addFiles]
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

  function fileIcon(file: File) {
    if (file.type.startsWith('image/')) return <ImageIcon className="h-3 w-3" />;
    return <FileText className="h-3 w-3" />;
  }

  return (
    <div
      className={`flex flex-col rounded-xl border bg-card p-3 shadow-sm transition-shadow focus-within:shadow-md focus-within:border-primary/30 ${
        dragOver ? 'border-primary/50 bg-primary/5' : 'border-border'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File preview chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {fileIcon(file)}
              <span className="max-w-[120px] truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="ml-0.5 rounded hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2.5">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={isLoading}
          rows={1}
          className="flex-1 resize-none bg-transparent text-lg leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-50"
        />

        {/* Attach file button */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              />
            }
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
          >
            <Paperclip className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>Attach file (image, PDF, CSV, TXT)</TooltipContent>
        </Tooltip>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_STRING}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Send / Stop button */}
        {isLoading && onStop ? (
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon" variant="destructive" className="h-8 w-8 shrink-0" />}
              onClick={onStop}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </TooltipTrigger>
            <TooltipContent>Stop (Esc)</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<Button size="icon" className="h-8 w-8 shrink-0" />}
              onClick={handleSubmit}
              disabled={!value.trim()}
            >
              <Send className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>Send (⌘+Enter)</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
