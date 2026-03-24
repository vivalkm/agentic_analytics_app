# Lakehouse Analytics — Feature Catalog

Exhaustive inventory of every feature provided by the application, organized by feature group.

---

## 1. Agentic Query Loop

The core intelligence layer that turns natural language into validated SQL results.

- **Natural language to SQL**: Converts free-form questions into Trino SQL via LLM (Anthropic Claude)
- **Multi-iteration retry loop**: Up to 3 attempts to produce correct results — generates SQL, executes, validates, revises if needed
- **Streaming NDJSON event protocol**: 14 event types (`thinking`, `sql_start`, `sql_chunk`, `sql`, `execution`, `validation`, `analysis_chunk`, `done`, `clarification`, `progress`, `metadata_ready`, `needs_metadata`, `error`) streamed line-by-line to the client
- **Context-aware SQL generation**: Assembles system prompt from domain context, metric catalog, local query library, GitHub query library, and schema metadata in priority order
- **Conversation history**: Sends up to 10 prior turns (question + SQL + results summary + analysis) for multi-turn context continuity
- **No-SQL response detection**: When the LLM responds without SQL, heuristically classifies the response as a "direct answer" (long, has markdown formatting) or a "clarification request" (short/question)
- **SQL auto-correction**: LLM pre-execution review checks for logical errors (join fan-out, wrong date ranges, incorrect aggregation, missing filters); if corrected SQL is provided, it's automatically substituted
- **Unused table rotation**: Tracks which tables were tried across iterations and provides untried tables to subsequent attempts
- **Progress polling during metadata load**: Emits progress events every 2.5s with schema/table counts while waiting for metadata
- **Needs-metadata detection**: If no relevant tables are found, emits a `needs_metadata` event prompting the user to refresh schema

## 2. SQL Validation & Safety

- **Three-phase read-only enforcement**: (1) Regex scan for blocked keywords (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, MERGE, REPLACE, GRANT, REVOKE, CALL, EXECUTE), (2) first-keyword allowlist check (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN), (3) AST parsing via `node-sql-parser` with Trino dialect to verify all statements are SELECTs
- **Comment stripping**: Removes `--` line comments and `/* */` block comments before validation
- **Empty/comment-only query rejection**: Returns specific error for queries with no executable content
- **LLM SQL review**: Pre-execution check for logical errors — join fan-out, wrong date ranges, incorrect aggregation, wrong table qualifiers, ambiguous column references, missing core remittance filters
- **API-level SQL blocking**: The `/api/execute` endpoint returns HTTP 403 with `{error, blocked: true}` if validation fails

## 3. Results Validation

- **Zero-row detection**: Automatically retries with revised SQL when query returns no rows
- **Code-level date completeness check**: Detects quarter references in questions (Q1-Q4, "first quarter", "this quarter"), validates data starts within 15 days of expected quarter start, reports specific missing months
- **LLM results quality review**: Checks date range completeness, row count reasonableness, column relevance, data granularity, and value sanity — suggests specific alternative tables if invalid

## 4. SQL Execution (Trino MCP)

- **MCP subprocess**: Spawns `uvx` child process running Trino MCP server, communicates via JSON-RPC 2.0 over stdin/stdout
- **Singleton client**: Single MCP process reused across all requests
- **30-second startup timeout**: Process initialization guard
- **300-second query timeout**: Per-tool-call execution limit (5 minutes)
- **Dedicated metadata routing**: SHOW SCHEMAS, SHOW TABLES, and DESCRIBE statements routed to specialized MCP tools to avoid LIMIT-appending issues
- **Result parsing**: Handles both JSON and pipe-delimited text table formats from MCP responses; infers column types (bigint, double, boolean, date, timestamp, varchar) from data samples
- **Environment routing**: Configurable `prod` or `preprod` Trino environment via `TRINO_ENVIRONMENT` env var
- **10,000 row limit**: Default LIMIT applied to query execution

## 5. LLM Analysis

- **Streaming markdown analysis**: Streams analysis token-by-token after successful query execution
- **Structured analysis format**: Executive summary (2-3 sentences), key findings (bullet points), outliers/patterns, and follow-up questions
- **Chart configuration generation**: LLM produces a ```` ```chart ``` ```` JSON block specifying chart type, axes, and grouping — overrides heuristic detection
- **Follow-up question extraction**: Parses suggested follow-up questions from analysis text (up to 5), each with an "Ask" button to immediately run
- **Multi-turn analysis context**: Includes conversation history so analysis can reference prior findings
- **Multimodal input support**: Accepts image, PDF, CSV, and TXT attachments alongside the question — images as ImageBlocks, PDFs as DocumentBlocks, text files as labeled text

