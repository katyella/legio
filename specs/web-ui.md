# Spec: Legio Web UI

## Objective

Add a local web UI to Legio for monitoring agent swarms. The UI is **read-only** (no write actions yet) and uses a **chat-app style interface** where agent-to-agent mail threads are the primary view, with dashboard/status/events as supporting context.

## Constraints

- **Zero runtime dependencies** — use only `Bun.serve()` (built-in HTTP/WS server), `bun:sqlite`, `Bun.file()`, etc.
- **No build step for frontend** — vanilla HTML/CSS/JS served as static files
- **Follow existing patterns** — tab indentation, 100-char line width, colocated tests, strict TypeScript (`noUncheckedIndexedAccess`, `noExplicitAny`), typed errors extending `LegioError`
- **Reuse existing store interfaces** — do not reimplement data access; import and call the existing `SessionStore`, `MailStore`, `EventStore`, `MetricsStore`, `MergeQueue`, `RunStore`
- **Reuse existing aggregation functions** — `gatherStatus()` from `src/commands/status.ts`, `gatherInspectData()` from `src/commands/inspect.ts`, `loadConfig()` from `src/config.ts`

## Architecture

```
CLI Command: legio server start [--port <n>] [--host <addr>]
    |
    v
Bun.serve()
    |
    +-- /api/*     -->  src/server/routes.ts   (JSON REST API, read-only)
    +-- /ws        -->  src/server/websocket.ts (WebSocket, polls stores every 2s)
    +-- /*         -->  src/server/public/*     (static files: HTML/CSS/JS)
```

The server opens SQLite stores per-request (open → query → close) to avoid holding connections long-term. All stores already use WAL mode + busy_timeout for concurrent access from agents.

## File Structure

Create these new files:

```
src/
  server/
    index.ts              # Bun.serve() setup, static file serving, WS upgrade
    index.test.ts         # Server lifecycle, route matching, WS handshake
    routes.ts             # API route handler: URL path → store query → JSON Response
    routes.test.ts        # Route tests with real seeded SQLite databases
    websocket.ts          # WS connection manager, polling loop, change detection, broadcast
    websocket.test.ts     # WS message format, subscription tests
    public/
      index.html          # SPA shell with nav and layout containers
      style.css           # Dark theme, CSS grid, chat bubbles, agent state colors
      app.js              # Hash router, WebSocket client, state management, auto-reconnect
      components.js       # Render functions for each view (chat, dashboard, events, costs, inspect)
  commands/
    server.ts             # CLI command: legio server start [--port] [--host]
    server.test.ts        # Arg parsing, help text, port validation
```

## Changes to Existing Files

1. **`src/index.ts`**:
   - Add `import { serverCommand } from "./commands/server.ts";`
   - Add `"server"` to the `COMMANDS` array
   - Add help line: `  server <sub>            Local web UI (start)`
   - Add switch case: `case "server": await serverCommand(commandArgs); break;`

2. **`src/errors.ts`**:
   - Add `ServerError` class extending `LegioError` with code `"SERVER_ERROR"` and optional `port` field

3. **`src/commands/dashboard.ts`**:
   - Add `export` keyword to the existing `loadDashboardData()` function (currently not exported but contains the exact data aggregation the web UI needs)

4. **`src/commands/completions.ts`**:
   - Add `server` command definition to the completions data with its subcommands and flags

## CLI Command

### `legio server start`

Starts the HTTP + WebSocket server in the foreground. Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `4173` | Port to listen on |
| `--host <addr>` | `127.0.0.1` | Bind address (localhost only for security) |
| `--open` | off | Auto-open browser after server starts |
| `--help`, `-h` | — | Show help |

The command:
1. Calls `loadConfig(process.cwd())` to resolve the project root
2. Validates `.legio/` exists
3. Starts `Bun.serve()` with the configured port/host
4. Prints the URL to stdout
5. Handles SIGINT for graceful shutdown

## REST API Specification

All endpoints are `GET`, return `Content-Type: application/json`. On error, return `{ "error": "<message>" }` with appropriate HTTP status.

