import { readFile } from "node:fs/promises";

/**
 * Parser for Claude Code transcript JSONL files.
 *
 * Extracts token usage data from assistant-type entries in transcript files
 * at ~/.claude/projects/{project-slug}/{session-id}.jsonl.
 *
 * Each assistant entry contains per-turn usage:
 * {
 *   "type": "assistant",
 *   "message": {
 *     "model": "claude-opus-4-6",
 *     "usage": {
 *       "input_tokens": 3,
 *       "output_tokens": 9,
 *       "cache_read_input_tokens": 19401,
 *       "cache_creation_input_tokens": 9918
 *     }
 *   }
 * }
 */

export interface TranscriptUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	modelUsed: string | null;
}

/** A single extracted text message from a transcript entry. */
export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
}

/** Pricing per million tokens (USD). */
interface ModelPricing {
	inputPerMTok: number;
	outputPerMTok: number;
	cacheReadPerMTok: number;
	cacheCreationPerMTok: number;
}

/** Hardcoded pricing for known Claude models. */
const MODEL_PRICING: Record<string, ModelPricing> = {
	opus: {
		inputPerMTok: 15,
		outputPerMTok: 75,
		cacheReadPerMTok: 1.5, // 10% of input
		cacheCreationPerMTok: 3.75, // 25% of input
	},
	sonnet: {
		inputPerMTok: 3,
		outputPerMTok: 15,
		cacheReadPerMTok: 0.3, // 10% of input
		cacheCreationPerMTok: 0.75, // 25% of input
	},
	haiku: {
		inputPerMTok: 0.8,
		outputPerMTok: 4,
		cacheReadPerMTok: 0.08, // 10% of input
		cacheCreationPerMTok: 0.2, // 25% of input
	},
};

/**
 * Determine the pricing tier for a given model string.
 * Matches on substring: "opus" -> opus pricing, "sonnet" -> sonnet, "haiku" -> haiku.
 * Returns null if unrecognized.
 */
function getPricingForModel(model: string): ModelPricing | null {
	const lower = model.toLowerCase();
	if (lower.includes("opus")) return MODEL_PRICING.opus ?? null;
	if (lower.includes("sonnet")) return MODEL_PRICING.sonnet ?? null;
	if (lower.includes("haiku")) return MODEL_PRICING.haiku ?? null;
	return null;
}

/**
 * Calculate the estimated cost in USD for a given usage and model.
 * Returns null if the model is unrecognized.
 */
export function estimateCost(usage: TranscriptUsage): number | null {
	if (usage.modelUsed === null) return null;

	const pricing = getPricingForModel(usage.modelUsed);
	if (pricing === null) return null;

	const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMTok;
	const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
	const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok;
	const cacheCreationCost = (usage.cacheCreationTokens / 1_000_000) * pricing.cacheCreationPerMTok;

	return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Narrow an unknown value to determine if it looks like a transcript assistant entry.
 * Returns the usage fields if valid, or null otherwise.
 */
function extractUsageFromEntry(entry: unknown): {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	model: string | undefined;
} | null {
	if (typeof entry !== "object" || entry === null) return null;

	const obj = entry as Record<string, unknown>;
	if (obj.type !== "assistant") return null;

	const message = obj.message;
	if (typeof message !== "object" || message === null) return null;

	const msg = message as Record<string, unknown>;
	const usage = msg.usage;
	if (typeof usage !== "object" || usage === null) return null;

	const u = usage as Record<string, unknown>;

	return {
		inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
		outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
		cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
		cacheCreationTokens:
			typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
		model: typeof msg.model === "string" ? msg.model : undefined,
	};
}

/**
 * Extract the first text block content from an assistant transcript entry.
 * Returns the text string, or null if the entry is not an assistant turn
 * or contains no text content block.
 */
export function extractAssistantText(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null) return null;

	const obj = entry as Record<string, unknown>;
	if (obj.type !== "assistant") return null;

	const message = obj.message;
	if (typeof message !== "object" || message === null) return null;

	const msg = message as Record<string, unknown>;
	const content = msg.content;

	if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "object" && block !== null) {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
					return b.text;
				}
			}
		}
	}

	return null;
}

/**
 * Extract text content from a human transcript entry.
 * Returns the first non-empty text block content, or null.
 */
function extractHumanText(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null) return null;

	const obj = entry as Record<string, unknown>;
	if (obj.type !== "human") return null;

	const message = obj.message;
	if (typeof message !== "object" || message === null) return null;

	const msg = message as Record<string, unknown>;
	const content = msg.content;

	// Content may be a string or an array of blocks
	if (typeof content === "string" && content.length > 0) {
		return content;
	}

	if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "object" && block !== null) {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
					return b.text;
				}
			} else if (typeof block === "string" && block.length > 0) {
				return block;
			}
		}
	}

	return null;
}

/**
 * Parse a Claude Code transcript JSONL file and extract text messages.
 *
 * Reads from a given line offset (for incremental parsing across calls).
 * Returns extracted messages with role ("user" | "assistant") and the
 * next line index to use for the subsequent call.
 *
 * @param transcriptPath - Absolute path to the transcript JSONL file
 * @param fromLine - 0-based line index to start reading from (default 0)
 * @returns Messages found and the next line index
 */
export async function parseTranscriptTexts(
	transcriptPath: string,
	fromLine = 0,
): Promise<{ messages: TranscriptMessage[]; nextLine: number }> {
	const fileText = await readFile(transcriptPath, "utf-8");
	const lines = fileText.split("\n");

	// When a JSONL file ends with \n, split() produces a trailing empty element.
	// Exclude it from the watermark so that appended lines at that position are
	// correctly processed on the next incremental call.
	const lastLine = lines[lines.length - 1] ?? "";
	const nextLine = lastLine.trim().length === 0 ? lines.length - 1 : lines.length;

	const messages: TranscriptMessage[] = [];

	for (let i = fromLine; i < lines.length; i++) {
		const trimmed = lines[i]?.trim() ?? "";
		if (trimmed.length === 0) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (typeof parsed !== "object" || parsed === null) continue;
		const obj = parsed as Record<string, unknown>;

		if (obj.type === "assistant") {
			const text = extractAssistantText(parsed);
			if (text !== null) {
				messages.push({ role: "assistant", text });
			}
		} else if (obj.type === "human") {
			const text = extractHumanText(parsed);
			if (text !== null) {
				messages.push({ role: "user", text });
			}
		}
	}

	return { messages, nextLine };
}

/**
 * Parse a Claude Code transcript JSONL file and aggregate token usage.
 *
 * Reads the file line by line, extracting usage data from each assistant
 * entry. Returns aggregated totals and the model from the first assistant turn.
 *
 * @param transcriptPath - Absolute path to the transcript JSONL file
 * @returns Aggregated usage data across all assistant turns
 */
export async function parseTranscriptUsage(transcriptPath: string): Promise<TranscriptUsage> {
	const text = await readFile(transcriptPath, "utf-8");
	const lines = text.split("\n");

	const result: TranscriptUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		modelUsed: null,
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Skip malformed lines
			continue;
		}

		const usage = extractUsageFromEntry(parsed);
		if (usage === null) continue;

		result.inputTokens += usage.inputTokens;
		result.outputTokens += usage.outputTokens;
		result.cacheReadTokens += usage.cacheReadTokens;
		result.cacheCreationTokens += usage.cacheCreationTokens;

		// Capture model from first assistant turn
		if (result.modelUsed === null && usage.model !== undefined) {
			result.modelUsed = usage.model;
		}
	}

	return result;
}