## 6. Schema Metadata

- **Two-tier caching**: In-memory (`globalThis`) survives Next.js hot reloads; disk (`.cache/metadata.json`) survives restarts
- **Priority schema loading**: Schemas listed in `TRINO_PRIORITY_SCHEMAS` load first, unblocking the agent loop faster
- **Priority table boosting**: Tables listed in `TRINO_PRIORITY_TABLES` get +15 relevance score boost
- **Background refresh**: Non-blocking metadata refresh with progressive cache updates after each table
- **Schema skip list**: Configurable schemas to exclude entirely (default: `information_schema`, `sys`)
- **Table comment fetching**: Queries `system.metadata.table_comments` for table-level descriptions
- **Column comment extraction**: Reads column-level comments from DESCRIBE output
- **Keyword-based relevance scoring**: Scores tables against user question using table name (+10), schema name (+5), table comment (+8), column name (+3), column comment (+4), word decomposition (+6), priority schema (+5), priority table (+15)

## 7. Query Library (Local)

- **SQL file convention**: Files in `query-library/` use a structured header: `-- description` marker, multi-line description, optional `-- tags: tag1, tag2`, separator `-- ------------`
- **Lazy SQL loading**: Headers parsed on startup; full SQL bodies loaded on-demand only when metadata matching is insufficient
- **Two-pass keyword matching**: Pass 1 scores description + filename + tags (threshold: score >= 5); Pass 2 lazy-loads SQL bodies for entries that didn't match in Pass 1
- **Stop word filtering**: Common words (the, and, for, from, with, that, this) excluded from matching
- **5 pre-built queries**: daily-financials, mtd-topline-metrics-deep-dive, mtd-revenue-nca-outlook, smb-financials, wbr-bridge

## 8. Query Library (GitHub)

- **Remote repository sync**: Fetches SQL files from a configurable GitHub repository (`QUERY_LIBRARY_REPO` env var)
- **GitHub API integration**: Authenticated via `GITHUB_TOKEN` / `GH_TOKEN` for private repos
- **URL parsing**: Extracts owner, repo, branch, and path from GitHub tree URLs
- **Concurrency-limited fetching**: Fetches file contents in batches of 5
- **12-hour staleness threshold**: Re-syncs from GitHub when cache exceeds 12 hours
- **Header parsing**: Supports both `--` line comment and `/* */` block comment header styles
- **Two-pass keyword matching**: Same scoring algorithm as local query library
- **Filename prefixing**: GitHub query entries prefixed with `github:` to distinguish from local ones
- **Two-tier caching**: In-memory (`globalThis`) + disk (`.cache/github-queries.json`)

## 9. Statsig Metric Catalog

- **Statsig Console API client**: Fetches metric sources and derived metrics from `statsigapi.net`
- **Team filtering**: Only syncs metrics from configured teams (`STATSIG_METRIC_TEAMS` env var, default: `squad-FPA,squad-INTA`)
- **Paginated fetching**: 100 items per page with automatic pagination
- **Metric SQL resolution**: For each metric, tries the metric-specific SQL endpoint first, falls back to source SQL via cross-reference map
- **Concurrency-limited SQL fetching**: Fetches metric SQL in batches of 5 with `Promise.allSettled` for graceful failure handling
- **24-hour staleness threshold**: Re-syncs from Statsig when cache exceeds 24 hours
- **Two-tier caching**: In-memory (`globalThis`) + disk (`.cache/metrics.json`)
- **Keyword matching**: Exact name match (+10), description/tags/source name (+5), SQL body (+2, only if already scored > 0), derived metric bonus (+3)
- **Rich metric model**: Captures aggregation type, value column, filter criteria, metric type, source name, backing SQL, and Statsig console URL

## 10. Domain Context

