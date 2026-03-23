'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatInput } from '@/components/chat-input';
import { SQLEditor } from '@/components/sql-editor';
import { AnalysisCard } from '@/components/analysis-card';
import { ThinkingStep } from '@/components/thinking-step';
import { ChartRenderer } from '@/components/chart-renderer';
import { CSVDownload } from '@/components/csv-download';
import { RawDataPreview } from '@/components/raw-data-preview';
import { NotebookCell, QueryResult, AgentEvent, ConversationTurn } from '@/lib/types';
import { loadSession, saveSession, generateCellId } from '@/lib/session';
import { detectChartType } from '@/lib/chart-detector';
import { SchemaExplorer } from '@/components/schema-explorer';
import { QueryLibrary } from '@/components/query-library';
import { Database, Trash2, Loader2, Sparkles, Play, Search, CheckCircle2, PanelLeft, PanelLeftClose, Menu, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type AgentPhase =
  | 'idle'
  | 'generating'
  | 'executing'
  | 'validating'
  | 'retrying'
  | 'analyzing';

function buildHistory(cells: NotebookCell[], maxTurns = 3): ConversationTurn[] {
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
      analysis: run.analysis ? run.analysis.slice(0, 500) : undefined,
    });
  }
  return turns.slice(-maxTurns);
}

