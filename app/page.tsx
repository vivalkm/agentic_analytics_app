'use client';

import { APP_NAME, APP_DESCRIPTION } from '@/lib/constants';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatInput } from '@/components/chat-input';
import { SQLEditor } from '@/components/sql-editor';
import { AnalysisCard, renderMarkdown } from '@/components/analysis-card';
import { ThinkingStep } from '@/components/thinking-step';
import { ChartRenderer } from '@/components/chart-renderer';
import { CSVDownload } from '@/components/csv-download';
import { RawDataPreview } from '@/components/raw-data-preview';
import { NotebookCell, QueryResult, AgentEvent, ConversationTurn, Attachment } from '@/lib/types';
import { loadSession, saveSession, generateCellId } from '@/lib/session';
import { detectChartType } from '@/lib/chart-detector';
import { SchemaExplorer } from '@/components/schema-explorer';
import { QueryLibrary } from '@/components/query-library';
import { MetricsCatalog } from '@/components/metrics-catalog';
import { SettingsDialog } from '@/components/settings-dialog';
import { ApiKeyPrompt } from '@/components/api-key-prompt';
import { ExportAnalysis } from '@/components/export-analysis';
import { Database, Trash2, Loader2, Sparkles, Play, Search, CheckCircle2, PanelLeft, PanelLeftClose, Menu, ArrowDown, Sun, Moon, Keyboard, MessageCircleQuestion, RefreshCw, DatabaseZap, Heart, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/error-boundary';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';

type AgentPhase =
  | 'idle'
  | 'generating'
  | 'exploring'
  | 'executing'
  | 'validating'
  | 'retrying'
  | 'analyzing';

function buildHistory(cells: NotebookCell[], maxTurns = 10): ConversationTurn[] {
  // Group cells by agentRunId into completed turns
  const runs = new Map<string, { question?: string; sql?: string; results?: QueryResult; analysis?: string }>();
  for (const cell of cells) {
    const runId = cell.metadata?.agentRunId;
    if (!runId) continue;
    if (!runs.has(runId)) runs.set(runId, {});
    const run = runs.get(runId)!;
    if (cell.type === 'question') run.question = cell.content;
    if (cell.type === 'sql' && cell.metadata?.sql) run.sql = cell.metadata.sql;
    if (cell.type === 'results' && cell.metadata?.results) run.results = cell.metadata.results;
    if (cell.type === 'analysis') run.analysis = cell.content;
  }

  const turns: ConversationTurn[] = [];
  for (const run of runs.values()) {
    if (!run.question || !run.sql) continue; // skip incomplete runs
    const r = run.results;
    turns.push({
      question: run.question,
      sql: run.sql,
      resultSummary: r ? `${r.rowCount} rows, columns: ${r.columns.join(', ')}` : undefined,
      analysis: run.analysis ? run.analysis.slice(0, 1000) : undefined,
    });
  }
  const result = turns.slice(-maxTurns);
  // Give the most recent turn a larger analysis window so follow-ups like "continue" work
  if (result.length > 0) {
    const last = result[result.length - 1];
    const lastRun = Array.from(runs.values()).find((r) => r.question === last.question);
    if (lastRun?.analysis) {
      last.analysis = lastRun.analysis.slice(0, 4000);
    }
  }
  return result;
}

export default function Home() {
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('idle');

  const [streamingSQL, setStreamingSQL] = useState('');
  const [isExecuting, setIsExecuting] = useState(false); // For manual re-runs
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [prefillValue, setPrefillValue] = useState('');
  const [prefillKey, setPrefillKey] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyChecked, setApiKeyChecked] = useState(false);
  const { theme, setTheme } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const isNearBottomRef = useRef(true);

  const isDragging = useRef(false);
  const agentAbortRef = useRef<AbortController | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    let lastWidth = 0;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const maxWidth = window.innerWidth * 0.3;
      lastWidth = Math.min(Math.max(ev.clientX, 200), maxWidth);
      // Apply directly to DOM to avoid re-rendering the entire page tree
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${lastWidth}px`;
        sidebarRef.current.style.minWidth = `${lastWidth}px`;
      }
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      // Commit final width to React state once
      if (lastWidth > 0) setSidebarWidth(lastWidth);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  // Avoid hydration mismatch for theme
  useEffect(() => setMounted(true), []);

  // Check if API key is configured on mount
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        const apiKeySetting = data.settings?.find((s: { key: string }) => s.key === 'ANTHROPIC_API_KEY');
        setNeedsApiKey(!apiKeySetting?.hasValue);
        setApiKeyChecked(true);
      })
      .catch(() => setApiKeyChecked(true));
  }, []);

  // Load session on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const saved = loadSession();
    if (saved.length > 0) setCells(saved);
  }, []);

  // Save session on change
  useEffect(() => {
    if (cells.length > 0) saveSession(cells);
  }, [cells]);

  // Track scroll position to decide auto-scroll behavior
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const threshold = 150;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      isNearBottomRef.current = nearBottom;
      setShowScrollToBottom(!nearBottom);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll only when user is already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [cells, streamingSQL, agentPhase]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

  const addCell = useCallback((cell: NotebookCell) => {
    setCells((prev) => [...prev, cell]);
  }, []);

  const updateCell = useCallback(
    (id: string, updates: Partial<NotebookCell> | ((prev: NotebookCell) => Partial<NotebookCell>)) => {
      setCells((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          const resolved = typeof updates === 'function' ? updates(c) : updates;
          return { ...c, ...resolved };
        })
      );
    },
    []
  );

  const updateCellMetadata = useCallback(
    (id: string, metaUpdates: Partial<NonNullable<NotebookCell['metadata']>>) => {
      setCells((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, metadata: { ...c.metadata, ...metaUpdates } }
            : c
        )
      );
    },
    []
  );

  // Mark all thinking/intermediate cells in a run as collapsed
  const collapseThinkingCells = useCallback((agentRunId: string) => {
    setCells((prev) =>
      prev.map((c) => {
        if (c.metadata?.agentRunId !== agentRunId) return c;
        if (c.type === 'thinking') {
          return { ...c, metadata: { ...c.metadata, collapsed: true } };
        }
        return c;
      })
    );
  }, []);

  /**
   * Stream the agent response, processing NDJSON events into cells.
   */
  const streamAgentResponse = useCallback(
    async (question: string, files?: File[]) => {
      // Abort any in-flight agent run before starting a new one
      if (agentAbortRef.current) {
        agentAbortRef.current.abort();
      }
      const abortController = new AbortController();
      agentAbortRef.current = abortController;

      const agentRunId = `run-${Date.now()}`;

      // Convert files to Attachment objects
      let attachments: Attachment[] | undefined;
      if (files && files.length > 0) {
        attachments = await Promise.all(
          files.map(
            (file) =>
              new Promise<Attachment>((resolve) => {
                if (file.type === 'text/csv' || file.type === 'text/plain') {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve({ name: file.name, mediaType: file.type, data: reader.result as string });
                  reader.readAsText(file);
                } else {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    const base64 = dataUrl.split(',')[1] || '';
                    resolve({ name: file.name, mediaType: file.type, data: base64 });
                  };
                  reader.readAsDataURL(file);
                }
              })
          )
        );
      }

      // Add question cell
      addCell({
        id: generateCellId(),
        type: 'question',
        content: question + (attachments ? ` [${attachments.length} file${attachments.length > 1 ? 's' : ''} attached]` : ''),
        timestamp: Date.now(),
        metadata: { agentRunId },
      });

      setAgentPhase('generating');
      setStreamingSQL('');

      // Track cell IDs per iteration for updating
      const sqlCellIds: Record<number, string> = {};
      const thinkingCellIds: Record<number, string> = {};
      let analysisCellId: string | null = null;
      let analysisText = '';
      let latestResultsCellId: string | null = null;
      let finalIteration = 1;

      try {
        const history = buildHistory(cellsRef.current);
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, history, attachments }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const err = await res.json();
          addCell({
            id: generateCellId(),
            type: 'error',
            content: err.error || 'Agent request failed',
            timestamp: Date.now(),
            metadata: { agentRunId },
          });
          setAgentPhase('idle');
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let event: AgentEvent;
            try {
              event = JSON.parse(trimmed);
            } catch {
              continue;
            }

            switch (event.type) {
              case 'thinking': {
                setAgentPhase('exploring');
                setStatusText(event.content.slice(0, 80));

                const existingThinkingId = thinkingCellIds[event.iteration];
                if (existingThinkingId) {
                  // Append to existing thinking cell — direct concat for streaming deltas
                  updateCell(existingThinkingId, (prev) => ({
                    content: prev.content + event.content,
                  }));
                } else {
                  const thinkingId = generateCellId();
                  thinkingCellIds[event.iteration] = thinkingId;
                  addCell({
                    id: thinkingId,
                    type: 'thinking',
                    content: event.content,
                    timestamp: Date.now(),
                    metadata: {
                      agentRunId,
                      iteration: event.iteration,
                      collapsed: false,
                    },
                  });
                }
                break;
              }

              case 'sql_start': {
                // Start streaming SQL generation
                setAgentPhase('generating');
                setStatusText('');
                setStreamingSQL('');
                break;
              }

              case 'sql_chunk': {
                // Accumulate streaming SQL text
                setStreamingSQL((prev) => prev + event.delta);
                break;
              }

              case 'sql': {
                // SQL generation complete — clear streaming state
                setStreamingSQL('');
                setAgentPhase('executing');

                const existingSqlId = sqlCellIds[event.iteration];
                if (existingSqlId) {
                  // Update existing SQL cell for this iteration (e.g. after review correction)
                  updateCell(existingSqlId, {
                    content: event.sql,
                    metadata: {
                      sql: event.sql,
                      question,
                      assumptions: event.explanation,
                      agentRunId,
                      iteration: event.iteration,
                    },
                  });
                } else {
                  const sqlCellId = generateCellId();
                  sqlCellIds[event.iteration] = sqlCellId;
                  addCell({
                    id: sqlCellId,
                    type: 'sql',
                    content: event.sql,
                    timestamp: Date.now(),
                    metadata: {
                      sql: event.sql,
                      question,
                      assumptions: event.explanation,
                      agentRunId,
                      iteration: event.iteration,
                    },
                  });
                }
                break;
              }

              case 'execution': {
                setAgentPhase('validating');
                setStatusText('');
                const results: QueryResult = {
                  columns: event.columns,
                  columnTypes: event.columnTypes,
                  rows: event.rows,
                  rowCount: event.rowCount,
                  executionTimeMs: event.executionTimeMs,
                };
                const chartConfig = detectChartType(results, question);
                const resultsCellId = generateCellId();

                latestResultsCellId = resultsCellId;

                addCell({
                  id: resultsCellId,
                  type: 'results',
                  content: `${results.rowCount} rows returned`,
                  timestamp: Date.now(),
                  metadata: {
                    results,
                    chartConfig,
                    agentRunId,
                    iteration: event.iteration,
                  },
                });
                break;
              }

              case 'validation': {
                // Update the most recent thinking cell for this iteration
                setCells((prev) => {
                  const thinkingCell = [...prev]
                    .reverse()
                    .find(
                      (c) =>
                        c.type === 'thinking' &&
                        c.metadata?.agentRunId === agentRunId &&
                        c.metadata?.iteration === event.iteration
                    );
                  if (thinkingCell) {
                    return prev.map((c) =>
                      c.id === thinkingCell.id
                        ? {
                            ...c,
                            metadata: {
                              ...c.metadata,
                              validationResult: {
                                valid: event.valid,
                                reason: event.reason,
                                suggestion: event.suggestion,
                              },
                            },
                          }
                        : c
                    );
                  }
                  return prev;
                });
                break;
              }

              case 'analysis_chunk': {
                setAgentPhase('analyzing');
                setStatusText('');
                analysisText += event.delta;

                if (!analysisCellId) {
                  const id = generateCellId();
                  analysisCellId = id;
                  addCell({
                    id,
                    type: 'analysis',
                    content: analysisText,
                    timestamp: Date.now(),
                    metadata: { agentRunId, question },
                  });
                } else {
                  updateCell(analysisCellId, { content: analysisText });
                }
                break;
              }

              case 'done': {
                finalIteration = event.finalIteration;

                // Store iteration count on the analysis cell
                if (analysisCellId && event.iterations > 1) {
                  updateCellMetadata(analysisCellId, { iteration: event.iterations });
                }

                // If LLM provided a non-'none' chart config, override the heuristic one on the results cell.
                // Skip 'none' so we don't discard a working heuristic chart.
                if (event.chartConfig && event.chartConfig.type !== 'none' && latestResultsCellId) {
                  updateCellMetadata(latestResultsCellId, { chartConfig: event.chartConfig });
                }

                // Strip the ```chart block from analysis text
                if (analysisCellId && analysisText.includes('```chart')) {
                  const cleaned = analysisText.replace(/```chart\s*\n?[\s\S]*?```/, '').trimEnd();
                  updateCell(analysisCellId, { content: cleaned });
                  analysisText = cleaned;
                }

                // If there were multiple iterations, collapse thinking steps
                if (event.iterations > 1) {
                  collapseThinkingCells(agentRunId);
                }
                break;
              }

              case 'clarification': {
                setStreamingSQL('');
                addCell({
                  id: generateCellId(),
                  type: 'clarification',
                  content: event.content,
                  timestamp: Date.now(),
                  metadata: { agentRunId },
                });
                break;
              }

              case 'progress': {
                // Update status bar only — no new cells
                setStatusText(event.content);
                break;
              }

              case 'metadata_ready': {
                // Schema loaded — bump version so sidebar refetches
                setSchemaVersion((v) => v + 1);
                break;
              }

              case 'needs_metadata': {
                setStreamingSQL('');
                addCell({
                  id: generateCellId(),
                  type: 'needs_metadata',
                  content: event.content,
                  timestamp: Date.now(),
                  metadata: { agentRunId, question: event.question },
                });
                break;
              }

              case 'tool_call': {
                setAgentPhase('exploring');
                const toolLabel =
                  event.tool === 'run_exploratory_query'
                    ? `Running query: ${event.input.purpose ?? ''}\n\`\`\`sql\n${event.input.sql ?? ''}\n\`\`\``
                    : event.tool === 'describe_table'
                    ? `Examining table: ${event.input.schema}.${event.input.table}`
                    : event.tool === 'list_tables'
                    ? `Listing tables in ${event.input.schema}`
                    : `${event.tool}`;
                setStatusText(toolLabel.slice(0, 80));

                const toolThinkingId = generateCellId();
                thinkingCellIds[event.step + 1000] = toolThinkingId; // offset to avoid collision
                addCell({
                  id: toolThinkingId,
                  type: 'thinking',
                  content: toolLabel,
                  timestamp: Date.now(),
                  metadata: {
                    agentRunId,
                    iteration: event.step,
                    collapsed: false,
                  },
                });
                break;
              }

              case 'tool_result': {
                const resultSummary = event.isError
                  ? `Error: ${event.result}`
                  : event.rowCount !== undefined
                  ? `Got ${event.rowCount} rows (${event.executionTimeMs}ms)`
                  : event.result.slice(0, 200);

                // Append result summary to the matching tool_call thinking cell
                const toolResultCellId = thinkingCellIds[event.step + 1000];
                if (toolResultCellId) {
                  updateCell(toolResultCellId, (prev) => ({
                    content: prev.content + '\n\n' + (event.isError ? '**Error:** ' : '**Result:** ') + resultSummary,
                  }));
                }
                break;
              }

              case 'error': {
                setStreamingSQL('');
                addCell({
                  id: generateCellId(),
                  type: 'error',
                  content: event.content,
                  timestamp: Date.now(),
                  metadata: { agentRunId, iteration: event.iteration },
                });
                break;
              }
            }
          }
        }
        // Flush remaining bytes from decoder
        buffer += decoder.decode();
        if (buffer.trim()) {
          try {
            const event: AgentEvent = JSON.parse(buffer.trim());
            // Process the final event if valid — but this is rare;
            // NDJSON lines are newline-terminated so buffer is usually empty
            if (event.type === 'done') {
              // handled below
            }
          } catch {
            // incomplete JSON, ignore
          }
        }

        // Update analysis cell with final metadata (results, chart config, sql)
        if (analysisCellId && latestResultsCellId) {
          setCells((prev) => {
            const resultsCell = prev.find((c) => c.id === latestResultsCellId);
            return prev.map((c) =>
              c.id === analysisCellId
                ? {
                    ...c,
                    metadata: {
                      ...c.metadata,
                      results: resultsCell?.metadata?.results,
                      // Use the results cell's chartConfig (which may have been overridden by LLM)
                      chartConfig: resultsCell?.metadata?.chartConfig,
                      sql: sqlCellIds[finalIteration]
                        ? prev.find((x) => x.id === sqlCellIds[finalIteration])
                            ?.metadata?.sql
                        : undefined,
                    },
                  }
                : c
            );
          });
        }
      } catch (error) {
        // Silently ignore aborted requests (user started a new query)
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStreamingSQL('');
        addCell({
          id: generateCellId(),
          type: 'error',
          content:
            error instanceof Error ? error.message : 'Agent request failed',
          timestamp: Date.now(),
          metadata: { agentRunId },
        });
      } finally {
        // Only reset if this is still the active run (not aborted by a newer one)
        if (!abortController.signal.aborted) {
          setAgentPhase('idle');
          setStreamingSQL('');
        }
      }
    },
    [addCell, updateCell, updateCellMetadata, collapseThinkingCells]
  );

  /**
   * Manual SQL execution (from editor re-run). Uses the simple flow, not the agent loop.
   */
  const handleExecuteFromEditor = useCallback(
    async (sql: string) => {
      setIsExecuting(true);
      try {
        const res = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql }),
        });

        const data = await res.json();
        if (!res.ok) {
          addCell({
            id: generateCellId(),
            type: 'error',
            content: data.error || 'Execution failed',
            timestamp: Date.now(),
          });
          return;
        }

        const results: QueryResult = {
          columns: data.columns,
          columnTypes: data.columnTypes,
          rows: data.rows,
          rowCount: data.rowCount,
          executionTimeMs: 0,
        };
        const chartConfig = detectChartType(results);

        addCell({
          id: generateCellId(),
          type: 'results',
          content: `${results.rowCount} rows returned`,
          timestamp: Date.now(),
          metadata: { sql, results, chartConfig },
        });
      } catch (error) {
        addCell({
          id: generateCellId(),
          type: 'error',
          content:
            error instanceof Error ? error.message : 'Execution failed',
          timestamp: Date.now(),
        });
      } finally {
        setIsExecuting(false);
      }
    },
    [addCell]
  );

  const handleClearSession = () => {
    setCells([]);
    saveSession([]);
  };

  const handleInsertTable = useCallback((fqn: string) => {
    setPrefillValue(fqn);
    setPrefillKey((k) => k + 1);
    setMobileSheetOpen(false);
  }, []);

  const handleUseQuery = useCallback(
    (question: string) => {
      streamAgentResponse(question);
      setMobileSheetOpen(false);
    },
    [streamAgentResponse]
  );

  const isLoading = agentPhase !== 'idle' || isExecuting;

  const handleStop = useCallback(() => {
    agentAbortRef.current?.abort();
    setAgentPhase('idle');
    setStreamingSQL('');
  }, []);

  const phaseConfig: Record<AgentPhase, { icon: typeof Loader2; text: string; color: string }> = {
    idle: { icon: Loader2, text: '', color: '' },
    generating: {
      icon: Sparkles,
      text: 'Writing SQL...',
      color: 'text-blue-400',
    },
    exploring: { icon: Search, text: statusText || 'Exploring data...', color: 'text-purple-400' },
    executing: { icon: Play, text: 'Running query...', color: 'text-amber-400' },
    validating: { icon: Search, text: 'Checking results...', color: 'text-purple-400' },
    retrying: {
      icon: Loader2,
      text: 'Refining approach...',
      color: 'text-amber-400',
    },
    analyzing: { icon: CheckCircle2, text: 'Analyzing results...', color: 'text-green-400' },
  };

  const sidebarContent = (
    <Tabs defaultValue="schema" className="flex h-full flex-col">
      <TabsList className="mx-3 mt-3 shrink-0">
        <TabsTrigger value="schema">Schema</TabsTrigger>
        <TabsTrigger value="library">Library</TabsTrigger>
        <TabsTrigger value="metrics">Metrics</TabsTrigger>
      </TabsList>
      <TabsContent value="schema" className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <SchemaExplorer onInsertTable={handleInsertTable} refreshKey={schemaVersion} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="library" className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <QueryLibrary onUseQuery={handleUseQuery} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="metrics" className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <MetricsCatalog />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );

  return (
    <>
    <TooltipProvider delay={300}>
    <div className="flex h-screen">
      {/* Desktop sidebar */}
      <aside
        data-print-hide
        ref={sidebarRef}
        className={cn(
          'hidden md:flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground overflow-hidden',
          !sidebarOpen && 'w-0 min-w-0 transition-[width] duration-200 ease-in-out'
        )}
        style={sidebarOpen ? { width: sidebarWidth, minWidth: sidebarWidth } : undefined}
      >
        {sidebarOpen && sidebarContent}
      </aside>

      {/* Sidebar resize handle */}
      {sidebarOpen && (
        <div
          onMouseDown={handleResizeStart}
          className="hidden md:flex w-1 cursor-col-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors group"
        >
          <div className="h-8 w-0.5 rounded-full bg-border group-hover:bg-primary/50 group-active:bg-primary transition-colors" />
        </div>
      )}

      {/* Mobile sidebar (Sheet) — only mount content when open to avoid duplicate fetches */}
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="left" className="w-75 p-0 bg-sidebar text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {mobileSheetOpen && sidebarContent}
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header data-print-hide className="flex items-center justify-between border-b border-border bg-card/50 backdrop-blur-sm px-4 py-2.5 sticky top-0 z-20">
          <div className="flex items-center gap-2.5">
            {/* Mobile hamburger */}
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" />}
                onClick={() => setMobileSheetOpen(true)}
              >
                <Menu className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>Open sidebar</TooltipContent>
            </Tooltip>
            {/* Desktop sidebar toggle */}
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" className="hidden md:inline-flex h-8 w-8" />}
                onClick={() => setSidebarOpen((o) => !o)}
              >
                {sidebarOpen ? (
                  <PanelLeftClose className="h-4 w-4" />
                ) : (
                  <PanelLeft className="h-4 w-4" />
                )}
              </TooltipTrigger>
              <TooltipContent>{sidebarOpen ? 'Close sidebar' : 'Open sidebar'}</TooltipContent>
            </Tooltip>
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
                <Database className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h1 className="text-base font-semibold tracking-tight leading-none">{APP_NAME}</h1>
                <p className="text-xs text-muted-foreground leading-tight mt-0.5">{APP_DESCRIPTION}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            {/* Keyboard shortcuts help */}
            <Dialog>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DialogTrigger
                      render={<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" />}
                    />
                  }
                >
                  <Keyboard className="h-4 w-4" />
                </TooltipTrigger>
                <TooltipContent>Keyboard shortcuts</TooltipContent>
              </Tooltip>
              <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                  <DialogTitle>Keyboard Shortcuts</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 text-sm">
                  {[
                    { keys: '⌘ + Enter', desc: 'Submit question' },
                    { keys: '⌘ + E', desc: 'Run SQL query' },
                    { keys: 'Escape', desc: 'Cancel SQL editing' },
                  ].map((s) => (
                    <div key={s.keys} className="flex items-center justify-between">
                      <span className="text-muted-foreground">{s.desc}</span>
                      <kbd className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-xs">{s.keys}</kbd>
                    </div>
                  ))}
                </div>
              </DialogContent>
            </Dialog>

            {/* Settings */}
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" />}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>

            {/* Theme toggle */}
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" />}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {mounted && theme === 'dark' ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </TooltipTrigger>
              <TooltipContent>Toggle theme</TooltipContent>
            </Tooltip>

            {/* Export analysis */}
            {cells.some((c) => c.type === 'analysis') && (
              <ExportAnalysis cells={cells} disabled={agentPhase !== 'idle'} />
            )}

            {/* Clear session */}
            {cells.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground" />}
                  onClick={handleClearSession}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </TooltipTrigger>
                <TooltipContent>Clear session</TooltipContent>
              </Tooltip>
            )}
          </div>
        </header>

        {/* Notebook cells */}
        <ErrorBoundary>
        <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-5 p-6 pb-32">
          {cells.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <Database className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-foreground">
                {APP_NAME}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground/70">
                {APP_DESCRIPTION}
              </p>
              <p className="mt-3 max-w-lg text-lg leading-relaxed text-muted-foreground">
                Ask questions about your data in plain English. I&apos;ll generate
                SQL, run it against your Trino lakehouse, and analyze the results.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-2.5">
                {[
                  'What is the monthly revenue trend for the last 12 months?',
                  'Show daily send volume trend for the last 30 days',
                  'How does actual revenue compare to forecast this quarter?',
                  'What tables and columns are available in the fpa schema?',
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => streamAgentResponse(q)}
                    className="rounded-full border border-border bg-card px-4 py-2.5 text-base text-muted-foreground shadow-sm transition-all hover:border-primary/50 hover:text-foreground hover:shadow-md"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {cells.map((cell) => {
            // Hide intermediate cells when collapsed
            return (
              <div key={cell.id}>
                {cell.type === 'question' && (
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow-sm">
                      Q
                    </div>
                    <p className="pt-1.5 text-lg font-medium leading-relaxed text-foreground">
                      {cell.content}
                    </p>
                  </div>
                )}

                {cell.type === 'thinking' && (
                  <ThinkingStep
                    content={cell.content}
                    collapsed={cell.metadata?.collapsed || false}
                    validationResult={cell.metadata?.validationResult}
                    intermediateSQL={cell.metadata?.sql}
                    inProgress={!cell.metadata?.validationResult && agentPhase !== 'idle'}
                  />
                )}

                {cell.type === 'sql' && (
                  <SQLEditor
                    sql={
                      cell.metadata?.sql || cell.content
                    }
                    onExecute={handleExecuteFromEditor}
                    isExecuting={isExecuting}
                    streaming={false}
                    defaultCollapsed={
                      // Collapse SQL once analysis is rendered for this run
                      !!cell.metadata?.agentRunId &&
                      cells.some(
                        (c) =>
                          c.type === 'analysis' &&
                          c.metadata?.agentRunId === cell.metadata?.agentRunId
                      )
                    }
                  />
                )}

                {cell.type === 'results' &&
                  cell.metadata?.results && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1">
                        <span className="text-base text-muted-foreground">
                          {cell.metadata.results.rowCount} rows returned
                          {cell.metadata.results.executionTimeMs > 0 &&
                            ` in ${cell.metadata.results.executionTimeMs}ms`}
                        </span>
                        <CSVDownload results={cell.metadata.results} />
                      </div>
                      {cell.metadata.chartConfig &&
                        cell.metadata.chartConfig.type !== 'none' && (
                          <div data-run-id={cell.metadata.agentRunId}>
                            <ChartRenderer
                              config={cell.metadata.chartConfig}
                              results={cell.metadata.results}
                            />
                          </div>
                        )}
                      <RawDataPreview results={cell.metadata.results} />
                    </div>
                  )}

                {cell.type === 'analysis' && (
                  <AnalysisCard
                    analysis={cell.content}
                    streaming={agentPhase === 'analyzing'}
                    onFollowUp={streamAgentResponse}
                  />
                )}

                {cell.type === 'error' && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-base text-destructive">
                    {cell.content}
                  </div>
                )}

                {cell.type === 'clarification' && (
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500">
                      <MessageCircleQuestion className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                      <p className="mb-1 text-base font-medium text-amber-500">Clarification needed</p>
                      <div
                        className="prose prose-sm max-w-none text-base leading-relaxed text-foreground"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.content) }}
                      />
                    </div>
                  </div>
                )}

                {cell.type === 'needs_metadata' && (
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
                      <DatabaseZap className="h-4 w-4" />
                    </div>
                    <div className="flex-1 rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3">
                      <p className="mb-1 text-base font-medium text-blue-500">Schema metadata required</p>
                      <p className="text-base leading-relaxed text-muted-foreground">
                        {cell.content}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3 gap-1.5 text-base"
                        disabled={isLoading}
                        onClick={async () => {
                          updateCell(cell.id, { content: 'Refreshing priority schemas (fpa, marketing, public)...' });
                          try {
                            const res = await fetch('/api/metadata', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ priorityOnly: true }),
                            });
                            const data = await res.json();
                            if (res.ok && data.tableCount > 0) {
                              updateCell(cell.id, {
                                content: `Priority schemas loaded — ${data.tableCount} tables available. Retrying your question...`,
                              });
                              const originalQuestion = cell.metadata?.question;
                              if (originalQuestion) {
                                streamAgentResponse(originalQuestion);
                              }
                            } else {
                              updateCell(cell.id, {
                                content: data.error || 'Metadata refresh completed but no tables were found. Check your Trino connection.',
                              });
                            }
                          } catch (err) {
                            updateCell(cell.id, {
                              content: `Metadata refresh failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                            });
                          }
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh Metadata & Retry
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Streaming SQL preview — shows while SQL is being generated token-by-token */}
          {streamingSQL && agentPhase === 'generating' && (() => {
            // Extract only the SQL portion once ```sql appears, hide the preamble explanation
            const sqlBlockStart = streamingSQL.indexOf('```sql');
            const sqlOnly = sqlBlockStart >= 0
              ? streamingSQL.slice(sqlBlockStart + 6).replace(/```$/, '')
              : null;
            const preamble = sqlBlockStart >= 0
              ? streamingSQL.slice(0, sqlBlockStart).trim()
              : streamingSQL.trim();
            return (
              <div className="rounded-xl border border-border bg-zinc-950 overflow-hidden shadow-sm">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span className="text-xs font-medium text-zinc-400">Writing SQL...</span>
                </div>
                {sqlOnly === null && preamble && (
                  <div className="px-4 py-2 text-sm text-zinc-400 border-b border-white/5">
                    {preamble}
                    <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                  </div>
                )}
                {sqlOnly !== null && (
                  <pre className="p-4 text-base leading-relaxed text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto">
                    {sqlOnly}
                    <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                  </pre>
                )}
              </div>
            );
          })()}

          {/* Inline status indicator — visible in the main content area */}
          {isLoading && agentPhase !== 'idle' && !streamingSQL && (
            <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm px-4 py-3 shadow-sm">
              {(() => {
                const config = phaseConfig[agentPhase];
                const Icon = config.icon;
                return (
                  <>
                    <Icon className={`h-4 w-4 ${agentPhase === 'generating' ? 'animate-pulse' : 'animate-spin'} ${config.color}`} />
                    <span className="text-base text-muted-foreground">
                      {statusText || config.text}
                    </span>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

        {/* Scroll to bottom button */}
        {showScrollToBottom && (
          <button
            data-print-hide
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3.5 py-2 text-xs font-medium text-muted-foreground shadow-lg backdrop-blur-sm transition-all hover:text-foreground hover:border-primary hover:shadow-xl"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Scroll to bottom
          </button>
        )}
      </div>
        </ErrorBoundary>

        {/* Input pinned at bottom */}
        <div data-print-hide className="border-t border-border bg-card/50 backdrop-blur-sm p-4">
          <div className="mx-auto max-w-4xl">
            <ChatInput
              onSubmit={streamAgentResponse}
              onStop={handleStop}
              isLoading={isLoading}
              prefillValue={prefillValue}
              prefillKey={prefillKey}
            />
          </div>
        </div>
        <p data-print-hide className="py-1.5 text-center text-xs text-muted-foreground/50">
          Created by Lincoln Li with <Heart className="inline h-3 w-3 fill-red-500 text-red-500 align-text-bottom" />
        </p>
      </div>
    </div>
    </TooltipProvider>

    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

    {apiKeyChecked && needsApiKey && (
      <ApiKeyPrompt
        onComplete={() => setNeedsApiKey(false)}
        onOpenSettings={() => { setNeedsApiKey(false); setSettingsOpen(true); }}
      />
    )}
    </>
  );
}