- **Business terminology injection**: `domain-context.md` is read once and included in every SQL generation prompt
- **Default core remittance filters**: Auto-applies `customer_is_business = FALSE` and `txn_is_core = TRUE` unless user explicitly asks about SMB or non-core
- **Forecast table routing**: Routes to `fpa.fpa_fcst_latest` (monthly) or `fpa.fpa_fcst_latest_daily_ma` (daily) based on granularity
- **Ambiguity awareness**: "business revenue" means general company revenue (not SMB); "core remittance" always excludes SMB and Rewire
- **Time defaults**: 12-month lookback when no time period specified; MTD/QTD/YTD uses T-1 (yesterday) as end date; current date injected into prompts

## 11. Chart Rendering

- **Three chart types**: Bar, Line, Pie (Donut)
- **Heuristic chart type detection**: Classifies columns as numeric/date/categorical, applies priority rules — line for time series, bar for comparisons, pie for 2-8 category slices
- **LLM chart config override**: LLM-generated chart config from analysis takes precedence over heuristic detection
- **Grouped bar charts**: When a `groupKey` is present, data is pivoted so each group becomes its own bar series
- **Dual-axis support**: When exactly two Y-series differ in scale by 5x or more, a second Y-axis appears on the right
- **Smart axis formatting**: Dates shortened to MM-DD; long labels truncated to 12 chars; numbers formatted with K/M/B suffixes
- **Line chart dot control**: Dots shown only when data has 30 or fewer points
- **Responsive sizing**: Charts fill container width at 300px height
- **8-color palette**: Blue, green, amber, rose, violet, cyan, orange, pink (HSL) cycled for multiple series
- **Dark-styled tooltips**: Dark background, rounded corners, custom border
- **Column relevance filtering**: Excludes noise columns (cumulative/running_total/ytd_/mtd_; count columns when asking about revenue; margin columns when asking about counts)
- **Conditional rendering**: Chart hidden if type is `none`, data is empty, or all values are zero

## 12. Notebook UI

### Cell Types
- **Question cells**: Blue "Q" avatar with question text in large font
- **Thinking cells**: Collapsible step showing attempt number, validation status icon (green check / amber warning / blue brain / spinning loader), summary text truncated to 80 chars, expandable details with validation failure reasons and intermediate SQL
- **SQL cells**: Syntax-highlighted code with Prism (oneDark theme), collapsible, auto-collapsed when analysis exists
- **Results cells**: Row count, execution time display, CSV download button, chart rendering, raw data preview table
- **Analysis cells**: Card with markdown rendering (headers, bold, italic, code, bullet lists, numbered lists, tables with alternating row stripes), iteration badge ("Resolved after N attempts"), follow-up question buttons
- **Error cells**: Red-bordered box with error message
- **Clarification cells**: Amber-themed box with question icon and markdown content
- **Needs-metadata cells**: Blue-themed box with "Refresh Metadata & Retry" button that loads schemas and auto-retries the question

### Streaming UI
- **Live SQL streaming preview**: Dark box with "Writing SQL..." header, spinning loader, monospace SQL text accumulating token-by-token, animated blinking cursor (pulsing blue bar)
- **Agent status indicator**: Phase-specific icon and text — "Writing SQL..." / "Running query..." / "Checking results..." / "Trying different approach (attempt N/3)..." / "Analyzing results..."
- **Dynamic status text**: Progress and thinking events override default phase text

### Multi-iteration Visual Handling
- **Intermediate cell hiding**: Previous iteration SQL and results cells are marked `isIntermediate` and hidden
- **Thinking step auto-collapse**: Multi-iteration thinking steps automatically collapsed after completion

## 13. Chat Input

- **Auto-resizing textarea**: Grows from 1 row to max 200px height
- **Cmd/Ctrl+Enter to submit**: Keyboard shortcut for sending
- **Send button**: Icon button with loading spinner state
- **File attachment button**: Opens native file picker for PNG, JPEG, GIF, WebP, PDF, CSV, TXT files
- **10 MB file size limit**: Native alert on exceeded limit
- **File preview chips**: Attached files shown as small chips with type icon, truncated filename, and remove (X) button
- **Drag and drop**: Entire input area accepts file drops with visual border/background feedback
- **Clipboard paste**: Pasting images from clipboard auto-attaches them
- **Prefill injection**: External components (e.g., schema explorer) can inject text into the input
- **Auto-focus**: Input focuses on mount and on prefill change
- **Focus styling**: Enhanced shadow and primary border on focus-within
- **Disabled state**: Textarea and buttons dimmed during loading
- **Placeholder text**: "Ask a question about your data... (Cmd+Enter to submit)"

## 14. SQL Editor

