# Lakehouse Analytics

An analytics app for interactive data exploration. Ask questions in natural language, get SQL generated and executed against Trino, then receive AI-powered analysis with charts.

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

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- An Anthropic API key (direct or via LLM gateway)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/vivalkm/agentic_analytics_app.git
   cd agentic_analytics_app
   ```

2. Create your environment file:
   ```bash
   cp .env.local.example .env.local
   ```

3. Edit `.env.local` and add your Anthropic API key:
   ```env
   ANTHROPIC_API_KEY=your-api-key
   ```
   All other settings (Trino, Statsig, GitHub) are pre-configured with defaults.

4. Start the app:
   ```bash
   docker compose up --build
   ```

5. Open [http://localhost:3000](http://localhost:3000)

On subsequent runs, just `docker compose up` (no `--build` needed unless code changes).

To stop: `docker compose down`

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
