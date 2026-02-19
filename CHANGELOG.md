# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2026-02-17

### Added

#### Reviewer Coverage Enforcement
- Reviewer-coverage doctor check in `legio doctor` — warns when leads spawn builders without corresponding reviewers, reports partial coverage ratios per lead
- `merge_ready` reviewer validation in `legio mail send` — advisory warning when sending `merge_ready` without reviewer sessions for the sender's builders

#### Scout-First Workflow Enforcement
- Scout-before-builder warning in `legio sling` — warns when a lead spawns a builder without having spawned any scouts first
- `parentHasScouts()` helper exported from sling for testability

#### Run Auto-Completion
- `legio coordinator stop` now auto-completes the active run (reads `current-run.txt`, marks run completed, cleans up)
- `legio log session-end` auto-completes the run when the coordinator exits (handles tmux window close without explicit stop)

#### Gitignore Wildcard+Whitelist Model
- `.legio/.gitignore` flipped from explicit blocklist to wildcard `*` + whitelist pattern — ignore everything, whitelist only tracked files (`config.yaml`, `agent-manifest.json`, `hooks.json`, `groups.json`, `agent-defs/`)
- `legio prime` auto-heals `.legio/.gitignore` on each session start — ensures existing projects get the updated gitignore
- `LEGIO_GITIGNORE` constant and `writeLegioGitignore()` exported from init.ts for reuse

#### Testing
- Test suite grew from 1812 to 1848 tests across 73 files (4726 expect() calls)

### Changed
- Lead agent definition (`agents/lead.md`) — scouts made mandatory (not optional), Phase 3 review made MANDATORY with stronger language, added `SCOUT_SKIP` failure mode, expanded cost awareness section explaining why scouts and reviewers are investments not overhead
- `legio init` .gitignore now always overwrites (supports `--force` reinit and auto-healing)

### Fixed
- Hooks template (`templates/hooks.json.tmpl`) — removed fragile `read -r INPUT; echo "$INPUT" |` stdin relay pattern; `legio log` now reads stdin directly via `--stdin` flag
- `readStdinJson()` in log command — reads all stdin chunks for large payloads instead of only the first line
- Doctor gitignore structure check updated for wildcard+whitelist model

## [0.5.3] - 2026-02-17

### Added

#### Configurable Agent Models
- `models:` section in `config.yaml` — override the default model (`sonnet`, `opus`, `haiku`) for any agent role (coordinator, supervisor, monitor, etc.)
- `resolveModel()` helper in agent manifest — resolution chain: config override > manifest default > fallback
- Supervisor and monitor entries added to `agent-manifest.json` with model and capability metadata
- `legio init` now seeds the default `models:` section in generated `config.yaml`

#### Testing
- Test suite grew from 1805 to 1812 tests across 73 files (4638 expect() calls)

## [0.5.2] - 2026-02-17

### Added

#### New Flags
- `--into <branch>` flag for `legio merge` — target a specific branch instead of always merging to canonicalBranch

#### Session Branch Tracking
- `legio prime` now records the orchestrator's starting branch to `.legio/session-branch.txt` at session start
- `legio merge` reads `session-branch.txt` as the default merge target when `--into` is not specified — resolution chain: `--into` flag > `session-branch.txt` > config `canonicalBranch`

#### Testing
- Test suite grew from 1793 to 1805 tests across 73 files (4615 expect() calls)

### Changed
- Git push blocking for agents now blocks ALL `git push` commands (previously only blocked push to canonical branches) — agents should use `legio merge` instead
- Init-deployed hooks now include a PreToolUse Bash guard that blocks `git push` for the orchestrator's project

### Fixed
- Test cwd pollution in agents test afterEach — restored cwd to prevent cross-file pollution

## [0.5.1] - 2026-02-16

### Added

#### New CLI Commands
- `legio agents discover` — discover and query agents by capability, state, file scope, and parent with `--capability`, `--state`, `--parent` filters and `--json` output

#### New Subsystems
- Session insight analyzer (`src/insights/analyzer.ts`) — analyzes EventStore data from completed sessions to extract structured patterns about tool usage, file edits, and errors for automatic mulch expertise recording
- Conflict history intelligence in merge resolver — tracks past conflict resolution patterns per file to skip historically-failing tiers and enrich AI resolution prompts with successful strategies

