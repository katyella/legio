/**
 * Multi-format logger that writes to multiple outputs simultaneously.
 *
 * Output files (all created in the provided logDir):
 * - session.log    — Human-readable: [TIMESTAMP] EVENT key=value
 * - events.ndjson  — Machine-parseable NDJSON stream (all events)
 * - tools.ndjson   — Tool use log (toolStart / toolEnd events only)
 * - errors.log     — Stack traces with context (error events only)
 *
 * Log directory structure: .legio/logs/{agent-name}/{session-timestamp}/
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LogEvent } from "../types.ts";
import { printToConsole } from "./reporter.ts";
import { sanitize, sanitizeObject } from "./sanitizer.ts";

export interface Logger {
	info(event: string, data?: Record<string, unknown>): void;
	warn(event: string, data?: Record<string, unknown>): void;
	error(event: string, error: Error, data?: Record<string, unknown>): void;
	debug(event: string, data?: Record<string, unknown>): void;
	toolStart(toolName: string, args: Record<string, unknown>): void;
	toolEnd(toolName: string, durationMs: number, result?: string): void;
	close(): void;
}

interface LoggerOptions {
	logDir: string;
	agentName: string;
	verbose?: boolean;
	redactSecrets?: boolean;
}

/**
 * Create a multi-format logger that writes to session.log, events.ndjson,
 * tools.ndjson, and errors.log simultaneously.
 *
 * The logDir is created if it does not exist. All writes are fire-and-forget
 * (errors during file I/O are silently ignored to avoid log-induced crashes).
 */
export function createLogger(options: LoggerOptions): Logger {
	const { logDir, agentName, verbose = false, redactSecrets = true } = options;

	const sessionLogPath = join(logDir, "session.log");
	const eventsPath = join(logDir, "events.ndjson");
	const toolsPath = join(logDir, "tools.ndjson");
	const errorsPath = join(logDir, "errors.log");

	// Pending writes queue. We chain promises to guarantee ordering
	// within each file, but different files write independently.
	let dirReady: Promise<void> | null = null;
	let closed = false;

	/**
	 * Ensure the log directory exists. Called lazily on first write.
	 * Subsequent calls return the cached promise.
	 */
	function ensureDir(): Promise<void> {
		if (dirReady === null) {
			dirReady = mkdir(logDir, { recursive: true }).then(() => undefined);
		}
		return dirReady;
	}

	/**
	 * Append text to a file, ensuring the directory exists first.
	 * Errors are silently swallowed — logging must never crash the app.
	 */
	function safeAppend(filePath: string, content: string): void {
		if (closed) return;
		ensureDir()
			.then(() => appendFile(filePath, content, "utf-8"))
			.catch(() => {
				// Silently ignore write errors — logging should never crash the host
			});
	}

	/**
	 * Conditionally redact secrets from a string.
	 */
	function maybeRedact(input: string): string {
		return redactSecrets ? sanitize(input) : input;
	}

	/**
	 * Conditionally redact secrets from an object.
	 */
	function maybeRedactObject(obj: Record<string, unknown>): Record<string, unknown> {
		return redactSecrets ? sanitizeObject(obj) : obj;
	}

	/**
	 * Build a LogEvent and dispatch it to all relevant outputs.
	 */
	function emit(
		level: LogEvent["level"],
		event: string,
		data: Record<string, unknown>,
		error?: Error,
	): void {
		const safeData = maybeRedactObject(data);

		const logEvent: LogEvent = {
			timestamp: new Date().toISOString(),
			level,
			event,
			agentName,
			data: safeData,
		};

		// 1. Console output
		printToConsole(logEvent, verbose);

		// 2. session.log — human-readable line
		const kvPairs = formatKeyValues(safeData);
		const kvSuffix = kvPairs.length > 0 ? ` ${kvPairs}` : "";
		const sessionLine = `[${logEvent.timestamp}] ${level.toUpperCase()} ${event}${kvSuffix}\n`;
		safeAppend(sessionLogPath, sessionLine);

		// 3. events.ndjson — full event as JSON
		safeAppend(eventsPath, `${JSON.stringify(logEvent)}\n`);

		// 4. errors.log — stack traces with context (error level only)
		if (level === "error" && error) {
			const errorBlock = buildErrorBlock(logEvent, error);
			safeAppend(errorsPath, errorBlock);
		}
	}

	/**
	 * Emit a tool event to the tools.ndjson file (and also to events.ndjson).
	 */
	function emitTool(event: string, data: Record<string, unknown>): void {
		const safeData = maybeRedactObject(data);

		const logEvent: LogEvent = {
			timestamp: new Date().toISOString(),
			level: "info",
			event,
			agentName,
			data: safeData,
		};

		// Console output
		printToConsole(logEvent, verbose);

		// events.ndjson
		safeAppend(eventsPath, `${JSON.stringify(logEvent)}\n`);

		// tools.ndjson
		safeAppend(toolsPath, `${JSON.stringify(logEvent)}\n`);

		// session.log
		const kvPairs = formatKeyValues(safeData);
		const kvSuffix = kvPairs.length > 0 ? ` ${kvPairs}` : "";
		const sessionLine = `[${logEvent.timestamp}] INFO ${event}${kvSuffix}\n`;
		safeAppend(sessionLogPath, sessionLine);
	}

	return {
		info(event: string, data?: Record<string, unknown>): void {
			emit("info", event, data ?? {});
		},

		warn(event: string, data?: Record<string, unknown>): void {
			emit("warn", event, data ?? {});
		},

		error(event: string, err: Error, data?: Record<string, unknown>): void {
			const errorData: Record<string, unknown> = {
				...data,
				errorMessage: maybeRedact(err.message),
				errorName: err.name,
			};
			emit("error", event, errorData, err);
		},

		debug(event: string, data?: Record<string, unknown>): void {
			emit("debug", event, data ?? {});
		},

		toolStart(toolName: string, args: Record<string, unknown>): void {
			emitTool("tool.start", { toolName, args });
		},

		toolEnd(toolName: string, durationMs: number, result?: string): void {
			const data: Record<string, unknown> = { toolName, durationMs };
			if (result !== undefined) {
				data.result = maybeRedact(result);
			}
			emitTool("tool.end", data);
		},

		close(): void {
			closed = true;
		},
	};
}

