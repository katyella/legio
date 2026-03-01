import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentError } from "../errors.ts";
import {
	capturePaneContent,
	createSession,
	getDescendantPids,
	getPanePid,
	hasTuiMarkers,
	isProcessAlive,
	isSessionAlive,
	killProcessTree,
	killSession,
	listSessions,
	readTerminalLog,
	sendKeys,
	startPipePane,
	stopPipePane,
	waitForTuiReady,
} from "./tmux.ts";

/**
 * tmux tests use child_process mocks — legitimate exception to "never mock what you can use for real".
 * Real tmux operations would hijack the developer's session and are unavailable in CI.
 * fs/promises is mocked because readTerminalLog reads actual files; using temp files would be
 * slower and less isolated for unit tests of the tailing logic.
 */

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	stat: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);
const mockMkdir = vi.mocked(mkdir);
const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);

/**
 * Helper to create a mock ChildProcess return value.
 *
 * Creates an EventEmitter with stdout/stderr PassThrough streams that
 * emit data and close events asynchronously via process.nextTick.
 */
function createMockProcess(stdout: string, stderr: string, exitCode: number): ChildProcess {
	const proc = new EventEmitter();
	const stdoutStream = new PassThrough();
	const stderrStream = new PassThrough();
	Object.assign(proc, {
		stdout: stdoutStream,
		stderr: stderrStream,
		stdin: null,
		pid: 12345,
		kill: vi.fn(),
	});
	process.nextTick(() => {
		if (stdout) stdoutStream.push(Buffer.from(stdout));
		stdoutStream.push(null);
		if (stderr) stderrStream.push(Buffer.from(stderr));
		stderrStream.push(null);
		proc.emit("close", exitCode);
	});
	return proc as unknown as ChildProcess;
}

describe("createSession", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("creates session and returns pane PID", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio — return a bin path
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			if (callCount === 2) {
				// tmux new-session
				return createMockProcess("", "", 0);
			}
			// tmux list-panes -t legio-auth -F '#{pane_pid}'
			return createMockProcess("42\n", "", 0);
		});

		const pid = await createSession(
			"legio-auth",
			"/repo/worktrees/auth",
			"claude --task 'do work'",
		);

		expect(pid).toBe(42);
	});

	test("passes correct args to tmux new-session with PATH wrapping", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			if (callCount === 2) {
				return createMockProcess("", "", 0);
			}
			return createMockProcess("1234\n", "", 0);
		});

		await createSession("my-session", "/work/dir", "echo hello");

		// Call 0 is 'which legio', call 1 is 'tmux new-session'
		const tmuxCallArgs = mockSpawn.mock.calls[1] as unknown[];
		const command = tmuxCallArgs[0] as string;
		const args = tmuxCallArgs[1] as string[];
		expect(command).toBe("tmux");
		expect(args[0]).toBe("new-session");
		expect(args).toContain("-s");
		expect(args).toContain("my-session");
		expect(args).toContain("-c");
		expect(args).toContain("/work/dir");
		// The command is the last arg, wrapped with env -u prefix
		const wrappedCmd = args[args.length - 1] as string;
		expect(wrappedCmd).toContain("env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT");
		expect(wrappedCmd).toContain("echo hello");
		// PATH is injected via -e flag, not shell export
		expect(args).toContain("-e");
		const eIndex = args.indexOf("-e");
		const pathArg = args[eIndex + 1] as string;
		expect(pathArg).toMatch(/^PATH=.*\/usr\/local\/bin/);

		const opts = tmuxCallArgs[2] as { cwd: string };
		expect(opts.cwd).toBe("/work/dir");
	});

	test("calls list-panes after creating to get pane PID", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			if (callCount === 2) {
				return createMockProcess("", "", 0);
			}
			return createMockProcess("7777\n", "", 0);
		});

		await createSession("test-agent", "/tmp", "ls");

		// 3 calls: which legio, tmux new-session, tmux list-panes
		expect(mockSpawn).toHaveBeenCalledTimes(3);
		const thirdCallArgs = mockSpawn.mock.calls[2] as unknown[];
		const command = thirdCallArgs[0] as string;
		const args = thirdCallArgs[1] as string[];
		expect([command, ...args]).toEqual([
			"tmux",
			"list-panes",
			"-t",
			"test-agent",
			"-F",
			"#{pane_pid}",
		]);
	});

	test("throws AgentError if session creation fails", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			return createMockProcess("", "duplicate session: my-session", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if list-panes fails after creation", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			if (callCount === 2) {
				// new-session succeeds
				return createMockProcess("", "", 0);
			}
			// list-panes fails
			return createMockProcess("", "error listing panes", 1);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("throws AgentError if pane PID output is empty", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			if (callCount === 2) {
				return createMockProcess("", "", 0);
			}
			// list-panes returns empty output
			return createMockProcess("", "", 0);
		});

		await expect(createSession("my-session", "/tmp", "ls")).rejects.toThrow(AgentError);
	});

	test("AgentError includes session name context", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio
				return createMockProcess("/usr/local/bin/legio\n", "", 0);
			}
			return createMockProcess("", "duplicate session: agent-foo", 1);
		});

		try {
			await createSession("agent-foo", "/tmp", "ls");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("agent-foo");
			expect(agentErr.agentName).toBe("agent-foo");
		}
	});

	test("still creates session when which legio fails (uses fallback)", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// which legio fails
				return createMockProcess("", "legio not found", 1);
			}
			if (callCount === 2) {
				// tmux new-session
				return createMockProcess("", "", 0);
			}
			// tmux list-panes
			return createMockProcess("5555\n", "", 0);
		});

		const pid = await createSession("fallback-agent", "/tmp", "echo test");
		expect(pid).toBe(5555);

		// The tmux command (last arg) should contain the original command
		const tmuxCallArgs = mockSpawn.mock.calls[1] as unknown[];
		const args = tmuxCallArgs[1] as string[];
		const tmuxCmd = args[args.length - 1] as string;
		expect(tmuxCmd).toContain("echo test");
	});
});

