import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { AgentManifest } from "../types.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Directory structure checks.
 * Validates that .legio/ and its subdirectories exist with correct permissions.
 */
export const checkStructure: DoctorCheckFn = async (
	_config,
	legioDir,
): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];

	// Check 1: .legio/ directory exists
	const legioDirExists = await pathExists(legioDir);
	checks.push({
		name: ".legio/ directory",
		category: "structure",
		status: legioDirExists ? "pass" : "fail",
		message: legioDirExists ? "Directory exists" : "Directory missing",
		details: legioDirExists ? undefined : ["Run 'legio init' to create it"],
		fixable: !legioDirExists,
	});

	// If .legio/ doesn't exist, bail early
	if (!legioDirExists) {
		return checks;
	}

	// Check 2: Required files
	const requiredFiles = ["config.yaml", "agent-manifest.json", "hooks.json", ".gitignore"];
	const missingFiles: string[] = [];

	for (const fileName of requiredFiles) {
		const filePath = join(legioDir, fileName);
		const exists = await pathExists(filePath);
		if (!exists) {
			missingFiles.push(fileName);
		}
	}

	checks.push({
		name: "Required files",
		category: "structure",
		status: missingFiles.length === 0 ? "pass" : "fail",
		message:
			missingFiles.length === 0
				? "All required files present"
				: `Missing ${missingFiles.length} file(s)`,
		details: missingFiles.length > 0 ? missingFiles : undefined,
		fixable: missingFiles.length > 0,
	});

	// Check 3: Required subdirectories
	const requiredDirs = ["agent-defs", "agents", "worktrees", "specs", "logs"];
	const missingDirs: string[] = [];

	for (const dirName of requiredDirs) {
		const dirPath = join(legioDir, dirName);
		const exists = await pathExists(dirPath);
		if (!exists) {
			missingDirs.push(`${dirName}/`);
		}
	}

	checks.push({
		name: "Required subdirectories",
		category: "structure",
		status: missingDirs.length === 0 ? "pass" : "fail",
		message:
			missingDirs.length === 0
				? "All required subdirectories present"
				: `Missing ${missingDirs.length} subdirectory(ies)`,
		details: missingDirs.length > 0 ? missingDirs : undefined,
		fixable: missingDirs.length > 0,
	});

	// Check 4: .gitignore contents — validate wildcard+whitelist model
	const gitignorePath = join(legioDir, ".gitignore");
	const expectedEntries = [
		"*",
		"!.gitignore",
		"!config.yaml",
		"!agent-manifest.json",
		"!hooks.json",
		"!groups.json",
		"!agent-defs/",
	];

	try {
		const gitignoreContent = await Bun.file(gitignorePath).text();
		const missingEntries = expectedEntries.filter((entry) => !gitignoreContent.includes(entry));

		checks.push({
			name: ".gitignore entries",
			category: "structure",
			status: missingEntries.length === 0 ? "pass" : "warn",
			message:
				missingEntries.length === 0
					? "All expected entries present"
					: `Missing ${missingEntries.length} entry(ies)`,
			details: missingEntries.length > 0 ? missingEntries : undefined,
			fixable: missingEntries.length > 0,
		});
	} catch {
		// .gitignore doesn't exist, already reported in required files check
		checks.push({
			name: ".gitignore entries",
			category: "structure",
			status: "fail",
			message: "Cannot read .gitignore",
			details: ["File is missing or unreadable"],
			fixable: true,
		});
	}

	// Check 5: agent-defs/ contains .md files referenced by agent-manifest.json
	try {
		const manifestPath = join(legioDir, "agent-manifest.json");
		const manifestContent = await Bun.file(manifestPath).text();
		const manifest = JSON.parse(manifestContent) as AgentManifest;

		const referencedFiles = new Set<string>();
		for (const agentDef of Object.values(manifest.agents)) {
			referencedFiles.add(agentDef.file);
		}

		const agentDefsDir = join(legioDir, "agent-defs");
		const missingDefFiles: string[] = [];

		for (const fileName of referencedFiles) {
			const filePath = join(agentDefsDir, fileName);
			const exists = await pathExists(filePath);
			if (!exists) {
				missingDefFiles.push(fileName);
			}
		}

		checks.push({
			name: "Agent definition files",
			category: "structure",
			status: missingDefFiles.length === 0 ? "pass" : "fail",
			message:
				missingDefFiles.length === 0
					? "All referenced .md files present"
					: `Missing ${missingDefFiles.length} agent definition(s)`,
			details: missingDefFiles.length > 0 ? missingDefFiles : undefined,
			fixable: missingDefFiles.length > 0,
		});
	} catch (error) {
		// Manifest missing or malformed, already reported or will be in config checks
		checks.push({
			name: "Agent definition files",
			category: "structure",
			status: "fail",
			message: "Cannot validate agent definitions",
			details: [
				error instanceof Error ? error.message : "agent-manifest.json is missing or malformed",
			],
			fixable: false,
		});
	}

	// Check 6: No leftover files from failed init attempts
	// Common temp files: .tmp, .bak, config.yaml~, etc.
	try {
		const entries = await Array.fromAsync(new Bun.Glob("*.{tmp,bak}").scan({ cwd: legioDir }));
		const tempFiles = entries.filter((name) => name.endsWith(".tmp") || name.endsWith(".bak"));

		checks.push({
			name: "Leftover temp files",
			category: "structure",
			status: tempFiles.length === 0 ? "pass" : "warn",
			message:
				tempFiles.length === 0 ? "No temp files found" : `Found ${tempFiles.length} temp file(s)`,
			details: tempFiles.length > 0 ? tempFiles : undefined,
			fixable: tempFiles.length > 0,
		});
	} catch {
		// Ignore errors scanning for temp files
	}

	return checks;
};
