import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir } from "../test-helpers.ts";
import type { SessionHandoff } from "../types.ts";
import { loadCheckpoint } from "./checkpoint.ts";
import { completeHandoff, initiateHandoff, resumeFromHandoff } from "./lifecycle.ts";

describe("lifecycle", () => {
	let agentsDir: string;

	beforeEach(async () => {
		agentsDir = await mkdtemp(join(tmpdir(), "legio-lifecycle-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(agentsDir);
	});

	test("initiateHandoff creates checkpoint and handoff record", async () => {
		const handoff = await initiateHandoff({
			agentsDir,
			agentName: "builder-1",
			sessionId: "session-100",
			beadId: "legio-xyz1",
			reason: "compaction",
			progressSummary: "Built the widget",
			pendingWork: "Tests remain",
			currentBranch: "legio/builder-1/legio-xyz1",
			filesModified: ["src/widget.ts"],
			mulchDomains: ["agents"],
		});

		// Handoff record is correct
		expect(handoff.fromSessionId).toBe("session-100");
		expect(handoff.toSessionId).toBeNull();
		expect(handoff.reason).toBe("compaction");
		expect(handoff.checkpoint.agentName).toBe("builder-1");
		expect(handoff.checkpoint.progressSummary).toBe("Built the widget");

		// Checkpoint was saved to disk
		const checkpoint = await loadCheckpoint(agentsDir, "builder-1");
		expect(checkpoint).not.toBeNull();
		expect(checkpoint?.sessionId).toBe("session-100");

		// Handoffs file was created
		const handoffsPath = join(agentsDir, "builder-1", "handoffs.json");
		expect(await access(handoffsPath).then(() => true).catch(() => false)).toBe(true);
		const handoffs = JSON.parse(await readFile(handoffsPath, "utf-8")) as SessionHandoff[];
		expect(handoffs).toHaveLength(1);
	});

	test("resumeFromHandoff returns pending handoff", async () => {
		await initiateHandoff({
			agentsDir,
			agentName: "builder-2",
			sessionId: "session-200",
			beadId: "legio-abc2",
			reason: "crash",
			progressSummary: "Halfway done",
			pendingWork: "Finish implementation",
			currentBranch: "legio/builder-2/legio-abc2",
			filesModified: ["src/foo.ts"],
			mulchDomains: [],
		});

		const result = await resumeFromHandoff({
			agentsDir,
			agentName: "builder-2",
		});

		expect(result).not.toBeNull();
		expect(result?.checkpoint.sessionId).toBe("session-200");
		expect(result?.checkpoint.progressSummary).toBe("Halfway done");
		expect(result?.handoff.reason).toBe("crash");
		expect(result?.handoff.toSessionId).toBeNull();
	});

	test("completeHandoff updates toSessionId and clears checkpoint", async () => {
		await initiateHandoff({
			agentsDir,
			agentName: "builder-3",
			sessionId: "session-300",
			beadId: "legio-def3",
			reason: "manual",
			progressSummary: "Done with phase 1",
			pendingWork: "Phase 2",
			currentBranch: "legio/builder-3/legio-def3",
			filesModified: [],
			mulchDomains: [],
		});

		await completeHandoff({
			agentsDir,
			agentName: "builder-3",
			newSessionId: "session-301",
		});

		// Checkpoint should be cleared
		const checkpoint = await loadCheckpoint(agentsDir, "builder-3");
		expect(checkpoint).toBeNull();

		// Handoff should have toSessionId set
		const handoffs = JSON.parse(
			await readFile(join(agentsDir, "builder-3", "handoffs.json"), "utf-8"),
		) as SessionHandoff[];
		expect(handoffs).toHaveLength(1);
		const first = handoffs[0];
		expect(first).toBeDefined();
		expect(first?.toSessionId).toBe("session-301");
	});

	test("multiple handoffs accumulate in handoffs.json", async () => {
		// First handoff
		await initiateHandoff({
			agentsDir,
			agentName: "builder-4",
			sessionId: "session-400",
			beadId: "legio-ghi4",
			reason: "compaction",
			progressSummary: "First session work",
			pendingWork: "Continue",
			currentBranch: "legio/builder-4/legio-ghi4",
			filesModified: ["a.ts"],
			mulchDomains: [],
		});

		// Complete the first handoff
		await completeHandoff({
			agentsDir,
			agentName: "builder-4",
			newSessionId: "session-401",
		});

		// Second handoff
		await initiateHandoff({
			agentsDir,
			agentName: "builder-4",
			sessionId: "session-401",
			beadId: "legio-ghi4",
			reason: "timeout",
			progressSummary: "Second session work",
			pendingWork: "Finish up",
			currentBranch: "legio/builder-4/legio-ghi4",
			filesModified: ["a.ts", "b.ts"],
			mulchDomains: [],
		});

		const handoffs = JSON.parse(
			await readFile(join(agentsDir, "builder-4", "handoffs.json"), "utf-8"),
		) as SessionHandoff[];
		expect(handoffs).toHaveLength(2);

		const first = handoffs[0];
		expect(first).toBeDefined();
		expect(first?.toSessionId).toBe("session-401");

		const second = handoffs[1];
		expect(second).toBeDefined();
		expect(second?.toSessionId).toBeNull();
	});

	test("resumeFromHandoff returns null when no pending handoff exists", async () => {
		const result = await resumeFromHandoff({
			agentsDir,
			agentName: "nonexistent-agent",
		});
		expect(result).toBeNull();
	});

	test("resumeFromHandoff returns null when all handoffs are completed", async () => {
		await initiateHandoff({
			agentsDir,
			agentName: "builder-5",
			sessionId: "session-500",
			beadId: "legio-jkl5",
			reason: "compaction",
			progressSummary: "Done",
			pendingWork: "Nothing",
			currentBranch: "legio/builder-5/legio-jkl5",
			filesModified: [],
			mulchDomains: [],
		});

		await completeHandoff({
			agentsDir,
			agentName: "builder-5",
			newSessionId: "session-501",
		});

		const result = await resumeFromHandoff({
			agentsDir,
			agentName: "builder-5",
		});
		expect(result).toBeNull();
	});
});
