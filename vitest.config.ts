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
		// routes.test.ts is owned by the routes-builder and uses bun:test directly;
		// only include the server core tests that this builder owns.
		include: ["src/server/index.test.ts", "src/server/websocket.test.ts"],
	},
});