- **Prism syntax highlighting**: oneDark theme, fixed dark background regardless of app theme
- **Collapsible SQL block**: Chevron-animated header, auto-collapses when analysis cell exists
- **Copy to clipboard**: Copy icon button with 2-second check-mark confirmation
- **Inline edit mode**: Toggle between read-only highlighted view and editable monospace textarea (resizable, min-height 80px, spellcheck off)
- **Run query**: Play icon + "Run" button; shows "Running..." during execution
- **Cmd/Ctrl+E keyboard shortcut**: Execute query from both view and edit mode
- **Escape to cancel editing**: Reverts to original SQL
- **Streaming mode**: Edit and run buttons hidden during SQL generation; only copy available
- **Empty state placeholder**: `-- Generating SQL...` when SQL is empty

## 15. Data Export

- **CSV download**: POST to `/api/export` with columns and rows, returns downloadable CSV blob
- **Proper CSV escaping**: Quotes values containing commas, double-quotes, or newlines; doubles internal quotes
- **Filename sanitization**: Non-alphanumeric characters replaced with underscores
- **Timestamped filenames**: Default format `export-{timestamp}.csv`
- **Loading indicator**: Spinning icon and disabled button during download

## 16. Raw Data Preview

- **Collapsible data table**: Starts collapsed with row and column count summary
- **Sticky column headers**: Headers stay visible when scrolling
- **Cell formatting**: Null/undefined shown as em-dash; large numbers with locale formatting; floats to 2 decimal places; strings truncated at 50 chars
- **10-row preview limit**: Shows "Showing N of M rows" footer when truncated
- **Hover row highlighting**: Rows highlight on hover
- **Horizontal scroll**: Overflow-x-auto for wide tables
- **Hidden when empty**: Component returns null when row count is 0

## 17. Sidebar — Schema Explorer

- **Three-level collapsible tree**: Catalog > Schema > Table > Columns
- **Context-sensitive icons**: Database (catalog), Folder/FolderOpen (schema), Table2 (table), Columns3 (column)
- **Table count badges**: Per-schema table count badges and total table count in header
- **Click-to-copy table FQN**: Clicking a table name copies `catalog.schema.table` to clipboard and inserts it into the chat input
- **Green check confirmation**: 1.5-second visual confirmation after copying
- **Search/filter**: Text input filters by table or schema name; forces all tree nodes open when filtering
- **Refresh button**: Triggers priority schema reload from Trino; spinning animation while refreshing
- **Last refreshed timestamp**: "Synced with Trino at {date} {time}"
- **Auto-refetch on metadata_ready**: Schema explorer refetches when agent loop emits metadata availability
- **Column type display**: Monospace type annotations next to column names
- **Column comment tooltips**: Native `title` tooltip on hover when comment exists
- **Loading skeleton**: Spinner + "Loading schema..." + animated placeholder bars
- **Empty state**: "No tables found. Click refresh." or "No matches."

## 18. Sidebar — Query Library

- **Query card list**: Displays saved SQL queries with description titles
- **Query count badge**: Total query count next to header
- **Search/filter**: Filters by description, filename, or tag
- **Tag badges**: Clickable tag pills that set the search filter
- **Collapsible SQL preview**: "Show SQL" trigger expands to dark code block (monospace, max-height 200px with scroll)
- **Loading skeleton**: Spinner + "Loading queries..." + animated placeholder bars
- **Empty state**: FileCode icon + "No saved queries." + hint to add `.sql` files
- **No matches state**: "No matches for '{search}'"

## 19. Sidebar — Metrics Catalog

- **Metrics card list**: Displays Statsig-synced metric definitions (derived metrics only)
- **Metrics count badge**: Derived metric count next to header
- **Sync button**: Triggers POST to `/api/metrics` for Statsig sync; spinning animation while syncing
- **Last synced timestamp**: "Synced with Statsig at {date} {time}"
- **Search/filter**: Filters by name, description, source name, or tag
- **Metric definition display**: Calculator icon + aggregation expression (e.g., "SUM(value_column)") in blue code badge + "from {sourceName}" text
- **Filter criteria display**: Filter icon + criteria conditions in amber code badges
- **Statsig console link**: Metric name links to Statsig console page (external link, opens in new tab)
- **Tag badges**: Clickable tag pills that set the search filter
- **Collapsible source SQL**: "Source SQL" trigger expands to dark code block (max-height 128px with scroll)
- **Description truncation**: 2-line clamp on descriptions
- **Empty state (no metrics)**: Conditional messaging based on whether Statsig is configured + "Sync from Statsig" button
- **Loading skeleton**: Spinner + "Loading metrics..." + animated placeholder bars