export default function Home() {
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('idle');
  const [agentIteration, setAgentIteration] = useState(1);
  const [streamingSQL, setStreamingSQL] = useState('');
  const [isExecuting, setIsExecuting] = useState(false); // For manual re-runs
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [prefillValue, setPrefillValue] = useState('');
  const [prefillKey, setPrefillKey] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const isNearBottomRef = useRef(true);

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
    (id: string, updates: Partial<NotebookCell>) => {
      setCells((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...updates } : c))
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
        if (c.type === 'thinking' || c.metadata?.isIntermediate) {
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
    async (question: string) => {
      const agentRunId = `run-${Date.now()}`;

      // Add question cell
      addCell({
        id: generateCellId(),
        type: 'question',
        content: question,
        timestamp: Date.now(),
        metadata: { agentRunId },
      });

      setAgentPhase('generating');
      setAgentIteration(1);
      setStreamingSQL('');

      // Track cell IDs per iteration for updating
      const sqlCellIds: Record<number, string> = {};
      let analysisCellId: string | null = null;
      let analysisText = '';
      let latestResultsCellId: string | null = null;
      let finalIteration = 1;
      let currentStreamingIteration = 1;

      try {
        const history = buildHistory(cellsRef.current);
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, history }),
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
          buffer = lines.pop() || ''; // Keep incomplete last line

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
                setAgentPhase(event.iteration > 1 ? 'retrying' : 'validating');
                setAgentIteration(event.iteration);
                addCell({
                  id: generateCellId(),
                  type: 'thinking',
                  content: event.content,
                  timestamp: Date.now(),
                  metadata: {
                    agentRunId,
                    iteration: event.iteration,
                    collapsed: false,
                  },
                });
                break;
              }

              case 'sql_start': {
                // Start streaming SQL generation
                setAgentPhase('generating');
                setAgentIteration(event.iteration);
                currentStreamingIteration = event.iteration;
                setStreamingSQL('');
                break;
              }

              case 'sql_chunk': {
                // Accumulate streaming SQL text
                setStreamingSQL((prev) => prev + event.delta);
                break;
              }

              case 'sql': {
                // SQL generation complete — clear streaming state and add final cell
                setStreamingSQL('');
                setAgentPhase('executing');
                setAgentIteration(event.iteration);

                // Mark previous iteration's SQL as intermediate
                for (const [iter, cellId] of Object.entries(sqlCellIds)) {
                  if (Number(iter) < event.iteration) {
                    updateCellMetadata(cellId, { isIntermediate: true });
                  }
                }

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
                break;
              }

              case 'execution': {
                setAgentPhase('validating');
                const results: QueryResult = {
                  columns: event.columns,
                  columnTypes: event.columnTypes,
                  rows: event.rows,
                  rowCount: event.rowCount,
                  executionTimeMs: event.executionTimeMs,
                };
                const chartConfig = detectChartType(results, question);
                const resultsCellId = generateCellId();

                // Mark previous results cells as intermediate
                if (latestResultsCellId) {
                  updateCellMetadata(latestResultsCellId, { isIntermediate: true });
                }
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

                // If LLM provided a chart config, override the heuristic one on the results cell
                if (event.chartConfig && latestResultsCellId) {
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
        setAgentPhase('idle');
        setStreamingSQL('');
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

  const phaseConfig: Record<AgentPhase, { icon: typeof Loader2; text: string; color: string }> = {
    idle: { icon: Loader2, text: '', color: '' },
    generating: {
      icon: Sparkles,
      text: agentIteration > 1 ? `Writing SQL (attempt ${agentIteration}/3)...` : 'Writing SQL...',
      color: 'text-blue-400',
    },
    executing: { icon: Play, text: 'Running query...', color: 'text-amber-400' },
    validating: { icon: Search, text: 'Checking results...', color: 'text-purple-400' },
    retrying: {
      icon: Loader2,
      text: `Trying different approach (attempt ${agentIteration}/3)...`,
      color: 'text-amber-400',
    },
    analyzing: { icon: CheckCircle2, text: 'Analyzing results...', color: 'text-green-400' },
  };

  const sidebarContent = (
    <Tabs defaultValue="schema" className="flex h-full flex-col">
      <TabsList className="mx-3 mt-3 shrink-0">
        <TabsTrigger value="schema">Schema</TabsTrigger>
        <TabsTrigger value="library">Library</TabsTrigger>
      </TabsList>
      <TabsContent value="schema" className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <SchemaExplorer onInsertTable={handleInsertTable} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="library" className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <QueryLibrary onUseQuery={handleUseQuery} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );

  return (
    <div className="flex h-screen">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden md:flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out overflow-hidden',
          sidebarOpen ? 'w-[280px] min-w-[280px]' : 'w-0 min-w-0'
        )}
      >
        {sidebarOpen && sidebarContent}
      </aside>

      {/* Mobile sidebar (Sheet) */}
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="left" className="w-[300px] p-0 bg-sidebar text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebarContent}
        </SheetContent>
      </Sheet>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="flex items-center gap-2">
            {/* Mobile hamburger */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 md:hidden"
              onClick={() => setMobileSheetOpen(true)}
            >
              <Menu className="h-4 w-4" />
            </Button>
            {/* Desktop sidebar toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex h-8 w-8"
              onClick={() => setSidebarOpen((o) => !o)}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeft className="h-4 w-4" />
              )}
            </Button>
            <Database className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Lakehouse Analytics</h1>
          </div>
          {cells.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearSession}
              className="text-xs text-muted-foreground"
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Clear
            </Button>
          )}
        </header>

        {/* Notebook cells */}
        <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4 pb-32">
          {cells.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Database className="mb-4 h-12 w-12 text-muted-foreground/30" />
              <h2 className="text-xl font-semibold text-foreground">
                Welcome to Lakehouse Analytics
              </h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Ask questions about your data in plain English. I&apos;ll generate
                SQL, run it against your Trino lakehouse, validate the results,
                and provide an analysis.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  'Show me the top 10 customers by lifetime value',
                  'What is the daily revenue trend this quarter?',
                  'Which products have the highest return rate?',
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => streamAgentResponse(q)}
                    className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {cells.map((cell) => {
            // Hide intermediate cells when collapsed
            if (cell.metadata?.isIntermediate && cell.metadata?.collapsed) {
              return null;
            }

            return (
              <div key={cell.id}>
                {cell.type === 'question' && (
                  <div className="flex items-start gap-3">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                      Q
                    </div>
                    <p className="pt-1 text-sm text-foreground">
                      {cell.content}
                    </p>
                  </div>
                )}

                {cell.type === 'thinking' && (
                  <ThinkingStep
                    content={cell.content}
                    iteration={cell.metadata?.iteration || 1}
                    collapsed={cell.metadata?.collapsed || false}
                    validationResult={cell.metadata?.validationResult}
                    intermediateSQL={cell.metadata?.sql}
                  />
                )}

                {cell.type === 'sql' && !cell.metadata?.isIntermediate && (
                  <SQLEditor
                    sql={
                      cell.metadata?.sql || cell.content
                    }
                    onExecute={handleExecuteFromEditor}
                    isExecuting={isExecuting}
                    streaming={false}
                  />
                )}

                {cell.type === 'results' &&
                  !cell.metadata?.isIntermediate &&
                  cell.metadata?.results && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1">
                        <span className="text-xs text-muted-foreground">
                          {cell.metadata.results.rowCount} rows returned
                          {cell.metadata.results.executionTimeMs > 0 &&
                            ` in ${cell.metadata.results.executionTimeMs}ms`}
                        </span>
                        <CSVDownload results={cell.metadata.results} />
                      </div>
                      {cell.metadata.chartConfig &&
                        cell.metadata.chartConfig.type !== 'none' && (
                          <ChartRenderer
                            config={cell.metadata.chartConfig}
                            results={cell.metadata.results}
                          />
                        )}
                      <RawDataPreview results={cell.metadata.results} />
                    </div>
                  )}

                {cell.type === 'analysis' && (
                  <AnalysisCard
                    analysis={cell.content}
                    streaming={agentPhase === 'analyzing'}
                    iterations={cell.metadata?.iteration}
                    onFollowUp={streamAgentResponse}
                  />
                )}

                {cell.type === 'error' && (
                  <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {cell.content}
                  </div>
                )}
              </div>
            );
          })}

          {/* Streaming SQL preview — shows while SQL is being generated token-by-token */}
          {streamingSQL && agentPhase === 'generating' && (
            <div className="rounded-lg border border-border bg-zinc-950 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                <span className="text-xs font-medium text-zinc-400">Writing SQL...</span>
              </div>
              <pre className="p-4 text-sm text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto">
                {streamingSQL}
                <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom" />
              </pre>
            </div>
          )}

          {/* Inline status indicator — visible in the main content area */}
          {isLoading && agentPhase !== 'idle' && !streamingSQL && (
            <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
              {(() => {
                const config = phaseConfig[agentPhase];
                const Icon = config.icon;
                return (
                  <>
                    <Icon className={`h-4 w-4 ${agentPhase === 'executing' || agentPhase === 'retrying' ? 'animate-spin' : 'animate-pulse'} ${config.color}`} />
                    <span className="text-sm text-muted-foreground">
                      {config.text}
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
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur transition-colors hover:text-foreground hover:border-primary"
          >
            <ArrowDown className="h-3 w-3" />
            Scroll to bottom
          </button>
        )}
      </div>

        {/* Input pinned at bottom */}
        <div className="border-t border-border bg-background p-4">
          <div className="mx-auto max-w-4xl">
            <ChatInput
              onSubmit={streamAgentResponse}
              isLoading={isLoading}
              prefillValue={prefillValue}
              prefillKey={prefillKey}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
