export interface TableMetadata {
  catalog: string;
  schema: string;
  table: string;
  columns: ColumnMetadata[];
  comment?: string;
  lastRefreshed: string;
}

export interface ColumnMetadata {
  name: string;
  type: string;
  comment?: string;
}

export interface NotebookCell {
  id: string;
  type: 'question' | 'sql' | 'results' | 'analysis' | 'error' | 'thinking' | 'clarification' | 'needs_metadata';
  content: string;
  timestamp: number;
  metadata?: {
    sql?: string;
    question?: string;
    results?: QueryResult;
    analysis?: string;
    chartConfig?: ChartConfig;
    error?: string;
    assumptions?: string;
    agentRunId?: string;
    iteration?: number;
    collapsed?: boolean;
    isIntermediate?: boolean;
    validationResult?: { valid: boolean; reason: string; suggestion?: string };
  };
}

export interface QueryResult {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
}

export interface ChartConfig {
  type: 'bar' | 'line' | 'pie' | 'none';
  xKey: string;
  yKeys: string[];
  /** Secondary categorical column used to group/color bars (e.g. region, month) */
  groupKey?: string;
  title?: string;
}

export interface QueryLibraryEntry {
  filename: string;
  description: string;
  sql: string;
  tags: string[];
}

export interface MetricEntry {
  id: string;
  name: string;
  description: string;
  sql: string;
  sourceName: string;
  tags: string[];
  /** 'source' = metric source (base table/query), 'derived' = derived metric from catalog */
  kind: 'source' | 'derived';
  /** Aggregation type for derived metrics (e.g. "sum", "daily_participation") */
  aggregation?: string;
  /** Value column for derived metrics */
  valueColumn?: string;
  /** Filter criteria for derived metrics (e.g. [{ type: "column", column: "status", condition: "is", values: ["completed"] }]) */
  criteria?: Array<{ type: string; column: string; condition: string; values: string[] }>;
  /** Metric type from Statsig (e.g. "composite", "warehouse_native") */
  metricType?: string;
}

export interface MetricCatalogCache {
  metrics: MetricEntry[];
  lastSynced: string;
}

export interface Attachment {
  /** Original filename */
  name: string;
  /** MIME type: image/png, image/jpeg, application/pdf, text/csv, text/plain */
  mediaType: string;
  /** Base64-encoded data for images/PDFs, or raw text content for CSV/TXT */
  data: string;
}

export interface MetadataCache {
  catalogs: string[];
  schemas: Record<string, string[]>;
  tables: TableMetadata[];
  lastRefreshed: string;
}

// Agent loop NDJSON events
export type AgentEvent =
  | { type: 'thinking'; iteration: number; content: string }
  | { type: 'sql_start'; iteration: number }
  | { type: 'sql_chunk'; delta: string }
  | { type: 'sql'; iteration: number; sql: string; explanation: string }
  | { type: 'execution'; iteration: number; rowCount: number; columns: string[]; columnTypes: string[]; rows: Record<string, unknown>[]; executionTimeMs: number }
  | { type: 'validation'; iteration: number; valid: boolean; reason: string; suggestion?: string }
  | { type: 'analysis_chunk'; delta: string }
  | { type: 'done'; iterations: number; finalIteration: number; chartConfig?: ChartConfig }
  | { type: 'error'; content: string; iteration?: number }
  | { type: 'clarification'; content: string }
  | { type: 'needs_metadata'; content: string; question: string }
  | { type: 'metadata_ready'; tableCount: number }
  | { type: 'progress'; content: string };

export interface ValidationResult {
  valid: boolean;
  reason: string;
  suggestion?: string;
}

export interface ConversationTurn {
  question: string;
  sql?: string;
  resultSummary?: string;
  analysis?: string;
}