## 20. Sidebar Layout

- **Desktop sidebar toggle**: PanelLeftClose/PanelLeft icon button with tooltip
- **Default 280px width**: Persisted in state
- **Drag-to-resize handle**: 1px-wide draggable divider between sidebar and content; min 200px, max 30% of viewport; cursor changes to `col-resize`; visual indicator bar on hover/active
- **Collapse animation**: 200ms ease-in-out width transition
- **Three tabs**: "Schema", "Library", "Metrics" via shadcn Tabs
- **Independent scroll per tab**: Each tab content wrapped in ScrollArea
- **Mobile hamburger menu**: Visible on small screens; opens a 300px Sheet (slide-in drawer) from the left
- **Mobile sheet**: Lazy-mounted content (avoids duplicate API fetches); "Navigation" sr-only title for accessibility

## 21. In-App Settings

- **First-run API key prompt**: Full-screen onboarding overlay when no `ANTHROPIC_API_KEY` is configured; collects API key (required) and optional base URL; auto-dismisses on success
- **Settings dialog**: Gear icon in header opens modal with 4 groups — LLM (API Key, Base URL, Model), Trino (Environment, Priority Schemas, Priority Tables), Statsig (Console API Key), GitHub (Query Library Repo, Token) — 9 managed env vars total
- **Secret field masking**: API keys/tokens shown as `****xxxx` with eye toggle to reveal
- **Dirty tracking**: Only edited fields sent on save; save button shows spinner then checkmark before auto-closing
- **Immediate effect**: Runtime override pattern (`getEnv()` checks in-memory overrides before `process.env`) so changes apply without server restart
- **`.env.local` persistence**: All settings written to disk and survive restarts
- **Settings API**: `GET /api/settings` returns masked values + `hasApiKey` flag; `PUT /api/settings` validates against managed key allowlist and writes to disk + memory

## 22. Header & Navigation

- **Sticky header**: Fixed at top with semi-transparent background and backdrop blur
- **App logo and title**: Database icon in primary-tinted container + "Lakehouse Analytics" text
- **Keyboard shortcuts dialog**: Button opens modal showing Cmd+Enter (submit), Cmd+E (run SQL), Escape (cancel edit)
- **Settings button**: Gear icon opens the settings dialog for API keys and configuration
- **Theme toggle**: Sun/Moon icon button toggling between dark and light modes; hydration-safe with mounted guard
- **Clear session button**: Trash icon + "Clear" text; only visible when cells exist; clears all cells and wipes localStorage

## 23. Welcome & Empty State

- **Welcome hero**: Large Database icon, heading, and descriptive paragraph
- **4 suggested questions**: Clickable pill buttons with pre-written example queries that immediately trigger the agent loop:
  - "What is the monthly revenue trend for the last 12 months?"
  - "Show daily send volume trend for the last 30 days"
  - "How does actual revenue compare to forecast this quarter?"
  - "What tables and columns are available in the fpa schema?"

## 24. Scroll & Navigation UX

- **Auto-scroll**: Scrolls to bottom when new content appears, but only if user is already near bottom (150px threshold)
- **Scroll-to-bottom button**: Floating pill button that appears when scrolled up; shows ArrowDown icon + "Scroll to bottom"; backdrop blur; smooth scroll on click

## 25. Session Persistence

- **localStorage-backed sessions**: Notebook cell state saved to `lakehouse-analytics-session` key
- **Auto-save on change**: Every cell state update triggers a save
- **Auto-load on mount**: Session restored from localStorage on page load
- **Clear session**: Removes localStorage key and resets cells
- **Unique cell IDs**: Generated as `cell-{timestamp}-{random6chars}`
- **Quota error handling**: Silently ignores localStorage quota exceeded errors

## 26. Error Handling

- **React error boundary**: Wraps notebook cells area; catches render errors; displays AlertTriangle icon, "Something went wrong" message, and "Try Again" reset button
- **Console error logging**: Logs caught errors and component stacks
- **Agent error events**: Top-level try/catch in agent loop emits error event to client
- **Per-cell error display**: Red-bordered error cells with inline error messages
- **Graceful LLM failures**: Validation/review functions fall back to "approved" or "valid" on parse failures

