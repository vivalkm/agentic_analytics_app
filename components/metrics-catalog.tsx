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
  Calculator,
  Filter,
  ExternalLink,
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

/** Base URL including project ID, e.g. https://console.statsig.com/6cg6VdWIzlGm38eE3ePry2 */
const STATSIG_CONSOLE_BASE = process.env.NEXT_PUBLIC_STATSIG_CONSOLE_URL || 'https://console.statsig.com';

function getStatsigUrl(metricName: string): string {
  return `${STATSIG_CONSOLE_BASE}/metrics/metrics_catalog/${encodeURIComponent(metricName)}/user_warehouse/setup?unitType=user_id`;
}

export function MetricsCatalog() {
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

  // Only show derived metrics — sources duplicate info already in the catalog
  const derivedMetrics = useMemo(() => metrics.filter((m) => m.kind === 'derived'), [metrics]);

  const filtered = useMemo(() => {
    if (!search.trim()) return derivedMetrics;
    const q = search.toLowerCase();
    return derivedMetrics.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.sourceName.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [derivedMetrics, search]);

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
            {derivedMetrics.length}
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
          Synced with Statsig at {new Date(lastSynced).toLocaleDateString()} {new Date(lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {/* Search */}
      {derivedMetrics.length > 0 && (
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
      {derivedMetrics.length === 0 ? (
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
              onTagClick={(tag) => setSearch(tag)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Build a human-readable definition string for a metric. */
function formatMetricDefinition(metric: MetricEntry): string | null {
  if (!metric.aggregation && !metric.valueColumn) return null;
  const agg = (metric.aggregation || 'count').toUpperCase();
  const col = metric.valueColumn || '*';
  return `${agg}(${col})`;
}

/** Format criteria as human-readable filter conditions. */
function formatCriteria(
  criteria: Array<{ type: string; column: string; condition: string; values: string[] }>
): string[] {
  return criteria.map((c) => {
    const vals = c.values.length === 1 ? c.values[0] : c.values.join(', ');
    return `${c.column} ${c.condition} ${vals}`;
  });
}

function MetricCard({
  metric,
  onTagClick,
}: {
  metric: MetricEntry;
  onTagClick: (tag: string) => void;
}) {
  const definition = formatMetricDefinition(metric);
  const filters = metric.criteria && metric.criteria.length > 0
    ? formatCriteria(metric.criteria)
    : [];

  return (
    <div className="rounded-lg border border-sidebar-border p-2.5 space-y-1.5">
      <a
        href={getStatsigUrl(metric.name)}
        target="_blank"
        rel="noopener noreferrer"
        title={`View ${metric.name} in Statsig`}
        className="block w-full"
      >
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium leading-snug text-sidebar-foreground hover:text-primary transition-colors truncate">
            {metric.name}
          </p>
          <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        </div>
      </a>

      {metric.description && (
        <p className="text-sm text-muted-foreground leading-snug line-clamp-2">
          {metric.description}
        </p>
      )}

      {/* Metric definition: aggregation + column + source + filters */}
      {(definition || metric.sourceName) && (
        <div className="space-y-1">
          <div className="flex items-start gap-1.5 text-xs">
            <Calculator className="mt-0.5 h-3 w-3 shrink-0 text-blue-400" />
            <div className="space-y-0.5">
              {definition && (
                <code className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-400 font-mono">
                  {definition}
                </code>
              )}
              {metric.sourceName && (
                <p className="text-muted-foreground/80">
                  from <span className="font-medium text-muted-foreground">{metric.sourceName}</span>
                </p>
              )}
            </div>
          </div>
          {filters.length > 0 && (
            <div className="flex items-start gap-1.5 text-xs">
              <Filter className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
              <div className="space-y-0.5">
                {filters.map((f, i) => (
                  <p key={i} className="text-muted-foreground/80">
                    <code className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-400 font-mono">{f}</code>
                  </p>
                ))}
              </div>
            </div>
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
            <span>Source SQL</span>
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
