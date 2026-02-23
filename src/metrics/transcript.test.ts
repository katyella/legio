/**
 * Tests for Claude Code transcript JSONL parser.
 *
 * Uses temp files with real-format JSONL data. No mocks.
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupTempDir } from "../test-helpers.ts";
import { estimateCost, extractAssistantText, parseTranscriptTexts, parseTranscriptUsage } from "./transcript.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "legio-transcript-test-"));
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

/** Write a JSONL file with the given lines. */
async function writeJsonl(filename: string, lines: unknown[]): Promise<string> {
	const path = join(tempDir, filename);
	const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	await writeFile(path, content, "utf8");
	return path;
}

// === parseTranscriptUsage ===

describe("parseTranscriptUsage", () => {
	test("parses a single assistant entry with all usage fields", async () => {
		const path = await writeJsonl("single.jsonl", [
			{
				type: "assistant",
				message: {
					model: "claude-opus-4-6",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 1000,
						cache_creation_input_tokens: 500,
					},
				},
			},
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(50);
		expect(usage.cacheReadTokens).toBe(1000);
		expect(usage.cacheCreationTokens).toBe(500);
		expect(usage.modelUsed).toBe("claude-opus-4-6");
	});

	test("aggregates usage across multiple assistant turns", async () => {
		const path = await writeJsonl("multi.jsonl", [
			{
				type: "assistant",
				message: {
					model: "claude-sonnet-4-20250514",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 1000,
						cache_creation_input_tokens: 500,
					},
				},
			},
			{
				type: "human",
				message: { content: "follow-up question" },
			},
			{
				type: "assistant",
				message: {
					model: "claude-sonnet-4-20250514",
					usage: {
						input_tokens: 200,
						output_tokens: 75,
						cache_read_input_tokens: 2000,
						cache_creation_input_tokens: 0,
					},
				},
			},
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(300);
		expect(usage.outputTokens).toBe(125);
		expect(usage.cacheReadTokens).toBe(3000);
		expect(usage.cacheCreationTokens).toBe(500);
		expect(usage.modelUsed).toBe("claude-sonnet-4-20250514");
	});

	test("skips non-assistant entries (human, system, tool_use, etc.)", async () => {
		const path = await writeJsonl("mixed.jsonl", [
			{ type: "system", content: "system prompt" },
			{
				type: "assistant",
				message: {
					model: "claude-opus-4-6",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "human", message: { content: "hello" } },
			{ type: "tool_result", content: "result" },
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(50);
	});

	test("returns zeros for empty file", async () => {
		const path = join(tempDir, "empty.jsonl");
		await writeFile(path, "", "utf8");

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.cacheReadTokens).toBe(0);
		expect(usage.cacheCreationTokens).toBe(0);
		expect(usage.modelUsed).toBeNull();
	});

	test("returns zeros for file with no assistant entries", async () => {
		const path = await writeJsonl("no-assistant.jsonl", [
			{ type: "human", message: { content: "hello" } },
			{ type: "system", content: "system prompt" },
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.modelUsed).toBeNull();
	});

	test("gracefully handles malformed JSON lines", async () => {
		const path = join(tempDir, "malformed.jsonl");
		const content = [
			'{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
			"this is not valid json",
			"",
			'{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":200,"output_tokens":75,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
		].join("\n");
		await writeFile(path, content, "utf8");

		const usage = await parseTranscriptUsage(path);

		// Should parse the two valid assistant entries, skip the malformed line
		expect(usage.inputTokens).toBe(300);
		expect(usage.outputTokens).toBe(125);
	});

	test("handles assistant entries with missing usage fields (defaults to 0)", async () => {
		const path = await writeJsonl("partial.jsonl", [
			{
				type: "assistant",
				message: {
					model: "claude-haiku-3-5-20241022",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						// No cache fields
					},
				},
			},
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(100);
		expect(usage.outputTokens).toBe(50);
		expect(usage.cacheReadTokens).toBe(0);
		expect(usage.cacheCreationTokens).toBe(0);
	});

	test("handles assistant entries with no usage object", async () => {
		const path = await writeJsonl("no-usage.jsonl", [
			{
				type: "assistant",
				message: {
					model: "claude-opus-4-6",
					content: "response without usage",
				},
			},
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(0);
		expect(usage.outputTokens).toBe(0);
		expect(usage.modelUsed).toBeNull();
	});

	test("captures model from first assistant turn only", async () => {
		const path = await writeJsonl("model-change.jsonl", [
			{
				type: "assistant",
				message: {
					model: "claude-sonnet-4-20250514",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "assistant",
				message: {
					model: "claude-opus-4-6",
					usage: {
						input_tokens: 20,
						output_tokens: 10,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
		]);

		const usage = await parseTranscriptUsage(path);

		expect(usage.modelUsed).toBe("claude-sonnet-4-20250514");
		expect(usage.inputTokens).toBe(30);
	});

	test("handles real-world transcript format with trailing newlines", async () => {
		const path = join(tempDir, "trailing.jsonl");
		const content =
			'{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":3,"output_tokens":9,"cache_read_input_tokens":19401,"cache_creation_input_tokens":9918}}}\n\n\n';
		await writeFile(path, content, "utf8");

		const usage = await parseTranscriptUsage(path);

		expect(usage.inputTokens).toBe(3);
		expect(usage.outputTokens).toBe(9);
		expect(usage.cacheReadTokens).toBe(19401);
		expect(usage.cacheCreationTokens).toBe(9918);
	});
});

// === estimateCost ===

describe("estimateCost", () => {
	test("calculates cost for opus 4.6 model (new pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-opus-4-6",
		});

		// opus 4.5+: input=$5, output=$25, cacheRead=$0.50, cacheCreation=$1.25
		expect(cost).toBeCloseTo(31.75, 2);
	});

	test("calculates cost for opus 4.5 model (new pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-opus-4-5",
		});

		// opus 4.5+: input=$5, output=$25, cacheRead=$0.50, cacheCreation=$1.25
		expect(cost).toBeCloseTo(31.75, 2);
	});

	test("calculates cost for opus 4 model (legacy pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-opus-4",
		});

		// opus legacy: input=$15, output=$75, cacheRead=$1.50, cacheCreation=$3.75
		expect(cost).toBeCloseTo(95.25, 2);
	});

	test("calculates cost for opus 4.1 model (legacy pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-opus-4-1",
		});

		// opus legacy: input=$15, output=$75, cacheRead=$1.50, cacheCreation=$3.75
		expect(cost).toBeCloseTo(95.25, 2);
	});

	test("calculates cost for sonnet model", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-sonnet-4-20250514",
		});

		// sonnet: input=$3, output=$15, cacheRead=$0.30, cacheCreation=$0.75
		expect(cost).toBeCloseTo(19.05, 2);
	});

	test("calculates cost for haiku 3.5 model (legacy pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-haiku-3-5-20241022",
		});

		// haiku legacy: input=$0.80, output=$4, cacheRead=$0.08, cacheCreation=$0.20
		expect(cost).toBeCloseTo(5.08, 2);
	});

	test("calculates cost for haiku 4.5 model (new pricing)", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheCreationTokens: 1_000_000,
			modelUsed: "claude-haiku-4-5-20251001",
		});

		// haiku 4.5+: input=$1, output=$5, cacheRead=$0.10, cacheCreation=$0.25
		expect(cost).toBeCloseTo(6.35, 2);
	});

	test("returns null for unknown model", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "gpt-4o",
		});

		expect(cost).toBeNull();
	});

	test("returns null when modelUsed is null", () => {
		const cost = estimateCost({
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: null,
		});

		expect(cost).toBeNull();
	});

	test("zero tokens yields zero cost", () => {
		const cost = estimateCost({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			modelUsed: "claude-opus-4-6",
		});

		expect(cost).toBe(0);
	});

	test("realistic session cost calculation", () => {
		// A typical agent session: ~20K input, ~5K output, heavy cache reads
		const cost = estimateCost({
			inputTokens: 20_000,
			outputTokens: 5_000,
			cacheReadTokens: 100_000,
			cacheCreationTokens: 15_000,
			modelUsed: "claude-sonnet-4-20250514",
		});

		// sonnet: (20K/1M)*3 + (5K/1M)*15 + (100K/1M)*0.30 + (15K/1M)*0.75
		// = 0.06 + 0.075 + 0.03 + 0.01125 = $0.17625
		expect(cost).not.toBeNull();
		if (cost !== null) {
			expect(cost).toBeGreaterThan(0.1);
			expect(cost).toBeLessThan(1.0);
		}
	});
});