### Core

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/health` | — | `{ ok: true, timestamp: "<ISO>" }` |
| `GET /api/status` | `gatherStatus(root, "orchestrator", true)` | Full dashboard state (agents, worktrees, mail unread, merge pending, metrics) |
| `GET /api/config` | `loadConfig(root)` | Project config (redact any secrets) |

### Agents

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/agents` | `SessionStore.getAll()` | All agent sessions |
| `GET /api/agents/active` | `SessionStore.getActive()` | Active agents only (booting/working/stalled) |
| `GET /api/agents/:name` | `SessionStore.getByName(name)` | Single agent session (404 if not found) |
| `GET /api/agents/:name/inspect` | `gatherInspectData(root, name, opts)` | Deep inspection: session + events + tool stats + token usage |
| `GET /api/agents/:name/events` | `EventStore.getByAgent(name, opts)` | Agent event timeline |

Query params for events: `?since=<ISO>`, `?until=<ISO>`, `?limit=<n>`, `?level=<debug|info|warn|error>`

### Mail

These endpoints power the chat view. This is the most important API surface.

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/mail` | `MailStore.getAll(filters)` | All messages. Filters: `?from=`, `?to=`, `?unread=true` |
| `GET /api/mail/unread` | `MailStore.getUnread(agent)` | Unread messages. Required: `?agent=<name>` |
| `GET /api/mail/:id` | `MailStore.getById(id)` | Single message by ID (404 if not found) |
| `GET /api/mail/thread/:threadId` | `MailStore.getByThread(threadId)` | All messages in a thread |

### Events

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/events` | `EventStore.getTimeline(opts)` | Events with filters: `?since=` (required), `?until=`, `?limit=`, `?level=` |
| `GET /api/events/errors` | `EventStore.getErrors(opts)` | Error-level events only |
| `GET /api/events/tools` | `EventStore.getToolStats(opts)` | Tool usage statistics: `?agent=`, `?since=` |

### Metrics & Costs

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/metrics` | `MetricsStore.getRecentSessions(limit)` | Session metrics. `?limit=<n>` (default 100) |
| `GET /api/metrics/snapshots` | `MetricsStore.getLatestSnapshots()` | Live token usage snapshots (one per active agent) |

### Runs

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/runs` | `RunStore.listRuns(opts)` | Run history. `?limit=<n>`, `?status=<active|completed|failed>` |
| `GET /api/runs/active` | `RunStore.getActiveRun()` | Current active run (null if none) |
| `GET /api/runs/:id` | `RunStore.getRun(id)` + `SessionStore.getByRun(id)` | Run detail with associated agents |

### Merge Queue

| Path | Store/Function | Description |
|------|----------------|-------------|
| `GET /api/merge-queue` | `MergeQueue.list(status)` | Merge queue entries. `?status=<pending|merging|merged|conflict|failed>` |

## Route Implementation Pattern

Use simple string matching with a helper for parameterized routes. No router library.

```typescript
function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const regexStr = pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  const match = new RegExp(`^${regexStr}$`).exec(path);
  return match?.groups ?? null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

Stores are opened and closed per-request:

```typescript
if (path === "/api/agents") {
  const store = openSessionStore(legioDir);
  try {
    return jsonResponse(store.getAll());
  } finally {
    store.close();
  }
}
```

## WebSocket Specification

### Server-Side Behavior

1. Accept WebSocket upgrade at `/ws`
2. Track connected clients in a `Set<ServerWebSocket>`
3. On connect: send full state snapshot immediately
4. Poll stores every 2 seconds (only when clients connected)
5. On change detected: broadcast snapshot to all clients
6. Change detection: compare JSON string of current state vs. previous (simple but effective)

### Message Protocol

**Server → Client:**

```typescript
// Full state snapshot (on connect + when data changes)
{
  type: "snapshot",
  data: {
    agents: AgentSession[],
    mail: { unreadCount: number, recent: MailMessage[] },
    mergeQueue: MergeEntry[],
    metrics: { totalSessions: number, avgDuration: number },
    runs: { active: Run | null },
  },
  timestamp: string // ISO
}
```

**Client → Server:**

```typescript
// Request immediate data refresh
{ type: "refresh" }
```

### Connection Management

- Server cleans up client references on close
- Polling interval pauses when zero clients connected
- No authentication (localhost-only by default)

## Frontend Specification

### Design

- **Dark theme** — dark background (#1a1b26), light text (#c0caf5), panel borders (#3b4261)
- **State colors** — working=green (#9ece6a), booting=yellow (#e0af68), stalled=red (#f7768e), zombie=gray (#565f89), completed=cyan (#7dcfff)
- **Priority colors** — urgent=red, high=yellow, normal=white, low=gray
- **Monospace font** for data tables and event feeds
- **Responsive** — CSS Grid, works from 800px+ width

### Navigation

Top nav bar with links to views. Hash-based routing (`#chat`, `#dashboard`, `#events`, `#costs`, `#inspect/:name`). Active link highlighted. WebSocket connection indicator (green dot = connected, red = disconnected). Last-updated timestamp.

