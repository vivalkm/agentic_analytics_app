import { AgentEvent, QueryResult, TableMetadata } from './types';
import {
  generateSQL,
  analyzeResults,
  fixSQL,
  validateResults,
  generateRevisedSQL,
  buildTableContext,
  checkDateCompleteness,
  parseChartConfigFromAnalysis,
} from './anthropic';
import { findRelevantTables, ensureMetadataLoading } from './metadata';
import { matchQueries, loadQueryLibrary, getQueryLibrary } from './query-matcher';
import { validateSQL } from './sql-validator';
import { executeTrinoMCP } from './trino-mcp';

const MAX_ITERATIONS = 3;

const encoder = new TextEncoder();

function emit(
  controller: ReadableStreamDefaultController,
  event: AgentEvent
): void {
  controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
}

/**
 * Collect a ReadableStream into a single string.
 */
async function collectStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/**
 * Stream a ReadableStream to the client as sql_chunk events,
 * returning the accumulated full text.
 */
async function streamSQLGeneration(
  controller: ReadableStreamDefaultController,
  stream: ReadableStream,
  iteration: number
): Promise<string> {
  emit(controller, { type: 'sql_start', iteration });

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const delta = decoder.decode(value, { stream: true });
    result += delta;
    emit(controller, { type: 'sql_chunk', delta });
  }
  return result;
}

/**
 * Extract SQL from LLM response text (looks for ```sql ... ``` blocks).
 */
function extractSQL(text: string): string {
  const match = text.match(/```sql\n?([\s\S]*?)```/);
  return match ? match[1].trim() : '';
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
export function runAgentLoop(question: string): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      try {
        // Load context
        if (getQueryLibrary().length === 0) loadQueryLibrary();
        ensureMetadataLoading();

        const relevantTables = findRelevantTables(question);
        const relevantQueries = matchQueries(question);

        let currentSQL = '';
        let currentResults: QueryResult | null = null;
        let finalIteration = 1;
        let succeeded = false;
        const usedTableNames: string[] = [];

        for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
          finalIteration = iteration;

          // --- Generate SQL (streamed to client) ---
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
              stream = await generateSQL(question, relevantTables, relevantQueries);
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
                unusedTables
              );
            }
            // Stream the SQL generation to the client token-by-token
            llmResponse = await streamSQLGeneration(controller, stream, iteration);
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
            emit(controller, {
              type: 'error',
              content: 'LLM did not generate a SQL query. ' + explanation,
              iteration,
            });
            break;
          }

          // Emit final SQL (client switches from streaming view to editor)
          emit(controller, { type: 'sql', iteration, sql, explanation });
          currentSQL = sql;

          // Track which tables have been used across iterations
          usedTableNames.push(...extractTablesFromSQL(sql));

          // --- Validate SQL (read-only check) ---
          const sqlValidation = validateSQL(sql);
          if (!sqlValidation.valid) {
            emit(controller, {
              type: 'error',
              content: sqlValidation.error || 'SQL validation failed',
              iteration,
            });
            break;
          }

          // --- Execute ---
          let execResult: { columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[] };
          try {
            execResult = await executeTrinoMCP(sql);
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
                const fixStream = await fixSQL(errorMsg, sql, question, relevantTables);
                const fixResponse = await collectStream(fixStream);
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
                      execResult = await executeTrinoMCP(fixedSQL);
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
              } catch {
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

          const results: QueryResult = {
            columns: execResult!.columns,
            columnTypes: execResult!.columnTypes,
            rows: execResult!.rows,
            rowCount: execResult!.rows.length,
            executionTimeMs: 0,
          };

          emit(controller, {
            type: 'execution',
            iteration,
            rowCount: results.rowCount,
            columns: results.columns,
            columnTypes: results.columnTypes,
            rows: results.rows,
            executionTimeMs: results.executionTimeMs,
          });

          currentResults = results;

          // --- Validate results ---
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
                unusedTables
              );
              const revisedResponse = await streamSQLGeneration(controller, revisedStream, iteration + 1);
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
                    const revisedExec = await executeTrinoMCP(revisedSQL);
                    const revisedResults: QueryResult = {
                      columns: revisedExec.columns,
                      columnTypes: revisedExec.columnTypes,
                      rows: revisedExec.rows,
                      rowCount: revisedExec.rows.length,
                      executionTimeMs: 0,
                    };

                    emit(controller, {
                      type: 'execution',
                      iteration: iteration + 1,
                      rowCount: revisedResults.rowCount,
                      columns: revisedResults.columns,
                      columnTypes: revisedResults.columnTypes,
                      rows: revisedResults.rows,
                      executionTimeMs: 0,
                    });

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
                  } catch {
                    // Revised query failed
                  }
                }
              }
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
                    unusedTables
                  );
                  const revisedResponse = await streamSQLGeneration(controller, revisedStream, iteration + 1);
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
                        const revisedExec = await executeTrinoMCP(revisedSQL);
                        const revisedResults: QueryResult = {
                          columns: revisedExec.columns,
                          columnTypes: revisedExec.columnTypes,
                          rows: revisedExec.rows,
                          rowCount: revisedExec.rows.length,
                          executionTimeMs: 0,
                        };

                        emit(controller, {
                          type: 'execution',
                          iteration: iteration + 1,
                          rowCount: revisedResults.rowCount,
                          columns: revisedResults.columns,
                          columnTypes: revisedResults.columnTypes,
                          rows: revisedResults.rows,
                          executionTimeMs: 0,
                        });

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
                      } catch {
                        // Revised query also failed, continue with original results
                      }
                    }
                  }
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

          succeeded = true;
          break;
        }

        // --- Stream analysis ---
        let llmChartConfig: import('./types').ChartConfig | undefined;

        if (currentResults && currentResults.rowCount > 0) {
          try {
            const analysisStream = await analyzeResults(
              question,
              currentSQL,
              currentResults
            );
            const reader = analysisStream.getReader();
            const decoder = new TextDecoder();
            let fullAnalysis = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const delta = decoder.decode(value, { stream: true });
              fullAnalysis += delta;
              emit(controller, { type: 'analysis_chunk', delta });
            }

            // Parse chart config from the completed analysis text
            const { chartConfig } = parseChartConfigFromAnalysis(fullAnalysis);
            if (chartConfig) {
              llmChartConfig = chartConfig;
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
        emit(controller, {
          type: 'error',
          content: `Agent loop failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      } finally {
        controller.close();
      }
    },
  });
}
