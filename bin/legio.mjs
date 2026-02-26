#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bootstrap shim: re-exec Node with --import tsx so TypeScript files load
// natively. tsx >= 4.21 dropped support for module.register() on Node >= 23,
// requiring --import instead.
//
// Resolve tsx from legio's own node_modules (not the user's cwd) so that
// `npm install -g` works regardless of what project the user is in.
//
// Guard logic (two-layer):
// 1. __LEGIO_TSX_LOADED env var: standard guard for the non-node_modules case.
//    Prevents infinite re-exec when the script is invoked directly from PATH.
// 2. When running from inside node_modules (npm install), Node v23+ refuses to
//    strip types unless tsx is active via --import. A daemon child may inherit
//    __LEGIO_TSX_LOADED=1 from its parent (before the parent's env was set),
//    so we additionally verify tsx is actually registered by checking execArgv.
//    Only skip re-exec when __LEGIO_TSX_LOADED=1 AND tsx is confirmed active.

const scriptPath = fileURLToPath(import.meta.url);
const inNodeModules = scriptPath.includes("/node_modules/");

// Resolve tsx to its absolute path within legio's own dependency tree.
// This ensures --import finds tsx even when cwd is a different project.
const require = createRequire(import.meta.url);
const tsxPath = require.resolve("tsx");

// True when this process was started with `node --import tsx ...`
const tsxImportActive =
	process.execArgv.some((arg, i, arr) => arg === "--import" && arr[i + 1] === "tsx") ||
	process.execArgv.some((arg) => arg === "--import=tsx") ||
	process.execArgv.some((arg, i, arr) => arg === "--import" && arr[i + 1] === tsxPath) ||
	process.execArgv.some((arg) => arg === `--import=${tsxPath}`);

if (process.env.__LEGIO_TSX_LOADED && (!inNodeModules || tsxImportActive)) {
	await import("../src/index.ts");
} else {
	const result = spawnSync(
		process.execPath,
		["--import", tsxPath, scriptPath, ...process.argv.slice(2)],
		{
			stdio: "inherit",
			env: { ...process.env, __LEGIO_TSX_LOADED: "1" },
		},
	);
	process.exit(result.status ?? 1);
}
