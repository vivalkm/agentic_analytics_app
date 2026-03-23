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
  type: 'question' | 'sql' | 'results' | 'analysis' | 'error' | 'thinking';
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
  title?: string;
}

export interface QueryLibraryEntry {
  filename: string;
  description: string;
  sql: string;
  tags: string[];
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
  | { type: 'done'; iterations: number; finalIteration: number }
  | { type: 'error'; content: string; iteration?: number };

export interface ValidationResult {
  valid: boolean;
  reason: string;
  suggestion?: string;
}