#### Agent Improvements
- INSIGHT recording protocol for agent definitions — read-only agents (scout, reviewer) use INSIGHT prefix for structured expertise observations; parent agents (lead, supervisor) record insights to mulch automatically

#### Testing
- Test suite grew from 1749 to 1793 tests across 73 files (4587 expect() calls)

### Changed
- `session-end` hook now calls `mulch record` directly instead of sending `mulch_learn` mail messages — removes mail indirection for expertise recording

### Fixed
- Coordinator tests now always inject fake monitor/watchdog for proper isolation

## [0.5.0] - 2026-02-16

### Added

#### New CLI Commands
- `legio feed` — unified real-time event stream across all agents with `--follow` mode for continuous polling, agent/run filtering, and JSON output
- `legio logs` — query NDJSON log files across agents with level filtering (`--level`), time range queries (`--since`/`--until`), and `--follow` tail mode
- `legio costs --live` — real-time token usage display for active agents

#### New Flags
- `--monitor` flag for `coordinator start/stop/status` — manage the Tier 2 monitor agent alongside the coordinator

#### Agent Improvements
- Mulch recording as required completion gate for all agent types — agents must record learnings before session close
- Mulch learn extraction added to Stop hooks for orchestrator and all agents
- Scout-spawning made default in lead.md Phase 1 with parallel support
- Reviewer spawning made mandatory in lead.md

#### Infrastructure
- Real-time token tracking infrastructure (`src/metrics/store.ts`, `src/commands/costs.ts`) — live session cost monitoring via transcript JSONL parsing

#### Testing
- Test suite grew from 1673 to 1749 tests across 71 files (4460 expect() calls)

### Fixed
- Duplicate `feed` entry in CLI command router and help text

## [0.4.1] - 2026-02-16

### Added

#### New CLI Commands & Flags
- `legio --completions <shell>` — shell completion generation for bash, zsh, and fish
- `--quiet` / `-q` global flag — suppress non-error output across all commands
- `legio mail send --to @all` — broadcast messaging with group addresses (`@all`, `@builders`, `@scouts`, `@reviewers`, `@leads`, `@mergers`, etc.)

#### Output Control
- Central `NO_COLOR` convention support (`src/logging/color.ts`) — respects `NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb` environment variables per https://no-color.org
- All ANSI color output now goes through centralized color module instead of inline escape codes

#### Infrastructure
- Merge queue migrated from JSON file to SQLite (`merge-queue.db`) for durability and concurrent access

#### Testing
- Test suite grew from 1612 to 1673 tests across 69 files (4267 expect() calls)

### Fixed
- Freeze duration counter for completed/zombie agents in status and dashboard displays

## [0.4.0] - 2026-02-15

### Added

#### New CLI Commands
- `legio doctor` — comprehensive health check system with 9 check modules (dependencies, config, structure, databases, consistency, agents, merge-queue, version, logs) and formatted output with pass/warn/fail status
- `legio inspect <agent>` — deep per-agent inspection aggregating session data, metrics, events, and live tmux capture with `--follow` polling mode

#### New Flags
- `--watchdog` flag for `coordinator start` — auto-starts the watchdog daemon alongside the coordinator
- `--debounce <ms>` flag for `mail check` — prevents excessive mail checking by skipping if called within the debounce window
- PostToolUse hook entry for debounced mail checking

#### Observability Improvements
- Automated failure recording in watchdog via mulch — records failure patterns for future reference
- Mulch learn extraction in `log session-end` — captures session insights automatically
- Mulch health checks in `legio clean` — validates mulch installation and domain health during cleanup

#### Testing
- Test suite grew from 1435 to 1612 tests across 66 files (3958 expect() calls)

### Fixed

- Wire doctor command into CLI router and update command groups

## [0.3.0] - 2026-02-13

### Added

#### New CLI Commands
- `legio run` command — orchestration run lifecycle management (`list`, `show`, `complete` subcommands) with RunStore backed by sessions.db
- `legio trace` command — agent/bead timeline viewing for debugging and post-mortem observability
- `legio clean` command — cleanup worktrees, sessions, and artifacts with auto-cleanup on agent teardown