describe("listSessions", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("parses session list output", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("legio-auth:42\nlegio-data:99\n", "", 0));

		const sessions = await listSessions();

		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.name).toBe("legio-auth");
		expect(sessions[0]?.pid).toBe(42);
		expect(sessions[1]?.name).toBe("legio-data");
		expect(sessions[1]?.pid).toBe(99);
	});

	test("returns empty array when no server running", async () => {
		mockSpawn.mockImplementation(() =>
			createMockProcess("", "no server running on /tmp/tmux-501/default", 1),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("returns empty array when 'no sessions' in stderr", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "no sessions", 1));

		const sessions = await listSessions();

		expect(sessions).toHaveLength(0);
	});

	test("throws AgentError on other tmux failures", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "protocol version mismatch", 1));

		await expect(listSessions()).rejects.toThrow(AgentError);
	});

	test("skips malformed lines", async () => {
		mockSpawn.mockImplementation(() =>
			createMockProcess("valid-session:123\nmalformed-no-colon\n:no-name\n\n", "", 0),
		);

		const sessions = await listSessions();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe("valid-session");
		expect(sessions[0]?.pid).toBe(123);
	});

	test("passes correct args to tmux", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await listSessions();

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual(["tmux", "list-sessions", "-F", "#{session_name}:#{pid}"]);
	});
});

describe("getPanePid", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("returns PID from tmux display-message", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("42\n", "", 0));

		const pid = await getPanePid("legio-auth");

		expect(pid).toBe(42);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual([
			"tmux",
			"display-message",
			"-p",
			"-t",
			"legio-auth",
			"#{pane_pid}",
		]);
	});

	test("returns null when session does not exist", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "can't find session: gone", 1));

		const pid = await getPanePid("gone");

		expect(pid).toBeNull();
	});

	test("returns null when output is empty", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		const pid = await getPanePid("empty-output");

		expect(pid).toBeNull();
	});

	test("returns null when output is not a number", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("not-a-pid\n", "", 0));

		const pid = await getPanePid("bad-output");

		expect(pid).toBeNull();
	});
});

