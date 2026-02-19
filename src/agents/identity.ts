import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentError } from "../errors.ts";
import type { AgentIdentity } from "../types.ts";

const IDENTITY_FILENAME = "identity.yaml";
const MAX_RECENT_TASKS = 20;

// === YAML Serialization ===

/**
 * Serialize an AgentIdentity to a YAML string.
 *
 * Produces simple key-value pairs with proper indentation.
 * Arrays of scalars use `- item` syntax.
 * Arrays of objects use `- key: value` with indented continuation lines.
 */
function serializeIdentityYaml(identity: AgentIdentity): string {
	const lines: string[] = [];

	lines.push(`name: ${quoteIfNeeded(identity.name)}`);
	lines.push(`capability: ${quoteIfNeeded(identity.capability)}`);
	lines.push(`created: ${quoteIfNeeded(identity.created)}`);
	lines.push(`sessionsCompleted: ${identity.sessionsCompleted}`);

	// expertiseDomains
	if (identity.expertiseDomains.length === 0) {
		lines.push("expertiseDomains: []");
	} else {
		lines.push("expertiseDomains:");
		for (const domain of identity.expertiseDomains) {
			lines.push(`\t- ${quoteIfNeeded(domain)}`);
		}
	}

	// recentTasks (array of objects)
	if (identity.recentTasks.length === 0) {
		lines.push("recentTasks: []");
	} else {
		lines.push("recentTasks:");
		for (const task of identity.recentTasks) {
			lines.push(`\t- beadId: ${quoteIfNeeded(task.beadId)}`);
			lines.push(`\t\tsummary: ${quoteIfNeeded(task.summary)}`);
			lines.push(`\t\tcompletedAt: ${quoteIfNeeded(task.completedAt)}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Quote a string value if it contains characters that could be misinterpreted
 * by a YAML parser (colons, hashes, leading/trailing whitespace, etc.).
 */
function quoteIfNeeded(value: string): string {
	if (
		value === "" ||
		value.includes(": ") ||
		value.includes("#") ||
		value.startsWith(" ") ||
		value.endsWith(" ") ||
		value.startsWith('"') ||
		value.startsWith("'") ||
		value === "true" ||
		value === "false" ||
		value === "null" ||
		value === "~" ||
		/^\d/.test(value)
	) {
		// Use double quotes, escaping internal double quotes
		const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${escaped}"`;
	}
	return value;
}

// === YAML Deserialization ===

/**
 * Parse an AgentIdentity YAML file into a structured object.
 *
 * This is a purpose-built parser for the identity YAML format. It handles:
 * - Simple key: value pairs (strings, numbers)
 * - Arrays of scalars (expertiseDomains)
 * - Arrays of objects (recentTasks with beadId, summary, completedAt)
 * - Empty arrays (`[]`)
 * - Quoted strings
 * - Tab indentation
 */
function parseIdentityYaml(text: string): AgentIdentity {
	const lines = text.split("\n");

	let name = "";
	let capability = "";
	let created = "";
	let sessionsCompleted = 0;
	const expertiseDomains: string[] = [];
	const recentTasks: Array<{ beadId: string; summary: string; completedAt: string }> = [];

	let currentSection: "none" | "expertiseDomains" | "recentTasks" = "none";
	let currentTask: { beadId: string; summary: string; completedAt: string } | null = null;

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();

		// Skip empty lines and comments
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// Top-level key: value (no leading whitespace)
		if (!rawLine.startsWith("\t") && !rawLine.startsWith(" ")) {
			// Flush any pending task
			if (currentTask !== null) {
				recentTasks.push(currentTask);
				currentTask = null;
			}

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const key = trimmed.slice(0, colonIndex).trim();
			const rawValue = trimmed.slice(colonIndex + 1).trim();

			switch (key) {
				case "name":
					name = parseScalar(rawValue);
					currentSection = "none";
					break;
				case "capability":
					capability = parseScalar(rawValue);
					currentSection = "none";
					break;
				case "created":
					created = parseScalar(rawValue);
					currentSection = "none";
					break;
				case "sessionsCompleted":
					sessionsCompleted = Number.parseInt(parseScalar(rawValue), 10) || 0;
					currentSection = "none";
					break;
				case "expertiseDomains":
					if (rawValue === "[]") {
						currentSection = "none";
					} else {
						currentSection = "expertiseDomains";
					}
					break;
				case "recentTasks":
					if (rawValue === "[]") {
						currentSection = "none";
					} else {
						currentSection = "recentTasks";
					}
					break;
			}
			continue;
		}

		// Indented line: array items or nested object properties
		if (currentSection === "expertiseDomains") {
			if (trimmed.startsWith("- ")) {
				expertiseDomains.push(parseScalar(trimmed.slice(2).trim()));
			}
			continue;
		}

		if (currentSection === "recentTasks") {
			if (trimmed.startsWith("- ")) {
				// New array item — flush previous task
				if (currentTask !== null) {
					recentTasks.push(currentTask);
				}
				currentTask = { beadId: "", summary: "", completedAt: "" };

				// Parse the key-value on the same line as the dash
				const itemContent = trimmed.slice(2).trim();
				const itemColonIdx = itemContent.indexOf(":");
				if (itemColonIdx !== -1) {
					const itemKey = itemContent.slice(0, itemColonIdx).trim();
					const itemValue = parseScalar(itemContent.slice(itemColonIdx + 1).trim());
					assignTaskField(currentTask, itemKey, itemValue);
				}
			} else if (currentTask !== null) {
				// Continuation line for current task object
				const colonIdx = trimmed.indexOf(":");
				if (colonIdx !== -1) {
					const fieldKey = trimmed.slice(0, colonIdx).trim();
					const fieldValue = parseScalar(trimmed.slice(colonIdx + 1).trim());
					assignTaskField(currentTask, fieldKey, fieldValue);
				}
			}
		}
	}

	// Flush final pending task
	if (currentTask !== null) {
		recentTasks.push(currentTask);
	}

	return {
		name,
		capability,
		created,
		sessionsCompleted,
		expertiseDomains,
		recentTasks,
	};
}

/**
 * Assign a parsed field value to a task object by key name.
 */
function assignTaskField(
	task: { beadId: string; summary: string; completedAt: string },
	key: string,
	value: string,
): void {
	switch (key) {
		case "beadId":
			task.beadId = value;
			break;
		case "summary":
			task.summary = value;
			break;
		case "completedAt":
			task.completedAt = value;
			break;
	}
}

/**
 * Parse a scalar YAML value, stripping quotes if present.
 */
function parseScalar(raw: string): string {
	if (raw.length >= 2) {
		if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
			return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	return raw;
}

// === Public API ===

/**
 * Create a new agent identity file.
 *
 * Writes the identity to `{baseDir}/{identity.name}/identity.yaml`,
 * creating the directory if it doesn't exist.
 *
 * @param baseDir - Absolute path to the agents base directory (e.g., `.legio/agents`)
 * @param identity - The AgentIdentity to persist
 */
export async function createIdentity(baseDir: string, identity: AgentIdentity): Promise<void> {
	const filePath = join(baseDir, identity.name, IDENTITY_FILENAME);
	const dir = dirname(filePath);

	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		throw new AgentError(`Failed to create identity directory: ${dir}`, {
			agentName: identity.name,
			cause: err instanceof Error ? err : undefined,
		});
	}

	const yaml = serializeIdentityYaml(identity);

	try {
		await writeFile(filePath, yaml);
	} catch (err) {
		throw new AgentError(`Failed to write identity file: ${filePath}`, {
			agentName: identity.name,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Load an existing agent identity from disk.
 *
 * Reads from `{baseDir}/{name}/identity.yaml`. Returns null if the file
 * does not exist.
 *
 * @param baseDir - Absolute path to the agents base directory
 * @param name - Agent name (used as subdirectory)
 * @returns The loaded AgentIdentity, or null if not found
 */
export async function loadIdentity(baseDir: string, name: string): Promise<AgentIdentity | null> {
	const filePath = join(baseDir, name, IDENTITY_FILENAME);
	const exists = await access(filePath).then(() => true).catch(() => false);

	if (!exists) {
		return null;
	}

	let text: string;
	try {
		text = await readFile(filePath, "utf-8");
	} catch (err) {
		throw new AgentError(`Failed to read identity file: ${filePath}`, {
			agentName: name,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		return parseIdentityYaml(text);
	} catch (err) {
		throw new AgentError(`Failed to parse identity YAML: ${filePath}`, {
			agentName: name,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Update an existing agent identity.
 *
 * Loads the identity, applies updates, writes back, and returns the result.
 *
 * Supported updates:
 * - `sessionsCompleted`: Incremented by the given value (additive)
 * - `expertiseDomains`: Merged with existing (deduplicating)
 * - `completedTask`: Appended to `recentTasks` with a current ISO timestamp
 *
 * The `recentTasks` list is capped at 20 entries; oldest entries are dropped.
 *
 * @param baseDir - Absolute path to the agents base directory
 * @param name - Agent name
 * @param update - Partial update to apply
 * @returns The updated AgentIdentity
 * @throws AgentError if the identity does not exist
 */
export async function updateIdentity(
	baseDir: string,
	name: string,
	update: Partial<Pick<AgentIdentity, "sessionsCompleted" | "expertiseDomains">> & {
		completedTask?: { beadId: string; summary: string };
	},
): Promise<AgentIdentity> {
	const identity = await loadIdentity(baseDir, name);

	if (identity === null) {
		throw new AgentError(`Agent identity not found: ${name}`, {
			agentName: name,
		});
	}

	// Increment sessionsCompleted
	if (update.sessionsCompleted !== undefined) {
		identity.sessionsCompleted += update.sessionsCompleted;
	}

	// Merge expertiseDomains (deduplicate)
	if (update.expertiseDomains !== undefined) {
		const existing = new Set(identity.expertiseDomains);
		for (const domain of update.expertiseDomains) {
			existing.add(domain);
		}
		identity.expertiseDomains = [...existing];
	}

	// Append completed task
	if (update.completedTask !== undefined) {
		identity.recentTasks.push({
			beadId: update.completedTask.beadId,
			summary: update.completedTask.summary,
			completedAt: new Date().toISOString(),
		});

		// Cap at MAX_RECENT_TASKS, dropping oldest
		if (identity.recentTasks.length > MAX_RECENT_TASKS) {
			identity.recentTasks = identity.recentTasks.slice(
				identity.recentTasks.length - MAX_RECENT_TASKS,
			);
		}
	}

	// Write back
	await createIdentity(baseDir, identity);

	return identity;
}
