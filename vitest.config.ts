import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Shim Bun-specific built-in modules so vitest (Node.js) can load server files
 * that transitively import bun:sqlite. The websocket manager wraps all store
 * access in try/catch, so a Database constructor that throws is fine at runtime.
 * enforce:"pre" ensures this plugin intercepts before vite's built-in resolver.
 */
function bunShims(): Plugin {
	return {
		name: "bun-shims",
		enforce: "pre",
		resolveId(id) {
			if (id === "bun:sqlite") return "\0bun:sqlite";
			return undefined;
		},
		load(id) {
			if (id === "\0bun:sqlite") {
				return `
					export class Database {
						constructor() {
							throw new Error("bun:sqlite is not available in the Node.js/vitest environment");
						}
					}
				`;
			}
			return undefined;
		},
	};
}

export default defineConfig({
	plugins: [bunShims()],
	test: {
		include: [
			"src/mail/**/*.test.ts",
			"src/sessions/**/*.test.ts",
			"src/events/**/*.test.ts",
			"src/metrics/**/*.test.ts",
			"src/merge/**/*.test.ts",
			"src/server/**/*.test.ts",
		],
	},
});