### View 1: Chat (primary — `#/` or `#chat`)

This is the main view. Slack-style layout:

**Left sidebar (fixed width ~250px):**
- "All Messages" channel at top
- List of agents, each showing:
  - Colored dot for state (working/booting/stalled/zombie/completed)
  - Agent name
  - Capability label (dim)
  - Unread message count badge (if > 0)
- Agents sorted: active first (working, booting, stalled), then completed, then zombie
- Click agent to filter messages

**Main area:**
- Header: selected agent name + capability + state
- Message feed (scrollable, newest at bottom):
  - Each message rendered as a chat bubble
  - Left-aligned bubbles for messages TO the selected agent
  - Right-aligned bubbles for messages FROM the selected agent
  - Bubble shows: sender name, message type badge (status/question/result/error/worker_done/etc.), priority indicator, subject line (bold), body text, timestamp (relative, e.g. "2m ago")
  - Thread grouping: messages with same threadId visually grouped with a connecting line
- When "All Messages" selected: interleaved feed, all messages, each bubble shows from→to

### View 2: Dashboard (`#dashboard`)

4-panel grid layout mirroring the TUI:

**Agents panel (top, full width):**
- Table with columns: State (icon), Name (link to inspect), Capability, Task ID, Duration, Tmux (alive indicator)
- Sortable by clicking column headers
- State icons: ● working, ◐ booting, ⚠ stalled, ○ zombie, ✓ completed

**Mail panel (middle-left, 60% width):**
- Last 10 messages: priority color, from→to, subject, relative time

**Merge Queue panel (middle-right, 40% width):**
- Entries with status color, agent name, branch name

**Metrics strip (bottom, full width):**
- Total sessions, average duration, capability breakdown (inline stats)

### View 3: Events (`#events`)

Live event feed:
- Scrollable list, newest at top
- Each event: timestamp, color-coded type label (TOOL+/TOOL-/SESS+/SESS-/MAIL>/MAIL</SPAWN/ERROR), agent name, detail
- Filter bar: agent dropdown, event type checkboxes, level dropdown
- Auto-scroll toggle button
- Events loaded via REST API initially, then WebSocket updates append new ones

### View 4: Costs (`#costs`)

Token/cost table:
- Table: agent name, capability, input tokens, output tokens, cache read, cache created, estimated cost
- Totals row at bottom
- If live snapshots available: show active agents with burn rate (tokens/min, cost/min)
- Group-by-capability toggle

### View 5: Inspect (`#inspect/:name`)

Deep per-agent view (navigated to by clicking agent name anywhere):

- **Header**: agent name, state badge, capability, task ID, branch name, parent agent, duration
- **Token Usage**: input, output, cache read, cache created, estimated cost, model used
- **Tool Stats**: table of top tools by call count, with avg/max duration
- **Recent Tool Calls**: timeline list (timestamp, tool name, duration, truncated args)

### JavaScript Architecture

