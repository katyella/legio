import { afterEach, beforeEach, describe, expect, vi, test, type MockInstance } from "vitest";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../types.ts";
import { createLogger } from "./logger.ts";

describe("createLogger", () => {
	let tempDir: string;
	let logDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-logger-test-"));
		logDir = join(tempDir, "logs");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function readLogFile(filename: string): Promise<string> {
		return readFile(join(logDir, filename), "utf-8");
	}

	async function readJsonLines(filename: string): Promise<LogEvent[]> {
		const content = await readLogFile(filename);
		return content
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as LogEvent);
	}

	async function fileExists(filePath: string): Promise<boolean> {
		try {
			await access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	describe("lazy directory creation", () => {
		test("does not create log directory until first write", async () => {
			createLogger({ logDir, agentName: "test-agent" });

			// Directory should NOT exist yet -- no write has been issued
			const exists = await fileExists(logDir);
			expect(exists).toBe(false);
		});

		test("creates log directory on first write", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("test.event");

			// Give time for async mkdir + append to complete
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const files = await readdir(logDir);
			expect(files.length).toBeGreaterThan(0);

			logger.close();
		});
	});

	describe("info", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("test.event", { key: "value" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("INFO test.event");
			expect(sessionLog).toContain("key=value");

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(1);
			expect(events[0]?.level).toBe("info");
			expect(events[0]?.event).toBe("test.event");
			expect(events[0]?.data.key).toBe("value");

			logger.close();
		});

		test("does not write to errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("happy.path");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const exists = await fileExists(join(logDir, "errors.log"));
			expect(exists).toBe(false);

			logger.close();
		});

		test("works with empty data", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("simple.event");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("INFO simple.event");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data).toEqual({});

			logger.close();
		});
	});

	describe("warn", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.warn("rate.limit", { remaining: 10 });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("WARN rate.limit");
			expect(sessionLog).toContain("remaining=10");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("warn");
			expect(events[0]?.event).toBe("rate.limit");

			logger.close();
		});

		test("does not write to errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.warn("just.a.warning");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const exists = await fileExists(join(logDir, "errors.log"));
			expect(exists).toBe(false);

			logger.close();
		});
	});

	describe("error", () => {
		test("writes to session.log, events.ndjson, and errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Something went wrong");
			logger.error("request.failed", error, { statusCode: 500 });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("ERROR request.failed");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("error");
			expect(events[0]?.event).toBe("request.failed");
			expect(events[0]?.data.errorMessage).toBe("Something went wrong");
			expect(events[0]?.data.errorName).toBe("Error");
			expect(events[0]?.data.statusCode).toBe(500);

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Error: Something went wrong");
			expect(errorsLog).toContain("request.failed");
			expect(errorsLog).toContain("Stack Trace:");

			logger.close();
		});

		test("includes error cause if present", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const cause = new Error("Root cause");
			const error = new Error("Wrapper error", { cause });
			logger.error("nested.error", error);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Caused by: Error: Root cause");

			logger.close();
		});
	});

	describe("debug", () => {
		test("writes to session.log and events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.debug("config.detail", { verbose: true });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("DEBUG config.detail");

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.level).toBe("debug");

			logger.close();
		});

		test("does not write to errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.debug("trace.detail");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const exists = await fileExists(join(logDir, "errors.log"));
			expect(exists).toBe(false);

			logger.close();
		});
	});

	describe("toolStart and toolEnd", () => {
		test("writes to session.log, events.ndjson, and tools.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Read", { path: "/path/to/file" });
			logger.toolEnd("Read", 150, "file contents");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("tool.start");
			expect(sessionLog).toContain("tool.end");

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(2);
			// Order not guaranteed due to async writes
			const eventNames = events.map((e) => e.event);
			expect(eventNames).toContain("tool.start");
			expect(eventNames).toContain("tool.end");

			const tools = await readJsonLines("tools.ndjson");
			expect(tools).toHaveLength(2);
			// Order not guaranteed due to async writes
			const toolStart = tools.find((t) => t.event === "tool.start");
			const toolEnd = tools.find((t) => t.event === "tool.end");
			expect(toolStart).toBeDefined();
			expect(toolStart?.data.toolName).toBe("Read");
			expect(toolEnd).toBeDefined();
			expect(toolEnd?.data.toolName).toBe("Read");
			expect(toolEnd?.data.durationMs).toBe(150);
			expect(toolEnd?.data.result).toBe("file contents");

			logger.close();
		});

		test("toolStart includes args in tool event data", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Bash", { command: "ls -la", cwd: "/tmp" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			const startEvent = tools.find((t) => t.event === "tool.start");
			expect(startEvent?.data.args).toEqual({ command: "ls -la", cwd: "/tmp" });

			logger.close();
		});

		test("toolEnd works without result", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolEnd("Write", 50);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.data.result).toBeUndefined();

			logger.close();
		});

		test("does not write to errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Bash", { command: "echo test" });
			logger.toolEnd("Bash", 10);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const exists = await fileExists(join(logDir, "errors.log"));
			expect(exists).toBe(false);

			logger.close();
		});
	});

	describe("redaction", () => {
		test("redacts secrets when redactSecrets is true (default)", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("api.call", { apiKey: "sk-ant-secret123" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.apiKey).toBe("[REDACTED]");

			logger.close();
		});

		test("redacts secrets in session.log", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("api.call", { token: "ghp_abc123xyz" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("[REDACTED]");
			expect(sessionLog).not.toContain("ghp_abc123xyz");

			logger.close();
		});

		test("redacts secrets in error messages", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Failed with key sk-ant-secret123");
			logger.error("error.occurred", error);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.errorMessage).toBe("Failed with key [REDACTED]");

			logger.close();
		});

		test("redacts secrets in tool results", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolEnd("Bash", 100, "export ANTHROPIC_API_KEY=sk-ant-secret");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.data.result).toBe("export [REDACTED]");

			logger.close();
		});

		test("does not redact secrets when redactSecrets is false", async () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				redactSecrets: false,
			});

			logger.info("api.call", { apiKey: "sk-ant-secret123" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.apiKey).toBe("sk-ant-secret123");

			logger.close();
		});

		test("does not redact when redactSecrets is false for error messages", async () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				redactSecrets: false,
			});

			const error = new Error("Key is sk-ant-secret123");
			logger.error("err", error);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.data.errorMessage).toBe("Key is sk-ant-secret123");

			logger.close();
		});

		test("does not redact when redactSecrets is false for tool results", async () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				redactSecrets: false,
			});

			logger.toolEnd("Bash", 10, "Bearer my-token-value");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.data.result).toBe("Bearer my-token-value");

			logger.close();
		});
	});

	describe("verbose mode", () => {
		let consoleLogSpy: MockInstance;

		beforeEach(() => {
			consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		});

		afterEach(() => {
			consoleLogSpy.mockRestore();
		});

		test("suppresses debug console output when verbose is false", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: false,
			});

			logger.debug("debug.event");

			// Console should not be called
			expect(consoleLogSpy).toHaveBeenCalledTimes(0);

			logger.close();
		});

		test("prints debug console output when verbose is true", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: true,
			});

			logger.debug("debug.event");

			// Console should be called
			expect(consoleLogSpy).toHaveBeenCalledTimes(1);

			logger.close();
		});

		test("always prints non-debug events regardless of verbose", () => {
			const logger = createLogger({
				logDir,
				agentName: "test-agent",
				verbose: false,
			});

			logger.info("info.event");

			// Console should be called even with verbose=false
			expect(consoleLogSpy).toHaveBeenCalledTimes(1);

			logger.close();
		});
	});

	describe("close", () => {
		test("prevents further writes after close", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("before.close");
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			logger.close();

			logger.info("after.close");
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			// Should only have the event before close
			expect(events).toHaveLength(1);
			expect(events[0]?.event).toBe("before.close");
		});

		test("prevents tool writes after close", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Read", { path: "/tmp/a" });
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			logger.close();

			logger.toolStart("Read", { path: "/tmp/b" });
			logger.toolEnd("Read", 100);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			expect(tools).toHaveLength(1);
			expect(tools[0]?.event).toBe("tool.start");
		});

		test("prevents error writes after close", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.error("first.error", new Error("before"));
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			logger.close();

			logger.error("second.error", new Error("after"));
			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(1);
			expect(events[0]?.event).toBe("first.error");
		});
	});

	describe("agentName", () => {
		test("includes agentName in all logged events", async () => {
			const logger = createLogger({ logDir, agentName: "scout-1" });

			logger.info("test.event");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events[0]?.agentName).toBe("scout-1");

			logger.close();
		});

		test("includes agentName in tool events", async () => {
			const logger = createLogger({ logDir, agentName: "builder-3" });

			logger.toolStart("Write", { path: "/tmp/out" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const tools = await readJsonLines("tools.ndjson");
			expect(tools[0]?.agentName).toBe("builder-3");

			logger.close();
		});

		test("includes agentName in errors.log", async () => {
			const logger = createLogger({ logDir, agentName: "merger-2" });

			logger.error("merge.failed", new Error("conflict"));

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Agent:     merger-2");

			logger.close();
		});
	});

	describe("error isolation", () => {
		test("continues logging after write errors (no crash)", async () => {
			// Create logger with an invalid path to trigger write errors
			const invalidLogDir = join(tempDir, "nonexistent", "very", "deep", "path");
			const logger = createLogger({ logDir: invalidLogDir, agentName: "test-agent" });

			// These should not throw even if writes fail
			expect(() => logger.info("test1")).not.toThrow();
			expect(() => logger.error("test2", new Error("test"))).not.toThrow();
			expect(() => logger.debug("test3")).not.toThrow();
			expect(() => logger.toolStart("Bash", { cmd: "ls" })).not.toThrow();
			expect(() => logger.toolEnd("Bash", 10)).not.toThrow();

			logger.close();
		});
	});

	describe("session.log format", () => {
		test("uses [ISO_TIMESTAMP] LEVEL event key=value format", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("task.completed", { taskId: "task-123", duration: 5000 });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			// Format: [TIMESTAMP] LEVEL EVENT key=value key=value\n
			expect(sessionLog).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
			expect(sessionLog).toContain("INFO task.completed");
			expect(sessionLog).toContain("taskId=task-123");
			expect(sessionLog).toContain("duration=5000");

			logger.close();
		});

		test("quotes string values containing spaces", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("deploy.start", { env: "production west" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain('env="production west"');

			logger.close();
		});

		test("renders null and undefined values as key=null", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("check.result", { passed: null, detail: undefined });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("passed=null");
			expect(sessionLog).toContain("detail=null");

			logger.close();
		});

		test("JSON stringifies object values", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("config.loaded", { options: { retries: 3, timeout: 1000 } });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain('options={"retries":3,"timeout":1000}');

			logger.close();
		});

		test("renders simple string values without quotes", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("agent.started", { name: "scout-1" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("name=scout-1");
			// Should NOT be quoted since there are no spaces
			expect(sessionLog).not.toContain('name="scout-1"');

			logger.close();
		});

		test("renders boolean values", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("feature.flag", { enabled: true, deprecated: false });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			expect(sessionLog).toContain("enabled=true");
			expect(sessionLog).toContain("deprecated=false");

			logger.close();
		});

		test("renders event without key=value suffix when data is empty", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("heartbeat");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const sessionLog = await readLogFile("session.log");
			// Should end with just the event name and newline, no trailing space
			expect(sessionLog).toMatch(/INFO heartbeat\n$/);

			logger.close();
		});
	});

	describe("events.ndjson format", () => {
		test("each line is a valid JSON LogEvent with all required fields", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("check.fields", { someKey: 42 });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			const event = events[0];
			expect(event).toBeDefined();

			// Verify all LogEvent fields are present
			expect(event?.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
			expect(event?.level).toBe("info");
			expect(event?.event).toBe("check.fields");
			expect(event?.agentName).toBe("test-agent");
			expect(event?.data).toEqual({ someKey: 42 });

			logger.close();
		});

		test("uses valid NDJSON format with one JSON object per line", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("event1");
			logger.info("event2");
			logger.info("event3");

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const content = await readLogFile("events.ndjson");
			const lines = content.trim().split("\n");

			expect(lines).toHaveLength(3);

			// Each line should be valid JSON
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}

			logger.close();
		});

		test("tool events also appear in events.ndjson", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.toolStart("Bash", { command: "ls" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(1);
			expect(events[0]?.event).toBe("tool.start");

			logger.close();
		});
	});

	describe("errors.log format", () => {
		test("includes separator lines, timestamp, event, agent, error, and stack", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const error = new Error("Test error");
			logger.error("test.error", error);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const errorsLog = await readLogFile("errors.log");

			// Separator is 72 '=' characters
			expect(errorsLog).toContain("=".repeat(72));
			expect(errorsLog).toContain("Timestamp:");
			expect(errorsLog).toContain("Event:     test.error");
			expect(errorsLog).toContain("Agent:     test-agent");
			expect(errorsLog).toContain("Error:     Error: Test error");
			expect(errorsLog).toContain("Stack Trace:");

			logger.close();
		});

		test("includes Data field when data is provided", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.error("db.error", new Error("connection refused"), { host: "localhost" });

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Data:");
			expect(errorsLog).toContain('"host"');

			logger.close();
		});

		test("includes cause chain when error.cause exists", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			const rootCause = new TypeError("null reference");
			const mid = new Error("query failed", { cause: rootCause });
			logger.error("deep.error", mid);

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const errorsLog = await readLogFile("errors.log");
			expect(errorsLog).toContain("Caused by: TypeError: null reference");

			logger.close();
		});
	});

	describe("multiple events", () => {
		test("logs multiple events across all levels", async () => {
			const logger = createLogger({ logDir, agentName: "test-agent" });

			logger.info("event1");
			logger.warn("event2");
			logger.error("event3", new Error("test"));

			await new Promise<void>((resolve) => setTimeout(resolve, 50));

			const events = await readJsonLines("events.ndjson");
			expect(events).toHaveLength(3);

			// Check that all events are present (order not guaranteed due to async writes)
			const eventNames = events.map((e) => e.event);
			expect(eventNames).toContain("event1");
			expect(eventNames).toContain("event2");
			expect(eventNames).toContain("event3");

			logger.close();
		});
	});
});