describe("getDescendantPids", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("returns empty array when process has no children", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 1));

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([]);
	});

	test("returns direct children when they have no grandchildren", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 100 → children 200, 300
				return createMockProcess("200\n300\n", "", 0);
			}
			// pgrep -P 200 and pgrep -P 300 → no grandchildren
			return createMockProcess("", "", 1);
		});

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([200, 300]);
	});

	test("returns descendants in depth-first order (deepest first)", async () => {
		// Tree: 100 → 200 → 400
		//             → 300
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 100 → children 200, 300
				return createMockProcess("200\n300\n", "", 0);
			}
			if (callCount === 2) {
				// pgrep -P 200 → child 400
				return createMockProcess("400\n", "", 0);
			}
			if (callCount === 3) {
				// pgrep -P 400 → no children
				return createMockProcess("", "", 1);
			}
			// pgrep -P 300 → no children
			return createMockProcess("", "", 1);
		});

		const pids = await getDescendantPids(100);

		// Deepest-first: 400 (grandchild), then 200, 300 (direct children)
		expect(pids).toEqual([400, 200, 300]);
	});

	test("handles deeply nested tree", async () => {
		// Tree: 1 → 2 → 3 → 4
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// pgrep -P 1 → 2
				return createMockProcess("2\n", "", 0);
			}
			if (callCount === 2) {
				// pgrep -P 2 → 3
				return createMockProcess("3\n", "", 0);
			}
			if (callCount === 3) {
				// pgrep -P 3 → 4
				return createMockProcess("4\n", "", 0);
			}
			// pgrep -P 4 → no children
			return createMockProcess("", "", 1);
		});

		const pids = await getDescendantPids(1);

		// Deepest-first: 4, 3, 2
		expect(pids).toEqual([4, 3, 2]);
	});

	test("skips non-numeric pgrep output lines", async () => {
		mockSpawn.mockImplementation((_command: string, args: readonly string[]) => {
			if (args[1] === "100") {
				return createMockProcess("200\nnot-a-pid\n300\n", "", 0);
			}
			return createMockProcess("", "", 1);
		});

		const pids = await getDescendantPids(100);

		expect(pids).toEqual([200, 300]);
	});
});

describe("isProcessAlive", () => {
	test("returns true for current process (self-check)", () => {
		// process.pid is always alive
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("returns false for a non-existent PID", () => {
		// PID 2147483647 (max int32) is extremely unlikely to exist
		expect(isProcessAlive(2147483647)).toBe(false);
	});
});

describe("killProcessTree", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mockSpawn.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		killSpy.mockRestore();
	});

	test("sends SIGTERM to root when no descendants", async () => {
		// pgrep -P 100 → no children
		mockSpawn.mockImplementation(() => createMockProcess("", "", 1));

		await killProcessTree(100, 0);

		expect(killSpy).toHaveBeenCalledWith(100, "SIGTERM");
	});

	test("sends SIGTERM deepest-first then SIGKILL survivors", async () => {
		// Tree: 100 → 200 → 300
		let pgrepCallCount = 0;
		mockSpawn.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				// pgrep -P 100 → 200
				return createMockProcess("200\n", "", 0);
			}
			if (pgrepCallCount === 2) {
				// pgrep -P 200 → 300
				return createMockProcess("300\n", "", 0);
			}
			// pgrep -P 300 → no children
			return createMockProcess("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal: String(signal) });
			return true;
		});

		await killProcessTree(100, 0);

		// Phase 1 (SIGTERM): deepest-first → 300, 200, then root 100
		// Phase 2 (SIGKILL): isProcessAlive check (signal 0), then SIGKILL for survivors
		const sigterms = signals.filter((s) => s.signal === "SIGTERM");
		expect(sigterms).toEqual([
			{ pid: 300, signal: "SIGTERM" },
			{ pid: 200, signal: "SIGTERM" },
			{ pid: 100, signal: "SIGTERM" },
		]);
	});

	test("sends SIGKILL to survivors after grace period", async () => {
		// Tree: 100 → 200 (no grandchildren)
		let pgrepCallCount = 0;
		mockSpawn.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				return createMockProcess("200\n", "", 0);
			}
			return createMockProcess("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string | number }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal });
			// signal 0 is the isProcessAlive check — simulate processes still alive
			return true;
		});

		await killProcessTree(100, 10); // 10ms grace period for test speed

		// Should have: SIGTERM(200), SIGTERM(100), alive-check(200), SIGKILL(200),
		//              alive-check(100), SIGKILL(100)
		const sigkills = signals.filter((s) => s.signal === "SIGKILL");
		expect(sigkills.length).toBe(2);
		expect(sigkills[0]).toEqual({ pid: 200, signal: "SIGKILL" });
		expect(sigkills[1]).toEqual({ pid: 100, signal: "SIGKILL" });
	});

	test("skips SIGKILL for processes that died during grace period", async () => {
		let pgrepCallCount = 0;
		mockSpawn.mockImplementation(() => {
			pgrepCallCount++;
			if (pgrepCallCount === 1) {
				return createMockProcess("200\n", "", 0);
			}
			return createMockProcess("", "", 1);
		});

		const signals: Array<{ pid: number; signal: string | number }> = [];
		killSpy.mockImplementation((pid: number, signal: string | number) => {
			signals.push({ pid, signal });
			// signal 0 (isProcessAlive) — processes are dead
			if (signal === 0) {
				throw new Error("ESRCH");
			}
			return true;
		});

		await killProcessTree(100, 10);

		// Should have SIGTERM calls but no SIGKILL (processes died)
		const sigkills = signals.filter((s) => s.signal === "SIGKILL");
		expect(sigkills).toEqual([]);
	});

	test("silently handles SIGTERM errors for already-dead processes", async () => {
		// No children
		mockSpawn.mockImplementation(() => createMockProcess("", "", 1));

		killSpy.mockImplementation(() => {
			throw new Error("ESRCH: No such process");
		});

		// Should not throw
		await killProcessTree(100, 0);
	});
});

