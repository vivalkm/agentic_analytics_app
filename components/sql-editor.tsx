'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Play, Copy, Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SQLEditorProps {
  sql: string;
  onExecute: (sql: string) => void;
  isExecuting: boolean;
  streaming?: boolean;
}

export function SQLEditor({
  sql,
  onExecute,
  isExecuting,
  streaming = false,
}: SQLEditorProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(sql);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync editValue when sql prop changes (streaming)
  useEffect(() => {
    if (!editing) setEditValue(sql);
  }, [sql, editing]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(editing ? editValue : sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [sql, editValue, editing]);

  const handleExecute = useCallback(() => {
    if (isExecuting || streaming) return;
    onExecute(editing ? editValue : sql);
  }, [sql, editValue, editing, isExecuting, streaming, onExecute]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        handleExecute();
      }
      if (e.key === 'Escape') {
        setEditing(false);
        setEditValue(sql);
      }
    },
    [handleExecute, sql]
  );

  const startEditing = useCallback(() => {
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  return (
    <div className="group relative rounded-lg border border-border bg-zinc-950 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="text-xs font-medium text-zinc-400">SQL</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-zinc-400 hover:text-white"
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </Button>
          {!streaming && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-zinc-400 hover:text-white"
                onClick={editing ? () => { setEditing(false); setEditValue(sql); } : startEditing}
              >
                {editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs text-zinc-400 hover:text-white"
                onClick={handleExecute}
                disabled={isExecuting}
              >
                <Play className="h-3 w-3" />
                {isExecuting ? 'Running...' : 'Run (⌘E)'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Editor / Highlighter */}
      {editing ? (
        <textarea
          ref={textareaRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full min-h-[80px] resize-y bg-zinc-950 p-4 font-mono text-sm text-zinc-100 focus:outline-none"
          spellCheck={false}
        />
      ) : (
        <SyntaxHighlighter
          language="sql"
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.875rem',
          }}
        >
          {sql || '-- Generating SQL...'}
        </SyntaxHighlighter>
      )}
    </div>
  );
}
