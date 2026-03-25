'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Database,
  Folder,
  FolderOpen,
  Table2,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Check,
  Search,
  Loader2,
  Columns3,
} from 'lucide-react';

interface ColumnInfo {
  name: string;
  type: string;
  comment?: string;
}

interface TableInfo {
  catalog: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  comment?: string;
}

interface MetadataResponse {
  tree: Record<string, Record<string, string[]>>;
  tables: TableInfo[];
  prioritySchemas: string[];
  lastRefreshed: string | null;
  isRefreshing: boolean;
  tableCount: number;
}

interface SchemaExplorerProps {
  onInsertTable: (fqn: string) => void;
  /** Increment to trigger a refetch (e.g. after metadata loads) */
  refreshKey?: number;
}

function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SchemaExplorer({ onInsertTable, refreshKey }: SchemaExplorerProps) {
  const [data, setData] = useState<MetadataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [copiedFqn, setCopiedFqn] = useState<string | null>(null);
  const fetchInFlight = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMetadata = useCallback(async () => {
    if (fetchInFlight.current) return null;
    fetchInFlight.current = true;
    try {
      const res = await fetch('/api/metadata');
      if (res.ok) {
        const json: MetadataResponse = await res.json();
        setData(json);
        if (!json.isRefreshing) setRefreshing(false);
        return json;
      }
    } catch {
      // silently fail
    } finally {
      fetchInFlight.current = false;
    }
    return null;
  }, []);

  // Polling: when isRefreshing is true, poll every 2s for progressive updates
  useEffect(() => {
    if (data?.isRefreshing) {
      // Start polling
      if (!pollTimer.current) {
        pollTimer.current = setInterval(() => {
          fetchMetadata();
        }, 2000);
      }
    } else {
      // Stop polling
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }

    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [data?.isRefreshing, fetchMetadata]);

  // Initial fetch
  useEffect(() => {
    fetchMetadata().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when refreshKey changes (metadata loaded by agent loop)
  const prevRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== prevRefreshKey.current) {
      prevRefreshKey.current = refreshKey;
      fetchMetadata();
    }
  }, [refreshKey, fetchMetadata]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorityOnly: true }),
      });
      await fetchMetadata();
    } catch {
      // silently fail
    }
    // Don't setRefreshing(false) here — polling will clear it when isRefreshing goes false
  };

  const columnMap = useMemo(() => {
    const map = new Map<string, ColumnInfo[]>();
    for (const t of data?.tables ?? []) {
      map.set(`${t.catalog}.${t.schema}.${t.table}`, t.columns);
    }
    return map;
  }, [data?.tables]);

  const prioritySet = useMemo(
    () => new Set((data?.prioritySchemas ?? []).map((s) => s.toLowerCase())),
    [data?.prioritySchemas]
  );

  const filteredTree = useMemo(() => {
    if (!data?.tree) return {};
    if (!search.trim()) return data.tree;

    const q = search.toLowerCase();
    const result: Record<string, Record<string, string[]>> = {};
    for (const [catalog, schemas] of Object.entries(data.tree)) {
      for (const [schema, tables] of Object.entries(schemas)) {
        const filtered = tables.filter(
          (t) => t.toLowerCase().includes(q) || schema.toLowerCase().includes(q)
        );
        // Also show the schema if the schema name matches, even with no table matches
        if (filtered.length > 0 || schema.toLowerCase().includes(q)) {
          if (!result[catalog]) result[catalog] = {};
          result[catalog][schema] = filtered;
        }
      }
    }
    return result;
  }, [data?.tree, search]);

  const handleTableClick = useCallback(
    (fqn: string) => {
      navigator.clipboard.writeText(fqn).catch(() => {});
      onInsertTable(fqn);
      setCopiedFqn(fqn);
      setTimeout(() => setCopiedFqn(null), 1500);
    },
    [onInsertTable]
  );

  const isFiltered = search.trim().length > 0;
  const catalogEntries = Object.entries(filteredTree);

  if (loading) {
    return (
      <div className="p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading schema...
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-6 rounded bg-sidebar-accent/30 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      {/* Stats + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-sidebar-foreground">Schema</span>
          <Badge variant="secondary" className="text-xs px-1.5 py-0">
            {data?.tableCount ?? 0} tables
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh schema"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Last refreshed */}
      {data?.lastRefreshed && (
        <p className="text-xs text-muted-foreground/70">
          {data.isRefreshing ? (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Syncing... {data.tableCount} tables loaded
            </span>
          ) : (
            <>Synced with Trino at {new Date(data.lastRefreshed).toLocaleDateString()} {new Date(data.lastRefreshed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
          )}
        </p>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
          placeholder="Filter tables..."
          className="h-7 pl-7 text-xs"
        />
      </div>

      {/* Tree */}
      {catalogEntries.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          {data?.tableCount === 0 ? 'No tables found. Click refresh.' : 'No matches.'}
        </div>
      ) : (
        <div className="space-y-0.5">
          {catalogEntries.map(([catalog, schemas]) => (
            <CatalogNode
              key={catalog}
              catalog={catalog}
              schemas={schemas}
              columnMap={columnMap}
              copiedFqn={copiedFqn}
              onTableClick={handleTableClick}
              forceOpen={isFiltered}
              defaultOpen={catalogEntries.length === 1}
              prioritySchemas={prioritySet}
              isRefreshing={data?.isRefreshing ?? false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogNode({
  catalog,
  schemas,
  columnMap,
  copiedFqn,
  onTableClick,
  forceOpen,
  defaultOpen,
  prioritySchemas,
  isRefreshing,
}: {
  catalog: string;
  schemas: Record<string, string[]>;
  columnMap: Map<string, ColumnInfo[]>;
  copiedFqn: string | null;
  onTableClick: (fqn: string) => void;
  forceOpen: boolean;
  defaultOpen: boolean;
  prioritySchemas: Set<string>;
  isRefreshing: boolean;
}) {
  const schemaEntries = Object.entries(schemas);
  const controlled = forceOpen ? { open: true } : {};

  return (
    <Collapsible.Root defaultOpen={defaultOpen} {...controlled}>
      <Collapsible.Trigger className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm font-medium hover:bg-sidebar-accent group">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[open]:rotate-90" />
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate">{catalog}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="pl-3">
        {schemaEntries.map(([schema, tables]) => (
          <SchemaNode
            key={schema}
            catalog={catalog}
            schema={schema}
            tables={tables}
            columnMap={columnMap}
            copiedFqn={copiedFqn}
            onTableClick={onTableClick}
            forceOpen={forceOpen}
            isPriority={prioritySchemas.has(schema.toLowerCase())}
            isRefreshing={isRefreshing}
          />
        ))}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function SchemaNode({
  catalog,
  schema,
  tables,
  columnMap,
  copiedFqn,
  onTableClick,
  forceOpen,
  isPriority,
  isRefreshing,
}: {
  catalog: string;
  schema: string;
  tables: string[];
  columnMap: Map<string, ColumnInfo[]>;
  copiedFqn: string | null;
  onTableClick: (fqn: string) => void;
  forceOpen: boolean;
  isPriority: boolean;
  isRefreshing: boolean;
}) {
  const controlled = forceOpen ? { open: true } : {};
  const isEmpty = tables.length === 0;

  return (
    <Collapsible.Root defaultOpen={isPriority} {...controlled}>
      <Collapsible.Trigger className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm hover:bg-sidebar-accent group">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[open]:rotate-90" />
        <Folder className="h-3.5 w-3.5 text-muted-foreground group-data-[open]:hidden" />
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground hidden group-data-[open]:block" />
        <span className="truncate">{schema}</span>
        <span className="ml-auto flex items-center gap-1">
          {isEmpty && isRefreshing ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : (
            <Badge variant="secondary" className="text-xs px-1 py-0">
              {tables.length}
            </Badge>
          )}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="pl-3">
        {isEmpty && isRefreshing ? (
          <div className="px-1.5 py-1 text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading tables...
          </div>
        ) : isEmpty ? (
          <div className="px-1.5 py-1 text-xs text-muted-foreground">
            No tables
          </div>
        ) : (
          tables.map((table) => {
            const fqn = `${catalog}.${schema}.${table}`;
            return (
              <TableNode
                key={table}
                fqn={fqn}
                table={table}
                columns={columnMap.get(fqn) || []}
                isCopied={copiedFqn === fqn}
                onTableClick={onTableClick}
                forceOpen={forceOpen}
              />
            );
          })
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function TableNode({
  fqn,
  table,
  columns,
  isCopied,
  onTableClick,
  forceOpen,
}: {
  fqn: string;
  table: string;
  columns: ColumnInfo[];
  isCopied: boolean;
  onTableClick: (fqn: string) => void;
  forceOpen: boolean;
}) {
  const controlled = forceOpen ? { open: true } : {};

  return (
    <Collapsible.Root {...controlled}>
      <div className="flex items-center gap-0.5">
        <Collapsible.Trigger className="flex items-center p-1 rounded hover:bg-sidebar-accent group">
          <ChevronRight className="h-2.5 w-2.5 text-muted-foreground transition-transform group-data-[open]:rotate-90" />
        </Collapsible.Trigger>
        <button
          onClick={() => onTableClick(fqn)}
          className="flex flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-sidebar-accent truncate"
          title={fqn}
        >
          <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{table}</span>
          {isCopied && <Check className="h-3.5 w-3.5 shrink-0 text-green-400" />}
        </button>
      </div>
      <Collapsible.Panel className="pl-6">
        {columns.map((col) => (
          <div
            key={col.name}
            className="flex items-center justify-between gap-2 px-1.5 py-0.5 text-sm"
            title={col.comment || undefined}
          >
            <span className="truncate text-sidebar-foreground/80">
              <Columns3 className="mr-1 inline h-3 w-3 text-muted-foreground" />
              {col.name}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {col.type}
            </span>
          </div>
        ))}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