describe("killSession", () => {
	let killSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mockSpawn.mockReset();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		killSpy.mockRestore();
	});

	test("gets pane PID, kills process tree, then kills tmux session", async () => {
		const cmds: string[][] = [];
		mockSpawn.mockImplementation((command: string, args: readonly string[]) => {
			cmds.push([command, ...args]);

			if (command === "tmux" && args[0] === "display-message") {
				// getPanePid → returns PID 500
				return createMockProcess("500\n", "", 0);
			}
			if (command === "pgrep") {
				// getDescendantPids → no children
				return createMockProcess("", "", 1);
			}
			if (command === "tmux" && args[0] === "kill-session") {
				return createMockProcess("", "", 0);
			}
			return createMockProcess("", "", 0);
		});

		await killSession("legio-auth");

		// Should have called: tmux display-message, pgrep, tmux kill-session
		expect(cmds[0]).toEqual(["tmux", "display-message", "-p", "-t", "legio-auth", "#{pane_pid}"]);
		expect(cmds[1]).toEqual(["pgrep", "-P", "500"]);
		const lastCmd = cmds[cmds.length - 1];
		expect(lastCmd).toEqual(["tmux", "kill-session", "-t", "legio-auth"]);

		// Should have sent SIGTERM to root PID 500
		expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
	});

	test("skips process cleanup when pane PID is not available", async () => {
		const cmds: string[][] = [];
		mockSpawn.mockImplementation((command: string, args: readonly string[]) => {
			cmds.push([command, ...args]);

			if (command === "tmux" && args[0] === "display-message") {
				// getPanePid → session not found
				return createMockProcess("", "can't find session", 1);
			}
			if (command === "tmux" && args[0] === "pipe-pane") {
				return createMockProcess("", "", 0);
			}
			if (command === "tmux" && args[0] === "kill-session") {
				return createMockProcess("", "", 0);
			}
			return createMockProcess("", "", 0);
		});

		await killSession("legio-auth");

		// Should call: tmux display-message, tmux pipe-pane (stopPipePane), tmux kill-session
		expect(cmds).toHaveLength(3);
		expect(cmds[0]?.[1]).toBe("display-message");
		expect(cmds[1]?.[1]).toBe("pipe-pane");
		expect(cmds[2]?.[1]).toBe("kill-session");
		// No process.kill calls since we had no PID
		expect(killSpy).not.toHaveBeenCalled();
	});

	test("succeeds silently when session is already gone after process cleanup", async () => {
		mockSpawn.mockImplementation((command: string, args: readonly string[]) => {
			if (command === "tmux" && args[0] === "display-message") {
				return createMockProcess("500\n", "", 0);
			}
			if (command === "pgrep") {
				return createMockProcess("", "", 1);
			}
			if (command === "tmux" && args[0] === "kill-session") {
				// Session already gone after process cleanup
				return createMockProcess("", "can't find session: legio-auth", 1);
			}
			return createMockProcess("", "", 0);
		});

		// Should not throw — session disappearing is expected
		await killSession("legio-auth");
	});

	test("throws AgentError on unexpected tmux kill-session failure", async () => {
		mockSpawn.mockImplementation((command: string, args: readonly string[]) => {
			if (command === "tmux" && args[0] === "display-message") {
				return createMockProcess("", "can't find session", 1);
			}
			if (command === "tmux" && args[0] === "kill-session") {
				return createMockProcess("", "server exited unexpectedly", 1);
			}
			return createMockProcess("", "", 0);
		});

		await expect(killSession("broken-session")).rejects.toThrow(AgentError);
	});

	test("AgentError contains session name on failure", async () => {
		mockSpawn.mockImplementation((command: string, args: readonly string[]) => {
			if (command === "tmux" && args[0] === "display-message") {
				return createMockProcess("", "error", 1);
			}
			if (command === "tmux" && args[0] === "kill-session") {
				return createMockProcess("", "server exited unexpectedly", 1);
			}
			return createMockProcess("", "", 0);
		});

		try {
			await killSession("ghost-agent");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("ghost-agent");
			expect(agentErr.agentName).toBe("ghost-agent");
		}
	});
});