#### Observability & Persistence
- Run tracking via `run_id` integrated into sling and clean commands
- `RunStore` in sessions.db for durable run state
- `SessionStore` (SQLite) — migrated from sessions.json for concurrent access and crash safety
- Phase 2 CLI query commands and Phase 3 event persistence for the observability pipeline

#### Agent Improvements
- Project-scoped tmux naming (`legio-{projectName}-{agentName}`) to prevent cross-project session collisions
- `ENV_GUARD` on all hooks — prevents hooks from firing outside legio-managed worktrees
- Mulch-informed lead decomposition — leader agents use mulch expertise when breaking down tasks
- Mulch conflict pattern recording — merge resolver records conflict patterns to mulch for future reference

#### MulchClient Expansion
- New commands and flags for the mulch CLI wrapper
- `--json` parsing support with corrected types and flag spread

#### Community & Documentation
- `STEELMAN.md` — comprehensive risk analysis for agent swarm deployments
- Community files: CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
- Package metadata (keywords, repository, homepage) for npm/GitHub presence

#### Testing
- Test suite grew from 912 to 1435 tests across 55 files (3416 expect() calls)

### Fixed

- Fix `isCanonicalRoot` guard blocking all worktree overlays when dogfooding legio on itself
- Fix auto-nudge tmux corruption and deploy coordinator hooks correctly
- Fix 4 P1 issues: orchestrator nudge routing, bash guard bypass, hook capture isolation, overlay guard
- Fix 4 P1/P2 issues: ENV_GUARD enforcement, persistent agent state, project-scoped tmux kills, auto-nudge coordinator
- Strengthen agent orchestration with additional P1 bug fixes

### Changed

- CLI commands grew from 17 to 20 (added run, trace, clean)

## [0.2.0] - 2026-02-13

### Added

#### Coordinator & Supervisor Agents
- `legio coordinator` command — persistent orchestrator that runs at project root, decomposes objectives into subtasks, dispatches agents via sling, and tracks batches via task groups
  - `start` / `stop` / `status` subcommands
  - `--attach` / `--no-attach` with TTY-aware auto-detection for tmux sessions
  - Scout-delegated spec generation for complex tasks
- Supervisor agent definition — per-project team lead (depth 1) that receives dispatch mail from coordinator, decomposes into worker-sized subtasks, manages worker lifecycle, and escalates unresolvable issues
- 7 base agent types (added coordinator + supervisor to existing scout, builder, reviewer, lead, merger)

#### Task Groups & Session Lifecycle
- `legio group` command — batch coordination (`create` / `status` / `add` / `remove` / `list`) with auto-close when all member beads issues complete, mail notification to coordinator on auto-close
- Session checkpoint save/restore for compaction survivability (`prime --compact` restores from checkpoint)
- Handoff orchestration (initiate/resume/complete) for crash recovery

#### Typed Mail Protocol
- 8 protocol message types: `worker_done`, `merge_ready`, `merged`, `merge_failed`, `escalation`, `health_check`, `dispatch`, `assign`
- Type-safe `sendProtocol<T>()` and `parsePayload<T>()` for structured agent coordination
- JSON payload column with schema migration handling 3 upgrade paths

#### Agent Nudging
- `legio nudge` command with retry (3x), debounce (500ms), and `--force` to skip debounce
- Auto-nudge on urgent/high priority mail send

#### Structural Tool Enforcement
- PreToolUse hooks mechanically block file-modifying tools (Write/Edit/NotebookEdit) for non-implementation agents (scout, reviewer, coordinator, supervisor)
- PreToolUse Bash guards block dangerous git operations (`push`, `reset --hard`, `clean -f`, etc.) for all agents
- Whitelist git add/commit for coordinator/supervisor capabilities while keeping git push blocked
- Block Claude Code native team/task tools (Task, TeamCreate, etc.) for all legio agents — enforces legio sling delegation

#### Watchdog Improvements
- ZFC principle: tmux liveness as primary signal, pid check as secondary, sessions.json as tertiary
- Descendant tree walking for process cleanup — `getPanePid()`, `getDescendantPids()`, `killProcessTree()` with SIGTERM → grace → SIGKILL
- Re-check zombies on every tick, handle investigate action
- Stalled state added to zombie reconciliation

