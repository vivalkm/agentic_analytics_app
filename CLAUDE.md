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

Hex-like notebook app: natural language question → LLM SQL generation → Trino execution → LLM analysis + charts.

**Data flow through the agent loop** (`lib/agent-loop.ts`):
1. **Context loading**: Loads metadata cache, query library, metric catalog, GitHub queries (non-blocking, priority schemas block first run only)
2. **Relevance matching**: Keyword-scores metrics, local queries, GitHub queries, and table schemas against the user question
3. **SQL generation** (streamed): `lib/anthropic.ts` builds a system prompt with domain context + matched references in priority order
4. **Validation**: Read-only enforcement (`lib/sql-validator.ts`), then LLM SQL review
5. **Execution**: `lib/trino-mcp.ts` runs SQL via MCP subprocess (JSON-RPC over stdio)
6. **Result validation**: Date completeness check + LLM result review
7. **Retry loop**: Up to 3 iterations with `fixSQL()` / `generateRevisedSQL()`
8. **Analysis** (streamed): Markdown analysis with chart config parsed from output

**API routes** (`app/api/*/route.ts`) are thin wrappers. The main endpoint `POST /api/agent` returns an NDJSON stream of `AgentEvent` objects. The client (`app/page.tsx`) reads line-by-line.

### Reference Priority for SQL Generation

When the LLM generates SQL, context is provided in this order:
1. Statsig metric catalog (authoritative metric definitions)
2. Local query library (`query-library/*.sql`)
3. GitHub shared queries (`QUERY_LIBRARY_REPO`)
4. Schema metadata (build from scratch)

### Key Modules

| Module | Purpose |
|---|---|
| `lib/agent-loop.ts` | Core orchestrator — the main loop |
| `lib/anthropic.ts` | All LLM calls, system prompts, streaming |
| `lib/trino-mcp.ts` | MCP subprocess client, SQL execution, metadata tools |
| `lib/metadata.ts` | Schema introspection with two-tier cache |
| `lib/statsig.ts` | Statsig Console API client |
| `lib/metric-catalog.ts` | Metric catalog cache + matching |
| `lib/github-queries.ts` | GitHub repo query library cache + matching |
| `lib/query-matcher.ts` | Local query library matching (lazy SQL loading) |
| `lib/sql-validator.ts` | Read-only SQL enforcement (regex + AST) |
| `lib/chart-detector.ts` | Heuristic chart type detection |
| `domain-context.md` | Business terminology and default filters for prompts |

## Important Patterns

**HMR-safe caching**: All server-side caches (metadata, metrics, github-queries) use `globalThis` + disk `.cache/*.json`. On startup: load from disk → store in globalThis. On refresh: update globalThis → write to disk.

**Streaming**: Agent loop streams NDJSON events via `ReadableStream`. SQL generation and analysis stream individual tokens from Anthropic's streaming API. Client reads with `response.body.getReader()`.

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