describe("isSessionAlive", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("returns true when session exists (exit 0)", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		const alive = await isSessionAlive("legio-auth");

		expect(alive).toBe(true);
	});

	test("returns false when session does not exist (non-zero exit)", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "can't find session: nonexistent", 1));

		const alive = await isSessionAlive("nonexistent");

		expect(alive).toBe(false);
	});

	test("passes correct args to tmux has-session", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await isSessionAlive("my-agent");

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual(["tmux", "has-session", "-t", "my-agent"]);
	});
});

describe("sendKeys", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("passes correct args to tmux send-keys", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await sendKeys("legio-auth", "echo hello world");

		// Two calls: text with -l flag, then Enter separately
		expect(mockSpawn).toHaveBeenCalledTimes(2);
		const call1 = mockSpawn.mock.calls[0] as unknown[];
		expect([call1[0] as string, ...(call1[1] as string[])]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"legio-auth",
			"-l",
			"echo hello world",
		]);
		const call2 = mockSpawn.mock.calls[1] as unknown[];
		expect([call2[0] as string, ...(call2[1] as string[])]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"legio-auth",
			"Enter",
		]);
	});

	test("sends text with -l literal flag", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await sendKeys("legio-auth", "hello");

		const call1 = mockSpawn.mock.calls[0] as unknown[];
		const args = call1[1] as string[];
		expect(args).toContain("-l");
	});

	test("flattens newlines in keys to spaces", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await sendKeys("legio-agent", "line1\nline2\nline3");

		// Two calls: text with -l flag (newlines flattened), then Enter
		expect(mockSpawn).toHaveBeenCalledTimes(2);
		const call1 = mockSpawn.mock.calls[0] as unknown[];
		expect([call1[0] as string, ...(call1[1] as string[])]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"legio-agent",
			"-l",
			"line1 line2 line3",
		]);
		const call2 = mockSpawn.mock.calls[1] as unknown[];
		expect([call2[0] as string, ...(call2[1] as string[])]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"legio-agent",
			"Enter",
		]);
	});

	test("sends Enter with empty string (follow-up submission)", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await sendKeys("legio-agent", "");

		// Only one call: just Enter, no text step for empty string
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		expect([callArgs[0] as string, ...(callArgs[1] as string[])]).toEqual([
			"tmux",
			"send-keys",
			"-t",
			"legio-agent",
			"Enter",
		]);
	});

	test("throws AgentError on failure", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "session not found: dead-agent", 1));

		await expect(sendKeys("dead-agent", "echo test")).rejects.toThrow(AgentError);
	});

	test("fails on text step error and does not proceed to Enter", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// Text step fails
				return createMockProcess("", "session not found: my-agent", 1);
			}
			// Enter step should NOT be reached
			return createMockProcess("", "", 0);
		});

		await expect(sendKeys("my-agent", "some text")).rejects.toThrow(AgentError);
		// Only the text step was called; Enter step was skipped
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});

	test("AgentError contains session name on failure", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "session not found: my-agent", 1));

		try {
			await sendKeys("my-agent", "test command");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("my-agent");
			expect(agentErr.agentName).toBe("my-agent");
		}
	});

	test("error message says 'server not running' when tmux has no server", async () => {
		mockSpawn.mockImplementation(() =>
			createMockProcess("", "no server running on /tmp/tmux-501/default", 1),
		);

		try {
			await sendKeys("dead-agent", "echo test");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("Tmux server not running");
		}
	});

	test("error message says 'not found' when session does not exist", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "session not found: dead-agent", 1));

		try {
			await sendKeys("dead-agent", "echo test");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("not found");
		}
	});

	test("error message includes stderr for unrecognized tmux errors", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "unexpected tmux protocol error", 1));

		try {
			await sendKeys("agent", "echo test");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.message).toContain("unexpected tmux protocol error");
		}
	});

	test("throws AgentError when Enter step fails", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				// Text step succeeds
				return createMockProcess("", "", 0);
			}
			// Enter step fails
			return createMockProcess("", "session not found: some-agent", 1);
		});

		await expect(sendKeys("some-agent", "hello")).rejects.toThrow(AgentError);
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});
});

