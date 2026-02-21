#!/usr/bin/env tsx
/**
 * Bump version in both package.json and src/index.ts.
 *
 * Usage: npm run version:bump <major|minor|patch>
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: npm run version:bump <major|minor|patch>";

type BumpType = "major" | "minor" | "patch";

function parseVersion(version: string): [number, number, number] {
	const parts = version.split(".");
	if (parts.length !== 3) {
		throw new Error(`Invalid semver: ${version}`);
	}
	const [major, minor, patch] = parts.map(Number) as [number, number, number];
	if ([major, minor, patch].some((n) => Number.isNaN(n))) {
		throw new Error(`Invalid semver: ${version}`);
	}
	return [major, minor, patch];
}

function bumpVersion(version: string, type: BumpType): string {
	const [major, minor, patch] = parseVersion(version);
	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

async function main(): Promise<void> {
	const bumpType = process.argv[2] as BumpType | undefined;

	if (!bumpType || !["major", "minor", "patch"].includes(bumpType)) {
		console.error(USAGE);
		process.exit(1);
	}

	const scriptDir = dirname(fileURLToPath(import.meta.url));

	// Read and update package.json
	const pkgPath = join(scriptDir, "..", "package.json");
	const pkgText = await readFile(pkgPath, "utf-8");
	const pkg = JSON.parse(pkgText) as { version: string };
	const oldVersion = pkg.version;
	const newVersion = bumpVersion(oldVersion, bumpType);
	pkg.version = newVersion;
	await writeFile(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);

	// Read and update src/index.ts
	const indexPath = join(scriptDir, "..", "src", "index.ts");
	const indexText = await readFile(indexPath, "utf-8");
	const updatedIndex = indexText.replace(
		/const VERSION = "[^"]+"/,
		`const VERSION = "${newVersion}"`,
	);
	if (updatedIndex === indexText) {
		console.error("Error: Could not find VERSION constant in src/index.ts");
		process.exit(1);
	}
	await writeFile(indexPath, updatedIndex);

	console.log(`${oldVersion} -> ${newVersion}`);
	console.log("Updated: package.json, src/index.ts");
	console.log("\nNext steps:");
	console.log(`  1. Update CHANGELOG.md with changes under [${newVersion}]`);
	console.log(`  2. git add -A && git commit -m "v${newVersion}"`);
	console.log("  3. git push  (GitHub Actions will auto-tag)");
}

main();