**`app.js`** — Core application:
- `state` object holding all data (agents, mail, mergeQueue, metrics, runs, events)
- `connect()` — WebSocket connection with auto-reconnect (3s delay)
- `route()` — reads `location.hash`, calls appropriate render function from `components.js`
- `render()` — called on state change, re-renders current view
- `hashchange` listener for navigation
- `formatDuration(ms)` / `timeAgo(iso)` / `truncate(str, len)` utility functions

**`components.js`** — Pure render functions:
- `renderChat(state, el)` — chat view with sidebar + message feed
- `renderDashboard(state, el)` — 4-panel grid
- `renderEvents(state, el)` — event feed
- `renderCosts(state, el)` — cost table
- `renderInspect(state, el, agentName)` — agent detail

Each function receives the current state and a DOM element, renders into it using `innerHTML` with template literals. For the chat view, use incremental DOM updates (append new messages) rather than full re-render to avoid scroll position loss.

## Testing Requirements

Follow the project's testing philosophy: **never mock what you can use for real.**

### `src/server/index.test.ts`
- Start server on random port with real temp `.legio/` directory
- Verify HTTP responses: `/api/health` returns 200, `/index.html` returns HTML, unknown routes return 404
- Verify WebSocket upgrade succeeds
- Verify graceful shutdown

### `src/server/routes.test.ts`
- Create temp `.legio/` with real SQLite databases
- Seed databases with test data (agents, mail, events, metrics, merge entries)
- Call `handleApiRequest()` directly with constructed `Request` objects
- Verify each endpoint returns correct JSON shape
- Verify query parameter filtering works
- Verify 404 for unknown routes
- Verify error responses for malformed requests

### `src/server/websocket.test.ts`
- Start real server, connect real WebSocket
- Verify initial snapshot message received
- Verify message format matches protocol spec
- Verify broadcast on data change

### `src/commands/server.test.ts`
- `--help` flag prints help text and exits
- `--port` validates numeric input
- Missing `.legio/` directory produces clear error

## Implementation Order

### Phase 1: Server skeleton + core API
1. Add `ServerError` to `src/errors.ts`
2. Create `src/commands/server.ts` with arg parsing and help text
3. Create `src/server/index.ts` with `Bun.serve()` setup
4. Create `src/server/routes.ts` with `/api/health`, `/api/status`, `/api/agents`, `/api/mail` endpoints
5. Wire `server` command into `src/index.ts`
6. Export `loadDashboardData()` from `src/commands/dashboard.ts`
7. Write `src/commands/server.test.ts` and `src/server/routes.test.ts`
8. Verify: `bun test && bun run lint && bun run typecheck`

### Phase 2: Complete API + WebSocket
1. Add all remaining routes to `src/server/routes.ts` (events, metrics, runs, merge-queue, inspect, config)
2. Implement query parameter parsing and filtering
3. Create `src/server/websocket.ts` with polling loop and broadcast
4. Wire WebSocket into `src/server/index.ts`
5. Write `src/server/websocket.test.ts` and expand `src/server/routes.test.ts`
6. Update `src/commands/completions.ts`
7. Verify: `bun test && bun run lint && bun run typecheck`

### Phase 3: Frontend — Chat view (primary)
1. Create `src/server/public/index.html` with SPA shell and nav
2. Create `src/server/public/style.css` with dark theme and chat layout
3. Create `src/server/public/app.js` with hash router, WebSocket client, state management
4. Create `src/server/public/components.js` with `renderChat()` function
5. Manual test: start server, open browser, verify chat view renders mail data

### Phase 4: Frontend — Remaining views
1. Add `renderDashboard()` to `components.js`
2. Add `renderEvents()` to `components.js`
3. Add `renderCosts()` to `components.js`
4. Add `renderInspect()` to `components.js`
5. Polish: responsive layout, loading states, empty states
6. Manual test: verify all views render correctly with real data

## Quality Gates

Before marking any phase complete:
1. `bun test` — all tests pass (existing + new)
2. `bun run lint` — biome check clean (tab indentation, 100-char width, no unused vars, no `any`)
3. `bun run typecheck` — tsc passes (strict mode)