describe("capturePaneContent", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("returns pane content on success", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("> type your message\n", "", 0));

		const content = await capturePaneContent("legio-auth");

		expect(content).toBe("> type your message\n");
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual(["tmux", "capture-pane", "-t", "legio-auth", "-p"]);
	});

	test("returns empty string when session does not exist", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "can't find session: gone", 1));

		const content = await capturePaneContent("gone");

		expect(content).toBe("");
	});

	test("returns empty string when capture-pane fails", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "no server running", 1));

		const content = await capturePaneContent("any-session");

		expect(content).toBe("");
	});
});

describe("hasTuiMarkers", () => {
	test("returns true for 'bypass permissions' marker", () => {
		expect(hasTuiMarkers("Claude Code — bypass permissions")).toBe(true);
	});

	test("returns true for horizontal line box-drawing character ─", () => {
		expect(hasTuiMarkers("────────────────────────────────")).toBe(true);
	});

	test("returns true for bold horizontal line box-drawing character ━", () => {
		expect(hasTuiMarkers("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")).toBe(true);
	});

	test("returns true for top-left corner box-drawing character ╭", () => {
		expect(hasTuiMarkers("╭─ Claude Code ──────────────────╮")).toBe(true);
	});

	test("returns true for bottom-left corner box-drawing character ╰", () => {
		expect(hasTuiMarkers("╰────────────────────────────────╯")).toBe(true);
	});

	test("returns false for plain shell prompt", () => {
		expect(hasTuiMarkers("user@host:~$ ")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(hasTuiMarkers("")).toBe(false);
	});

	test("returns false for generic non-TUI content", () => {
		expect(hasTuiMarkers("> ready for input")).toBe(false);
	});
});

describe("startPipePane", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockMkdir.mockReset();
		mockMkdir.mockResolvedValue(undefined);
	});

	test("creates log directory and calls tmux pipe-pane with correct args", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await startPipePane("legio-auth", "/tmp/legio/logs/auth/terminal.log");

		expect(mockMkdir).toHaveBeenCalledWith("/tmp/legio/logs/auth", { recursive: true });
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect(command).toBe("tmux");
		expect(args[0]).toBe("pipe-pane");
		expect(args).toContain("-t");
		expect(args).toContain("legio-auth");
		const shellCmd = args[args.length - 1] as string;
		expect(shellCmd).toContain("cat >>");
		expect(shellCmd).toContain("/tmp/legio/logs/auth/terminal.log");
	});

	test("throws AgentError if tmux pipe-pane fails", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "can't find session: legio-auth", 1));

		await expect(startPipePane("legio-auth", "/tmp/terminal.log")).rejects.toThrow(AgentError);
	});

	test("AgentError includes session name on failure", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "no server running", 1));

		try {
			await startPipePane("my-agent", "/tmp/terminal.log");
			expect(true).toBe(false);
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(AgentError);
			const agentErr = err as AgentError;
			expect(agentErr.agentName).toBe("my-agent");
		}
	});
});

describe("stopPipePane", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("calls tmux pipe-pane with session name and no command arg", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		await stopPipePane("legio-auth");

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual(["tmux", "pipe-pane", "-t", "legio-auth"]);
	});

	test("does not throw when tmux returns non-zero exit code", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("", "can't find session: gone", 1));

		// Should not throw — stopPipePane is best-effort
		await expect(stopPipePane("gone-session")).resolves.toBeUndefined();
	});
});

