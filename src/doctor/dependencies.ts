import { spawn } from "node:child_process";
import type { LegioConfig } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * External dependency checks.
 * Validates that required CLI tools (git, node, tmux, sd, mulch) are available.
 * bd is checked as optional (legacy tracker backend).
 */
export const checkDependencies: DoctorCheckFn = async (
	config: LegioConfig,
	_legioDir,
): Promise<DoctorCheck[]> => {
	const backend = config.taskTracker.backend;

	const requiredTools = [
		{ name: "git", versionFlag: "--version", required: true },
		{ name: "node", versionFlag: "--version", required: true },
		{ name: "tmux", versionFlag: "-V", required: true },
		{
			name: "sd",
			versionFlag: "--version",
			required: false,
			installHint: "npm install -g @os-eco/seeds-cli — https://github.com/jayminwest/seeds",
		},
		{
			name: "mulch",
			versionFlag: "--version",
			required: false,
			installHint: "npm install -g @os-eco/mulch-cli — https://github.com/jayminwest/mulch",
		},
		{
			name: "bd",
			versionFlag: "--version",
			required: false,
			installHint: "https://github.com/steveyegge/beads",
		},
	];

	const checks: DoctorCheck[] = [];

	for (const tool of requiredTools) {
		const check = await checkTool(tool.name, tool.versionFlag, tool.required, tool.installHint);
		checks.push(check);
	}

	return checks;
};

/**
 * Check if a CLI tool is available by attempting to run it with a version flag.
 */
async function checkTool(
	name: string,
	versionFlag: string,
	required: boolean,
	installHint?: string,
): Promise<DoctorCheck> {
	try {
		const { exitCode, stdout, stderr } = await new Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>((resolve, reject) => {
			const proc = spawn(name, [versionFlag], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
			proc.on("error", reject);
		});

		if (exitCode === 0) {
			const version = stdout.split("\n")[0]?.trim() || "version unknown";

			return {
				name: `${name} availability`,
				category: "dependencies",
				status: "pass",
				message: `${name} is available`,
				details: [version],
			};
		}

		// Non-zero exit code
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} command failed (exit code ${exitCode})`,
			details: stderr ? [stderr.trim()] : undefined,
			fixable: true,
		};
	} catch (error) {
		// Command not found or spawn failed
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} is not installed or not in PATH`,
			details: [
				installHint
					? `Install ${name}: ${installHint}`
					: `Install ${name} or ensure it is in your PATH`,
				error instanceof Error ? error.message : String(error),
			],
			fixable: true,
		};
	}
}
