# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

Only the latest release on the current major version line receives security updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/katyella/legio/security/advisories).

1. Go to the [Security Advisories page](https://github.com/katyella/legio/security/advisories)
2. Click **"New draft security advisory"**
3. Fill in a description of the vulnerability, including steps to reproduce if possible

### Response Timeline

- **Acknowledgment**: Within 48 hours of your report
- **Initial assessment**: Within 7 days
- **Fix or mitigation**: Within 30 days for confirmed vulnerabilities

We will keep you informed of progress throughout the process.

## Scope

Legio is a CLI tool that orchestrates multiple Claude Code agents via git worktrees, tmux sessions, and SQLite databases on the local filesystem. The following are considered security issues:

- **Command injection** -- Unsanitized input passed to `Bun.spawn` or shell execution
- **Path traversal** -- Accessing files outside the intended project or `.legio/` directory
- **Arbitrary file access** -- Reading or writing files the user did not intend
- **Symlink attacks** -- Following symlinks to unintended locations
- **Temp file races** -- TOCTOU vulnerabilities in temporary file handling
- **Agent escape** -- An agent accessing files outside its designated worktree or file scope
- **Mail injection** -- Crafted messages that manipulate agent behavior or escalate privileges

The following are generally **not** in scope:

- Denial of service via large input (Legio is a local tool, not a service)
- Issues that require the attacker to already have local shell access with the same privileges as the user
- Social engineering or phishing
- Costs incurred from spawning many agents (this is an operational concern, not a security vulnerability)

## Security Measures

Legio already implements several hardening measures:

- Tool enforcement hooks that mechanically block file modifications for non-implementation agents
- Dangerous git operation blocking (force push, reset --hard) via PreToolUse hooks
- File scope enforcement per agent via overlay configuration
- SQLite WAL mode with busy timeouts for safe concurrent access

If you believe any of these measures can be bypassed, please report it through the process above.