describe("readTerminalLog", () => {
	beforeEach(() => {
		mockStat.mockReset();
		mockReadFile.mockReset();
	});

	test("returns null when log file does not exist", async () => {
		mockStat.mockRejectedValue(new Error("ENOENT: no such file"));

		const result = await readTerminalLog("/tmp/missing.log");

		expect(result).toBeNull();
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	test("returns full content when no tailLines specified", async () => {
		mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
		mockReadFile.mockResolvedValue("line1\nline2\nline3\n" as never);

		const result = await readTerminalLog("/tmp/terminal.log");

		expect(result).toBe("line1\nline2\nline3\n");
	});

	test("returns last N lines when tailLines specified", async () => {
		mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
		mockReadFile.mockResolvedValue("a\nb\nc\nd\ne\n" as never);

		const result = await readTerminalLog("/tmp/terminal.log", 3);

		expect(result).toBe("c\nd\ne\n");
	});

	test("returns full content when tailLines >= line count", async () => {
		mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
		mockReadFile.mockResolvedValue("line1\nline2\n" as never);

		const result = await readTerminalLog("/tmp/terminal.log", 100);

		expect(result).toBe("line1\nline2\n");
	});

	test("passes log path to readFile with utf-8 encoding", async () => {
		mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
		mockReadFile.mockResolvedValue("content" as never);

		await readTerminalLog("/my/log/path.log");

		expect(mockReadFile).toHaveBeenCalledWith("/my/log/path.log", "utf-8");
	});
});

describe("waitForTuiReady", () => {
	beforeEach(() => {
		mockSpawn.mockReset();
	});

	test("resolves immediately when pane already has TUI markers", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("╭─ Claude Code ──╮\n", "", 0));

		await waitForTuiReady("legio-agent", { postReadyDelay: 0 });

		// Should call capture-pane once and return without timeout
		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const callArgs = mockSpawn.mock.calls[0] as unknown[];
		const command = callArgs[0] as string;
		const args = callArgs[1] as string[];
		expect([command, ...args]).toEqual(["tmux", "capture-pane", "-t", "legio-agent", "-p"]);
	});

	test("polls until pane shows TUI markers", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount <= 2) {
				// First two polls: empty pane
				return createMockProcess("", "", 0);
			}
			// Third poll: TUI marker appeared
			return createMockProcess("╭─ Claude Code ────────────────────╮\n", "", 0);
		});

		await waitForTuiReady("legio-agent", { timeout: 5_000, interval: 10, postReadyDelay: 0 });

		// Should have polled 3 times
		expect(mockSpawn).toHaveBeenCalledTimes(3);
	});

	test("does not trigger ready on plain shell prompt (regression)", async () => {
		let callCount = 0;
		mockSpawn.mockImplementation(() => {
			callCount++;
			if (callCount <= 2) {
				// Shell prompt only — no TUI markers
				return createMockProcess("user@host:~$ ", "", 0);
			}
			// Eventually return TUI content
			return createMockProcess("╭─ Claude Code ──╮\n", "", 0);
		});

		await waitForTuiReady("legio-agent", { timeout: 5_000, interval: 10, postReadyDelay: 0 });

		// Polled past the shell prompt, resolved only when TUI markers appeared
		expect(mockSpawn).toHaveBeenCalledTimes(3);
	});

	test("resolves without throwing when timeout expires with no TUI markers", async () => {
		// Always return empty content (no TUI markers)
		mockSpawn.mockImplementation(() => createMockProcess("", "", 0));

		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		// Short timeout so test is fast
		await expect(
			waitForTuiReady("legio-agent", { timeout: 100, interval: 10, postReadyDelay: 0 }),
		).resolves.toBeUndefined();

		// Should emit a warning on timeout
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Warning"));

		stderrSpy.mockRestore();
	});

	test("applies postReadyDelay after marker detection", async () => {
		mockSpawn.mockImplementation(() => createMockProcess("╭─ Claude Code ──╮\n", "", 0));

		const start = Date.now();
		await waitForTuiReady("legio-agent", { timeout: 5_000, interval: 10, postReadyDelay: 100 });
		const elapsed = Date.now() - start;

		// Should have waited at least ~100ms for the post-ready delay
		expect(elapsed).toBeGreaterThanOrEqual(80);
	});
});
