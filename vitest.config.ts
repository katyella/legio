import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		include: [
			"src/mail/**/*.test.ts",
			"src/sessions/**/*.test.ts",
			"src/events/**/*.test.ts",
			"src/metrics/**/*.test.ts",
			"src/merge/**/*.test.ts",
		],
	},
});
