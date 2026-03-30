# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```bash
npm run dev      # Start dev server (Turbopack, port 3000)
npm run build    # Production build
npm run start    # Start production server
npm run lint     # ESLint (next/core-web-vitals + next/typescript)
```

No test framework is configured.

## Architecture

Hex-like notebook app: natural language question → exploratory tool-use agent → Trino SQL → LLM analysis + charts.

### Data Flow

1. **User submits question** → `app/page.tsx` POSTs to `/api/agent` with `{ question, history, attachments }`
2. **API route** (`app/api/agent/route.ts`) validates input, calls `runAgentLoopV2()` which returns a `ReadableStream` of NDJSON `AgentEvent` objects
3. **Agent loop** (`lib/agent-loop-v2.ts`) runs in 4 phases:

**Phase 0 — Load Context** (non-blocking, priority schemas block first run only):
- Metadata cache (`lib/metadata.ts`) — two-tier: `globalThis` + `.cache/metadata.json`
- Query library (`lib/query-matcher.ts`) — local SQL files from `query-library/`
- Metric catalog (`lib/metric-catalog.ts`) — synced from Statsig Console API
- GitHub queries (`lib/github-queries.ts`) — shared SQL from remote repo
- Keyword-scores all context against the question to find relevant tables, metrics, queries

**Phase 1 — Build System Prompt** (`lib/anthropic.ts` → `getExploratorySystemPrompt()`):
- Domain rules, Trino SQL conventions, date handling, core remittance filters
- Matched context in priority order: Statsig metrics > query library > GitHub queries > schema metadata
- Business rules from `domain-context.md`

**Phase 2 — Agentic Tool Loop** (max 20 tool calls):
- The LLM autonomously decides what to explore using Anthropic's tool-use API
- Streams thinking text + tool calls/results as NDJSON events in real-time
- 5 tools defined in `lib/agent-tools.ts`:
  - `describe_table` — column metadata (cache-first, falls back to Trino MCP)
  - `list_tables` — schema discovery (cache-first)
  - `run_exploratory_query` — small SQL for data exploration (auto LIMIT 100, results capped at 20 rows)
  - `submit_final_query` — production-quality answer SQL (exits loop)
  - `ask_clarification` — ask user a follow-up (exits loop)
- All queries validated read-only via `lib/sql-validator.ts` (regex + AST)
- All queries executed via `lib/trino-mcp.ts` (MCP subprocess, JSON-RPC over stdio)

**Phase 3 — Analysis** (streamed):
- `analyzeResults()` sends question + SQL + results to Claude for markdown analysis
- LLM includes a `chart` config block (bar/line/pie/none) at the end
- `parseChartConfigFromAnalysis()` extracts it; falls back to `detectChartType()` heuristic if invalid

4. **Client processes stream** → `app/page.tsx` reads NDJSON line-by-line, maps events to notebook cells:
   - `thinking` → collapsible ThinkingStep cell (agent reasoning)
   - `tool_call`/`tool_result` → thinking cell with tool description + result summary
   - `sql` → SQLEditor cell (syntax-highlighted, re-runnable)
   - `execution` → results cell (data table + chart)
   - `analysis_chunk` → AnalysisCard cell (streaming markdown)
   - `done` → applies chart config, collapses thinking steps

### Reference Priority for SQL Generation

When the LLM generates SQL, context is provided in this order:
1. Statsig metric catalog (authoritative metric definitions)
2. Local query library (`query-library/*.sql`)
3. GitHub shared queries (`QUERY_LIBRARY_REPO`)
4. Schema metadata (build from scratch)

### Key Modules

| Module | Purpose |
|---|---|
| `lib/agent-loop-v2.ts` | Core orchestrator — agentic tool-use loop |
| `lib/agent-tools.ts` | 5 tool definitions + execution handlers |
| `lib/anthropic.ts` | LLM calls, system prompts, analysis, streaming |
| `lib/trino-mcp.ts` | MCP subprocess client, SQL execution, metadata tools |
| `lib/metadata.ts` | Schema introspection with two-tier cache (`globalThis` + disk) |
| `lib/sql-validator.ts` | Read-only SQL enforcement (regex + AST via node-sql-parser) |
| `lib/statsig.ts` | Statsig Console API client |
| `lib/metric-catalog.ts` | Metric catalog cache + keyword matching |
| `lib/github-queries.ts` | GitHub repo query library cache + matching |
| `lib/query-matcher.ts` | Local query library matching (lazy SQL loading) |
| `lib/chart-detector.ts` | Heuristic chart type detection (fallback) |
| `lib/session.ts` | Client-side session persistence (localStorage) |
| `domain-context.md` | Business terminology and default filters for prompts |

### API Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/agent` | POST | Main entry — NDJSON stream of AgentEvents |
| `/api/metadata` | GET/POST | Schema tree + refresh trigger |
| `/api/execute` | POST | Direct SQL execution (manual re-runs) |
| `/api/library` | GET | Query library listing |
| `/api/metrics` | GET | Metric catalog listing |
| `/api/analyze` | POST | Standalone analysis |
| `/api/export` | GET | CSV download |
| `/api/settings` | GET/PUT | App settings |

## Important Patterns

**HMR-safe caching**: All server-side caches (metadata, metrics, github-queries) use `globalThis` + disk `.cache/*.json`. On startup: load from disk → store in globalThis. On refresh: update globalThis → write to disk.

**Streaming**: Agent loop streams NDJSON events via `ReadableStream`. The agentic tool loop streams LLM thinking text token-by-token. Analysis streams markdown chunks. Client reads with `response.body.getReader()`.

**Tool-use pattern**: The LLM receives tool definitions as JSON schemas, returns `tool_use` content blocks, the loop executes tools and returns `tool_result` blocks. Loop continues until `submit_final_query` succeeds or max 20 tool calls reached.

**Query library convention**: SQL files in `query-library/` use a header block: `-- description` marker, multi-line description, optional `-- tags: ...`, separator `-- ------------`.

**Trino MCP**: Spawns `uvx --from git+https://github.com/Remitly/toolbox.git#subdirectory=trino trino-mcp` as a child process. Singleton client, 300s timeout per tool call. SHOW/DESCRIBE statements route to dedicated MCP metadata tools to avoid LIMIT-appending issues.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (via LLM gateway) |
| `ANTHROPIC_BASE_URL` | Yes | LLM gateway URL |
| `ANTHROPIC_MODEL` | No | Model ID override |
| `TRINO_ENVIRONMENT` | No | `prod` or `preprod` (default: `prod`) |
| `TRINO_DEFAULT_CATALOG` | No | Catalog to introspect (default: `lakehouse`) |
| `TRINO_PRIORITY_SCHEMAS` | No | Comma-separated schemas loaded first |
| `TRINO_PRIORITY_TABLES` | No | Comma-separated FQNs with highest relevance boost |
| `STATSIG_CONSOLE_API_KEY` | No | Statsig Console API key for metric sync |
| `QUERY_LIBRARY_REPO` | No | GitHub URL for shared query library |
| `GITHUB_TOKEN` / `GH_TOKEN` | No | GitHub token for private repo access |

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS v4 (oklch tokens), shadcn/ui (base-nova), Recharts, Anthropic SDK, node-sql-parser (Trino dialect), next-themes.

## Next.js 16 Warning

This uses Next.js 16 which has breaking changes from earlier versions. Read docs in `node_modules/next/dist/docs/` before writing code. Heed deprecation notices.
