import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
	{
		test: {
			name: "unit",
			include: ["src/**/*.test.ts"],
			exclude: [
				"src/commands/coordinator.test.ts",
				"src/merge/resolver.test.ts",
				"src/merge/merge.test.ts",
				"src/commands/clean.test.ts",
				"src/commands/gateway.test.ts",
				"src/mulch/client.test.ts",
				"src/worktree/manager.test.ts",
			],
			testTimeout: 15_000,
			hookTimeout: 30_000,
			reporters: ["dot"],
		},
	},
	{
		test: {
			name: "integration",
			include: [
				"src/commands/coordinator.test.ts",
				"src/merge/resolver.test.ts",
				"src/merge/merge.test.ts",
				"src/commands/clean.test.ts",
				"src/commands/gateway.test.ts",
				"src/mulch/client.test.ts",
				"src/worktree/manager.test.ts",
			],
			testTimeout: 15_000,
			hookTimeout: 30_000,
			reporters: ["dot"],
		},
	},
]);
