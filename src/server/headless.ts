/**
 * HeadlessCoordinator — spawn Claude Code as a PTY subprocess without tmux.
 *
 * Uses the `script` command to allocate a pseudo-terminal:
 * - macOS: script -q /dev/null -c <cmd>
 * - Linux: script -qfc <cmd> /dev/null
 *
 * Output is buffered in a ring buffer (default 500 lines) and broadcast
 * to WebSocket clients via the 'output' event.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { HeadlessCoordinatorConfig } from "../types.ts";

export class HeadlessCoordinator extends EventEmitter {
	private proc: ChildProcess | null = null;
	private ringBuffer: string[] = [];
	private maxLines: number;
	private running = false;

	constructor(private config: HeadlessCoordinatorConfig) {
		super();
		this.maxLines = config.ringBufferSize ?? 500;
	}

	/**
	 * Start the coordinator subprocess via `script` (PTY wrapper).
	 * Emits 'output' events with raw text chunks.
	 * Emits 'exit' with the exit code when the process ends.
	 */
	start(): void {
		if (this.running) {
			throw new Error("HeadlessCoordinator is already running");
		}

		// Platform-specific script args
		const scriptArgs =
			process.platform === "linux"
				? ["-qfc", this.config.command, "/dev/null"]
				: ["-q", "/dev/null", "-c", this.config.command];

		this.proc = spawn("script", scriptArgs, {
			cwd: this.config.cwd,
			env: { ...process.env, ...this.config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.running = true;

		this.proc.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			// Split into lines and buffer each
			const lines = text.split("\n");
			for (const line of lines) {
				this.ringBuffer.push(line);
				while (this.ringBuffer.length > this.maxLines) {
					this.ringBuffer.shift();
				}
			}
			this.emit("output", text);
		});

		this.proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			// Also buffer stderr output
			const lines = text.split("\n");
			for (const line of lines) {
				this.ringBuffer.push(line);
				while (this.ringBuffer.length > this.maxLines) {
					this.ringBuffer.shift();
				}
			}
			this.emit("output", text);
		});

		this.proc.on("close", (code: number | null) => {
			this.running = false;
			this.proc = null;
			this.emit("exit", code ?? 1);
		});
	}

	/**
	 * Write input to the coordinator's stdin (e.g., user messages).
	 */
	write(input: string): void {
		if (!this.running || !this.proc?.stdin) {
			throw new Error("HeadlessCoordinator is not running");
		}
		this.proc.stdin.write(input);
	}

	/**
	 * Gracefully stop the coordinator.
	 * Sends SIGTERM, waits 5s, then SIGKILL if still running.
	 */
	async stop(): Promise<void> {
		if (!this.running || !this.proc) {
			return;
		}

		const proc = this.proc;

		return new Promise<void>((resolve) => {
			const killTimeout = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// ignore — process may have already exited
				}
				resolve();
			}, 5000);

			proc.on("close", () => {
				clearTimeout(killTimeout);
				resolve();
			});

			try {
				proc.kill("SIGTERM");
			} catch {
				clearTimeout(killTimeout);
				resolve();
			}
		});
	}

	/**
	 * Return the full ring buffer contents as a newline-joined string.
	 */
	getOutput(): string {
		return this.ringBuffer.join("\n");
	}

	/**
	 * Whether the coordinator subprocess is currently running.
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * PID of the underlying `script` process, or null if not started.
	 */
	getPid(): number | null {
		return this.proc?.pid ?? null;
	}
}
