# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] - 2026-03-03

### Fixed
- Idle agents showed a gray `?` icon instead of a green `●` dot in the dashboard agent roster and badge component

## [0.3.3] - 2026-03-03

### Fixed
- Agents in `idle` state (between tool calls) disappeared from all queries and UI — `getActive()`, `getByRunIncludeActive()`, status zombie reconciliation, dashboard metrics, and the `activeAgents` computed signal now all include `idle` as an active state
- Dashboard showed "0 active / 2 total" and "Active: 0" when coordinator and gateway were alive but idle between tool calls
- 2467 tests across 83 test files (up from 2467 across 83)

## [0.3.2] - 2026-03-03

### Fixed
- `legio --version` now reads from package.json instead of a hardcoded string

## [0.3.1] - 2026-03-03

### Fixed
- Status commands (status, coordinator, gateway, monitor, supervisor) no longer destructively write zombie state to the DB — display-only zombie reconciliation prevents the race where page loads zombify agents before watchman can promote them to working
- Watchman and monitor auto-start moved before TUI wait and beacon delivery in `startCoordinator()`, closing the 15-30s race window
- Publish workflow restored `registry-url` and `NODE_AUTH_TOKEN` for npm OIDC trusted publishing

## [0.2.3] - 2026-03-02

### Fixed
- Coordinator and sling beacons now explain what legio is — previously Claude Code on fresh machines rejected thin beacons as "unrecognized" foreign content (same fix as gateway in v0.2.1)
- Coordinator beacon startup instructions use `legio status` instead of `bd ready` / `legio group status` (doesn't assume beads is installed)
- `legio doctor` no longer flags persistent agent identity files (coordinator, gateway, monitor) as stale — they legitimately exist outside the agent manifest
- Gateway greeting mail ("Gateway is online and ready") is only sent after confirmed beacon delivery — previously it was sent even when the beacon was rejected
- 2399 tests across 79 test files (up from 2397 across 79)

## [0.2.2] - 2026-03-02

### Fixed
- Coordinator and sling beacons now explain what legio is — previously Claude Code on fresh machines rejected thin beacons as "unrecognized" foreign content (same fix as gateway in v0.2.1)
- Coordinator beacon startup instructions use `legio status` instead of `bd ready` / `legio group status` (doesn't assume beads is installed)
- `legio doctor` no longer flags persistent agent identity files (coordinator, gateway, monitor) as stale — they legitimately exist outside the agent manifest
- 2398 tests across 79 test files (up from 2397 across 79)

## [0.2.1] - 2026-03-02

### Fixed
- Gateway beacon now explains what legio is — previously Claude Code on fresh machines rejected the thin beacon as "unrecognized" foreign content
- Gateway tmux session now receives provider env vars (`collectProviderEnv()`) — was the only agent type missing them
- Removed hardcoded `bd create` from gateway beacon (not all users have beads)
- `legio doctor` checks for bun availability with install instructions (required runtime for seeds and mulch)
- `legio doctor` marks sd, mulch, and bd as optional dependencies (warn instead of fail)
- Doctor install hints explain what each tool does and note bun requirement
- README requirements section separates required (Node, Claude Code, git, tmux) from optional (sd, mulch, bd) dependencies

## [0.2.0] - 2026-03-02

### Added
- Task tracker abstraction layer (`src/tracker/`) with factory, types, and adapters for beads and seeds backends — agent definitions are now tracker-agnostic via `{{TRACKER_CLI}}` and `{{TRACKER_NAME}}` template variables
- Gateway greeting mail — gateway sends an introductory message to the human after beacon delivery, visible in the dashboard chat
- Terminal panel session-state-aware ready detection — replaces the previous stale decay model with deterministic state machine
- Boot timeout detection and unregistered agent detection in watchman daemon
- Nudge session fallback and escalation/dispatch default high priority
- Beacon activity state machine — replaces thinking boolean with capture-driven activity detection
- Sleep hook guard — `PreToolUse` hooks block `sleep` commands in agent Bash calls
- Status prefix styling in chat message bubbles
- Nudge and wait-for-workers patterns documented in builder, lead, and supervisor agent definitions
- Completion notification and anti-sleep-polling guidance in agent definitions

### Changed
- Unified watchdog + mailman into single watchman daemon (`src/watchman/`)
- Mobile-responsive web UI — dashboard, issues, chat, costs, and inspect views all work on small screens
- Gateway beacon delivery uses deterministic store-polling instead of fragile pane-content heuristics
- `legio up` spawns gateway via awaited `run()` instead of fire-and-forget `spawnDetached()`, matching coordinator's reliable pattern
- Hook templates use `$LEGIO_AGENT_NAME` env var instead of hardcoded `{{AGENT_NAME}}` placeholder
- Quality gate commands included in overlay for read-only agents (scout, reviewer)
- Dashboard `/api/agents` scoped to current run instead of all historical sessions
- Fish shell compatibility — use `env -u` instead of `unset` in tmux sessions
- Package author updated to Matthew Wojtowicz
- 2397 tests across 79 test files (up from 2384 across 85)

### Fixed
- Gateway beacon delivery — replaced unreliable pane-content polling with store-polling `verifyBeaconDelivery()`, fixing the consistent "beacon stuck in input buffer" issue when started via `legio up`
- Removed 200ms `sendKeys` delay band-aid from tmux.ts (no longer needed with store-polling)
- Suppressed noisy watchman nudge spam during gateway startup
- Issues view sort order uses `closed_at` for closed column
- Test isolation — replaced `vi.mock` module-level mocking with DI pattern to prevent cross-file leaks
- Test performance — shared repos across tests, removed redundant git-wrapper tests, replaced `process.chdir` with `vi.spyOn(process, "cwd")`
- CI: set git identity in cloned test repos so merge-resolver tests pass on runners without global git config
- 13 agent definition documentation fixes (CLAUDE.md accuracy, agent roles, capability sections)

## [0.1.3] - 2026-02-27

### Fixed
- Global install (`npm install -g`) failed when run from a project without tsx — shim now resolves tsx from legio's own node_modules
- Publish workflow uses Node 24 + OIDC trusted publishing (no NPM_TOKEN needed)

## [0.1.2] - 2026-02-27

### Added
- Gateway first-run experience — beacon includes `FIRST_RUN` flag on first session, triggering self-introduction, `legio doctor` health check, and project onboarding
- Language-agnostic quality gates detection in `legio init` — auto-detects test/lint/typecheck commands for Node.js, Rust, Python, Go, Elm, Maven, Gradle, Ruby, and Elixir
- `quality-gates-configured` doctor check — warns when quality gates are missing or contain placeholder commands
- Install hints in `legio doctor` for missing dependencies (beads, mulch)

### Changed
- Agent definitions are fully language-agnostic — no hardcoded tool references (bun, npm, etc.)
- Default quality gates no longer include `typecheck` (language-specific, detected per-project instead)
- Gateway agent definition (`agents/gateway.md`) includes new "First Run" workflow section

### Fixed
- Removed project-specific tool references from agent definitions
- Corrected beads URL to `steveyegge/beads` in doctor output
- Fixed npm publish workflow — removed duplicate step from auto-tag, use OIDC in publish.yml

## [0.1.1] - 2026-02-26

### Changed
- Rewrote README to be product-focused (~130 lines, down from ~557)
- Moved CLI reference, REST API table, and architecture details to `docs/`
- Added costs, tasks, and updated inspect screenshots
- Simplified token cost warning
- Moved Overstory credit to footer

### Fixed
- Corrected GitHub URL in generated `config.yaml` comment
- Added Write/Edit scope and `worktree clean --all` constraints to lead agent definition

### Removed
- `STEELMAN.md` (risk analysis document)
- `ARCHITECTURE.md` (superseded by `docs/architecture.md`)
- `AGENTS.md` (superseded by `CLAUDE.md`)
- `bun.lock` (project uses npm)
- `templates/CLAUDE.md.tmpl` (dead template, not loaded by any code)
- `specs/web-ui.md` (historical spec, served its purpose)
- Gateway chat screenshot (removed from README)

## [0.1.0] - 2026-02-25

Initial public release on npm as [`@katyella/legio`](https://www.npmjs.com/package/@katyella/legio).

### Added

#### Core CLI
- CLI entry point with command router (`legio <command>`) — 34 commands
- `legio init` — initialize `.legio/` in a target project (deploys agent definitions, seeds config)
- `legio up` / `legio down` — bootstrap/shutdown full stack (init + server + coordinator)
- `legio sling` — spawn worker agents in git worktrees via tmux
- `legio prime` — load context for orchestrator or agent sessions (with `--compact` for compaction recovery)
- `legio status` — show active agents, worktrees, and project state
- `legio stop` — graceful shutdown sorting active sessions deepest-first

#### Agent System
- 10 base agent types: coordinator, supervisor, lead, gateway, scout, builder, reviewer, merger, monitor, CTO
- Two-layer agent definition: base `.md` files (HOW) + dynamic overlays (WHAT)
- Persistent agent identity and CV system
- Agent discovery via `legio agents discover` with capability/state/parent filters
- Configurable models per agent role via `config.yaml`
- Structural tool enforcement — PreToolUse hooks mechanically block file modifications for read-only agents and dangerous git operations for all agents
- Block Claude Code native team/task tools for all agents (enforces legio sling delegation)
- Root-user guard blocks all spawn/start commands
- Mulch domain inference for automatic expertise priming at spawn time

#### Coordination
- `legio coordinator` — persistent orchestrator with `start`/`stop`/`status`, auto-starts watchman/monitor
- `legio supervisor` — per-project team lead management
- `legio gateway` — planning companion and human interface agent
- `legio monitor` — Tier 2 continuous fleet patrol
- Task groups via `legio group` — batch coordination with auto-close on completion
- Session checkpoint save/restore for compaction survivability
- Handoff orchestration for crash recovery
- Run lifecycle management via `legio run`

#### Messaging
- `legio mail` — SQLite-based inter-agent messaging (send/check/list/read/reply/purge)
- 8 typed protocol messages: `worker_done`, `merge_ready`, `merged`, `merge_failed`, `escalation`, `health_check`, `dispatch`, `assign`
- Broadcast messaging with group addresses (`@all`, `@builders`, `@scouts`, etc.)
- `legio nudge` — tmux text nudge with retry, debounce, and auto-nudge on urgent mail
- JSON payload column for structured agent coordination

#### Merge Pipeline
- `legio merge` — merge agent branches with 4-tier conflict resolution
- FIFO merge queue backed by SQLite
- `--into` flag and `session-branch.txt` for flexible merge targets
- Unmerged branch safety check in worktree removal
- Conflict history intelligence for informed resolution strategies

#### Observability
- `legio dashboard` — live TUI dashboard for agent monitoring
- `legio inspect` — deep per-agent inspection with `--follow` polling
- `legio trace` — agent/bead timeline viewing
- `legio feed` — unified real-time event stream with `--follow` mode
- `legio errors` — aggregated error view across agents
- `legio replay` — interleaved chronological replay
- `legio logs` — NDJSON log query with level/time filtering and `--follow` tail
- `legio costs` — token/cost analysis with `--live` real-time display
- `legio metrics` — session metrics reporting
- `legio doctor` — health check system with 9 check modules

#### Web UI
- Browser-based dashboard with real-time WebSocket updates
- Views: Dashboard, Costs, Tasks, Chat, Setup, Gateway Chat, Inspect, Task Detail
- REST API with 30+ endpoints for full programmatic access
- Ideas CRUD API for planning workflow
- Gateway chat and coordinator chat with persistent history
- Preact + HTM + Tailwind CSS frontend (zero build step)

#### Infrastructure
- `legio hooks install` — orchestrator hooks management
- `legio worktree` — git worktree lifecycle (list/clean)
- `legio watchman` — unified watchman daemon (health monitoring, mail delivery, beacon management)
- `legio clean` — worktree/session/artifact cleanup
- `legio log` — hook event logging (NDJSON + human-readable)
- `legio server` — web UI server with daemon mode
- Shell completions for bash, zsh, and fish
- `--quiet` / `-q` global flag and `NO_COLOR` convention support
- Multi-format logging with secret redaction

#### Integrations
- beads (`bd`) CLI wrapper for issue tracking
- mulch CLI wrapper for structured expertise management
- Provider env var threading for model configuration

#### Testing
- 2384 tests across 85 files
- Colocated tests with source files
- Real implementations over mocks (temp git repos, SQLite `:memory:`, real filesystem)
- E2E lifecycle tests via Playwright
- Vitest test runner with forks pool for CI compatibility

[Unreleased]: https://github.com/katyella/legio/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/katyella/legio/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/katyella/legio/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/katyella/legio/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/katyella/legio/compare/v0.3.0...v0.3.1
[0.2.3]: https://github.com/katyella/legio/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/katyella/legio/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/katyella/legio/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/katyella/legio/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/katyella/legio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/katyella/legio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/katyella/legio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/katyella/legio/releases/tag/v0.1.0
