import Anthropic from '@anthropic-ai/sdk';
import { AgentEvent, QueryResult, ConversationTurn, Attachment } from './types';
import {
  getExploratorySystemPrompt,
  analyzeResults,
  parseChartConfigFromAnalysis,
  getClient,
  getModel,
  buildHistoryMessages,
  buildUserContent,
} from './anthropic';
import { TOOL_DEFINITIONS, executeTool } from './agent-tools';
import {
  findRelevantTables,
  ensureMetadataLoading,
  waitForPrioritySchemas,
  getMetadataCache,
  triggerBackgroundRefresh,
  ensureColumnsLoaded,
} from './metadata';
import { matchQueries, loadQueryLibrary, getQueryLibrary } from './query-matcher';
import { getMetricCatalog, ensureMetricsLoading } from './metric-catalog';
import { matchGitHubQueries, ensureGitHubQueriesLoading } from './github-queries';
import { detectChartType } from './chart-detector';

const MAX_TOOL_CALLS = 20;
const PROGRESS_POLL_MS = 2500;
/** Max rows sent to the client in a single NDJSON event. */
const MAX_CLIENT_ROWS = 2000;

const encoder = new TextEncoder();

function emit(
  controller: ReadableStreamDefaultController,
  event: AgentEvent,
): void {
  controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
}

/** Emit an execution event, capping rows to avoid OOM. */
function emitExecution(
  controller: ReadableStreamDefaultController,
  iteration: number,
  results: QueryResult,
): void {
  emit(controller, {
    type: 'execution',
    iteration,
    rowCount: results.rowCount,
    columns: results.columns,
    columnTypes: results.columnTypes,
    rows: results.rows.length > MAX_CLIENT_ROWS
      ? results.rows.slice(0, MAX_CLIENT_ROWS)
      : results.rows,
    executionTimeMs: results.executionTimeMs,
  });
}

/**
 * Wait for priority schemas while emitting progress events.
 */
async function waitWithProgress(
  controller: ReadableStreamDefaultController,
  waitFn: () => Promise<void>,
  label: string,
): Promise<void> {
  let done = false;
  const waitPromise = waitFn().then(() => { done = true; });

  while (!done) {
    const finished = await Promise.race([
      waitPromise.then(() => true as const),
      new Promise<false>((r) => setTimeout(() => r(false), PROGRESS_POLL_MS)),
    ]);
    if (finished) break;

    const cache = getMetadataCache();
    const tableCount = cache?.tables.length || 0;
    const schemasDone = cache
      ? [...new Set(cache.tables.map((t) => t.schema))].length
      : 0;

    emit(controller, {
      type: 'progress',
      content: `${label} — ${schemasDone} schema${schemasDone !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''} loaded so far...`,
    });
  }
}

/**
 * Run the exploratory agentic loop using Anthropic tool-use.
 * The LLM decides when to explore schema, run queries, and submit the final answer.
 */
