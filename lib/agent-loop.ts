import { AgentEvent, QueryResult, TableMetadata, ConversationTurn, Attachment } from './types';
import {
  generateSQL,
  analyzeResults,
  fixSQL,
  validateResults,
  generateRevisedSQL,
  reviewSQL,
  buildTableContext,
  checkDateCompleteness,
  parseChartConfigFromAnalysis,
} from './anthropic';
import { findRelevantTables, ensureMetadataLoading, waitForRefresh, waitForPrioritySchemas, getMetadataCache, triggerBackgroundRefresh, ensureColumnsLoaded } from './metadata';
import { matchQueries, loadQueryLibrary, getQueryLibrary } from './query-matcher';
import { matchMetrics, ensureMetricsLoading } from './metric-catalog';
import { matchGitHubQueries, ensureGitHubQueriesLoading } from './github-queries';
import { validateSQL } from './sql-validator';
import { executeTrinoMCP } from './trino-mcp';

const MAX_ITERATIONS = 3;
const PROGRESS_POLL_MS = 2500;
/** Max rows sent to the client in a single NDJSON event (avoids OOM on serialization). */
const MAX_CLIENT_ROWS = 2000;

const encoder = new TextEncoder();

function emit(
  controller: ReadableStreamDefaultController,
  event: AgentEvent
): void {
  controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
}

/** Emit an execution event, capping rows to avoid OOM on serialization. */
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
 * Collect a ReadableStream into a single string.
 * If signal is provided and aborted, cancels the stream and throws.
 */
async function collectStream(stream: ReadableStream, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  if (signal) {
    signal.addEventListener('abort', () => reader.cancel(), { once: true });
  }
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode(); // flush remaining bytes
  return result;
}

/**
 * Stream a ReadableStream to the client as sql_chunk events,
 * returning the accumulated full text.
 * If signal is provided and aborted, cancels the stream and throws.
 */
async function streamSQLGeneration(
  controller: ReadableStreamDefaultController,
  stream: ReadableStream,
  iteration: number,
  signal?: AbortSignal,
): Promise<string> {
  emit(controller, { type: 'sql_start', iteration });

  const reader = stream.getReader();
  if (signal) {
    signal.addEventListener('abort', () => reader.cancel(), { once: true });
  }
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const delta = decoder.decode(value, { stream: true });
    result += delta;
    emit(controller, { type: 'sql_chunk', delta });
  }
  const finalDelta = decoder.decode(); // flush remaining bytes
  if (finalDelta) {
    result += finalDelta;
    emit(controller, { type: 'sql_chunk', delta: finalDelta });
  }
  return result;
}

/**
 * Extract SQL from LLM response text (takes the LAST ```sql ... ``` block,
 * since the LLM often shows a "before" and "after" when revising).
 */
function extractSQL(text: string): string {
  const matches = [...text.matchAll(/```sql\n?([\s\S]*?)```/g)];
  return matches.length > 0 ? matches[matches.length - 1][1].trim() : '';
}

/**
 * Extract explanation text (everything outside the SQL block).
 */
function extractExplanation(text: string): string {
  return text.replace(/```sql[\s\S]*?```/g, '').trim();
}

/**
 * Find table names referenced in a SQL query (simple regex extraction).
 */
function extractTablesFromSQL(sql: string): string[] {
  const tables: string[] = [];
  // Match catalog.schema.table patterns
  const matches = sql.matchAll(/(\w+\.\w+\.\w+)/g);
  for (const match of matches) {
    tables.push(match[1].toLowerCase());
  }
  return [...new Set(tables)];
}

/**
 * Wait for priority schemas while emitting progress events to the client.
 */
