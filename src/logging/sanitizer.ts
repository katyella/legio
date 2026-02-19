/**
 * Secret redaction for log output.
 *
 * Scans strings and objects for known secret patterns (API keys, tokens, etc.)
 * and replaces them with "[REDACTED]" to prevent accidental credential leakage.
 */

const REDACT_PATTERNS: RegExp[] = [
	/sk-ant-[a-zA-Z0-9_-]+/g,
	/github_pat_[a-zA-Z0-9_]+/g,
	/Bearer\s+[a-zA-Z0-9._-]+/g,
	/ghp_[a-zA-Z0-9]+/g,
	/ANTHROPIC_API_KEY=[^\s]+/g,
];

const REDACTED = "[REDACTED]";

/**
 * Replace all known secret patterns in a string with "[REDACTED]".
 */
export function sanitize(input: string): string {
	let result = input;
	for (const pattern of REDACT_PATTERNS) {
		// Reset lastIndex since we reuse global regexps
		pattern.lastIndex = 0;
		result = result.replace(pattern, REDACTED);
	}
	return result;
}

/**
 * Deep-clone an object and sanitize all string values within it.
 * Handles nested objects and arrays. Non-string primitives are passed through.
 */
export function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
	return sanitizeValue(obj) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitize(value);
	}

	if (Array.isArray(value)) {
		return value.map(sanitizeValue);
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			result[key] = sanitizeValue((value as Record<string, unknown>)[key]);
		}
		return result;
	}

	return value;
}