export function runAgentLoopV2(
  question: string,
  history?: ConversationTurn[],
  attachments?: Attachment[],
): ReadableStream {
  const abortController = new AbortController();

  return new ReadableStream({
    cancel() {
      abortController.abort();
    },
    async start(controller) {
      const checkAborted = () => {
        if (abortController.signal.aborted)
          throw new DOMException('Aborted', 'AbortError');
      };

      try {
        // ── Phase 0: Load context ──
        if (getQueryLibrary().length === 0) loadQueryLibrary();
        ensureMetadataLoading();
        await ensureMetricsLoading();
        ensureGitHubQueriesLoading();

        // Block on priority schemas if no cache
        if (!getMetadataCache()) {
          emit(controller, {
            type: 'thinking',
            iteration: 1,
            content: 'Loading priority schemas...',
          });
          await waitWithProgress(controller, waitForPrioritySchemas, 'Loading priority schemas');
          const cache = getMetadataCache();
          emit(controller, { type: 'metadata_ready', tableCount: cache?.tables.length || 0 });
        }

        let relevantTables = findRelevantTables(question);
        const relevantQueries = matchQueries(question, 5);
        const relevantGitHubQueries = matchGitHubQueries(question, 5);
        const allMetrics = getMetricCatalog();

        console.log('[agent] Context loaded:', {
          tables: relevantTables.length,
          queries: relevantQueries.length,
          githubQueries: relevantGitHubQueries.length,
          metrics: allMetrics.length,
        });

        // If no tables AND no references, try forced refresh
        if (relevantTables.length === 0) {
          const cache = getMetadataCache();
          if (!cache || cache.tables.length === 0) {
            emit(controller, {
              type: 'thinking',
              iteration: 1,
              content: 'No table metadata available. Refreshing priority schemas...',
            });
            triggerBackgroundRefresh(true);
            await waitWithProgress(controller, waitForPrioritySchemas, 'Refreshing priority schemas');
            const refreshedCache = getMetadataCache();
            emit(controller, { type: 'metadata_ready', tableCount: refreshedCache?.tables.length || 0 });
            relevantTables = findRelevantTables(question);
          }

          // Still nothing? Check if we at least have metric/query refs
          if (relevantTables.length === 0 && allMetrics.length === 0 && relevantQueries.length === 0 && relevantGitHubQueries.length === 0) {
            emit(controller, {
              type: 'needs_metadata',
              content: 'No table metadata is available for this question. Please refresh the schema metadata from the sidebar, then try again.',
              question,
            });
            emit(controller, { type: 'done', iterations: 0, finalIteration: 0 });
            return;
          }
        }

        // Ensure columns are loaded for matched tables
        if (relevantTables.some((t) => t.columns.length === 0)) {
          emit(controller, { type: 'progress', content: 'Loading column metadata for matched tables...' });
          relevantTables = await ensureColumnsLoaded(relevantTables);
        }

        checkAborted();

        // ── Phase 1: Build system prompt and messages ──
        const systemPrompt = getExploratorySystemPrompt(
          relevantTables,
          allMetrics,
          relevantQueries,
          relevantGitHubQueries,
        );

        const messages: Anthropic.MessageParam[] = [
          ...buildHistoryMessages(history),
          { role: 'user', content: buildUserContent(question, attachments) },
        ];

        // ── Phase 2: Agentic tool-use loop ──
        let toolCallCount = 0;
        let finalSQL = '';
        let finalExplanation = '';
        let finalResults: QueryResult | null = null;
        let clarificationAsked = false;
        let directAnswer = '';

        while (toolCallCount < MAX_TOOL_CALLS) {
          checkAborted();

          emit(controller, { type: 'progress', content: 'Thinking...' });

          // Force final answer if at the limit
          const isForced = toolCallCount >= MAX_TOOL_CALLS - 1;
          const streamParams: Anthropic.MessageCreateParams = {
            model: getModel(),
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            tools: TOOL_DEFINITIONS,
            ...(isForced
              ? { tool_choice: { type: 'tool' as const, name: 'submit_final_query' } }
              : {}),
          };

          const client = getClient();
          const stream = client.messages.stream(streamParams);

          // Process streaming events
          let currentTextContent = '';
          const toolCalls: Array<{
            id: string;
            name: string;
            inputJson: string;
          }> = [];
          let activeToolIndex = -1;

          for await (const event of stream) {
            checkAborted();

            if (event.type === 'content_block_start') {
              if (event.content_block.type === 'text') {
                // Start of a text block — will emit thinking events
              } else if (event.content_block.type === 'tool_use') {
                activeToolIndex = toolCalls.length;
                toolCalls.push({
                  id: event.content_block.id,
                  name: event.content_block.name,
                  inputJson: '',
                });
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                currentTextContent += event.delta.text;
                // Stream thinking text to client
                emit(controller, {
                  type: 'thinking',
                  iteration: toolCallCount + 1,
                  content: event.delta.text,
                });
              } else if (event.delta.type === 'input_json_delta' && activeToolIndex >= 0) {
                toolCalls[activeToolIndex].inputJson += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              activeToolIndex = -1;
            }
          }

          // Get the full message for conversation history
          const finalMessage = await stream.finalMessage();
          const stopReason = finalMessage.stop_reason;

          // Append assistant message to history
          messages.push({ role: 'assistant', content: finalMessage.content });

          // If the model stopped without tool calls, it's a direct answer
          if (stopReason === 'end_turn' && toolCalls.length === 0) {
            directAnswer = currentTextContent;
            break;
          }

          // Execute tool calls and collect results
          if (toolCalls.length === 0) break;

          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

          for (const tc of toolCalls) {
            checkAborted();
            toolCallCount++;

            let input: Record<string, unknown>;
            try {
              input = JSON.parse(tc.inputJson);
            } catch {
              input = {};
            }

            // Emit tool_call event
            emit(controller, {
              type: 'tool_call',
              step: toolCallCount,
              tool: tc.name,
              input,
            });

            // Execute the tool
            const result = await executeTool(tc.name, input, abortController.signal);

            // Emit tool_result event
            const meta = result.metadata;
            emit(controller, {
              type: 'tool_result',
              step: toolCallCount,
              tool: tc.name,
              result: result.result.slice(0, 500),
              isError: result.isError,
              executionTimeMs: meta?.type === 'query_result' ? meta.queryResult.executionTimeMs : undefined,
              rowCount: meta?.type === 'query_result' ? meta.queryResult.rowCount : undefined,
            });

            // Handle special tools
            if (tc.name === 'submit_final_query' && !result.isError && meta?.type === 'query_result') {
              finalSQL = String(input.sql);
              finalExplanation = String(input.explanation || '');
              finalResults = meta.queryResult;

              // Emit SQL and execution events (same as v1)
              emit(controller, {
                type: 'sql',
                iteration: toolCallCount,
                sql: finalSQL,
                explanation: finalExplanation,
              });
              emitExecution(controller, toolCallCount, finalResults);
            }

            if (tc.name === 'ask_clarification' && meta?.type === 'clarification') {
              emit(controller, {
                type: 'clarification',
                content: meta.question,
              });
              clarificationAsked = true;
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: result.result,
              is_error: result.isError || undefined,
            });
          }

          // Append tool results to messages
          messages.push({ role: 'user', content: toolResults });

          // Exit conditions
          if (finalResults) break;
          if (clarificationAsked) break;

          // If submit_final_query was called but failed, the LLM gets the error
          // and can retry in the next iteration
        }

        // ── Handle forced termination ──
        if (toolCallCount >= MAX_TOOL_CALLS && !finalResults && !clarificationAsked && !directAnswer) {
          emit(controller, {
            type: 'thinking',
            iteration: toolCallCount + 1,
            content: 'Reached maximum number of tool calls without a final answer.',
          });
        }

        // ── Handle direct answer (no SQL) ──
        if (directAnswer && !finalResults) {
          // Stream as analysis
          emit(controller, { type: 'analysis_chunk', delta: directAnswer });
          emit(controller, { type: 'done', iterations: toolCallCount, finalIteration: toolCallCount });
          return;
        }

        // ── Phase 3: Analysis ──
        if (finalResults && finalResults.rowCount > 0) {
          checkAborted();
          emit(controller, { type: 'progress', content: 'Analyzing results...' });

          const analysisStream = await analyzeResults(
            question,
            finalSQL,
            finalResults,
            history,
          );

          const reader = analysisStream.getReader();
          if (abortController.signal.aborted) {
            reader.cancel();
            throw new DOMException('Aborted', 'AbortError');
          }
          abortController.signal.addEventListener('abort', () => reader.cancel(), { once: true });

          const decoder = new TextDecoder();
          let fullAnalysis = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const delta = decoder.decode(value, { stream: true });
            fullAnalysis += delta;
            emit(controller, { type: 'analysis_chunk', delta });
          }
          const finalDelta = decoder.decode();
          if (finalDelta) {
            fullAnalysis += finalDelta;
            emit(controller, { type: 'analysis_chunk', delta: finalDelta });
          }

          // Parse chart config from analysis
          const { chartConfig } = parseChartConfigFromAnalysis(fullAnalysis);
          let validChartConfig = chartConfig;

          // Validate chart config keys against actual result columns
          if (validChartConfig && validChartConfig.type !== 'none' && finalResults) {
            const colSet = new Set(finalResults.columns.map((c) => c.toLowerCase()));
            const xValid = colSet.has(validChartConfig.xKey.toLowerCase());
            const yValid = validChartConfig.yKeys.some((k) => colSet.has(k.toLowerCase()));
            if (!xValid || !yValid) {
              // Fall back to heuristic
              validChartConfig = detectChartType(finalResults);
            }
          }

          emit(controller, {
            type: 'done',
            iterations: toolCallCount,
            finalIteration: toolCallCount,
            chartConfig: validChartConfig || undefined,
          });
        } else {
          emit(controller, {
            type: 'done',
            iterations: toolCallCount,
            finalIteration: toolCallCount,
          });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Client disconnected — silently stop
        } else {
          console.error('[agent-loop-v2] Error:', err);
          emit(controller, {
            type: 'error',
            content: err instanceof Error ? err.message : 'An unexpected error occurred.',
          });
        }
      } finally {
        controller.close();
      }
    },
  });
}
