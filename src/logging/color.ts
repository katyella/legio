/**
 * Central ANSI color and output control.
 *
 * Respects the NO_COLOR convention (https://no-color.org/):
 * - When NO_COLOR env var is set (any value), all color codes become empty strings
 * - When TERM=dumb, colors are disabled
 * - When FORCE_COLOR is set to a truthy value, colors are forced on
 *
 * Also provides --quiet support: when quiet mode is enabled, non-error
 * output is suppressed. Commands check isQuiet() before writing to stdout.
 */

/**
 * Priority order for color detection:
 * 1. FORCE_COLOR (highest) — set to non-"0" to force colors on
 * 2. NO_COLOR — any value disables colors
 * 3. TERM=dumb — disables colors
 * 4. Default: colors enabled
 */
function shouldUseColor(): boolean {
	if (process.env.FORCE_COLOR !== undefined) {
		return process.env.FORCE_COLOR !== "0";
	}
	if (process.env.NO_COLOR !== undefined) {
		return false;
	}
	if (process.env.TERM === "dumb") {
		return false;
	}
	return true;
}

const useColor = shouldUseColor();

function code(ansiCode: string): string {
	return useColor ? ansiCode : "";
}

/**
 * ANSI color codes that respect NO_COLOR.
 * When colors are disabled, all values are empty strings.
 */
export const color = {
	reset: code("\x1b[0m"),
	bold: code("\x1b[1m"),
	dim: code("\x1b[2m"),
	red: code("\x1b[31m"),
	green: code("\x1b[32m"),
	yellow: code("\x1b[33m"),
	blue: code("\x1b[34m"),
	magenta: code("\x1b[35m"),
	cyan: code("\x1b[36m"),
	white: code("\x1b[37m"),
	gray: code("\x1b[90m"),
} as const;

/** Whether ANSI colors are currently enabled. */
export const colorsEnabled = useColor;

// --- Quiet mode ---
let quietMode = false;

/** Enable quiet mode (suppress non-error output). */
export function setQuiet(enabled: boolean): void {
	quietMode = enabled;
}

/** Check if quiet mode is active. */
export function isQuiet(): boolean {
	return quietMode;
}