#### Worker Self-Propulsion (Phase 3)
- Builder agents send `worker_done` mail on task completion
- Overlay quality gates include worker_done signal step
- Prime activation context injection for bound tasks
- `MISSING_WORKER_DONE` failure mode in builder definition

#### Interactive Agent Mode
- Switch sling from headless (`claude -p`) to interactive mode with tmux sendKeys beacon — hooks now fire, enabling mail, metrics, logs, and lastActivity updates
- Structured `buildBeacon()` with identity context and startup protocol
- Fix beacon sendKeys multiline bug (increase initial sleep, follow-up Enter after 500ms)

#### CLI Improvements
- `--verbose` flag for `legio status`
- `--json` flag for `legio sling`
- `--background` flag for `legio watch`
- Help text for unknown subcommands
- `SUPPORTED_CAPABILITIES` constant and `Capability` type

#### Init & Deployment
- `legio init` now deploys agent definitions (copies `agents/*.md` to `.legio/agent-defs/`) via `import.meta.dir` resolution
- E2E lifecycle test validates full init → config → manifest → overlay pipeline on throwaway external projects

#### Testing Improvements
- Colocated tests with source files (moved from `__tests__/` to `src/`)
- Shared test harness: `createTempGitRepo()`, `cleanupTempDir()`, `commitFile()` in `src/test-helpers.ts`
- Replaced `Bun.spawn` mocks with real implementations in 3 test files
- Optimized test harness: 38.1s → 11.7s (-69%)
- Comprehensive metrics command test coverage
- E2E init-sling lifecycle test
- Test suite grew from initial release to 515 tests across 24 files (1286 expect() calls)

### Fixed

- **60+ bugs** resolved across 8 dedicated fix sessions, covering P1 criticals through P4 backlog items:
  - Hooks enforcement: tool guard sed patterns now handle optional space after JSON colons
  - Status display: filter completed sessions from active agent count
  - Session lifecycle: move session recording before beacon send to fix booting → working race condition
  - Stagger delay (`staggerDelayMs`) now actually enforced between agent spawns
  - Hardcoded `main` branch replaced with dynamic branch detection in worktree/manager and merge/resolver
  - Sling headless mode fixes for E2E validation
  - Input validation, environment variable handling, init improvements, cleanup lifecycle
  - `.gitignore` patterns for `.legio/` artifacts
  - Mail, merge, and worktree subsystem edge cases

### Changed

- Agent propulsion principle: failure modes, cost awareness, and completion protocol added to all agent definitions
- Agent quality gates updated across all base definitions
- Test file paths updated from `__tests__/` convention to colocated `src/**/*.test.ts`

## [0.1.0] - 2026-02-12

### Added

- CLI entry point with command router (`legio <command>`)
- `legio init` — initialize `.legio/` in a target project
- `legio sling` — spawn worker agents in git worktrees via tmux
- `legio prime` — load context for orchestrator or agent sessions
- `legio status` — show active agents, worktrees, and project state
- `legio mail` — SQLite-based inter-agent messaging (send/check/list/read/reply)
- `legio merge` — merge agent branches with 4-tier conflict resolution
- `legio worktree` — manage git worktrees (list/clean)
- `legio log` — hook event logging (NDJSON + human-readable)
- `legio watch` — watchdog daemon with health monitoring and AI-assisted triage
- `legio metrics` — session metrics storage and reporting
- Agent manifest system with 5 base agent types (scout, builder, reviewer, lead, merger)
- Two-layer agent definition: base `.md` files (HOW) + dynamic overlays (WHAT)
- Persistent agent identity and CV system
- Hooks deployer for automatic worktree configuration
- beads (`bd`) CLI wrapper for issue tracking integration
- mulch CLI wrapper for structured expertise management
- Multi-format logging with secret redaction
- SQLite metrics storage for session analytics
- Full test suite using `bun test`
- Biome configuration for formatting and linting
- TypeScript strict mode with `noUncheckedIndexedAccess`

[Unreleased]: https://github.com/katyella/legio/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/katyella/legio/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/katyella/legio/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/katyella/legio/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/katyella/legio/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/katyella/legio/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/katyella/legio/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/katyella/legio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/katyella/legio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/katyella/legio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/katyella/legio/releases/tag/v0.1.0