// === extractAssistantText ===

describe("extractAssistantText", () => {
	test("returns text from assistant entry with text content block", () => {
		const entry = {
			type: "assistant",
			message: {
				model: "claude-opus-4-6",
				content: [{ type: "text", text: "Hello, how can I help?" }],
			},
		};
		expect(extractAssistantText(entry)).toBe("Hello, how can I help?");
	});

	test("returns first text block when multiple content blocks", () => {
		const entry = {
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "abc", name: "Bash", input: { command: "ls" } },
					{ type: "text", text: "I ran a command." },
				],
			},
		};
		expect(extractAssistantText(entry)).toBe("I ran a command.");
	});

	test("returns null for non-assistant entry type", () => {
		const entry = {
			type: "human",
			message: { content: [{ type: "text", text: "Hello" }] },
		};
		expect(extractAssistantText(entry)).toBeNull();
	});

	test("returns null when content array has no text blocks", () => {
		const entry = {
			type: "assistant",
			message: {
				content: [{ type: "tool_use", id: "x", name: "Read", input: {} }],
			},
		};
		expect(extractAssistantText(entry)).toBeNull();
	});

	test("returns null for entry with no message", () => {
		const entry = { type: "assistant" };
		expect(extractAssistantText(entry)).toBeNull();
	});

	test("returns null for null input", () => {
		expect(extractAssistantText(null)).toBeNull();
	});

	test("returns null for non-object input", () => {
		expect(extractAssistantText("not an object")).toBeNull();
	});

	test("skips empty text blocks and returns first non-empty one", () => {
		const entry = {
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "" },
					{ type: "text", text: "Actual response." },
				],
			},
		};
		expect(extractAssistantText(entry)).toBe("Actual response.");
	});
});

