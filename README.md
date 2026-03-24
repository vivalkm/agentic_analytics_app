# Lakehouse Analytics

A analytics app for interactive data exploration. Ask questions in natural language, get SQL generated and executed against Trino, then receive AI-powered analysis with charts.

## How It Works

1. **Ask a question** — Type a natural language question about your data
2. **SQL generation** — An LLM generates SQL using metric definitions, query library references, and schema metadata
3. **Execution** — The query runs against Trino via an MCP subprocess
4. **Analysis** — The LLM analyzes results and produces a markdown summary with charts
5. **Iterate** — Ask follow-up questions or edit the SQL directly

The agent loop retries up to 3 times, automatically fixing SQL errors and validating results.

## Features

- **Natural language to SQL** with streaming token output
- **Multi-source context**: Statsig metric catalog, local query library, shared GitHub queries, schema metadata
- **Automatic SQL validation**: Read-only enforcement, join fan-out detection, business logic review
- **Interactive charts**: Bar, line, and pie charts auto-detected from results
- **Sidebar tools**: Schema explorer, query library browser, metrics catalog with Statsig links
- **Dark mode** with oklch color themes
- **Session persistence** via localStorage
- **CSV export** for query results

## Getting Started

### Prerequisites

- Node.js 18+
- Access to a Trino cluster via [trino-mcp](https://github.com/Remitly/toolbox/tree/main/trino)
- Anthropic API key (direct or via LLM gateway)

### Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Create `.env.local` with your configuration:
   ```env
   # Required
   ANTHROPIC_API_KEY=your-api-key
   ANTHROPIC_BASE_URL=https://api.anthropic.com

   # Trino configuration
   TRINO_ENVIRONMENT=prod
   TRINO_DEFAULT_CATALOG=lakehouse
   TRINO_PRIORITY_SCHEMAS=fpa

   # Optional: Statsig metric catalog
   STATSIG_CONSOLE_API_KEY=your-statsig-key
   STATSIG_METRIC_TEAMS=squad-FPA,squad-INTA

   # Optional: Shared query library from GitHub
   QUERY_LIBRARY_REPO=https://github.com/org/repo/tree/main/path/to/sql
   GITHUB_TOKEN=your-github-token
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
app/
  page.tsx                  # Main notebook UI (single-page app)
  api/
    agent/route.ts          # Main endpoint — streams NDJSON agent events
    execute/route.ts        # Direct SQL execution
    metadata/route.ts       # Schema introspection cache
    metrics/route.ts        # Statsig metric catalog
    library/route.ts        # Query library listing
lib/
  agent-loop.ts             # Core orchestrator
  anthropic.ts              # LLM calls and system prompts
  trino-mcp.ts              # Trino MCP subprocess client
  metadata.ts               # Schema metadata cache
  statsig.ts                # Statsig Console API client
  metric-catalog.ts         # Metric catalog cache + matching
  github-queries.ts         # GitHub query library
  query-matcher.ts          # Local query library matching
  sql-validator.ts          # Read-only SQL enforcement
components/
  chat-input.tsx            # Question input
  sql-editor.tsx            # SQL display/editor
  analysis-card.tsx         # Markdown analysis renderer
  chart-renderer.tsx        # Recharts visualization
  schema-explorer.tsx       # Sidebar schema browser
  query-library.tsx         # Sidebar query library
  metrics-catalog.tsx       # Sidebar metrics catalog
query-library/              # Local .sql files with metadata headers
domain-context.md           # Business terminology for LLM prompts
```

## Reference Priority

When generating SQL, the LLM uses context in this priority order:

1. **Metric catalog** (Statsig) — Authoritative metric definitions with aggregation formulas
2. **Local query library** — Vetted production SQL in `query-library/`
3. **Shared GitHub queries** — Team-shared SQL from configured GitHub repo
4. **Schema metadata** — Table and column definitions from Trino introspection

## Tech Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Recharts · Anthropic SDK · node-sql-parser
