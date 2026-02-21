#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Bootstrap shim: re-exec Node with --import tsx so TypeScript files load
// natively. tsx >= 4.21 dropped support for module.register() on Node >= 23,
// requiring --import instead. The env guard prevents infinite re-exec.

if (process.env.__LEGIO_TSX_LOADED) {
	await import("../src/index.ts");
} else {
	const scriptPath = fileURLToPath(import.meta.url);
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", scriptPath, ...process.argv.slice(2)],
		{
			stdio: "inherit",
			env: { ...process.env, __LEGIO_TSX_LOADED: "1" },
		},
	);
	process.exit(result.status ?? 1);
}
