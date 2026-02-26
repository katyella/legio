# CLI Reference

Full command reference for the `legio` CLI.

## Bootstrap

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

## Core Workflow

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

legio stop                          Stop active agent sessions deepest-first
  --agent <name>                         Stop only the named agent
  --json                                 JSON output
```

## Server

```
legio server start                  Start the web UI server
  --port <n>                             Server port (default: 4173)
  --host <addr>                          Server host (default: 127.0.0.1)
  --open                                 Open browser on start
  --daemon                               Run as background process
legio server stop                   Stop the server daemon
legio server status                 Show server state
```

## Coordination Agents

```
legio coordinator start             Start persistent coordinator agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
  --watchdog                             Auto-start watchdog daemon with coordinator
  --monitor                              Auto-start Tier 2 monitor agent
legio coordinator stop              Stop coordinator
legio coordinator status            Show coordinator state

legio supervisor start              Start per-project supervisor agent
  --task <bead-id>                       Bead task ID (required)
  --name <name>                          Unique name (required)
  --parent <agent>                       Parent agent (default: coordinator)
  --depth <n>                            Hierarchy depth (default: 1)
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
legio supervisor stop               Stop supervisor
legio supervisor status             Show supervisor state

legio gateway start                 Start gateway planning agent
  --attach / --no-attach                 TTY-aware tmux attach (default: auto)
legio gateway stop                  Stop gateway
legio gateway status                Show gateway state

legio monitor start                 Start Tier 2 monitor agent
legio monitor stop                  Stop monitor agent
legio monitor status                Show monitor state
```

## Messaging

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
legio mail purge                    Delete old messages
  --all | --days <n> | --agent <name>

legio nudge <agent> [message]       Send a text nudge to an agent
  --from <name>                          Sender name (default: orchestrator)
  --force                                Skip debounce check
  --json                                 JSON output
```

## Merge & Groups

```
legio merge                         Merge agent branches into canonical
  --branch <name>                        Specific branch
  --all                                  All completed branches
  --into <branch>                        Target branch (default: session-branch.txt > canonicalBranch)
  --dry-run                              Check for conflicts only

legio group create <name>           Create a task group for batch tracking
legio group status <name>           Show group progress
legio group add <name> <issue-id>   Add issue to group
legio group remove <name> <id>      Remove issue from group
legio group list                    List all groups
```

## Monitoring & Observability

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
legio run complete                  Mark current run complete
```

## Infrastructure

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
  Categories: dependencies, config, structure, databases,
              consistency, agents, merge, logs, version

legio clean                         Clean up worktrees, sessions, artifacts
  --all  --mail  --sessions  --metrics
  --logs  --worktrees  --branches
  --agents  --specs  --json

legio log <event>                   Log a hook event (called by hooks)

Global Flags:
  --quiet, -q                            Suppress non-error output
  --completions <shell>                  Generate shell completions (bash, zsh, fish)
```
