# Legio

[![CI](https://img.shields.io/github/actions/workflow/status/katyella/legio/ci.yml?branch=main)](https://github.com/katyella/legio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-green)](https://nodejs.org)
[![GitHub release](https://img.shields.io/github/v/release/katyella/legio)](https://github.com/katyella/legio/releases)

Project-agnostic swarm system for Claude Code agent orchestration. Legio turns a single Claude Code session into a multi-agent team by spawning worker agents in git worktrees via tmux, coordinating them through a custom SQLite mail system, and merging their work back with tiered conflict resolution. Includes a built-in web UI for real-time fleet monitoring and orchestration.

> **Warning: Agent swarms are not a universal solution.** Do not deploy Legio without understanding the risks of multi-agent orchestration — compounding error rates, cost amplification, debugging complexity, and merge conflicts are the normal case, not edge cases. Read [STEELMAN.md](STEELMAN.md) for a full risk analysis and the [Agentic Engineering Book](https://github.com/jayminwest/agentic-engineering-book) ([web version](https://jayminwest.com/agentic-engineering-book)) before using this tool in production.

## How It Works

CLAUDE.md + hooks + the `legio` CLI turn your Claude Code session into a multi-agent orchestrator. A persistent coordinator agent manages task decomposition and dispatch, while a mechanical watchdog daemon monitors agent health and an autopilot daemon automates merges and cleanup.

```
Coordinator (persistent orchestrator at project root)
  --> Supervisor (per-project team lead, depth 1)
        --> Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Agent Types

| Agent | Role | Access |
|-------|------|--------|
| **Coordinator** | Persistent orchestrator — decomposes objectives, dispatches agents, tracks task groups | Read-only |
| **Supervisor** | Per-project team lead — manages worker lifecycle, handles nudge/escalation | Read-only |
| **Scout** | Read-only exploration and research | Read-only |
| **Builder** | Implementation and code changes | Read-write |
| **Reviewer** | Validation and code review | Read-only |
| **Lead** | Team coordination, can spawn sub-workers | Read-write |
| **Merger** | Branch merge specialist | Read-write |
| **Monitor** | Tier 2 continuous fleet patrol — ongoing health monitoring | Read-only |

### Key Architecture

- **Agent Definitions**: Two-layer system — base `.md` files define the HOW (workflow), per-task overlays define the WHAT (task scope). Base definition content is injected into spawned agent overlays automatically.
- **Messaging**: Custom SQLite mail system with typed protocol — 8 message types (`worker_done`, `merge_ready`, `dispatch`, `escalation`, etc.) for structured agent coordination, plus broadcast messaging with group addresses (`@all`, `@builders`, etc.)
- **Worktrees**: Each agent gets an isolated git worktree — no file conflicts between agents
- **Merge**: FIFO merge queue (SQLite-backed) with 4-tier conflict resolution
- **Watchdog**: Tiered health monitoring — Tier 0 mechanical daemon (tmux/pid liveness), Tier 1 AI-assisted failure triage, Tier 2 monitor agent for continuous fleet patrol
- **Autopilot**: Mechanical daemon that auto-processes `merge_ready` mail, merges completed branches, and optionally cleans worktrees
- **Web UI**: Browser-based dashboard with real-time WebSocket updates — agent monitoring, mail, terminal access, cost tracking, and setup wizard
- **Tool Enforcement**: PreToolUse hooks mechanically block file modifications for non-implementation agents and dangerous git operations for all agents
- **Task Groups**: Batch coordination with auto-close when all member issues complete
- **Session Lifecycle**: Checkpoint save/restore for compaction survivability, handoff orchestration for crash recovery
- **Token Instrumentation**: Session metrics extracted from Claude Code transcript JSONL files

## Requirements

- [Node.js](https://nodejs.org) (v22+)
- [Bun](https://bun.sh) (v1.0+, for running tests and the CLI)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- git
- tmux

## Installation

```bash
# Clone the repository
git clone https://github.com/katyella/legio.git
cd legio

# Install dependencies
bun install

# Link the CLI globally
bun link
```

## Quick Start

The fastest way to get started:

```bash
cd your-project

# Bootstrap everything — init, start server, open browser
legio up

# When you're done, shut it all down
legio down
```

Or step by step:

```bash
# Initialize legio in your project
legio init

# Install hooks into .claude/settings.local.json
legio hooks install

# Start the web UI server (daemon mode)
legio server start --daemon

# Start a coordinator (persistent orchestrator)
legio coordinator start

# Or spawn individual worker agents
legio sling <task-id> --capability builder --name my-builder

# Check agent status
legio status

# Live TUI dashboard for monitoring the fleet
legio dashboard

# Nudge a stalled agent
legio nudge <agent-name>

# Check mail from agents
legio mail check --inject
```

## Web UI

Legio includes a browser-based dashboard for real-time fleet monitoring. Start it with `legio server start` or `legio up`.

**Views:**

| View | Description |
|------|-------------|
| **Command** | Mission control — audit timeline + coordinator chat |
| **Chat** | Task-based conversations grouped by issue |
| **Dashboard** | Agent status, mail feed, merge queue, system metrics |
| **Events** | Tool events and timelines |
| **Issues** | Beads issue tracking and status |
| **Inspect** | Deep per-agent inspection |
| **Costs** | Token usage and cost breakdown |
| **Terminal** | Interactive tmux pane capture and text send |
| **Autopilot** | Autopilot daemon control and status |
| **Setup** | Interactive initialization wizard |

**Tech:** Preact + HTM + Tailwind CSS, WebSocket for real-time updates, zero build step.

## CLI Reference

### Bootstrap

```
legio up                            Start everything (init + server + coordinator)
  --port <n>                             Server port (default: 4173)
  --host <addr>                          Server host (default: 127.0.0.1)
  --no-open                              Skip opening browser
  --force                                Reinitialize even if .legio/ exists
  --json                                 JSON output

legio down                          Stop everything (coordinator + server)
  --json                                 JSON output
```

### Core Workflow

```
legio init                          Initialize .legio/ in current project
                                        (deploys agent definitions automatically)

legio sling <task-id>              Spawn a worker agent
  --capability <type>                    builder | scout | reviewer | lead | merger
                                         | coordinator | supervisor | monitor
  --name <name>                          Unique agent name
  --spec <path>                          Path to task spec file
  --files <f1,f2,...>                    Exclusive file scope
  --parent <agent-name>                  Parent (for hierarchy tracking)
  --depth <n>                            Current hierarchy depth
  --json                                 JSON output

legio prime                         Load context for orchestrator/agent
  --agent <name>                         Per-agent priming
  --compact                              Restore from checkpoint (compaction)

legio spec write <bead-id>          Write a task specification
  --body <content>                       Spec content (or pipe via stdin)

legio agents discover               Discover agents by capability/state/parent
  --capability <type>                    Filter by capability type
  --state <state>                        Filter by agent state
  --parent <name>                        Filter by parent agent
  --json                                 JSON output
```

### Server & Autopilot

```
legio server start                  Start the web UI server
  --port <n>                             Server port (default: 4173)
  --host <addr>                          Server host (default: 127.0.0.1)
  --open                                 Open browser on start
  --daemon                               Run as background process
legio server stop                   Stop the server daemon
legio server status                 Show server state

legio autopilot start               Start the autopilot daemon
legio autopilot stop                Stop the autopilot daemon
legio autopilot status              Show autopilot state (ticks, actions, config)
  --port <n>  --host <addr>  --json
```

### Coordination Agents

```
legio coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
  --watchdog                             Auto-start watchdog daemon with coordinator
  --monitor                              Auto-start Tier 2 monitor agent
legio coordinator stop              Stop coordinator
legio coordinator status            Show coordinator state

legio supervisor start              Start per-project supervisor agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
legio supervisor stop               Stop supervisor
legio supervisor status             Show supervisor state

legio monitor start                 Start Tier 2 monitor agent
legio monitor stop                  Stop monitor agent
legio monitor status                Show monitor state
```

### Messaging

```
legio mail send                     Send a message
  --to <agent>  --subject <text>  --body <text>
  --to @all | @builders | @scouts ...    Broadcast to group addresses
  --type <status|question|result|error>
  --priority <low|normal|high|urgent>    (urgent/high auto-nudges recipient)

legio mail check                    Check inbox (unread messages)
  --agent <name>  --inject  --json
  --debounce <ms>                        Skip if checked within window

legio mail list                     List messages with filters
  --from <name>  --to <name>  --unread

legio mail read <id>                Mark message as read
legio mail reply <id> --body <text> Reply in same thread

legio nudge <agent> [message]       Send a text nudge to an agent
  --from <name>                          Sender name (default: orchestrator)
  --force                                Skip debounce check
  --json                                 JSON output
```

### Merge & Groups

```
legio merge                         Merge agent branches into canonical
  --branch <name>                        Specific branch
  --all                                  All completed branches
  --into <branch>                        Target branch (default: session-branch.txt > canonicalBranch)
  --dry-run                              Check for conflicts only

legio group create <name>           Create a task group for batch tracking
legio group status <name>           Show group progress
legio group add <name> <issue-id>   Add issue to group
legio group list                    List all groups
```

### Monitoring & Observability

```
legio status                        Show all active agents, worktrees, beads state
  --json  --verbose

legio dashboard                     Live TUI dashboard for agent monitoring
  --interval <ms>                        Refresh interval (default: 2000)

legio inspect <agent>               Deep per-agent inspection
  --json  --follow  --interval <ms>  --no-tmux  --limit <n>

legio trace                         View agent/bead timeline
  --agent <name>  --run <id>
  --since <ts>  --until <ts>  --limit <n>  --json

legio feed [options]                Unified real-time event stream across agents
  --follow, -f  --interval <ms>
  --agent <name>  --run <id>  --json

legio errors                        Aggregated error view across agents
  --agent <name>  --run <id>
  --since <ts>  --until <ts>  --limit <n>  --json

legio replay                        Interleaved chronological replay
  --run <id>  --agent <name>
  --since <ts>  --until <ts>  --limit <n>  --json

legio logs [options]                Query NDJSON logs across agents
  --agent <name>  --level <level>
  --since <ts>  --until <ts>  --follow  --json

legio costs                         Token/cost analysis and breakdown
  --live  --agent <name>  --run <id>
  --by-capability  --last <n>  --json

legio metrics                       Show session metrics
  --last <n>  --json

legio run list                      List orchestration runs
legio run show <id>                 Show run details
legio run complete <id>             Mark a run complete
```

### Infrastructure

```
legio hooks install                 Install orchestrator hooks to .claude/settings.local.json
  --force                                Overwrite existing hooks
legio hooks uninstall               Remove orchestrator hooks
legio hooks status                  Check if hooks are installed

legio worktree list                 List worktrees with status
legio worktree clean                Remove completed worktrees
  --completed  --all

legio watch                         Start watchdog daemon (Tier 0)
  --interval <ms>  --background

legio doctor                        Run health checks on legio setup
  --json  --category <name>

legio clean                         Clean up worktrees, sessions, artifacts
  --all  --mail  --sessions  --metrics
  --logs  --worktrees  --branches
  --agents  --specs  --json

legio log <event>                   Log a hook event (called by hooks)

Global Flags:
  --quiet, -q                            Suppress non-error output
  --completions <shell>                  Generate shell completions (bash, zsh, fish)
```

## REST API

When the server is running, a full REST API is available at `http://localhost:4173/api/`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Overall project status |
| `GET /api/health` | Server health check |
| `GET /api/agents` | List all agents |
| `GET /api/agents/active` | Active agents only |
| `GET /api/agents/:name` | Agent details |
| `GET /api/agents/:name/inspect` | Deep inspection data |
| `GET /api/agents/:name/events` | Agent events |
| `GET /api/mail` | All messages |
| `GET /api/mail/unread` | Unread messages |
| `GET /api/mail/conversations` | Thread grouping |
| `POST /api/mail/send` | Send a message |
| `GET /api/events` | Tool events |
| `GET /api/events/errors` | Error events |
| `GET /api/metrics` | Session metrics |
| `GET /api/runs` | All runs |
| `GET /api/runs/active` | Active run |
| `GET /api/issues` | Beads issues |
| `GET /api/merge-queue` | Merge queue status |
| `POST /api/terminal/send` | Send keys to tmux pane |
| `GET /api/terminal/capture` | Capture pane output |
| `POST /api/autopilot/start` | Start autopilot |
| `POST /api/autopilot/stop` | Stop autopilot |
| `GET /api/autopilot/status` | Autopilot state |
| `POST /api/setup/init` | Initialize legio from UI |
| `GET /api/setup/status` | Setup status |
| `GET /api/audit` | Query audit trail |
| `WS /ws` | WebSocket for real-time updates |

## Tech Stack

- **Runtime**: Bun (TypeScript directly, no build step)
- **Node.js**: v22+ (required for `better-sqlite3`)
- **Dependencies**: `better-sqlite3` (SQLite), `ws` (WebSocket server)
- **Database**: SQLite via `better-sqlite3` (WAL mode for concurrent access)
- **Web UI**: Preact + HTM + Tailwind CSS (zero build step, served from `src/server/public/`)
- **Linting**: Biome (formatter + linter)
- **Testing**: `bun test` (core) + `vitest` (server, stores) + `playwright` (e2e)
- **External CLIs**: `bd` (beads), `mulch`, `git`, `tmux` — invoked as subprocesses

## Development

```bash
# Run core tests
bun test

# Run store/server tests (vitest)
bun run test:vitest
bun run test:server

# Run e2e tests (playwright)
bun run test:e2e

# Run a single test
bun test src/config.test.ts

# Lint + format check
biome check .

# Type check
tsc --noEmit

# All quality gates
bun test && biome check . && tsc --noEmit
```

### Versioning

Version is maintained in two places that must stay in sync:

1. `package.json` — `"version"` field
2. `src/index.ts` — `VERSION` constant

Use the bump script to update both:

```bash
bun run version:bump <major|minor|patch>
```

Git tags are created automatically by GitHub Actions when a version bump is pushed to `main`.

## Project Structure

```
legio/
  src/
    index.ts                      CLI entry point (command router)
    types.ts                      Shared types and interfaces
    config.ts                     Config loader + validation
    errors.ts                     Custom error types
    commands/                     One file per CLI subcommand (34 commands)
      up.ts                       Bootstrap full stack
      down.ts                     Shutdown full stack
      server.ts                   Web UI server lifecycle
      autopilot.ts                Autopilot daemon control
      agents.ts                   Agent discovery and querying
      coordinator.ts              Persistent orchestrator lifecycle
      supervisor.ts               Team lead management
      dashboard.ts                Live TUI dashboard (ANSI, zero deps)
      hooks.ts                    Orchestrator hooks management
      sling.ts                    Agent spawning
      group.ts                    Task group batch tracking
      nudge.ts                    Agent nudging
      mail.ts                     Inter-agent messaging
      monitor.ts                  Tier 2 monitor management
      merge.ts                    Branch merging
      status.ts                   Fleet status overview
      prime.ts                    Context priming
      init.ts                     Project initialization
      worktree.ts                 Worktree management
      watch.ts                    Watchdog daemon
      log.ts                      Hook event logging
      logs.ts                     NDJSON log query
      feed.ts                     Unified real-time event stream
      run.ts                      Orchestration run lifecycle
      trace.ts                    Agent/bead timeline viewing
      clean.ts                    Worktree/session cleanup
      doctor.ts                   Health check runner (9 check modules)
      inspect.ts                  Deep per-agent inspection
      spec.ts                     Task spec management
      errors.ts                   Aggregated error view
      replay.ts                   Interleaved event replay
      costs.ts                    Token/cost analysis
      metrics.ts                  Session metrics
      completions.ts              Shell completion generation (bash/zsh/fish)
    server/                       Web UI server
      routes.ts                   REST API routes
      websocket.ts                WebSocket real-time updates
      audit-store.ts              SQLite audit trail
      public/                     Frontend (Preact + HTM + Tailwind)
        views/                    UI views (command, chat, dashboard, etc.)
        components/               Reusable UI components
        lib/                      Client-side state, API, WebSocket
    autopilot/                    Autopilot daemon (auto-merge, cleanup)
      daemon.ts                   Polling-based automation
    agents/                       Agent lifecycle management
      manifest.ts                 Agent registry (load + query)
      overlay.ts                  Dynamic CLAUDE.md overlay generator
      identity.ts                 Persistent agent identity (CVs)
      checkpoint.ts               Session checkpoint save/restore
      lifecycle.ts                Handoff orchestration
      hooks-deployer.ts           Deploy hooks + tool enforcement
    worktree/                     Git worktree + tmux management
    mail/                         SQLite mail system (typed protocol, broadcast)
    merge/                        FIFO queue + conflict resolution
    watchdog/                     Tiered health monitoring (daemon, triage, health)
    logging/                      Multi-format logger + sanitizer + reporter + color control
    metrics/                      SQLite metrics + transcript parsing
    doctor/                       Health check modules (9 checks)
    insights/                     Session insight analyzer for auto-expertise
    beads/                        bd CLI wrapper + molecules
    mulch/                        mulch CLI wrapper
    e2e/                          End-to-end lifecycle tests
  agents/                         Base agent definitions (.md, 8 roles)
  templates/                      Templates for overlays and hooks
```

## License

MIT

---

Inspired by: https://github.com/steveyegge/gastown/
