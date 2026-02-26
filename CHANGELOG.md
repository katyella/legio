# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gateway first-run experience — beacon includes `FIRST_RUN` flag on first session, triggering self-introduction, `legio doctor` health check, and project onboarding
- Language-agnostic quality gates detection in `legio init` — auto-detects test/lint/typecheck commands for Node.js, Rust, Python, Go, Elm, Maven, Gradle, Ruby, and Elixir
- `quality-gates-configured` doctor check — warns when quality gates are missing or contain placeholder commands

### Changed
- `buildGatewayBeacon()` accepts optional `isFirstRun` parameter
- Default quality gates no longer include `typecheck` (language-specific, detected per-project instead)
- Gateway agent definition (`agents/gateway.md`) includes new "First Run" workflow section

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
- `legio coordinator` — persistent orchestrator with `start`/`stop`/`status`, auto-starts watchdog/monitor
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
- `legio watch` — watchdog daemon (Tier 0 mechanical monitoring, Tier 1 AI triage)
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

[Unreleased]: https://github.com/katyella/legio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/katyella/legio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/katyella/legio/releases/tag/v0.1.0
