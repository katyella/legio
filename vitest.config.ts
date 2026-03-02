import { defineConfig, defineProject } from "vitest/config";

export default defineConfig({
	test: {
		// Files using vi.mock() need isolation to prevent module mock leaks
		// across test files (see mulch mx-56558b). Projects let us run most
		// tests fast (isolate:false) while isolating vi.mock users.
		projects: [
			defineProject({
				test: {
					name: "isolated",
					include: ["src/worktree/tmux.test.ts"],
					testTimeout: 15_000,
					hookTimeout: 30_000,
					pool: "threads",
					isolate: true,
					restoreMocks: true,
				},
			}),
			defineProject({
				test: {
					name: "default",
					include: ["src/**/*.test.ts"],
					exclude: ["src/worktree/tmux.test.ts"],
					testTimeout: 15_000,
					hookTimeout: 30_000,
					pool: "threads",
					isolate: false,
					restoreMocks: true,
				},
			}),
		],
	},
});
