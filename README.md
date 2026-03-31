# Lakehouse Analytics

An analytics notebook for interactive data exploration. Ask questions in natural language, get SQL generated and executed against Trino, then receive AI-powered analysis with charts.

## How It Works

1. **Ask a question** — Type a natural language question about your data
2. **Agent explores** — An LLM agent autonomously explores schemas, runs sample queries, and examines data (up to 20 tool calls)
3. **SQL generation** — The agent writes production-quality SQL using metric definitions, query library references, and schema metadata
4. **Execution** — The query runs against Trino via a persistent Python connection with OAuth2 auth
5. **Analysis** — The LLM analyzes results and produces a markdown summary with auto-detected charts
6. **Iterate** — Ask follow-up questions, edit the SQL directly, or re-run queries

## Features

- **Agentic SQL generation** — LLM autonomously explores data before writing SQL, with streaming thinking output
- **Multi-source context**: Statsig metric catalog, local query library, shared GitHub queries, schema metadata
- **Automatic SQL validation**: Read-only enforcement, join fan-out detection, business logic review
- **Interactive charts**: Bar, line, and pie charts auto-detected from results
- **Sidebar tools**: Schema explorer, query library browser, metrics catalog with Statsig links
- **Export**: CSV download, analysis export (PDF/HTML)
- **File attachments**: Upload CSV/text files as context for questions
- **Dark mode** with oklch color themes
- **Session persistence** via localStorage
- **Stop button** to abort in-progress analysis

## Getting Started

### Prerequisites

- Node.js 22+
- Python 3.10+
- An Anthropic API key (direct or via LLM gateway)

### Quick Setup

```bash
git clone https://github.com/vivalkm/agentic_analytics_app.git
cd agentic_analytics_app/lakehouse-analytics
bash scripts/setup.sh
```

The setup script installs Node dependencies, creates a Python venv with the `trino` package, and copies `.env.local.example` to `.env.local`.

### Manual Setup

1. Install Node dependencies:
   ```bash
   npm install
   ```

2. Set up Python environment (for Trino connectivity):
   ```bash
   uv venv .venv && uv pip install trino --python .venv/bin/python
   # or without uv:
   python3 -m venv .venv && .venv/bin/pip install trino
   ```

3. Create your environment file:
   ```bash
   cp .env.local.example .env.local
   ```

4. Edit `.env.local` and add your Anthropic API key:
   ```env
   ANTHROPIC_API_KEY=your-api-key
   ```

5. Start the dev server:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (via LLM gateway) |
| `ANTHROPIC_BASE_URL` | Yes | LLM gateway URL |
| `ANTHROPIC_MODEL` | No | Model ID override |
| `TRINO_HOST` | No | Trino coordinator URL |
| `TRINO_PORT` | No | Trino port (default: `443`) |
| `TRINO_CATALOG` | No | Catalog to query (default: `lakehouse`) |
| `TRINO_PRIORITY_SCHEMAS` | No | Comma-separated schemas loaded first |
| `TRINO_PRIORITY_TABLES` | No | Comma-separated FQNs with highest relevance boost |
| `STATSIG_CONSOLE_API_KEY` | No | Statsig Console API key for metric sync |
| `QUERY_LIBRARY_REPO` | No | GitHub URL for shared query library |
| `GITHUB_TOKEN` | No | GitHub token for private repo access |

## Project Structure

```
app/
  page.tsx                    # Main notebook UI (single-page app)
  api/
    agent/route.ts            # Main endpoint — streams NDJSON agent events
    execute/route.ts          # Direct SQL execution (manual re-runs)
    metadata/route.ts         # Schema introspection cache
    metrics/route.ts          # Statsig metric catalog
    library/route.ts          # Query library listing
    analyze/route.ts          # Standalone analysis
    export/route.ts           # CSV download
    settings/route.ts         # App settings
lib/
  agent-loop-v2.ts            # Core orchestrator — agentic tool-use loop
  agent-tools.ts              # 5 tool definitions + execution handlers
  anthropic.ts                # LLM calls, system prompts, analysis, streaming
  trino.ts                    # Persistent Trino connection via Python subprocess
  metadata.ts                 # Schema metadata cache (globalThis + disk)
  statsig.ts                  # Statsig Console API client
  metric-catalog.ts           # Metric catalog cache + matching
  github-queries.ts           # GitHub query library cache + matching
  query-matcher.ts            # Local query library matching (lazy SQL loading)
  sql-validator.ts            # Read-only SQL enforcement (regex + AST)
  chart-detector.ts           # Heuristic chart type detection
  session.ts                  # Client-side session persistence
  env-config.ts               # Runtime env var management + settings UI
components/
  chat-input.tsx              # Question input with file attachments
  sql-editor.tsx              # Syntax-highlighted SQL display/editor
  analysis-card.tsx           # Streaming markdown analysis renderer
  chart-renderer.tsx          # Recharts visualization (bar/line/pie)
  thinking-step.tsx           # Collapsible agent thinking process
  schema-explorer.tsx         # Sidebar schema browser
  query-library.tsx           # Sidebar query library
  metrics-catalog.tsx         # Sidebar metrics catalog
  export-analysis.tsx         # PDF/HTML export
  settings-dialog.tsx         # Settings UI
scripts/
  setup.sh                    # One-command project setup
  trino-query.py              # Persistent Trino NDJSON server (OAuth2)
query-library/                # Local .sql files with metadata headers
domain-context.md             # Business terminology for LLM prompts
```

## Reference Priority

When generating SQL, the LLM uses context in this priority order:

1. **Metric catalog** (Statsig) — Authoritative metric definitions with aggregation formulas
2. **Local query library** — Vetted production SQL in `query-library/`
3. **Shared GitHub queries** — Team-shared SQL from configured GitHub repo
4. **Schema metadata** — Table and column definitions from Trino introspection

## Tech Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui · Recharts · Anthropic SDK · node-sql-parser · trino (Python)