async function waitWithProgress(
  controller: ReadableStreamDefaultController,
  waitFn: () => Promise<void>,
  label: string
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
 * Build a list of alternative tables the agent hasn't tried yet.
 */
function getUnusedTables(
  allTables: TableMetadata[],
  usedTableNames: string[]
): TableMetadata[] {
  const usedSet = new Set(usedTableNames.map((t) => t.toLowerCase()));
  return allTables.filter(
    (t) => !usedSet.has(`${t.catalog}.${t.schema}.${t.table}`.toLowerCase())
  );
}

/**
 * Run the agentic query loop.
 * Returns an NDJSON ReadableStream of AgentEvent objects.
 */
export function runAgentLoop(question: string, history?: ConversationTurn[], attachments?: Attachment[]): ReadableStream {
  const abortController = new AbortController();

  return new ReadableStream({
    cancel() {
      abortController.abort();
    },
    async start(controller) {
      const checkAborted = () => {
        if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      try {
        // Load context — wait for metadata so the LLM has table/column info
        if (getQueryLibrary().length === 0) loadQueryLibrary();
        ensureMetadataLoading();
        ensureMetricsLoading();
        ensureGitHubQueriesLoading();

        // Block until priority schemas are loaded (first load) so the LLM
        // never generates SQL without knowing the actual schema
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
        const relevantMetrics = matchMetrics(question, 10);

        // Log what references were found (priority order)
        const refSources: string[] = [];
        if (relevantMetrics.length > 0) {
          refSources.push(`${relevantMetrics.length} metric definition${relevantMetrics.length > 1 ? 's' : ''} (${relevantMetrics.map((m) => m.name).join(', ')})`);
        }
        if (relevantQueries.length > 0) {
          refSources.push(`${relevantQueries.length} local query reference${relevantQueries.length > 1 ? 's' : ''}`);
        }
        if (relevantGitHubQueries.length > 0) {
          refSources.push(`${relevantGitHubQueries.length} shared repo query reference${relevantGitHubQueries.length > 1 ? 's' : ''}`);
        }
        if (refSources.length > 0) {
          emit(controller, {
            type: 'thinking',
            iteration: 1,
            content: `Found ${refSources.join(', ')}.`,
          });
        }

        // If no relevant tables found, check if we have ANY metadata loaded
        if (relevantTables.length === 0) {
          const cache = getMetadataCache();
          const hasMetadata = cache && cache.tables.length > 0;

          if (!hasMetadata) {
            // No metadata at all — try a forced refresh, wait for priority schemas only
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

          // After refresh: still no relevant tables?
          if (relevantTables.length === 0) {
            if (relevantMetrics.length > 0 || relevantQueries.length > 0 || relevantGitHubQueries.length > 0) {
              // Metric catalog, query library, or GitHub repo has references — proceed
              emit(controller, {
                type: 'thinking',
                iteration: 1,
                content: relevantMetrics.length > 0
                  ? 'No exact table matches, but using metric catalog definitions.'
                  : 'No exact table matches, but using query library references.',
              });
            } else {
              // Nothing available — ask user to refresh metadata
              emit(controller, {
                type: 'needs_metadata',
                content: 'No table metadata is available for this question. Please refresh the schema metadata from the sidebar, then try again.',
                question,
              });
              emit(controller, { type: 'done', iterations: 0, finalIteration: 0 });
              return;
            }
          }
        }

        // Ensure columns are loaded for all matched tables (non-priority schemas
        // may only have table names listed but no columns yet during Phase 2)
        if (relevantTables.some((t) => t.columns.length === 0)) {
          emit(controller, { type: 'progress', content: 'Loading column metadata for matched tables...' });
          relevantTables = await ensureColumnsLoaded(relevantTables);
        }

        let currentSQL = '';
        let currentResults: QueryResult | null = null;
        let finalIteration = 1;
        let succeeded = false;
        const usedTableNames: string[] = [];

        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
          finalIteration = iteration;

          // --- Generate SQL (streamed to client) ---
          checkAborted();
          if (iteration > 1) {
            emit(controller, {
              type: 'thinking',
              iteration,
              content: `Attempt ${iteration}: Generating revised SQL using different tables/approach...`,
            });
          }

          let llmResponse: string;
          try {
            let stream: ReadableStream;
            if (iteration === 1) {
              stream = await generateSQL(question, relevantTables, relevantQueries, history, relevantMetrics, relevantGitHubQueries, attachments);
            } else {
              // Build context about what was already tried
              const unusedTables = getUnusedTables(relevantTables, usedTableNames);
              const prevValidation = `Previous query returned results that didn't answer the question well.`;
              stream = await generateRevisedSQL(
                question,
                currentSQL,
                prevValidation,
                undefined,
                relevantTables,
                relevantQueries,
                unusedTables,
                relevantMetrics,
                relevantGitHubQueries,
                attachments,
              );
            }
            // Stream the SQL generation to the client token-by-token
            llmResponse = await streamSQLGeneration(controller, stream, iteration, abortController.signal);
          } catch (err) {
            emit(controller, {
              type: 'error',
              content: `Failed to generate SQL: ${err instanceof Error ? err.message : 'Unknown error'}`,
              iteration,
            });
            break;
          }

          const sql = extractSQL(llmResponse);
          const explanation = extractExplanation(llmResponse);

          if (!sql) {
            // LLM didn't generate SQL — could be a direct answer or a clarification question.
            // Heuristic: if the response is long and contains markdown formatting (headers, tables,
            // bullets), it's a direct answer; if it's short or ends with a question, it's a clarification.
            const isDirectAnswer =
              explanation.length > 200 ||
              /^#{1,3}\s/m.test(explanation) ||
              /^\|.+\|$/m.test(explanation) ||
              /^[\-\*]\s/m.test(explanation);

            if (isDirectAnswer) {
              // Stream as analysis so it gets proper markdown rendering
              for (let i = 0; i < explanation.length; i += 100) {
                const chunk = explanation.slice(i, i + 100);
                emit(controller, { type: 'analysis_chunk', delta: chunk });
              }
            } else {
              emit(controller, {
                type: 'clarification',
                content: explanation || 'Could you clarify your question? I need more details to write an accurate query.',
              });
            }
            emit(controller, { type: 'done', iterations: 0, finalIteration: 0 });
            return;
          }

          // Emit final SQL (client switches from streaming view to editor)
          emit(controller, { type: 'sql', iteration, sql, explanation });
          currentSQL = sql;

          // Track which tables have been used across iterations
          usedTableNames.push(...extractTablesFromSQL(sql));

          // --- Validate SQL (read-only check) ---
          checkAborted();
          const sqlValidation = validateSQL(sql);
          if (!sqlValidation.valid) {
            emit(controller, {
              type: 'error',
              content: sqlValidation.error || 'SQL validation failed',
              iteration,
            });
            break;
          }

          // --- LLM review (logical error check) ---
          try {
            emit(controller, {
              type: 'progress',
              content: 'Reviewing query for logical errors...',
            });
            const review = await reviewSQL(question, currentSQL, relevantTables);
            if (!review.approved && review.correctedSQL) {
              const issuesSummary = review.issues.join('; ');
              emit(controller, {
                type: 'thinking',
                iteration,
                content: `Found issues: ${issuesSummary}. Auto-correcting...`,
              });
              currentSQL = review.correctedSQL;
              usedTableNames.push(...extractTablesFromSQL(review.correctedSQL));
              emit(controller, {
                type: 'sql',
                iteration,
                sql: review.correctedSQL,
                explanation: `Corrected: ${issuesSummary}`,
              });

              // Re-validate the corrected SQL
              const correctedValidation = validateSQL(review.correctedSQL);
              if (!correctedValidation.valid) {
                emit(controller, {
                  type: 'error',
                  content: correctedValidation.error || 'Corrected SQL validation failed',
                  iteration,
                });
                break;
              }
            }
          } catch (reviewErr) {
            console.error('[agent] SQL review failed, proceeding:', reviewErr);
          }

          // --- Execute ---
          checkAborted();
          let execResult: { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] } | undefined = undefined;
          let execTimeMs = 0;
          try {
            const t0 = Date.now();
            execResult = await executeTrinoMCP(currentSQL);
            execTimeMs = Date.now() - t0;
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Execution failed';

            // Try auto-fix if we have iterations left
            if (iteration < MAX_ITERATIONS) {
              emit(controller, {
                type: 'thinking',
                iteration,
                content: `Query failed: ${errorMsg}. Attempting to fix...`,
              });

              try {
                const fixStream = await fixSQL(currentSQL, errorMsg, question, relevantTables);
                const fixResponse = await collectStream(fixStream, abortController.signal);
                const fixedSQL = extractSQL(fixResponse);
                if (fixedSQL) {
                  currentSQL = fixedSQL;
                  usedTableNames.push(...extractTablesFromSQL(fixedSQL));
                  emit(controller, {
                    type: 'sql',
                    iteration,
                    sql: fixedSQL,
                    explanation: extractExplanation(fixResponse),
                  });

                  const fixValidation = validateSQL(fixedSQL);
                  if (fixValidation.valid) {
                    try {
                      const t1 = Date.now();
                      execResult = await executeTrinoMCP(fixedSQL);
                      execTimeMs = Date.now() - t1;
                    } catch (retryErr) {
                      emit(controller, {
                        type: 'thinking',
                        iteration,
                        content: `Fix also failed: ${retryErr instanceof Error ? retryErr.message : 'Unknown error'}. Will retry with different approach.`,
                      });
                      continue;
                    }
                  } else {
                    continue;
                  }
                } else {
                  continue;
                }
              } catch (fixErr) {
                console.error('[agent] fixSQL failed:', fixErr);
                emit(controller, {
                  type: 'thinking',
                  iteration,
                  content: `SQL fix attempt failed: ${fixErr instanceof Error ? fixErr.message : 'Unknown error'}. Retrying with different approach...`,
                });
                continue;
              }
            } else {
              emit(controller, {
                type: 'error',
                content: `Query execution failed after ${MAX_ITERATIONS} attempts: ${errorMsg}`,
                iteration,
              });
              break;
            }
          }

          if (!execResult) {
            emit(controller, {
              type: 'error',
              content: 'SQL execution failed after all retry attempts',
              iteration,
            });
            break;
          }

          const results: QueryResult = {
            columns: execResult.columns,
            columnTypes: execResult.columnTypes,
            rows: execResult.rows,
            rowCount: execResult.rows.length,
            executionTimeMs: execTimeMs,
          };

          emitExecution(controller, iteration, results);

          currentResults = results;

          // --- Validate results ---
          checkAborted();
          if (results.rowCount === 0) {
            if (iteration < MAX_ITERATIONS) {
              emit(controller, {
                type: 'validation',
                iteration,
                valid: false,
                reason: 'Query returned 0 rows. The table may be empty or filters too restrictive.',
                suggestion: 'Try completely different tables or broaden the filter conditions.',
              });
              emit(controller, {
                type: 'thinking',
                iteration,
                content: 'No results returned. Trying a different approach with alternative tables...',
              });
              continue;
            }
          }

          if (results.rowCount > 0) {
            // Fast code-level date completeness check (catches "Q1 but missing January" etc.)
            const dateCheck = checkDateCompleteness(question, results);
            if (dateCheck && !dateCheck.valid && iteration < MAX_ITERATIONS) {
              emit(controller, {
                type: 'validation',
                iteration,
                valid: false,
                reason: dateCheck.reason,
                suggestion: dateCheck.suggestion,
              });

              const unusedTables = getUnusedTables(relevantTables, usedTableNames);
              emit(controller, {
                type: 'thinking',
                iteration,
                content: `Date range issue detected: ${dateCheck.reason}\n${dateCheck.suggestion}${unusedTables.length > 0 ? `\nTables NOT yet tried: ${unusedTables.map((t) => `${t.catalog}.${t.schema}.${t.table}`).join(', ')}` : ''}`,
              });

              const revisedStream = await generateRevisedSQL(
                question,
                sql,
                dateCheck.reason,
                dateCheck.suggestion,
                relevantTables,
                relevantQueries,
                unusedTables,
                relevantMetrics,
                relevantGitHubQueries,
                attachments,
              );
              const revisedResponse = await streamSQLGeneration(controller, revisedStream, iteration + 1, abortController.signal);
              const revisedSQL = extractSQL(revisedResponse);
              if (revisedSQL) {
                currentSQL = revisedSQL;
                usedTableNames.push(...extractTablesFromSQL(revisedSQL));
                emit(controller, {
                  type: 'sql',
                  iteration: iteration + 1,
                  sql: revisedSQL,
                  explanation: extractExplanation(revisedResponse),
                });

                const revisedValidation = validateSQL(revisedSQL);
                if (revisedValidation.valid) {
                  try {
                    const rt0 = Date.now();
                    const revisedExec = await executeTrinoMCP(revisedSQL);
                    const revisedResults: QueryResult = {
                      columns: revisedExec.columns,
                      columnTypes: revisedExec.columnTypes,
                      rows: revisedExec.rows,
                      rowCount: revisedExec.rows.length,
                      executionTimeMs: Date.now() - rt0,
                    };

                    emitExecution(controller, iteration + 1, revisedResults);

                    // Check date completeness on revised results too
                    const revisedDateCheck = checkDateCompleteness(question, revisedResults);
                    if (!revisedDateCheck || revisedDateCheck.valid !== false) {
                      currentSQL = revisedSQL;
                      currentResults = revisedResults;
                      finalIteration = iteration + 1;
                      succeeded = true;
                      break;
                    }

                    // Even if date check fails again, use these results
                    currentSQL = revisedSQL;
                    currentResults = revisedResults;
                    finalIteration = iteration + 1;
                  } catch (dateRetryErr) {
                    console.error('[agent] Date-completeness revised query failed:', dateRetryErr);
                    emit(controller, {
                      type: 'thinking',
                      iteration,
                      content: `Revised query failed: ${dateRetryErr instanceof Error ? dateRetryErr.message : 'Unknown error'}. Proceeding with current results.`,
                    });
                  }
                }
              }
              // The inline block above already consumed iteration+1, so bump
              // the counter to avoid re-running that iteration in the main loop.
              iteration++;
              continue;
            }

            try {
              const validation = await validateResults(question, sql, results, relevantTables);

              if (!validation.valid) {
                emit(controller, {
                  type: 'validation',
                  iteration,
                  valid: false,
                  reason: validation.reason,
                  suggestion: validation.suggestion,
                });

                if (iteration < MAX_ITERATIONS) {
                  const unusedTables = getUnusedTables(relevantTables, usedTableNames);
                  const unusedTableHint =
                    unusedTables.length > 0
                      ? `\nAvailable tables NOT yet tried: ${unusedTables.map((t) => `${t.catalog}.${t.schema}.${t.table}`).join(', ')}`
                      : '';

                  emit(controller, {
                    type: 'thinking',
                    iteration,
                    content: `Results issue: ${validation.reason}${validation.suggestion ? `\nSuggestion: ${validation.suggestion}` : ''}${unusedTableHint}`,
                  });

                  // Generate revised SQL with validation context + unused tables hint
                  const revisedStream = await generateRevisedSQL(
                    question,
                    sql,
                    validation.reason,
                    validation.suggestion,
                    relevantTables,
                    relevantQueries,
                    unusedTables,
                    relevantMetrics,
                    relevantGitHubQueries,
                    attachments,
                  );
                  const revisedResponse = await streamSQLGeneration(controller, revisedStream, iteration + 1, abortController.signal);
                  const revisedSQL = extractSQL(revisedResponse);
                  if (revisedSQL) {
                    currentSQL = revisedSQL;
                    usedTableNames.push(...extractTablesFromSQL(revisedSQL));

                    emit(controller, {
                      type: 'sql',
                      iteration: iteration + 1,
                      sql: revisedSQL,
                      explanation: extractExplanation(revisedResponse),
                    });

                    // Execute the revised SQL immediately
                    const revisedValidation = validateSQL(revisedSQL);
                    if (revisedValidation.valid) {
                      try {
                        const rt1 = Date.now();
                        const revisedExec = await executeTrinoMCP(revisedSQL);
                        const revisedResults: QueryResult = {
                          columns: revisedExec.columns,
                          columnTypes: revisedExec.columnTypes,
                          rows: revisedExec.rows,
                          rowCount: revisedExec.rows.length,
                          executionTimeMs: Date.now() - rt1,
                        };

                        emitExecution(controller, iteration + 1, revisedResults);

                        // Validate the revised results
                        if (revisedResults.rowCount > 0) {
                          const reValidation = await validateResults(
                            question, revisedSQL, revisedResults, relevantTables
                          );
                          emit(controller, {
                            type: 'validation',
                            iteration: iteration + 1,
                            valid: reValidation.valid,
                            reason: reValidation.reason,
                          });
                          if (reValidation.valid) {
                            currentSQL = revisedSQL;
                            currentResults = revisedResults;
                            finalIteration = iteration + 1;
                            succeeded = true;
                            break;
                          }
                        }

                        currentSQL = revisedSQL;
                        currentResults = revisedResults;
                        finalIteration = iteration + 1;
                      } catch (valRetryErr) {
                        console.error('[agent] Validation revised query failed:', valRetryErr);
                        emit(controller, {
                          type: 'thinking',
                          iteration,
                          content: `Revised query failed: ${valRetryErr instanceof Error ? valRetryErr.message : 'Unknown error'}. Proceeding with current results.`,
                        });
                      }
                    }
                  }
                  // The inline block above already consumed iteration+1, so bump
                  // the counter to avoid re-running that iteration in the main loop.
                  iteration++;
                  continue;
                }
              } else {
                // Validation passed
                if (iteration > 1) {
                  emit(controller, {
                    type: 'validation',
                    iteration,
                    valid: true,
                    reason: validation.reason,
                  });
                }
                succeeded = true;
                break;
              }
            } catch (validationErr) {
              console.error('[agent] Validation error, proceeding:', validationErr);
              succeeded = true;
              break;
            }
          }

          succeeded = currentResults !== null && currentResults.rowCount > 0;
          break;
        }

        // --- Stream analysis ---
        checkAborted();
        let llmChartConfig: import('./types').ChartConfig | undefined;

        if (currentResults && currentResults.rowCount > 0) {
          try {
            const analysisStream = await analyzeResults(
              question,
              currentSQL,
              currentResults,
              history
            );
            const reader = analysisStream.getReader();
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
            const finalDelta = decoder.decode(); // flush remaining bytes
            if (finalDelta) {
              fullAnalysis += finalDelta;
              emit(controller, { type: 'analysis_chunk', delta: finalDelta });
            }

            // Parse chart config from the completed analysis text
            const { chartConfig } = parseChartConfigFromAnalysis(fullAnalysis);
            if (chartConfig && chartConfig.type !== 'none' && currentResults) {
              // Validate that LLM-suggested keys actually exist in the result columns
              const colSet = new Set(currentResults.columns.map((c) => c.toLowerCase()));
              const xValid = colSet.has(chartConfig.xKey.toLowerCase());
              const yValid = chartConfig.yKeys.some((k) => colSet.has(k.toLowerCase()));
              if (xValid && yValid) {
                llmChartConfig = chartConfig;
              }
            }
          } catch (err) {
            emit(controller, {
              type: 'error',
              content: `Analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            });
          }
        }

        emit(controller, {
          type: 'done',
          iterations: finalIteration,
          finalIteration,
          ...(llmChartConfig ? { chartConfig: llmChartConfig } : {}),
        });
      } catch (err) {
        // Client disconnect — silently stop
        if (err instanceof DOMException && err.name === 'AbortError') return;
        try {
          emit(controller, {
            type: 'error',
            content: `Agent loop failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          });
        } catch {
          // Stream already closed (client disconnected) — nothing to do
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
}
