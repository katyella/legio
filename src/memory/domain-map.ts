/**
 * Domain inference from file paths.
 *
 * Maps file paths to expertise domain names using glob pattern matching.
 * Moved from src/mulch/client.ts — these are pure functions with no
 * external dependency on mulch.
 */

/**
 * Default mapping from glob patterns to domain names.
 * Used by inferDomainsFromFiles() when no custom map is provided.
 */
export const DEFAULT_DOMAIN_MAP: Record<string, string[]> = {
	"src/commands/**": ["cli"],
	"src/server/routes*": ["server"],
	"src/server/public/**": ["frontend"],
	"src/sessions/**": ["server"],
	"src/metrics/**": ["server"],
	"src/events/**": ["server"],
	"src/mail/**": ["server"],
	"src/agents/**": ["swarm"],
	"src/worktree/**": ["swarm", "merge"],
	"src/merge/**": ["merge"],
	"src/beads/**": ["cli"],
	"src/memory/**": ["cli"],
	"src/tracker/**": ["cli"],
	"src/*.test.*": ["testing"],
	"src/**/*.test.*": ["testing"],
	"agents/**": ["swarm"],
	"templates/**": ["swarm"],
};

/**
 * Convert a glob pattern to a regular expression and test it against a file path.
 *
 * Rules:
 * - `**` in `/**\/` position matches zero or more path segments (including zero)
 * - `**` at the end of pattern matches any remaining path
 * - `*` matches any characters within a single path segment (no slashes)
 * - All other regex special characters are escaped
 *
 * @internal
 */
export function matchGlob(pattern: string, filePath: string): boolean {
	let regexStr = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === undefined) break;
		if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
			// Check for /**/  in the middle of the pattern
			if (i > 0 && pattern[i - 1] === "/" && i + 2 < pattern.length && pattern[i + 2] === "/") {
				// /**/  → match zero or more path segments (consumes the trailing /)
				regexStr += "(?:.*/)?";
				i += 3; // skip **/
			} else {
				// ** at end (or start, or without surrounding slashes) → match anything
				regexStr += ".*";
				i += 2;
			}
		} else if (ch === "*") {
			// * → match any chars within a single segment (no slashes)
			regexStr += "[^/]*";
			i++;
		} else {
			// Escape regex special chars
			regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i++;
		}
	}
	regexStr += "$";
	return new RegExp(regexStr).test(filePath);
}

/**
 * Infer domain names from a list of file paths using glob pattern matching.
 *
 * Maps file paths to domain names using the provided domain map (or DEFAULT_DOMAIN_MAP).
 * Returns a deduplicated array of matched domain names.
 *
 * @param files - File paths to match (relative to project root)
 * @param domainMap - Optional custom glob-to-domain mapping; falls back to DEFAULT_DOMAIN_MAP
 * @returns Deduplicated array of matched domain names
 */
export function inferDomainsFromFiles(
	files: readonly string[],
	domainMap?: Record<string, string[]>,
): string[] {
	const map = domainMap ?? DEFAULT_DOMAIN_MAP;
	const domainsSet = new Set<string>();
	for (const file of files) {
		for (const [pattern, domains] of Object.entries(map)) {
			if (matchGlob(pattern, file)) {
				for (const domain of domains) {
					domainsSet.add(domain);
				}
			}
		}
	}
	return Array.from(domainsSet);
}
