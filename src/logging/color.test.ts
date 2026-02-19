import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// Resolve the project root from this file's location (src/logging/ -> project root)
const projectRoot = join(dirname(import.meta.dir), "..");

describe("color module", () => {
	// Test via subprocess to control env vars at import time

	test("colors enabled by default (no env vars)", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: undefined },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(true);
		expect(result.reset).toBe("\x1b[0m");
	});

	test("NO_COLOR disables colors", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(false);
		expect(result.reset).toBe("");
	});

	test("TERM=dumb disables colors", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, TERM: "dumb", NO_COLOR: undefined, FORCE_COLOR: undefined },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(false);
		expect(result.reset).toBe("");
	});

	test("FORCE_COLOR overrides NO_COLOR", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "1" },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
		const result = JSON.parse(output.trim());
		expect(result.colorsEnabled).toBe(true);
		expect(result.reset).toBe("\x1b[0m");
	});

	test("FORCE_COLOR=0 disables colors", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				'import { color, colorsEnabled } from "./src/logging/color.ts"; console.log(JSON.stringify({ colorsEnabled, reset: color.reset }))',
			],
			{
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: undefined },
			},
		);
		await proc.exited;
		const output = await new Response(proc.stdout).text();
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
