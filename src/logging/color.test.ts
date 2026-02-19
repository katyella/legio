import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// Resolve the project root from this file's location (src/logging/ -> project root)
const projectRoot = join(dirname(import.meta.dirname), "..");

function makeEnv(overrides: Record<string, string | undefined>): Record<string, string> {
	const merged = { ...process.env, ...overrides };
	return Object.fromEntries(
		Object.entries(merged).filter(([, v]) => v !== undefined),
	) as Record<string, string>;
}

async function runBun(code: string, envOverrides: Record<string, string | undefined>): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("bun", ["-e", code], {
			cwd: projectRoot,
			env: makeEnv(envOverrides),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.on("close", () => resolve(stdout));
		proc.on("error", reject);
	});
}

describe("color module", () => {
	// Test via subprocess to control env vars at import time

	test("colors enabled by default (no env vars)", async () => {
		const code =
			'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))';
		const output = await runBun(code, { NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: undefined });
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(true);
		expect(result.reset).toBe("\x1b[0m");
	});

	test("NO_COLOR disables colors", async () => {
		const code =
			'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))';
		const output = await runBun(code, { NO_COLOR: "1", FORCE_COLOR: undefined });
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(false);
		expect(result.reset).toBe("");
	});

	test("TERM=dumb disables colors", async () => {
		const code =
			'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))';
		const output = await runBun(code, { TERM: "dumb", NO_COLOR: undefined, FORCE_COLOR: undefined });
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(false);
		expect(result.reset).toBe("");
	});

	test("FORCE_COLOR overrides NO_COLOR", async () => {
		const code =
			'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))';
		const output = await runBun(code, { NO_COLOR: "1", FORCE_COLOR: "1" });
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(true);
		expect(result.reset).toBe("\x1b[0m");
	});

	test("FORCE_COLOR=0 disables colors", async () => {
		const code =
			'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))';
		const output = await runBun(code, { FORCE_COLOR: "0", NO_COLOR: undefined });
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(false);
	});

	test("setQuiet/isQuiet controls quiet mode", async () => {
		const { isQuiet, setQuiet } = await import("./color.ts");
		expect(isQuiet()).toBe(false);
		setQuiet(true);
		expect(isQuiet()).toBe(true);
		setQuiet(false);
		expect(isQuiet()).toBe(false);
	});

	test("all color keys present", async () => {
		const { color } = await import("./color.ts");
		const expectedKeys = [
			"reset",
			"bold",
			"dim",
			"red",
			"green",
			"yellow",
			"blue",
			"magenta",
			"cyan",
			"white",
			"gray",
		];
		for (const key of expectedKeys) {
			expect(key in color).toBe(true);
		}
	});
});
