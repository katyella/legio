/**
 * Base error class for all Legio errors.
 * Includes a machine-readable `code` field for programmatic handling.
 */
export class LegioError extends Error {
	readonly code: string;

	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LegioError";
		this.code = code;
	}
}

/**
 * Raised when config loading or validation fails.
 * Examples: missing config file, invalid YAML, schema violations.
 */
export class ConfigError extends LegioError {
	readonly configPath: string | null;
	readonly field: string | null;

	constructor(
		message: string,
		context?: {
			configPath?: string;
			field?: string;
			cause?: Error;
		},
	) {
		super(message, "CONFIG_ERROR", { cause: context?.cause });
		this.name = "ConfigError";
		this.configPath = context?.configPath ?? null;
		this.field = context?.field ?? null;
	}
}

/**
 * Raised for agent lifecycle issues.
 * Examples: spawn failure, agent not found, depth limit exceeded.
 */
export class AgentError extends LegioError {
	readonly agentName: string | null;
	readonly capability: string | null;

	constructor(
		message: string,
		context?: {
			agentName?: string;
			capability?: string;
			cause?: Error;
		},
	) {
		super(message, "AGENT_ERROR", { cause: context?.cause });
		this.name = "AgentError";
		this.agentName = context?.agentName ?? null;
		this.capability = context?.capability ?? null;
	}
}

/**
 * Raised when hierarchy constraints are violated.
 * Examples: coordinator spawning a builder directly instead of through a lead.
 */
export class HierarchyError extends LegioError {
	readonly agentName: string | null;
	readonly requestedCapability: string | null;

	constructor(
		message: string,
		context?: {
			agentName?: string;
			requestedCapability?: string;
			cause?: Error;
		},
	) {
		super(message, "HIERARCHY_VIOLATION", { cause: context?.cause });
		this.name = "HierarchyError";
		this.agentName = context?.agentName ?? null;
		this.requestedCapability = context?.requestedCapability ?? null;
	}
}

/**
 * Raised when git worktree operations fail.
 * Examples: worktree creation, branch conflicts, cleanup failures.
 */
export class WorktreeError extends LegioError {
	readonly worktreePath: string | null;
	readonly branchName: string | null;

	constructor(
		message: string,
		context?: {
			worktreePath?: string;
			branchName?: string;
			cause?: Error;
		},
	) {
		super(message, "WORKTREE_ERROR", { cause: context?.cause });
		this.name = "WorktreeError";
		this.worktreePath = context?.worktreePath ?? null;
		this.branchName = context?.branchName ?? null;
	}
}

/**
 * Raised when mail system operations fail.
 * Examples: DB access errors, invalid message format, delivery failures.
 */
export class MailError extends LegioError {
	readonly agentName: string | null;
	readonly messageId: string | null;

	constructor(
		message: string,
		context?: {
			agentName?: string;
			messageId?: string;
			cause?: Error;
		},
	) {
		super(message, "MAIL_ERROR", { cause: context?.cause });
		this.name = "MailError";
		this.agentName = context?.agentName ?? null;
		this.messageId = context?.messageId ?? null;
	}
}

/**
 * Raised when merge or conflict resolution fails.
 * Examples: unresolvable conflicts, merge queue errors, tier escalation failures.
 */
export class MergeError extends LegioError {
	readonly branchName: string | null;
	readonly conflictFiles: string[];

	constructor(
		message: string,
		context?: {
			branchName?: string;
			conflictFiles?: string[];
			cause?: Error;
		},
	) {
		super(message, "MERGE_ERROR", { cause: context?.cause });
		this.name = "MergeError";
		this.branchName = context?.branchName ?? null;
		this.conflictFiles = context?.conflictFiles ?? [];
	}
}

/**
 * Raised when input validation fails.
 * Examples: invalid agent names, malformed beadIds, bad CLI arguments.
 */
export class ValidationError extends LegioError {
	readonly field: string | null;
	readonly value: unknown;

	constructor(
		message: string,
		context?: {
			field?: string;
			value?: unknown;
			cause?: Error;
		},
	) {
		super(message, "VALIDATION_ERROR", { cause: context?.cause });
		this.name = "ValidationError";
		this.field = context?.field ?? null;
		this.value = context?.value ?? null;
	}
}

/**
 * Raised when task group operations fail.
 * Examples: group not found, duplicate member, auto-close failures.
 */
export class GroupError extends LegioError {
	readonly groupId: string | null;

	constructor(
		message: string,
		context?: {
			groupId?: string;
			cause?: Error;
		},
	) {
		super(message, "GROUP_ERROR", { cause: context?.cause });
		this.name = "GroupError";
		this.groupId = context?.groupId ?? null;
	}
}

/**
 * Raised when session lifecycle operations fail.
 * Examples: checkpoint save/restore failures, handoff failures.
 */
export class LifecycleError extends LegioError {
	readonly agentName: string | null;
	readonly sessionId: string | null;

	constructor(
		message: string,
		context?: {
			agentName?: string;
			sessionId?: string;
			cause?: Error;
		},
	) {
		super(message, "LIFECYCLE_ERROR", { cause: context?.cause });
		this.name = "LifecycleError";
		this.agentName = context?.agentName ?? null;
		this.sessionId = context?.sessionId ?? null;
	}
}

/**
 * Raised when the web UI server fails to start or encounters a runtime error.
 * Examples: port already in use, bind failure, static file not found.
 */
export class ServerError extends LegioError {
	readonly port: number | null;

	constructor(
		message: string,
		context?: {
			port?: number;
			cause?: Error;
		},
	) {
		super(message, "SERVER_ERROR", { cause: context?.cause });
		this.name = "ServerError";
		this.port = context?.port ?? null;
	}
}