## 27. Theming & Visual Design

- **Dark mode default**: Defaults to dark theme with system preference detection
- **oklch color space**: All color tokens use perceptually uniform oklch values
- **Blue-purple accent**: Hue 260 as primary throughout
- **5 chart-specific colors**: Distinct hues for chart series (blue-purple, teal-green, amber, pink-magenta, cyan)
- **Sidebar-specific tokens**: Full set of sidebar color tokens for consistent sidebar theming
- **Border radius scale**: Base 0.625rem with computed sm through 4xl sizes
- **Custom scrollbar**: 6px thin scrollbar with transparent track and semi-transparent thumb
- **17px base font size**: Slightly larger than browser default for readability
- **Inter font**: OpenType features cv02, cv03, cv04, cv11 enabled
- **JetBrains Mono**: Used for all code/SQL/data display
- **Antialiased rendering**: WebKit and Firefox font smoothing
- **Tooltip system**: 300ms delay, arrow indicators, animated fade/zoom
- **Animation utilities**: tw-animate-css for UI transitions
- **Backdrop blur**: Used on header, input area, and scroll-to-bottom button

## 28. API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/agent` | Main agentic loop — NDJSON stream of events |
| POST | `/api/analyze` | Standalone streaming analysis of SQL + results |
| POST | `/api/execute` | SQL execution with read-only validation |
| POST | `/api/export` | CSV generation and download |
| GET | `/api/library` | Fetch local query library entries |
| POST | `/api/query` | Single-pass streaming SQL generation (no retry loop) |
| GET | `/api/metadata` | Fetch current schema metadata cache |
| POST | `/api/metadata` | Trigger metadata refresh (blocking, priority-only, or fire-and-forget) |
| GET | `/api/metrics` | Fetch metric catalog |
| POST | `/api/metrics` | Force Statsig metric sync |
| GET | `/api/settings` | Fetch all managed settings (secrets masked) |
| PUT | `/api/settings` | Update settings — writes `.env.local` + runtime overrides |

## 29. Caching Architecture

- **HMR-safe pattern**: All caches use `globalThis` + disk files to survive both hot reloads and restarts
- **Metadata cache**: `globalThis.__metadataCache` + `.cache/metadata.json`
- **Metric catalog cache**: `globalThis.__metricCache` + `.cache/metrics.json`
- **GitHub query cache**: `globalThis.__githubQueryCache` + `.cache/github-queries.json`
- **Domain context cache**: Module-level variable (`_domainContext`), loaded once from disk
- **Progressive cache updates**: Metadata cache updated after each table introspection (no all-or-nothing refresh)
- **Staleness thresholds**: Metrics at 24 hours, GitHub queries at 12 hours

## 30. Build & Dev Tooling

- **Next.js 16.2.1**: App Router, React 19, Turbopack dev server
- **TypeScript 5**: Strict mode, bundler resolution, incremental compilation
- **Tailwind CSS v4**: CSS-first configuration (no JS config file)
- **ESLint 9**: Flat config with `next/core-web-vitals` + `next/typescript`
- **shadcn/ui (base-nova)**: Component library with neutral base color
- **Path aliases**: `@/*` maps to project root
- **React Strict Mode disabled**: Prevents double-mounting that would complicate streaming and MCP subprocess management
- **Dev indicators disabled**: Clean development UI without Next.js overlays
- **No test framework**: No testing infrastructure configured
- **No middleware**: No request interception layer
- **No Docker**: No containerization configuration

## 31. Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd/Ctrl + Enter` | Chat input | Submit question |
| `Cmd/Ctrl + E` | SQL editor | Execute SQL query |
| `Escape` | SQL editor (edit mode) | Cancel editing, revert to original SQL |

## 32. Accessibility

- **Screen-reader labels**: Mobile sheet has sr-only "Navigation" title; dialog close button has sr-only "Close" label
- **Tooltip descriptions**: All icon buttons have tooltip labels
- **Keyboard navigation**: Send, file attach, sidebar toggle, theme toggle, clear session all accessible via keyboard
- **ARIA attributes**: Dialog, Sheet, and Tooltip components use Radix/Base UI primitives with proper ARIA roles
- **`suppressHydrationWarning`**: Prevents theme class mismatch warnings