// === parseTranscriptTexts ===

describe("parseTranscriptTexts", () => {
	test("extracts both user and assistant messages", async () => {
		const path = await writeJsonl("mixed-roles.jsonl", [
			{
				type: "human",
				message: { content: [{ type: "text", text: "What is 2+2?" }] },
			},
			{
				type: "assistant",
				message: {
					model: "claude-opus-4-6",
					content: [{ type: "text", text: "2+2 equals 4." }],
				},
			},
		]);

		const { messages, nextLine } = await parseTranscriptTexts(path);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "user", text: "What is 2+2?" });
		expect(messages[1]).toEqual({ role: "assistant", text: "2+2 equals 4." });
		expect(nextLine).toBe(2); // 2 JSON lines; trailing empty excluded from watermark
	});

	test("returns empty array for file with no human or assistant entries", async () => {
		const path = await writeJsonl("system-only.jsonl", [
			{ type: "system", content: "system prompt" },
		]);

		const { messages } = await parseTranscriptTexts(path);
		expect(messages).toHaveLength(0);
	});

	test("skips entries with no text content", async () => {
		const path = await writeJsonl("no-text.jsonl", [
			{
				type: "assistant",
				message: {
					content: [{ type: "tool_use", name: "Bash", id: "x", input: {} }],
				},
			},
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Done." }],
				},
			},
		]);

		const { messages } = await parseTranscriptTexts(path);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({ role: "assistant", text: "Done." });
	});

	test("respects fromLine offset for incremental parsing", async () => {
		const path = await writeJsonl("incremental.jsonl", [
			{
				type: "human",
				message: { content: [{ type: "text", text: "First message" }] },
			},
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "First response" }] },
			},
			{
				type: "human",
				message: { content: [{ type: "text", text: "Second message" }] },
			},
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Second response" }] },
			},
		]);

		// First call: get all
		const first = await parseTranscriptTexts(path, 0);
		expect(first.messages).toHaveLength(4);

		// Second call: start from where first call ended
		const second = await parseTranscriptTexts(path, first.nextLine);
		expect(second.messages).toHaveLength(0);
		expect(second.nextLine).toBe(first.nextLine);
	});

	test("incremental parsing captures only new messages after offset", async () => {
		const path = join(tempDir, "growing.jsonl");

		// Write first two entries
		const lines1 = [
			{ type: "human", message: { content: [{ type: "text", text: "Hello" }] } },
			{ type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } },
		];
		await writeFile(path, `${lines1.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

		const first = await parseTranscriptTexts(path, 0);
		expect(first.messages).toHaveLength(2);

		// Append two more entries
		const lines2 = [
			{ type: "human", message: { content: [{ type: "text", text: "How are you?" }] } },
			{ type: "assistant", message: { content: [{ type: "text", text: "I'm great!" }] } },
		];
		const { appendFile } = await import("node:fs/promises");
		await appendFile(path, `${lines2.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");

		// Second call with offset from first call
		const second = await parseTranscriptTexts(path, first.nextLine);
		expect(second.messages).toHaveLength(2);
		expect(second.messages[0]).toEqual({ role: "user", text: "How are you?" });
		expect(second.messages[1]).toEqual({ role: "assistant", text: "I'm great!" });
	});

	test("returns empty array for empty file", async () => {
		const path = join(tempDir, "empty-texts.jsonl");
		await writeFile(path, "", "utf8");

		const { messages, nextLine } = await parseTranscriptTexts(path);
		expect(messages).toHaveLength(0);
		expect(nextLine).toBe(0); // split("") gives [""] — trailing empty excluded → 0
	});

	test("handles human entry with string content", async () => {
		const path = await writeJsonl("human-string.jsonl", [
			{
				type: "human",
				message: { content: "Plain string message" },
			},
		]);

		const { messages } = await parseTranscriptTexts(path);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({ role: "user", text: "Plain string message" });
	});

	test("skips malformed JSON lines gracefully", async () => {
		const path = join(tempDir, "malformed-texts.jsonl");
		const content = [
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "Valid" }] },
			}),
			"this is not json",
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: "Also valid" }] },
			}),
		].join("\n");
		await writeFile(path, content, "utf8");

		const { messages } = await parseTranscriptTexts(path);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.text).toBe("Valid");
		expect(messages[1]?.text).toBe("Also valid");
	});
});