/**
 * Format a data record as space-separated key=value pairs for session.log.
 */
function formatKeyValues(data: Record<string, unknown>): string {
	const entries = Object.entries(data);
	if (entries.length === 0) {
		return "";
	}

	return entries
		.map(([key, value]) => {
			if (value === undefined || value === null) {
				return `${key}=null`;
			}
			if (typeof value === "string") {
				return value.includes(" ") ? `${key}="${value}"` : `${key}=${value}`;
			}
			if (typeof value === "object") {
				return `${key}=${JSON.stringify(value)}`;
			}
			return `${key}=${String(value)}`;
		})
		.join(" ");
}

/**
 * Build a multi-line error block for errors.log.
 */
function buildErrorBlock(event: LogEvent, error: Error): string {
	const separator = "=".repeat(72);
	const lines: string[] = [
		separator,
		`Timestamp: ${event.timestamp}`,
		`Event:     ${event.event}`,
		`Agent:     ${event.agentName ?? "unknown"}`,
	];

	// Include data fields
	const dataEntries = Object.entries(event.data);
	if (dataEntries.length > 0) {
		lines.push(`Data:      ${JSON.stringify(event.data)}`);
	}

	lines.push("");
	lines.push(`Error:     ${error.name}: ${error.message}`);

	if (error.stack) {
		lines.push("");
		lines.push("Stack Trace:");
		lines.push(error.stack);
	}

	if (error.cause instanceof Error) {
		lines.push("");
		lines.push(`Caused by: ${error.cause.name}: ${error.cause.message}`);
		if (error.cause.stack) {
			lines.push(error.cause.stack);
		}
	}

	lines.push(separator);
	lines.push("");

	return lines.join("\n");
}
