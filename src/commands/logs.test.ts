import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import type { LogEvent } from "../types.ts";
import { logsCommand } from "./logs.ts";

/**
 * Test helper: capture stdout during command execution.
 * Since logsCommand writes to process.stdout.write, we temporarily replace it.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	let output = "";
	const originalWrite = process.stdout.write;

	process.stdout.write = ((chunk: string) => {
		output += chunk;
		return true;
	}) as typeof process.stdout.write;

	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}

	return output;
}

describe("logsCommand", () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(async () => {
		// Create a temp directory for each test
		tmpDir = join(
			tmpdir(),
			`legio-logs-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		);
		await mkdir(tmpDir, { recursive: true });

		// Save original cwd and change to tmpDir so loadConfig finds our test config
		originalCwd = process.cwd();
		process.chdir(tmpDir);
	});

	afterEach(async () => {
		// Restore cwd
		process.chdir(originalCwd);

		// Clean up temp directory
		try {
			await rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Helper: create a minimal config.yaml in tmpDir.
	 */
	async function createConfig(): Promise<void> {
		const legioDir = join(tmpDir, ".legio");
		await mkdir(legioDir, { recursive: true });

		const configContent = `project:
  name: test-project
  root: ${tmpDir}
  canonicalBranch: main
`;

		await writeFile(join(legioDir, "config.yaml"), configContent, "utf-8");
	}

	/**
	 * Helper: create an events.ndjson file for a given agent and session.
	 */
	async function createLogFile(
		agentName: string,
		sessionTimestamp: string,
		events: LogEvent[],
	): Promise<void> {
		const logsDir = join(tmpDir, ".legio", "logs", agentName, sessionTimestamp);
		await mkdir(logsDir, { recursive: true });

		const ndjson = events.map((e) => JSON.stringify(e)).join("\n");
		await writeFile(join(logsDir, "events.ndjson"), ndjson, "utf-8");
	}

	test("shows help text", async () => {
		await createConfig();

		const output = await captureStdout(async () => {
			await logsCommand(["--help"]);
		});

		expect(output).toContain("legio logs");
		expect(output).toContain("--agent");
		expect(output).toContain("--level");
		expect(output).toContain("--since");
	});

	test("no logs directory returns gracefully", async () => {
		await createConfig();
		// Do NOT create logs directory

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		expect(output).toContain("No log files found");
	});

	test("lists all entries across agents", async () => {
		await createConfig();

		const eventsAgentA: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: { toolName: "Bash" },
			},
		];

		const eventsAgentB: LogEvent[] = [
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "error",
				event: "spawn.failed",
				agentName: "agent-b",
				data: { errorMessage: "worktree exists" },
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", eventsAgentA);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", eventsAgentB);

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		expect(output).toContain("tool.start");
		expect(output).toContain("agent-a");
		expect(output).toContain("spawn.failed");
		expect(output).toContain("agent-b");
		expect(output).toContain("2 entries");
	});

	test("filters by agent", async () => {
		await createConfig();

		const eventsAgentA: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: {},
			},
		];

		const eventsAgentB: LogEvent[] = [
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "info",
				event: "worker.done",
				agentName: "agent-b",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", eventsAgentA);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", eventsAgentB);

		const output = await captureStdout(async () => {
			await logsCommand(["--agent", "agent-a"]);
		});

		expect(output).toContain("tool.start");
		expect(output).toContain("agent-a");
		expect(output).not.toContain("worker.done");
		expect(output).not.toContain("agent-b");
	});

	test("filters by level", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "info.event",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T10:01:00.000Z",
				level: "error",
				event: "error.event",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T10:02:00.000Z",
				level: "warn",
				event: "warn.event",
				agentName: "agent-a",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--level", "error"]);
		});

		expect(output).toContain("error.event");
		expect(output).not.toContain("info.event");
		expect(output).not.toContain("warn.event");
		expect(output).toContain("1 entry");
	});

	test("respects --limit", async () => {
		await createConfig();

		const events: LogEvent[] = [];
		for (let i = 0; i < 10; i++) {
			events.push({
				timestamp: `2026-01-01T10:${i.toString().padStart(2, "0")}:00.000Z`,
				level: "info",
				event: `event-${i}`,
				agentName: "agent-a",
				data: {},
			});
		}

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--limit", "3"]);
		});

		// Should show the 3 most recent entries (event-7, event-8, event-9)
		expect(output).toContain("3 entries");
		expect(output).toContain("event-7");
		expect(output).toContain("event-8");
		expect(output).toContain("event-9");
		expect(output).not.toContain("event-0");
		expect(output).not.toContain("event-6");
	});

	test("JSON output", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "tool.start",
				agentName: "agent-a",
				data: { toolName: "Bash" },
			},
			{
				timestamp: "2026-01-02T11:00:00.000Z",
				level: "error",
				event: "spawn.failed",
				agentName: "agent-b",
				data: { errorMessage: "worktree exists" },
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", [events[0] as LogEvent]);
		await createLogFile("agent-b", "2026-01-02T00-00-00-000Z", [events[1] as LogEvent]);

		const output = await captureStdout(async () => {
			await logsCommand(["--json"]);
		});

		// Parse JSON output
		const parsed: unknown = JSON.parse(output.trim());
		expect(Array.isArray(parsed)).toBe(true);

		const arr = parsed as LogEvent[];
		expect(arr).toHaveLength(2);
		expect(arr[0]?.event).toBe("tool.start");
		expect(arr[1]?.event).toBe("spawn.failed");
	});

	test("filters by --since with ISO timestamp", async () => {
		await createConfig();

		const events: LogEvent[] = [
			{
				timestamp: "2026-01-01T10:00:00.000Z",
				level: "info",
				event: "event-10:00",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T11:00:00.000Z",
				level: "info",
				event: "event-11:00",
				agentName: "agent-a",
				data: {},
			},
			{
				timestamp: "2026-01-01T12:00:00.000Z",
				level: "info",
				event: "event-12:00",
				agentName: "agent-a",
				data: {},
			},
		];

		await createLogFile("agent-a", "2026-01-01T00-00-00-000Z", events);

		const output = await captureStdout(async () => {
			await logsCommand(["--since", "2026-01-01T11:00:00.000Z"]);
		});

		expect(output).toContain("event-11:00");
		expect(output).toContain("event-12:00");
		expect(output).not.toContain("event-10:00");
		expect(output).toContain("2 entries");
	});

	test("invalid level throws ValidationError", async () => {
		await createConfig();

		await expect(
			captureStdout(async () => {
				await logsCommand(["--level", "critical"]);
			}),
		).rejects.toThrow(ValidationError);
	});

	test("invalid limit throws ValidationError", async () => {
		await createConfig();

		await expect(
			captureStdout(async () => {
				await logsCommand(["--limit", "abc"]);
			}),
		).rejects.toThrow(ValidationError);
	});

	test("handles malformed NDJSON lines gracefully", async () => {
		await createConfig();

		const logsDir = join(tmpDir, ".legio", "logs", "agent-a", "2026-01-01T00-00-00-000Z");
		await mkdir(logsDir, { recursive: true });

		// Write mixed valid and invalid NDJSON lines
		const mixedContent = `{"timestamp":"2026-01-01T10:00:00.000Z","level":"info","event":"valid-event-1","agentName":"agent-a","data":{}}
this is not json
{"timestamp":"2026-01-01T10:01:00.000Z","level":"info","event":"valid-event-2","agentName":"agent-a","data":{}}
{"incomplete": "object"
{"timestamp":"2026-01-01T10:02:00.000Z","level":"info","event":"valid-event-3","agentName":"agent-a","data":{}}
`;

		await writeFile(join(logsDir, "events.ndjson"), mixedContent, "utf-8");

		const output = await captureStdout(async () => {
			await logsCommand([]);
		});

		// Should show the 3 valid events, silently skip the malformed lines
		expect(output).toContain("valid-event-1");
		expect(output).toContain("valid-event-2");
		expect(output).toContain("valid-event-3");
		expect(output).toContain("3 entries");
		expect(output).not.toContain("this is not json");
	});
});
