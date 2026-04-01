'use client';

import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Play, Copy, Check, Pencil, X, ChevronRight, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SQLEditorProps {
  sql: string;
  onExecute: (sql: string) => void;
  isExecuting: boolean;
  streaming?: boolean;
  /** Start collapsed — user can click to expand */
  defaultCollapsed?: boolean;
}

export const SQLEditor = memo(function SQLEditor({
  sql,
  onExecute,
  isExecuting,
  streaming = false,
  defaultCollapsed = false,
}: SQLEditorProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(sql);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
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
    setCollapsed(false);
    setEditing(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  return (
    <div className="group relative rounded-xl border border-border bg-muted overflow-hidden shadow-sm">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-base font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
          <Code2 className="h-3.5 w-3.5" />
          SQL
        </button>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" />}
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </TooltipTrigger>
            <TooltipContent>{copied ? 'Copied!' : 'Copy SQL'}</TooltipContent>
          </Tooltip>
          {!streaming && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" />}
                  onClick={editing ? () => { setEditing(false); setEditValue(sql); } : startEditing}
                >
                  {editing ? <X className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
                </TooltipTrigger>
                <TooltipContent>{editing ? 'Cancel edit' : 'Edit SQL'}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" />}
                  onClick={handleExecute}
                  disabled={isExecuting}
                >
                  <Play className="h-3 w-3" />
                  {isExecuting ? 'Running...' : 'Run'}
                </TooltipTrigger>
                <TooltipContent>Run query (⌘E)</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* Editor / Highlighter — collapsible */}
      {!collapsed && (
        editing ? (
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full min-h-[80px] resize-y bg-muted p-4 font-mono text-sm text-foreground focus:outline-none"
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
              fontSize: '1rem',
            }}
          >
            {sql || '-- Generating SQL...'}
          </SyntaxHighlighter>
        )
      )}
    </div>
  );
});
