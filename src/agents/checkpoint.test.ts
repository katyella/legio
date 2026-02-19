import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { SessionCheckpoint } from "../types.ts";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint.ts";

function makeCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
	return {
		agentName: "test-agent",
		beadId: "legio-abc1",
		sessionId: "session-001",
		timestamp: "2025-01-01T00:00:00.000Z",
		progressSummary: "Implemented checkpoint module",
		filesModified: ["src/agents/checkpoint.ts"],
		currentBranch: "legio/test-agent/legio-abc1",
		pendingWork: "Write tests",
		mulchDomains: ["agents"],
		...overrides,
	};
}

describe("checkpoint", () => {
	let agentsDir: string;

	beforeEach(async () => {
		agentsDir = await mkdtemp(join(tmpdir(), "legio-checkpoint-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(agentsDir);
	});

	test("save and load a checkpoint", async () => {
		const checkpoint = makeCheckpoint();

		await saveCheckpoint(agentsDir, checkpoint);
		const loaded = await loadCheckpoint(agentsDir, "test-agent");

		expect(loaded).not.toBeNull();
		expect(loaded?.agentName).toBe("test-agent");
		expect(loaded?.beadId).toBe("legio-abc1");
		expect(loaded?.sessionId).toBe("session-001");
		expect(loaded?.progressSummary).toBe("Implemented checkpoint module");
		expect(loaded?.filesModified).toEqual(["src/agents/checkpoint.ts"]);
		expect(loaded?.currentBranch).toBe("legio/test-agent/legio-abc1");
		expect(loaded?.pendingWork).toBe("Write tests");
		expect(loaded?.mulchDomains).toEqual(["agents"]);
	});

	test("load returns null when no checkpoint exists", async () => {
		const result = await loadCheckpoint(agentsDir, "nonexistent-agent");
		expect(result).toBeNull();
	});

	test("clear removes the checkpoint file", async () => {
		const checkpoint = makeCheckpoint();

		await saveCheckpoint(agentsDir, checkpoint);
		const before = await loadCheckpoint(agentsDir, "test-agent");
		expect(before).not.toBeNull();

		await clearCheckpoint(agentsDir, "test-agent");
		const after = await loadCheckpoint(agentsDir, "test-agent");
		expect(after).toBeNull();
	});

	test("clear does not error when file does not exist", async () => {
		// Should not throw
		await clearCheckpoint(agentsDir, "nonexistent-agent");
	});

	test("overwrite existing checkpoint", async () => {
		const first = makeCheckpoint({ progressSummary: "First pass" });
		await saveCheckpoint(agentsDir, first);

		const second = makeCheckpoint({
			progressSummary: "Second pass",
			filesModified: ["src/agents/checkpoint.ts", "src/agents/lifecycle.ts"],
		});
		await saveCheckpoint(agentsDir, second);

		const loaded = await loadCheckpoint(agentsDir, "test-agent");
		expect(loaded?.progressSummary).toBe("Second pass");
		expect(loaded?.filesModified).toEqual(["src/agents/checkpoint.ts", "src/agents/lifecycle.ts"]);
	});
});
