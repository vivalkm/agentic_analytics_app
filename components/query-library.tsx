'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  FileCode,
  Code2,
  ChevronRight,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface QueryEntry {
  filename: string;
  description: string;
  sql: string;
  tags: string[];
}

interface QueryLibraryProps {
  onUseQuery: (question: string) => void;
}

export function QueryLibrary({ onUseQuery }: QueryLibraryProps) {
  const [queries, setQueries] = useState<QueryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const fetched = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchLibrary = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/library', { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => setQueries(data.queries || []))
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
      })
      .finally(() => { setLoading(false); setSyncing(false); });
  };

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetchLibrary();
    return () => { abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSync = () => {
    setSyncing(true);
    fetchLibrary();
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return queries;
    const q = search.toLowerCase();
    return queries.filter(
      (entry) =>
        entry.description.toLowerCase().includes(q) ||
        entry.filename.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [queries, search]);

  if (loading) {
    return (
      <div className="p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading queries...
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
          <span className="text-sm font-medium text-sidebar-foreground">Query Library</span>
          <Badge variant="secondary" className="text-xs px-1.5 py-0">
            {queries.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleSync}
          disabled={syncing}
          title="Reload from disk"
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Search */}
      {queries.length > 0 && (
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            placeholder="Filter queries..."
            className="h-7 pl-7 text-xs"
          />
        </div>
      )}

      {/* Query list */}
      {queries.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-center">
          <FileCode className="mb-2 h-8 w-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">
            No saved queries.
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Add .sql files to the query-library/ directory.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No matches for &ldquo;{search}&rdquo;
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <QueryCard
              key={entry.filename}
              entry={entry}
              onUse={() => onUseQuery(entry.description)}
              onTagClick={(tag) => setSearch(tag)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QueryCard({
  entry,
  onUse,
  onTagClick,
}: {
  entry: QueryEntry;
  onUse: () => void;
  onTagClick: (tag: string) => void;
}) {
  return (
    <div className="rounded-lg border border-sidebar-border p-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <p className="text-sm font-medium leading-snug text-sidebar-foreground">
          {entry.description}
        </p>
      </div>

      {entry.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.tags.map((tag) => (
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

      <Collapsible.Root>
        <Collapsible.Trigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-sidebar-foreground group">
          <ChevronRight className="h-3 w-3 transition-transform group-data-[open]:rotate-90" />
          <Code2 className="h-3 w-3" />
          <span>Show SQL</span>
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <pre className="mt-1.5 rounded bg-zinc-950 p-2 text-xs font-mono text-zinc-400 overflow-x-auto max-h-[200px] overflow-y-auto leading-relaxed">
            {entry.sql.trim()}
          </pre>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}
