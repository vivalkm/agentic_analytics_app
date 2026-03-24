'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  BarChart3,
  ChevronRight,
  Code2,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface MetricEntry {
  id: string;
  name: string;
  description: string;
  sql: string;
  sourceName: string;
  tags: string[];
  kind: 'source' | 'derived';
  aggregation?: string;
  valueColumn?: string;
  criteria?: Array<{ type: string; column: string; condition: string; values: string[] }>;
  metricType?: string;
}

interface MetricsCatalogProps {
  onInsertMetric: (question: string) => void;
}

export function MetricsCatalog({ onInsertMetric }: MetricsCatalogProps) {
  const [metrics, setMetrics] = useState<MetricEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fetched = useRef(false);

  const fetchMetrics = () => {
    fetch('/api/metrics')
      .then((res) => res.json())
      .then((data) => {
        setMetrics(data.metrics || []);
        setLastSynced(data.lastSynced || null);
        setSyncing(data.isSyncing || false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetchMetrics();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/metrics', { method: 'POST' });
      const data = await res.json();
      setMetrics(data.metrics || []);
      setLastSynced(data.lastSynced || null);
    } catch {
      // ignore
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return metrics;
    const q = search.toLowerCase();
    return metrics.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.sourceName.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [metrics, search]);

  if (loading) {
    return (
      <div className="p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading metrics...
        </div>
        {[1, 2].map((i) => (
          <div key={i} className="h-16 rounded bg-sidebar-accent/30 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-sidebar-foreground">Metrics</span>
          <Badge variant="secondary" className="text-xs px-1.5 py-0">
            {metrics.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleSync}
          disabled={syncing}
          title="Sync from Statsig"
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Last synced */}
      {lastSynced && (
        <p className="text-xs text-muted-foreground/70">
          Synced {new Date(lastSynced).toLocaleDateString()} {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {/* Search */}
      {metrics.length > 0 && (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            placeholder="Filter metrics..."
            className="h-7 pl-7 text-xs"
          />
        </div>
      )}

      {/* Metric list */}
      {metrics.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center">
          <BarChart3 className="mb-2 h-8 w-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">
            No metrics synced yet.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {process.env.NEXT_PUBLIC_STATSIG_CONFIGURED
              ? 'Click the sync button to fetch metrics from Statsig.'
              : 'Set STATSIG_CONSOLE_API_KEY in .env.local to enable.'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 text-xs"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1 h-3 w-3" />
                Sync from Statsig
              </>
            )}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No matches for &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((metric, i) => (
            <MetricCard
              key={metric.id || `metric-${i}`}
              metric={metric}
              onAsk={() => onInsertMetric(`What is the ${metric.name}?`)}
              onTagClick={(tag) => setSearch(tag)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({
  metric,
  onAsk,
  onTagClick,
}: {
  metric: MetricEntry;
  onAsk: () => void;
  onTagClick: (tag: string) => void;
}) {
  return (
    <div className="rounded-lg border border-sidebar-border p-2.5 space-y-1.5">
      <button
        className="text-left w-full"
        onClick={onAsk}
        title={`Ask about ${metric.name}`}
      >
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium leading-snug text-sidebar-foreground hover:text-primary transition-colors truncate">
            {metric.name}
          </p>
          <span className={`shrink-0 rounded px-1 py-0 text-[11px] leading-tight ${metric.kind === 'derived' ? 'bg-purple-500/15 text-purple-400' : 'bg-zinc-500/15 text-zinc-400'}`}>
            {metric.kind === 'derived' ? 'metric' : 'source'}
          </span>
        </div>
      </button>

      {metric.description && (
        <p className="text-sm text-muted-foreground leading-snug line-clamp-2">
          {metric.description}
        </p>
      )}

      {metric.kind === 'derived' && (metric.aggregation || metric.sourceName) && (
        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground/80">
          {metric.aggregation && (
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-400">
              {metric.aggregation}
            </span>
          )}
          {metric.sourceName && (
            <span className="rounded bg-zinc-500/10 px-1.5 py-0.5">
              src: {metric.sourceName}
            </span>
          )}
        </div>
      )}

      {metric.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {metric.tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-xs px-1 py-0 cursor-pointer hover:bg-accent"
              onClick={() => onTagClick(tag)}
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {metric.sql && (
        <Collapsible.Root>
          <Collapsible.Trigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-sidebar-foreground group">
            <ChevronRight className="h-3 w-3 transition-transform group-data-[open]:rotate-90" />
            <Code2 className="h-3 w-3" />
            <span>Show SQL</span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-400 font-mono">
              <code>{metric.sql}</code>
            </pre>
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </div>
  );
}
